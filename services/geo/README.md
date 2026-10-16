# GeoAgent geo service

Small FastAPI backend (Q-22) for operations the TypeScript side cannot do well: **cloud-masked median
composites**, **time-series reductions** and **zonal statistics**, on Sentinel-2 L2A from Earth Search
(`https://earth-search.aws.element84.com/v1`, collection `sentinel-2-l2a`; the same source, asset keys and
reflectance scaling as `src/app/api/agent/lib/{stac,cloud,reflectance}.ts`). TypeScript client:
`src/app/api/agent/lib/geo-service.ts` (`GEO_SERVICE_URL`).

## Run

```bash
cd services/geo
uv sync                                   # pinned by uv.lock
uv run uvicorn app.main:app --port 8100   # GEO_CACHE_DIR defaults to ./.cache/composites
uv run pytest                             # offline, deterministic (committed synthetic COG fixture)
GEO_LIVE=1 uv run pytest -s tests/test_live.py   # live Kasur NDVI composite
```

Behind a TLS-intercepting proxy set `SSL_CERT_FILE` (copied to `CURL_CA_BUNDLE` for GDAL) and `HTTPS_PROXY`.
Docker: `docker compose up geo` (service `geo`, port 8100 internal only, volume `geo_cache`, GDAL env set;
the app gets `GEO_SERVICE_URL=http://geo:8100`). The Dockerfile uses wheels only (rasterio, pyproj, shapely,
exactextract bundle GDAL/PROJ/GEOS) and has not been built in the authoring sandbox (no Docker daemon).

## Cloud Run

Deployed by `deploy/cloudrun/` (see its README): not publicly invokable, the web service calls it with a Google ID
token (`GEO_SERVICE_AUDIENCE` on the web side; the service itself has no auth code, Cloud Run IAM does it). Run it
with **max-instances=1**: composites are cached as COGs under `GEO_CACHE_DIR` and tile URLs embed the composite id, so
a second instance would 404 tiles for composites the first one computed. `GEO_CACHE_DIR` may point into a
gcsfuse-mounted bucket to survive restarts. The container honours `PORT` (default 8100) and runs as a non-root user.

## How the app uses it (Q-18)

With `GEO_SERVICE_URL` set, the operation registry offers `composite` (`engine/ops/composite.ts`, `tools/composite.ts`) and
the planner prompt gains one row: cloud-free / median / seasonal / monthly requests go to `composite`; a specific date stays
`fetch_ndvi` / `render_raster`. Without the variable the operation is absent (not offered, `GET /api/operations` omits it,
a call is refused as an unknown tool). The browser never talks to this service: layers use
`/api/geo/tiles/{id}/{z}/{x}/{y}?rescale=min,max&colormap_name=...`, a Next route that validates the 24-hex id, tile
coordinates and the three style params, forwards to `/composite/{id}/tiles/...`, passes upstream statuses through and turns
an unreachable service into `502 fetch_failed`. Errors map to results: 502 -> `failed` ("fetch failure, not an absence of
data"), `item_count: 0` -> an explicit "no scenes" answer, `id: null` with scenes -> "every pixel was masked" (nothing drawn).

## Endpoints

| | |
|---|---|
| `GET /health` | liveness |
| `POST /composite` | `{bbox \| geometry, start, end, bands[] \| expression, collection?, max_cloud?, resolution?, scl_keep?}` -> `{id, items, item_count, scene_days, valid_pixel_pct, valid_obs_per_pixel, stats{band:{min,max,mean,p2,p98,n}}, bounds, crs, tile_url_template, download_url, created, cached, message}` |
| `GET /composite/{id}` | stored metadata |
| `GET /composite/{id}/tiles/{z}/{x}/{y}.png?rescale=min,max&colormap_name=&bidx=` | rio-tiler PNG (256 px). Default stretch: p2..p98 of the composite for 1 band, 0..0.3 reflectance for 3 bands. 204 outside bounds |
| `GET /composite/{id}.tif` | the float32 COG (NaN = no valid observation) |
| `POST /timeseries` | `{bbox \| geometry, start, end, band \| expression, interval: scene\|month}` -> `series[{date, item_ids, mean, median, valid_pct, n_valid}]` |
| `POST /zonal` | `{features: FeatureCollection (<= 5000 polygons), source: composite id, stats[]}` -> per-feature, per-band stats. Stats: mean median min max sum count stdev variance valid_pct |

`expression` is a named index (`NDVI NDWI NDBI EVI NBR SAVI`, formulas identical to `titiler.ts`) or a safe
arithmetic formula over band names (Earth Search keys `red nir swir16 ...`, or `B04`-style aliases). Only
`+ - * / **`, numbers and parentheses are parsed (no `eval`).

### Errors (never a fake result)
- Upstream failure (STAC or COG read): **502** `{error:"fetch_failed", detail}`.
- No scenes: **200**, `item_count: 0`, `id: null`, explicit `message`.
- Scenes exist but every AOI pixel is masked: **200**, `id: null`, `valid_pixel_pct: 0`, `message`. No composite is written.
- Bad input **422** `bad_request`; AOI/stack over the memory cap **413** `too_large`; unknown/evicted id **404** `not_found`.

## Design choices

- **SCL mask.** Kept: 4 vegetation, 5 bare, 6 water, 7 unclassified, 11 snow (= `CLEAR_CLASSES` in `cloud.ts`, so
  the TS and Python sides agree). Dropped: 0 no-data, 1 saturated, **2 dark area** (ambiguous: terrain shadow or
  a genuinely dark surface; conservative, and the same as the TS side), 3 cloud shadow, 8/9 cloud, 10 thin cirrus.
  Override with `scl_keep`. Pixels with DN 0 in any needed band are also dropped. Masking is per pixel and per
  scene; `max_cloud` (scene-level) is optional and off by default.
- **Reflectance** = DN x 0.0001, offset 0. Earth Search declares `offset: -0.1` in `raster:bands` but serves pixels
  whose BOA offset is already removed (see `reflectance.ts`); applying it would be wrong. Nearest resampling, so
  20 m bands are replicated, not interpolated.
- **Median, then index.** Same-solar-day tiles are mosaicked first (so overlap does not double-weight a day);
  then a per-pixel `nanmedian` over days of each source band; then the expression on the median reflectance
  (as in GEE). A pixel with no clear observation is NaN. `valid_pixel_pct` is the share of AOI pixels with a value;
  `valid_obs_per_pixel` shows how many clear days each pixel had (a 1-observation "median" is not a median).
- **Grid.** UTM zone of the AOI centroid, `resolution` metres (default 10), AOI bounds snapped to the pixel grid,
  pixels outside the polygon are NaN (a bbox AOI is its UTM bounding box).
- **Content hash.** `id = sha256({v: "composite-v1", canonical request, sorted STAC item ids})[:24]`. The canonical
  request normalises band aliases, coordinates (6 dp) and `scl_keep`; item order is irrelevant. A new scene landing in
  the window changes the item set and therefore the id, so cached composites are never stale. Bump `HASH_VERSION`
  when masking/median semantics change. A cache hit still performs the STAC search (about 1 s) to learn the item set.
- **Zonal** uses `exactextract` (C++ exact fractional pixel coverage, windowed reads): mean/sum/count are
  coverage-weighted and NaN pixels excluded; `valid_pct` = valid coverage / total coverage of the polygon on the
  raster. Faster and more correct on edges than rasterising each polygon.
- **Limits** (env): `GEO_MAX_PIXELS` 25M per layer, `GEO_MAX_STACK_ELEMENTS` 300M (pixels x days x bands, all in
  RAM), `GEO_MAX_ITEMS` 200 scenes per search, `GEO_MAX_FEATURES` 5000.

## Measured (sandbox, 4 vCPU, via egress proxy, Earth Search + sentinel-cogs, 12 Oct 2026)

Kasur AOI `74.05-74.08 E, 31.12-31.15 N`, September 2026, NDVI, 10 m (336 x 290 px):

| | |
|---|---|
| items / scene-days | 32 / 14 |
| valid_pixel_pct | 100.0 (min 8, mean 10.6 clear observations per pixel) |
| NDVI p2 / p98 / mean | 0.112 / 0.843 / 0.550 |
| cold `POST /composite` | ~11.5 s |
| identical call (cache hit) | ~1.1-1.3 s (all of it the STAC search) |
| tile `z14` (cached COG) | ~0.17 s first, tens of ms after |
| `POST /timeseries` (scene, 14 days) | ~9 s |
| `POST /timeseries` (month, 2 months, red) | ~11.7 s |
| `POST /zonal` 2025 polygons x 1 band | ~2.0 s |

## Forecast and anomaly (monthly index)

`app/forecast.py`; accuracy in `eval/RESULTS.md` ("TimesFM forecasting (backtest)"). Both endpoints build a monthly series
with the same masked-median code as `/timeseries` (interval `month`, read quarter by quarter, 20 m by default; the per-quarter
result is cached under `<GEO_CACHE_DIR>/../series`, keyed by the STAC item set). A month counts as observed only if at least
30% of the AOI had a clear observation.

| | |
|---|---|
| `POST /anomaly` | `{bbox \| geometry, expression="NDVI", target_month: "YYYY-MM", history_years=5 (3-10)}` -> `{observed, observed_valid_pct, expected_p10/p50/p90, score, verdict, reason, history[], imputed_months, model{id,revision,method,backtest}, provenance, timing, warnings}`. `verdict`: `within_expected` / `below_expected` / `above_expected` / `cannot_determine` (no clear observation of the month, or history too short or sparse: 200 with a `reason`, never a guess). `score = (observed - p50) / sigma`, sigma from the p10-p90 width (`|score| > 1.28` = outside the range). The history ends the month before the target. |
| `POST /forecast` | **Off unless `GEO_TIMESFM=1`** (422 otherwise). `{bbox \| geometry, expression, history_start, history_end, horizon_months <= 12, interval: "month"}` -> `{history[{month,value,valid_pct,imputed}], forecast[{month,p10,p50,p90}], model{id,revision}, imputed_months, unfilled_gap_months, warnings, provenance, timing, backtest}`. `history_end` must lie in a complete month. |

**Refusals (422 `insufficient_history`)**: fewer than 36 months of history (counted from the first observed month), more than 25%
of months without a clear observation, or no clear observation in the last 2 months. Gaps of at most 2 months inside the series are
linearly interpolated and flagged `imputed: true`; longer gaps stay `value: null` (the model interpolates across them internally and
the response counts them in `unfilled_gap_months`). A trailing gap is forecast through, never filled.

**Method (backtest decision).** TimesFM 2.5 was *not better than monthly climatology on our backtest* (3-month lead: better MAE on 2 of 6 AOIs),
so `/anomaly` uses the climatology (mean of the same calendar month in earlier years, t prediction interval; measured p10-p90 coverage
83.0%, target 80%) and TimesFM is reachable only with `GEO_TIMESFM=1` (`method: "timesfm"` per request, and `/forecast`). The app mirrors this:
`detect_anomaly` is registered with `GEO_SERVICE_URL`; `forecast_index` additionally needs `GEO_TIMESFM_FORECAST=1`. Every response carries
`model` and the `backtest` figures it quotes (`app/backtest_summary.json`, written by `eval/backtest.py`).

**Model and license.** `google/timesfm-2.5-200m-pytorch` (Apache-2.0 code and weights), revision pinned to
`1d952420fba87f3c6dee4f240de0f1a0fbc790e3` (`GEO_TIMESFM_REVISION`), loaded lazily once (first use downloads ~800 MB from Hugging Face; set
`HF_HOME` to a persistent volume). Package `timesfm==3.0.2` (a code release that loads the 2.5 weights) with CPU torch 2.9.1 from
`download.pytorch.org/whl/cpu`, pinned in `pyproject.toml` / `uv.lock`. **TimesFM 3.0 weights are non-commercial
(timesfm-non-commercial-license-v1.0) and must not be used.** CPU timings (4 cores): load 3-17 s, inference 0.4-2 s per series; a cold
5-year series for a 10 km² AOI took ~7 min (years of scenes are read), warm ~1 min (STAC searches).

Known limit: 2017-18 scenes that exist only as requester-pays JP2 are skipped and counted in `provenance.skipped_unreadable_items`.

```bash
uv run pytest                      # offline; TimesFM test opt-in:
TFM_LIVE=1 uv run pytest tests/test_forecast.py -k live      # downloads the weights
uv run python eval/fetch_series.py && uv run python eval/backtest.py   # reproduce the backtest
```
