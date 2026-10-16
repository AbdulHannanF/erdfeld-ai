# Evaluation results

Measured results for GeoAgent evaluations that run offline. Each section says what
was measured, how, and how far the number can be trusted.

## Dataset registry retrieval

Measured 2026-10-11 on the committed snapshot (15,653 entries, 8.03 MB, harvested
2026-10-11). Reproduce with `npx vitest run src/app/api/agent/lib/registry/__tests__/retrieval.test.ts`
(per-theme tables and every miss are printed on each run).

**Metric.** hit@5: at least one of the top five results is an acceptable dataset.
"Acceptable" is a list of entry ids or family globs per question
(`eval/registry-questions.json`, `eval/registry-questions-holdout.json`). A merged
entry matches if its primary id or any alternate route matches. The test suite
rejects catch-all globs and requires the ground truth to exist in the registry.

| set | questions | hit@5 |
|---|---:|---:|
| tuning set (`registry-questions.json`) | 134 | **132 / 134 = 0.985** |
| hold-out set (`registry-questions-holdout.json`) | 51 | **49 / 51 = 0.961** |
| first run, before any tuning or ground-truth review | 134 | 117 / 134 = 0.873 |

### Per theme (tuning set, hit@5)

| theme | hit | theme | hit | theme | hit |
|---|---:|---|---:|---|---:|
| agriculture | 4/4 | geology | 3/3 | population | 5/5 |
| air-quality | 5/5 | hazards | 3/3 | precipitation | 5/5 |
| biodiversity | 3/3 | hydrology | 3/3 | sar | 7/7 |
| boundaries | 3/3 | infrastructure | 4/4 | snow-ice | 4/4 |
| buildings | 4/4 | land-cover | 6/6 | soil | 6/6 |
| climate | 6/6 | lidar | 6/6 | temperature | 4/4 |
| elevation | 8/8 | nightlights | 4/4 | urban | 3/3 |
| **embeddings** | **1/2 (0.50)** | ocean | 4/4 | vegetation | 5/5 |
| fire | 5/5 | optical | 7/7 | **water** | **4/5 (0.80)** |
| forest | 7/7 | | | weather | 3/3 |

Themes below 0.90 on the tuning set: **embeddings** (1 of 2) and **water** (4 of 5).
Each has one miss; with 2 and 5 questions per theme these fractions are very noisy.
On the hold-out set the themes below 0.90 are **climate** (2/3) and **snow-ice** (1/2).

### The misses

- **"lake water quality chlorophyll turbidity"** (water). Top five are Amazon,
  Louisiana and Peace-Athabasca in-situ datasets from ORNL DAAC that mention all
  the words. The Copernicus Land Monitoring lake water quality products (the
  intended answer) rank 10th and later. Genuine ranking weakness: nothing in the
  scorer prefers a global remote-sensing product over a regional field study.
- **"foundation model embeddings for land classification"** (embeddings). Satellite
  Embedding V1 ranks 8th: the question's other words ("land", "classification",
  "model") match WorldCover, Overture Base and several Earth Engine "model" assets
  better than the one word that matters.
- **Hold-out, "temperature anomalies relative to the 20th century".** Top hits are
  20th-century climatologies (CRU-style monthly means). The listed answer
  `gfw:berkeley_earth_temp_anomaly_2000_2020` is in the registry but not retrieved
  (its text says "temperature anomaly", the question's other words pull the
  climatologies). Genuine miss.
- **Hold-out, "Arctic sea ice extent daily".** Top five are the NSIDC "Near-Real-Time
  EASE-Grid Daily Global Ice Concentration" products (NISE), which are a correct
  answer; the ground truth, written before looking, did not list them. Counted as a
  miss on purpose: the hold-out ground truth was not edited after measurement. The
  fair reading is a hold-out of 50/51 against a corrected list.

### How much to trust these numbers

- The tuning set was used to develop the scorer. The first run (87.3%) was before
  any change. Between the first run and the final one: the fixture's ground truth
  was audited (loose substring globs removed; dead patterns pruned; datasets that
  genuinely answer a question and were found in the top results were added, for
  example PML evapotranspiration, IrrMapper, CHIRTS, SMERGE root-zone soil moisture,
  YCEO urban heat islands; the "glacier" and "coral" questions were corrected after
  checking what the registry holds); and the engine changed (idf-weighted coverage
  of the user's words, a fixed budget for synonym expansions, dropping expansion
  words common across the registry, radar band tokens, rules such as quantitative
  precipitation estimates, interferometry, GLIMS, bright-at-night). Treat 0.985 as
  an optimistic bound.
- The hold-out set (51 questions) was written after tuning and evaluated once; no
  scorer or ground-truth change followed. It was written by the same author who
  knew the snapshot, so it is not independent of the registry's contents. 0.961 is
  the better estimate of how well natural questions are answered, and the margin is
  wide (the 95% interval for 49/51 is roughly 0.87 to 0.99).
- Ground truth is judged by id/family, not by reading the data. A question can pass
  because a regional or in-situ dataset is acceptable, and the two ORNL-style misses
  above show the reverse. hit@5 says nothing about whether the best dataset is first.
- 29 themes, 2 to 8 questions each: per-theme figures are anecdotes, not rates.

### Latency and size

| quantity | value |
|---|---|
| snapshot on disk | 8.03 MB (`snapshot.json`), separate server-only chunk in `next build`, absent from the client bundle |
| snapshot parse + expand | about 0.16 s |
| index build (once, lazily, on first `find_dataset`) | about 0.8 s; first call in `next dev` measured 1.25 s end to end |
| query latency, warm, 185 questions (50 ms budget) | p50 0.5 ms, p95 about 1 ms, max about 3 ms |
| first query after load | index is warmed with two throwaway queries so it is not slower (an unwarmed first query measured about 31 ms) |

The 50 ms bound is asserted over every evaluation question in the test suite.

### Registry contents (from `docs/registry/SOURCES.md`)

| source | harvested | in snapshot |
|---|---:|---:|
| NASA CMR (cloud-hosted collections) | 9,520 | 9,464 |
| OpenTopography lidar/raster surveys | 4,736 | 4,324 |
| Google Earth Engine catalog | 894 | 871 |
| Copernicus Data Space STAC | 427 | 424 |
| Global Forest Watch data API | 239 | 239 |
| Copernicus openEO | 137 | 84 |
| Planetary Computer | 138 | 138 |
| EODC | 62 | 62 |
| LandsatLook | 14 | 13 |
| Element 84 Earth Search | 9 | 3 |
| curated (Overture, OSM, Open-Meteo, SoilGrids, WorldPop, FIRMS, GIBS, 3DEP, ARCO-ERA5, buildings, ...) | 33 | 31 |

"In snapshot" counts an entry once, under its highest-priority source; 144 entries
were folded into another entry's `alternates`. No source failed in the final run; a
forced network failure was exercised and the run kept the previous entries, reported
the failure and exited 0.

## Dataset readers — live

Measured 2026-10-11 with `REGISTRY_LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run src/app/api/agent/lib/registry/__tests__/readers-live.test.ts`.
Each row is a real `use_dataset({dataset_id})` call through the agent tool layer. Farmland AOI near Lahore
(74.05-74.08 E, 31.12-31.15 N, ~10 km²) and a Denver AOI (-104.995..-104.975, 39.735..39.75). A passing row means the number
was inside its physical range (DEM metres, SAR dB -30..+5, HAG >= 0, valid WorldCover classes) and one XYZ tile at the AOI centre
came back as a 200 PNG. Latency is the whole tool call, cold cache, from this sandbox through its egress proxy.

| dataset | outcome | key numbers | latency | tile at AOI centre |
|---|---|---|---:|---|
| Sentinel-1 RTC (VV dB) | ok | 2026-10-05: mean -8.752 dB, p95 -4.29, 90000 px, 99.5% of AOI | 4.9 s | 200 PNG |
| ALOS PALSAR mosaic (HH dB) | ok | 2021-01-01: mean -12.222 dB, 18225 px | 2.1 s | 200 PNG |
| NASADEM | ok | mean 197.312 m (189 to 205), 11664 px | 2.5 s | 200 PNG |
| Copernicus DEM GLO-30 | ok | mean 199.835 m (197.454 to 208.254), 11664 px | 2.5 s | 200 PNG |
| ALOS World 3D-30m | ok | mean 200.136 m (197 to 207), 11664 px | 2.4 s | 200 PNG |
| ESA WorldCover | ok | Cropland 80.2%, Tree cover 9.7%, Grassland 5.2% | 3.0 s | 200 PNG |
| JRC Global Surface Water (occurrence) | ok | mean 0.002%, max 7% | 2.1 s | 200 PNG |
| MODIS 13A1 (NDVI) | ok | 2026-09-06: mean 0.545, 100 px | 2.5 s | 200 PNG |
| io-lulc annual v02 | ok | 2023-01-01 Crops 97.4%, Built area 2.6%, Water 0% | 2.0 s | 200 PNG |
| SoilGrids 2.0 (rest) | ok | Clay: 20.6%  ·  Sand: 34.0%  ·  Silt: 45.4% | 6.0 s | n/a |
| Open-Meteo ERA5 (rest) | upstream rate-limited (429), reported honestly | Open-Meteo weather archive failed: open-meteo HTTP 429. The ERA5 service may be temporarily unavailable. | 2.0 s | n/a |
| Overture buildings | ok | 1125 buildings, footprints 0.92% of AOI, 0 with height | 3.6 s | geojson |
| NASA CMR ALOS-2 PALSAR-2 | auth_required | 100+ granule(s) | 1.1 s | n/a |
| Earth Engine GPWv4 population density | auth_required | credentials not configured (GEE_KEY_FILE) | 0.0 s | n/a |
| CIL-GDPCIR climate (Zarr) | unavailable | needs the Python geo service (Q-22) | 0.0 s | n/a |
| 3DEP HAG over Lahore (coverage refusal) | no_coverage | lists **no lidar point-cloud survey** | 1.3 s | n/a |
| 3DEP lidar height above ground (Denver) | ok | 2013-10-25: mean 6.57 m, p95 24.94 m, 110251 px; HAG raster rejected (reads 89.12 m), height from DSM-DTM | 7.3 s | inline PNG |
| 3DEP lidar height above ground (Washington DC) | ok | 2014-04-10: mean 7.95 m, p95 29.7 m, cross-check vs DSM-DTM consistent | 6.8 s | 200 PNG |
| 3DEP lidar DSM | ok | mean 1610.579 m (1577.119 to 2026.891) | 0.5 s | 200 PNG |
| 3DEP lidar DTM | ok | mean 1603.89 m (1576.155 to 1812.76) | 0.7 s | 200 PNG |
| 3DEP lidar point cloud (COPC) | metadata | 8 tiles, 2 project(s), 3.7 pts/m2, acquired 2008-04-19..2014-05-31 | 3.1 s | n/a |

## Flood mapping — live

`map_flood` (Sentinel-1 RTC from Planetary Computer, VV dB, Overture buildings and roads). Run on 2026-10-12 with
`FLOOD_LIVE=1 NODE_USE_ENV_PROXY=1 FLOOD_EXPORT=… npx vitest run flood-live` (`src/app/api/agent/tools/__tests__/flood-live.test.ts`).
Nothing below was assumed: the dates come from a scan of the data.

**AOI.** Ravi riverbed north-west of Lahore, bbox `[74.22, 31.56, 74.34, 31.66]` (126.4 km², river inside, no adjustment needed).
Window scanned: 2025-06-15 to 2025-10-15, 32 Sentinel-1 scenes on three relative orbits (34 and 107 descending, 100 ascending), 12.3 m grid.
The Ravi shows a clear event, so the Sutlej fallback at Kasur was not needed.

**Water fraction per scene** (threshold -15.0 dB, same for every scene):

| date | orbit | water % of AOI | role |
|---|---|---:|---|
| 2025-06-16 | ascending #100 | 3.46 |  |
| 2025-06-17 | descending #107 | 2.75 |  |
| 2025-06-24 | descending #34 | 3.86 |  |
| 2025-06-28 | ascending #100 | 3.01 |  |
| 2025-06-29 | descending #107 | 2.87 |  |
| 2025-07-06 | descending #34 | 3.30 |  |
| 2025-07-10 | ascending #100 | 4.37 |  |
| 2025-07-11 | descending #107 | 4.03 |  |
| 2025-07-18 | descending #34 | 3.70 |  |
| 2025-07-22 | ascending #100 | 2.86 |  |
| 2025-07-23 | descending #107 | 2.74 |  |
| 2025-07-30 | descending #34 | 2.91 |  |
| 2025-08-03 | ascending #100 | 3.76 |  |
| 2025-08-04 | descending #107 | 3.62 |  |
| 2025-08-05 | descending #34 | 3.85 |  |
| 2025-08-15 | ascending #100 | 3.52 |  |
| 2025-08-16 | descending #107 | 3.40 |  |
| 2025-08-23 | descending #34 | 3.06 | **before (dry)** |
| 2025-08-27 | ascending #100 | 5.56 |  |
| 2025-08-28 | descending #107 | 6.08 |  |
| 2025-09-04 | descending #34 | 6.43 | **after (peak)** |
| 2025-09-08 | ascending #100 | 3.44 |  |
| 2025-09-09 | descending #107 | 4.31 |  |
| 2025-09-16 | descending #34 | 3.66 |  |
| 2025-09-20 | ascending #100 | 2.81 |  |
| 2025-09-21 | descending #107 | 2.51 |  |
| 2025-09-28 | descending #34 | 3.05 |  |
| 2025-10-02 | ascending #100 | 2.89 |  |
| 2025-10-03 | descending #107 | 1.92 |  |
| 2025-10-10 | descending #34 | 2.84 |  |
| 2025-10-14 | ascending #100 | 2.40 |  |
| 2025-10-15 | descending #107 | 1.91 |  |

Baseline 1.9 to 4.4 %. The rise starts with the 2025-08-27 (5.56 %) and 2025-08-28 (6.08 %) passes and peaks on **2025-09-04 (6.43 %)**,
then falls back to 3.4 % by 2025-09-08 and 2.5 % by 2025-09-21. That matches the late-August to early-September 2025 Ravi flood.
Water fraction varies a little by orbit even on dry dates (for example 4.4 % on 2025-07-10/orbit 100), which is why before and after are taken from the same orbit.

**Pair chosen by the tool.** After = 2025-09-04, relative orbit 34 descending, `S1A_IW_GRDH_1SDV_20250904T010000_20250904T010025_060831_0792E0_rtc`, 6.43 % water.
Before = 2025-08-23, same orbit, `S1A_IW_GRDH_1SDV_20250823T010000_20250823T010025_060656_078BF5_rtc`, 3.06 % water: the latest of six earlier orbit-34 scenes in the lowest quarter of the water range.

**Threshold.** Otsu on the pooled AOI histogram split at -6.75 dB (separability 0.54); that is a land-versus-land split because water is only 2 to 6 % of the AOI,
so it was clamped to the −15 dB ceiling of the plausible water range (method `otsu-clamped`). About 4 % of pooled pixels are darker than −15 dB, a real dark population, so the fallback to −18 dB was not triggered.
Results are sensitive to this: new-flood area before the minimum-area filter is 4.25 km² at −15.0 dB, 3.52 km² at −16.5 dB and 2.29 km² at −18.0 dB.

**Result.**

| figure | value |
|---|---:|
| newly flooded area | 4.25 km² (3.38 % of the observed AOI) |
| flood polygons (min 1,000 m², holes kept) | 127 |
| permanent water (both dates) | 3.63 km² in 47 polygons |
| receded (water before, dry after) | 0.16 km² |
| buildings with centroid in the flood | 5 of 149,834 Overture buildings read (release 2026-09-23.1, not capped) |
| flooded road length | 0.43 km over 5 segments |

**Caveats observed.**
- The building count is small because this reach is mostly riverbed, sandbars and farmland; the dense city is outside the AOI. Where it overlaps built-up land, SAR double-bounce means flooded buildings are not detected, so it is a lower bound.
- The flood extent at −15 dB includes some scattered small patches away from the river that may be flooded paddy fields or smooth wet ground; there is no terrain (DEM/HAND) mask, so shadow cannot be ruled out.
- The extent is a snapshot on 2025-09-04, not the maximum extent. The 2025-08-27/28 passes are 7 to 8 days earlier and already show the river rising.
- No ground-truth flood map was used; this is a physical-plausibility check against the series and news timing, not a validation.

Full result (tile URLs, flood polygons, affected buildings, series) was exported for a demo to the session scratchpad `flood.json` (not committed).

## Clearest-scene picker — live (Q-60)

**Run:** 2026-10-12, `render_raster({bands:['B08'], start:'2026-09-01', end:'2026-09-30'})` via `executeTool`, Kasur AOI 74.05–74.08 E, 31.12–31.15 N (9.5 km²), Sentinel-2 L2A on AWS Earth Search + titiler.xyz.
Reproduce: `RASTER_LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run render-raster-live`. Recorded 16-px grids of all 12 items are the offline regression fixture (`lib/__tests__/__fixtures__/kasur-2026-09.json`).

**Root cause.** Not an SCL read failure and not thin cloud counted clear: SCL scored every candidate correctly. A date carries one item per MGRS tile, and the picker scored only the first six items.
Those were 09-28 (×2), 09-26 (×2) and 09-25 (×2): clouded (0 % clear, or 22–49 % clear) or tile 43RCQ clipping the AOI (13 % coverage, below the 60 % floor). All were rejected, the picker returned `null`, and `render_raster` fell back to the newest item, 09-28, unmasked.
The clear 09-23 scene was item 7 of 12 and was never scored.

| scene (tile) | AOI clear (SCL) | AOI coverage | B08 p2–p98 (SCL-clear px) | outcome |
|---|---:|---:|---|---|
| 2026-09-28 43RCQ | 0 % | 13 % | 0.80–0.86 | rejected (cloud) |
| 2026-09-28 43RDQ | 0 % | 100 % | 0.87–1.04 | rejected (cloud) |
| 2026-09-26 43RCQ / 43RDQ | 49 % / 38.6 % | 13 % / 100 % | 0.10–0.85 / 0.12–0.80 | rejected (coverage / under 40 % clear) |
| 2026-09-25 43RCQ / 43RDQ | 22 % / 32 % | 13 % / 100 % | 0.14–1.35 / 0.18–1.07 | rejected (under 40 % clear) |
| 2026-09-23 43RCQ | 100 % | 13 % | 0.24–0.40 | rejected (coverage) |
| **2026-09-23 43RDQ** | **100 %** | **100 %** | **0.20–0.46** | **chosen** |

**After the fix** the tool returns `S2C_43RDQ_20260923_0_L2A` (2026-09-23): 100 % of the AOI clear, 65,536 clear pixels, B08 min 0.044, p2 0.202, mean 0.329, p98 0.463, max 0.635 (reflectance, earth-search scale 1e-4, offset 0).
Fixes: the picker now scores in batches until a usable scene is found, and a reflectance plausibility gate refuses any scene whose AOI median blue, red or NIR reflectance over SCL-clear pixels exceeds 0.5 (recorded in the result's caveats and provenance; skipped for scenes more than half snow, and not applied to Landsat).

**Caveats.** The gate did not fire in this live run (SCL already rejected the cloudy scenes); it is covered by a test that pairs the real 09-28 band grids with a deliberately wrong all-vegetation SCL grid. The 0.5 threshold is a heuristic: bright desert or salt pans can exceed it in the visible bands.

## Cloud-masked median composite vs the single clearest scene — live (Q-18)
**Run:** 2026-10-12, Kasur AOI 74.05–74.08 E, 31.12–31.15 N (9.5 km²), September 2026, NDVI, Sentinel-2 L2A (Earth Search). Both through the real `/api/agent` stub-run path against the production build with `GEO_SERVICE_URL` set (geo service `services/geo`, 4 vCPU, behind the egress proxy). One AOI, one month: an illustration, not an accuracy claim.
`composite({expression:"NDVI", start:"2026-09-01", end:"2026-09-30"})` vs `render_raster({expression:"(B08-B04)/(B08+B04)", start:"2026-09-01", end:"2026-09-30"})` (clearest scene in the same window: `S2C_43RDQ_20260923_0_L2A`, 3.4 % scene cloud, 100 % clear over the AOI).

| | composite (median) | single scene 2026-09-23 |
|---|---:|---:|
| built from | 32 items, 14 scene-days, 8–11 clear obs/pixel (mean 10.6) | 1 scene |
| valid pixels | 100 % | 100 % |
| grid | 10 m UTM, 336 × 290 px | 256 px longest edge (~13 m) |
| NDVI p2 | 0.112 | 0.080 |
| NDVI mean | 0.550 | 0.575 |
| NDVI p98 | 0.843 | 0.910 |
| NDVI min / max | -0.059 / 0.899 | -0.208 / 0.995 |

`fetch_ndvi` / `compute_spectral_index` (no date argument, so the newest scene, 2026-10-08, 28.6 % scene cloud, 90.6 % of the AOI clear) gave mean 0.359, p2 0.113, p98 0.603 for the same AOI: a different date, not comparable, but it shows how far one acquisition can sit from another over cropland.
Timing: cold composite 12.1 s end to end (the service reads 14 days of scenes); the same request again was served from the content-addressed cache; a z14 tile through the Next proxy was 200 `image/png` (RGBA, 256 px).

**Interpretation.** The median is narrower than the single scene (p2 higher by 0.03, p98 lower by 0.07, extremes pulled in from -0.21/0.995 to -0.06/0.90) and its mean is 0.025 lower. That is what a median over ~10 clear days should do: it averages out single-date extremes (a freshly irrigated field, a residual haze edge, a harvested one) and describes the month, whereas the single scene describes 23 September, which in Kharif cropland is near peak greenness. The 0.025 mean difference is small next to the 0.2 spread between the two Earth Search dates above, so both are plausible for the same ground; this one AOI cannot say which is "more accurate", only that they answer different questions (month typical vs one day). The resolutions also differ slightly (10 m vs ~13 m grid), which affects tails more than the mean.
**Caveats.** n = 1 AOI and 1 month with abundant clear scenes: it does not test the case that motivates composites (a month where no single scene is clear). Not validated against ground truth. The composite carries no single acquisition date by design.
**Found along the way:** the geo service's tile endpoint returned grey tiles when `colormap_name` was given (`ImageData.apply_colormap` returns a new object in rio-tiler 9; the result was discarded). Fixed, with a pytest asserting RGBA.

## TimesFM forecasting (backtest)

**Question:** does Google TimesFM 2.5 forecast monthly Sentinel-2 NDVI better than two trivial baselines, well enough to ship `forecast_index` / `detect_anomaly` on it? **Answer: no.** At the 3-month lead it beat the best baseline (monthly climatology) on 2 of 6 AOIs and lost on pooled MAE (0.0523 vs 0.0508), so by the decision rule fixed beforehand **only the anomaly endpoint ships, with climatology as the expected value**; TimesFM stays behind `GEO_TIMESFM=1` (service) and `GEO_TIMESFM_FORECAST=1` (app) with the label "not better than climatology on our backtest".

- **Model:** `google/timesfm-2.5-200m-pytorch`, revision `1d952420fba87f3c6dee4f240de0f1a0fbc790e3`, Apache-2.0 (code and weights), `timesfm` 3.0.2 (code release; it loads the 2.5 weights named above), torch 2.9.1 CPU. TimesFM 3.0 weights are non-commercial and are not used. Settings: `max_context=512`, continuous quantile head, flip invariance, quantile-crossing fix, p10/p50/p90 = quantile columns 1/5/9.
- **Data:** monthly NDVI, the spatial median over a ~9-10 km² AOI of the cloud-masked (SCL) monthly median composite, Sentinel-2 L2A via Earth Search, 20 m, 2017-01 to 2025-12 (`services/geo/eval/fetch_series.py`, series committed in `services/geo/eval/series/`). A month counts as observed only with at least 30% of the AOI clear. 6 AOIs: the five `scripts/perf/baseline.mts` AOIs plus a maritime-pine forest (Landes, FR). Fetched 9 years of scenes per AOI: 912-3,450 scenes each; usable months of 108: Kasur 108, Lahore 108, Kitale 108, Iowa 106, Beauce 103, Landes 98.
- **Protocol (rolling origin):** for every target month 2023-01..2025-12 whose month has a clear observation, the history ends `lead` months earlier (same refusal rules as the service: gaps of at most 2 months linearly interpolated, at least 36 months, at most 25% missing), each method forecasts the target, and the forecast is scored against the observed value. 212 forecasts per lead (35/36/36/36/36/33 per AOI); no origin was refused. Seasonal-naive = value of the same month a year earlier; climatology = mean of the same calendar month in all earlier years of the history, interval = mean ± t(0.90, n-1)·sd·sqrt(1+1/n). Reproduce: `cd services/geo && uv run python eval/backtest.py` (about 4 min on 4 CPUs; raw per-forecast rows in `eval/backtest_results.json`).

### 3-month-ahead (the decision lead); bold = TimesFM best on MAE

| AOI | n | MAE TimesFM | MAE climatology | MAE seasonal-naive | RMSE TimesFM | RMSE clim. | RMSE naive | TimesFM p10-p90 cover | clim. p10-p90 cover | pinball TimesFM | pinball clim. |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Beauce, FR | 35 | 0.0657 | 0.0627 | 0.0993 | 0.0919 | 0.0876 | 0.1227 | 83% | 74% | 0.0222 | 0.0223 |
| Story Co., Iowa, US | 36 | 0.0472 | 0.0442 | 0.0554 | 0.0643 | 0.0635 | 0.0860 | 89% | 81% | 0.0159 | 0.0154 |
| Kasur, PK | 36 | 0.0554 | 0.0500 | 0.0721 | 0.0738 | 0.0681 | 0.1086 | 89% | 78% | 0.0180 | 0.0157 |
| Kitale, KE | 36 | **0.0402** | 0.0443 | 0.0559 | 0.0509 | 0.0549 | 0.0712 | 86% | 94% | 0.0137 | 0.0138 |
| Lahore edge, PK | 36 | 0.0330 | 0.0286 | 0.0446 | 0.0435 | 0.0397 | 0.0586 | 92% | 83% | 0.0107 | 0.0105 |
| Landes forest, FR | 33 | **0.0745** | 0.0773 | 0.0826 | 0.0945 | 0.1013 | 0.1296 | 67% | 88% | 0.0231 | 0.0249 |
| **all 6 AOIs (pooled)** | 212 | 0.0523 | 0.0508 | 0.0680 | 0.0719 | 0.0715 | 0.0990 | 84% | 83% | 0.0172 | 0.0170 |

### 1-month-ahead (the lead `/anomaly` actually uses)

| AOI | n | MAE TimesFM | MAE climatology | MAE seasonal-naive | RMSE TimesFM | RMSE clim. | RMSE naive | TimesFM p10-p90 cover | clim. p10-p90 cover | pinball TimesFM | pinball clim. |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Beauce, FR | 35 | 0.0706 | 0.0627 | 0.0993 | 0.0862 | 0.0876 | 0.1227 | 71% | 74% | 0.0208 | 0.0223 |
| Story Co., Iowa, US | 36 | **0.0436** | 0.0442 | 0.0554 | 0.0622 | 0.0635 | 0.0860 | 86% | 81% | 0.0154 | 0.0154 |
| Kasur, PK | 36 | 0.0555 | 0.0500 | 0.0721 | 0.0720 | 0.0681 | 0.1086 | 86% | 78% | 0.0181 | 0.0157 |
| Kitale, KE | 36 | **0.0349** | 0.0443 | 0.0559 | 0.0462 | 0.0549 | 0.0712 | 83% | 94% | 0.0117 | 0.0138 |
| Lahore edge, PK | 36 | 0.0323 | 0.0286 | 0.0446 | 0.0414 | 0.0397 | 0.0586 | 89% | 83% | 0.0102 | 0.0105 |
| Landes forest, FR | 33 | **0.0557** | 0.0773 | 0.0826 | 0.0817 | 0.1013 | 0.1296 | 91% | 88% | 0.0183 | 0.0249 |
| **all 6 AOIs (pooled)** | 212 | **0.0486** | 0.0508 | 0.0680 | 0.0668 | 0.0715 | 0.0990 | 84% | 83% | 0.0157 | 0.0170 |

### Interpretation

- **Decision rule:** TimesFM MAE better than the best simple baseline on a majority of AOIs, else ship the best baseline. 3-month lead: TimesFM wins 2/6 (Kitale, Landes), loses 4/6; the best baseline overall is climatology (pooled MAE 0.0508 vs seasonal-naive 0.0680). Not a majority, so climatology ships. At 1-month lead TimesFM is better pooled (0.0486 vs 0.0508) and wins 3/6 (Iowa by 0.0006, Kitale, Landes) but the decision is made at the pre-declared 3-month lead; the 1-month gain is 4% in MAE, which is inside what 6 AOIs x 3 years can resolve.
- **Where TimesFM helps:** Kitale and Landes (equatorial / forest). **Where it does not:** Kasur, Lahore and Beauce. A plausible reading, not tested here, is that the strongly periodic croplands are already well described by the same-month mean while Kitale and Landes have weaker or irregular seasonality; six AOIs cannot confirm it. Seasonal-naive is clearly the worst: one year ago is a noisy single sample.
- **Calibration of the shipped method (climatology):** the p10-p90 range contained the observed value in **83.0%** of the 212 forecasts (target 80%); per AOI 74% (Beauce) to 94% (Kitale). TimesFM's range covered 84.4% pooled (67% at Landes, 3-month lead). The coverage is measured on the same 3 years for all AOIs, and the AOIs are not independent samples of "the world": treat 83% as "about right for temperate and subtropical cropland and forest", not as a guarantee for desert, snow or irrigated-paddy AOIs, none of which were tested.
- **Caveats:** one index (NDVI), one sensor, 20 m, 9-10 km² AOIs, 3 test years (2023-2025) that include no extreme drought or flood year for most AOIs; climatology is evaluated with the same long history that TimesFM sees; no hyperparameter tuning of either method (so TimesFM is also not given the best possible chance, e.g. no fine-tuning or covariates); months with under 30% clear AOI cover are never scored, so the numbers describe only forecasts that could be checked. The 2017-2018 Earth Search scenes that exist only as requester-pays JP2 are skipped (1-24 per AOI, counted in the series files).
- **Timings (CPU, 4 cores):** model load 3.3 s from the local cache (17.5 s on the first run including the 800 MB download); inference 0.36-2.1 s per series (about 0.4 s in the backtest loop, 1.9-2.1 s inside the service with other work running); fetching the 5-year Kasur series cold took 407 s (while a build ran in parallel) and about 55 s warm (20 quarterly STAC searches; the masked quarter results are cached by item-id set).
- **Live check:** Kasur 2026-09 anomaly: observed NDVI 0.587, expected 0.586 (p10 0.535, p90 0.636), score +0.02, `within_expected`. TimesFM forecast Kasur 2026-10..2027-03 (flag on): p50 0.47, 0.31, 0.37, 0.55, 0.70, 0.68 with 80% ranges about ±0.1 wide.
## Claim verification: `not_cleared_since@1.0.0` against Hansen tree-cover loss — live (Q-25)

Measured 2026-10-13. **N = 250 plots, all of them run** (230 held-out test plots + 20 development plots),
about 5 minutes of wall time at concurrency 5 (median 7 s per plot, max 15 s; upstream fetch caches
warmed by the first plots). Raw rows: `eval/claims/results-2026-10-13.csv`; the per-plot figures the
decisions rested on: `eval/claims/records-not_cleared_since@1.0.0.jsonl`.

**Claim tested.** "This plot has not been cleared since 2020-07-31", checked up to 2024-07-31.
**Ground truth, independent of the recipe.** Hansen Global Forest Change GFC-2024-v1.12 (`lossyear`,
`treecover2000`), read through titiler from the public Google Cloud bucket. The recipe never reads
Hansen. A plot is 300 m x 300 m (10 x 10 Hansen pixels, about 9 ha):

- **loss** (claim false, expected Contradicted): at least 60% of the pixels lost tree cover in
  2021-2023, none in any other year, mean 2000 canopy at least 50%;
- **stable** (claim true, expected Supported): no loss pixel in any year 2001-2024 and canopy at
  least 40% everywhere, at least 70% on average.

25 loss + 25 stable plots in each of 5 biomes (seeded sample, `eval/claims/generate.ts`, seed 7):
Amazon (Para and Mato Grosso), Borneo (Kalimantan), Congo basin (DRC), Pacific Northwest (USA,
managed temperate conifer), miombo woodland (Zambia and Angola). The list is interleaved so any
prefix is balanced. The first 20 plots are the development split: the recipe's thresholds were
written down before any plot was run and **were not changed after seeing any result**, development or
test; the split exists so the number can be trusted as held out.

**Recipe.** Sentinel-2 L2A NDVI from `analyze_raster` (always-available operations): plot median at the
claim date, and the per-pixel change between the claim date and its same-season anniversary, masked on
both dates. Contradicted when at least 25% of the clear pixels lost more than 0.2 NDVI and the median
change is at most -0.1; Supported when at most 5% did and the median change is above -0.1; Cannot
determine for a plot under 0.5 ha, a baseline NDVI under 0.4, under 60% of the plot clear in the
baseline or 50% clear on both dates, scenes more than 45 days apart in the year, no usable scene, or a
mixed signal.

| Slice | N | Answered | Coverage | Abstained | Accuracy on answered (95% CI) | Loss called Contradicted | Stable called Supported | ECE |
|---|---|---|---|---|---|---|---|---|
| All plots | 250 | 182 | 73% | 27% | 80.8% (74% to 86%) | 87% | 75% | 0.098 |
| **Test split (held out)** | 230 | 168 | 73% | 27% | **81.0% (74% to 86%)** | 88% | 74% | **0.094** |
| Dev split | 20 | 14 | 70% | 30% | 78.6% (52% to 92%) | 71% | 86% | 0.140 |
| Test, amazon | 46 | 41 | 89% | 11% | 82.9% (69% to 91%) | 95% | 70% | 0.085 |
| Test, borneo | 46 | 23 | 50% | 50% | 78.3% (58% to 90%) | 60% | 92% | 0.175 |
| Test, congo | 46 | 30 | 65% | 35% | 63.3% (46% to 78%) | 64% | 63% | 0.268 |
| Test, miombo | 46 | 31 | 67% | 33% | 71.0% (53% to 84%) | 100% | 44% | 0.166 |
| Test, pacific northwest | 46 | 43 | 93% | 7% | 100.0% (92% to 100%) | 100% | 100% | 0.063 |

Abstention kinds over all 250: inconclusive 27, data_unavailable 21 (no clear baseline or pair),
out_of_scope 19 (baseline NDVI under 0.4), insufficient_quality 1. No plot ended in a runtime error.
ECE is over answered plots, 5 equal-width confidence bins; per-biome ECE rests on 23 to 43 answered
plots, so treat it as indicative.

**How to read it.**

- It works well where a clearing is a sharp, lasting NDVI drop and the scenes are clear (Pacific
  Northwest clear-cuts: 43 of 43 answered correct). It is weakest in the Congo basin and in miombo.
- **Miombo stable plots** are called Contradicted in 10 cases: seasonally dry woodland whose NDVI changes
  between two late-August scenes for reasons other than clearing (leaf and fire phenology). Hansen
  counts none of that as loss. Two dates cannot tell it from clearing.
- **Loss plots called Supported** (Congo 6, Borneo 4, Amazon 2): the canopy loss Hansen records is not a
  lasting 10 m NDVI drop on the second date. Fast regrowth of secondary vegetation within one to three
  years, partial canopy loss, and a 30 m label against a 10 m measurement all produce this. A
  two-date comparison cannot see clear-then-regrow.
- Overall 35 of the 182 answered plots (19%) are wrong; the Pacific Northwest figure is the best case, not the typical one.
- **The confidence score is a heuristic and is mildly over-confident** (ECE 0.094 overall, up to 0.27 in
  the Congo basin). It must not be shown as a probability; the case view says so.
- Sentinel-1 was not used (a plot under persistent cloud gets Cannot determine, not a radar answer), and
  the composite variant needs `GEO_SERVICE_URL`, so it was not built or measured here.
- Label caveat: Hansen "loss" is stand-replacing tree-cover loss from any cause (clearing, harvest,
  fire), 30 m, annual. A plot labelled stable can still have been thinned or burned understory.

CI replays a cached 20-plot subset (`eval/claims/fixtures/subset20.json`: live Sentinel-2 figures
recorded 2026-10-13, 2 loss + 2 stable in each of 5 biomes) through the recipe's decision rule with no
network (`engine/claims/__tests__/eval-subset.test.ts`): a change to the recipe or the evaluator that
alters any verdict fails there. Reproduce the full run with
`npx tsx eval/claims/generate.ts` (labels, needs `NODE_USE_ENV_PROXY=1` in the sandbox), then
`npx vite-node -c vitest.config.ts eval/claims/run.mts -- --split all` and
`npx vite-node -c vitest.config.ts eval/claims/report.mts --`. Scenes are re-read live, so a later run
can differ where new scenes appeared.

## Flood claim `flooded_on@1.0.0` — live smoke test, not an accuracy evaluation

2026-10-13, Sutlej AOI 74.40-74.56 E, 30.95-31.08 N, claim date 2025-09-04, tolerance 7 days, reference
30 days earlier. `map_flood` over the AOI found 18.0 km2 newly flooded (10% of 180.9 km2 observed; Sentinel-1A
pass 2025-09-04, reference 2025-08-05, same relative orbit 34). A 6.1 ha plot placed fully inside the
largest flood polygon: **Supported, confidence 0.90** (92.4% of the plot newly under water, pass 0 days from
the claim date, 99.5% observed). A 5.6 ha plot placed on land away from the flood: **Contradicted,
confidence 0.70** (the recipe's cap: radar can miss flooding under vegetation or among buildings). These
are two cases chosen with knowledge of the answer; they show the recipe runs end to end, not how often it
is right. There is no labelled flood set yet.

### Same AOI, live `map_flood` run (2026-10-16): the figure to quote

Result `r_36e6ecc2acef03c8`, one `map_flood` job through the live deployment's job API (`POST /api/jobs`, no
LLM), AOI 74.40-74.56 E, 30.95-31.08 N (220.4 km2), `before` 2025-08-05, `after` 2025-09-04. Pair chosen:
Sentinel-1A 2025-07-30 and 2025-09-04, both relative orbit 34 descending, VV, read at 16.5 m; 219.4 km2
observed (99.5% valid pixels).

| threshold | newly flooded |
|---|---:|
| −15.0 dB (used: Otsu −11.75 dB, clamped) | 34.5 km2 (15.7% of observed) |
| −16.5 dB | 28.8 km2 |
| −18.0 dB | 18.1 km2 |

At −15.0 dB: 238 Overture buildings (release 2026-09-23.1, 32,655 scanned) and 19.0 km of road in 60 segments
are in the flood polygons; 3.6 km2 was water on both dates. Radar misses flooding under vegetation and among
buildings, so each figure is a lower bound for its threshold. **Quote the range, 18.1-34.5 km2.** The 13 Oct
figure above (18.0 km2) observed only 180.9 km2 of the same AOI and does not record its threshold or scene
pair, so the two are not directly comparable.

## Live agent run: time budget, thinking level, grounding (2026-10-14)

`scripts/gemini-smoke.mts`, real Gemini API and real satellite reads, no mocks, one sample per cell
(timings vary run to run; this is not a benchmark).

Before (first live run): Q1 (flood, 2024 monsoon) ran more than 10 minutes with no end, tool progress
lines appeared in the answer text, and the analysis said July was cloud-blocked when the scene used
was 98.8% clear. Planning and analysis took about 10-15 s each at `medium` thinking.

After, `gemini-3.8-flash`, default settings (240 s budget, thinking `low` for both phases):

| Q | kind | total | plan LLM | synthesis LLM | outcome |
|---|---|---:|---:|---:|---|
| 1 | flood | 169 s | 6.9 s | 11.6 s | `map_flood` 150 s (21 radar scenes, about 6 s each, plus Overture); 0.13 km² newly flooded, 6 buildings; 1 sentence listed as unverified |
| 2 | NDVI | 28 s | 11.6 s | 9.4 s | mean NDVI 0.369, names the scene and date used |
| 3 | claim | 42 s | 10.0 s | 9.5 s | answered; the plan analysed 2020-2023 NDVI, but also ran `detect_deforestation` on a 2025-2026 window, which does not test the claim (planner quality, not fixed here) |
| 4 | refusal | 12.7 s | 7.9 s | 4.9 s | validator refused band B99; the model explained and listed valid bands |
| 5 | cannot-determine | 63.8 s | 11.1 s | 7.7 s | states yield cannot be determined from Earth observation |

Thinking level (Q2 and Q4, `gemini-3.8-flash`, both phases set the same, run in parallel):

| level | Q2 total | Q2 plan / synthesis | Q4 total | Q4 plan / synthesis |
|---|---:|---:|---:|---:|
| `low` | 36.2 s | 11.9 s / 10.2 s | 11.7 s | 7.3 s / 4.4 s |
| `medium` | 43.4 s | 14.0 s / 16.6 s | 15.1 s | 8.3 s / 6.8 s |

Same plans and same tool figures at both levels; `low` was 15-40% faster and the answers were of the
same kind. Hence `low` is the default for both phases. Two cells per level cannot show a quality
difference; the planner eval (`eval/PLANNER.md`) found none either (41/43 against 40/43).

`gemma-4-31b-it`, Q2 and Q4: Q2 59.8 s (plan 38.2 s, synthesis 14.3 s), three tool calls, correct
figures cited, no unverified sentences; Q4 9.3 s, declined correctly. The repetition loop seen
earlier with default sampling did not recur with the recommended sampling.

Flood mapping cost: reading a season window dominates (about 6 s per Sentinel-1 scene). The budget of
240 s with 40 s held back for the analysis fits this question with about 40 s to spare before the tool deadline; a longer
window will be cut at the tool deadline and answered as a partial result stating the skipped steps.

## Operation layer fixes, local run (2026-10-16)

`node eval/ops/run.mjs --base http://127.0.0.1:3100 --only ...` on a local standalone build, own database
schema, no LLM. Before = `eval/OPS.md` (deployed app, 2026-10-15).

| op | before | after |
|---|---|---|
| fetch_thermal (Phoenix, 2024-06-01 to 2024-08-31) | FAIL: one flat colour (239,248,33) | PASS: p2-p98 stretch in degrees C, clipped PNG informative; UI screenshot shows a per-pixel plasma layer |
| fetch_sar (Sutlej) | PARTIAL: one flat polygon | PASS: VV and VH dB raster layers, p2-p98 legend, tiles 200 and informative |
| fetch_ndvi imagery (Kasur) | PARTIAL: scene-wide preview.jpg, 190x the AOI | PASS: AOI-clipped true-colour tile layer, bounds 1.0x |
| classify_land_cover (Nile delta) | FAIL: "Urban 57%" from NDVI + OSM | PASS: ESA WorldCover 2021, Cropland 84%, Built-up 10%; categorical legend, tiles informative |
| classify_vegetation, detect_change, detect_deforestation | PARTIAL: no legend | PASS: legend present |
| fetch_temporal_stack | PARTIAL: charts[] empty | PASS: Vega-Lite series in charts[] |
| make_chart, style_layer | FAIL: ok, did nothing | PASS: run on the result picked by `result_id`; refused with a reason without one |

## Defects from the live evaluation of the deployed app (2026-10-15 to 2026-10-16)

Before = `eval/LIVE.md` (deployed revision 00004, 1 GiB web service). After = this branch, measured locally against the
real services (no LLM unless stated). Scripts: `scripts/perf/flood-memory.mts`, `scripts/perf/dem-live.mts`,
`scripts/perf/weather-live.mts`, `eval/live/replay-grounding.mts`, `scripts/perf/shortlist-recall.mts`,
`scripts/perf/prompt-tokens.mts`.

**map_flood memory.** Root cause: the Overture parquet read decoded every matching row group at once (nested geometry
arrays), 1.5 GB of heap for 24 000 road segments in a 9 km box over Valencia; plus one Float32 grid per scene in a
window scan and a cache bounded by entry count only. Peak `process.memoryUsage().heapUsed`, same AOIs and plan
arguments as the evaluation:

| case | AOI | before | after |
|---|---|---|---|
| fl03 (explicit dates, Valencia) | 64 km2 | 1575 MB (crashes a 1 GiB container) | 215 MB |
| fl02 (explicit dates, Dadu) | 144 km2 | crashed in the deployed run | 305-380 MB |
| fl05 (window scan, 10 scenes, Sylhet) | 100 km2 | crashed in the deployed run | 295-352 MB |
| fl02 and fl05 at once in one process (two job workers) | 244 km2 | n/a | 305 MB |

The Overture buildings read exceeds its 40 s limit from the development machine, so the building count is reported as
unavailable there; this is network time, not memory.

**Grounding check** (`eval/live/replay-grounding.mts`, 39 recorded answers). Flagged sentences: 104 (the UI showed 69) to
17. The replay rebuilds evidence from the record, which keeps only 120 characters of each tool summary, so the
17 left are figures that live in the full tool text (slope-class definitions, SCL shares) or are genuinely uncited (a
trivia answer from memory); the live check also sees the full summaries, provenance and facts lines, so it flags no more
than the replay does. No flagged figure in the evaluation was a fabricated measurement.

**Maximum elevation** (Copernicus DEM GLO-30 raster, every pixel in the box, tiles merged across the 1-degree edge):

| box | before (100 point samples) | after (raster) | surveyed summit |
|---|---|---|---|
| Matterhorn 6 km | 4105 m | 4329 m | 4478 m |
| Everest 8 km | 8599 m | 8738 m | 8849 m |
| Alps 144 km2 across 46 N | 3991 m | 4321 m | ALOS read 4348 m |

A 30 m cell averages a narrow summit, so the highest pixel stays 110-150 m under the surveyed height; the tool says so.

**Weather** (live Open-Meteo ERA5, `scripts/perf/weather-live.mts`): wx01 Dhaka July 2024 204.3 mm, wettest day 28.8 mm on
2024-07-01, 29 rain days; wx02 Niamey June-September 2023 315.9 mm; wx03 Phoenix July 2023 hottest day 46.8 C on 2023-07-20,
25 of 31 days above 43 C; wx04 Nairobi 2023 682.6 mm. Before: all four answered "cannot be determined". The CHIRPS layer was
always missing because `chirps-monthly` does not exist in the Planetary Computer catalogue; it now comes from
data.chc.ucsb.edu.

**Prompt size** (Gemini tokenizer, system prompt + tool declarations + question, per model turn): flood question
15 950 to 6 277 tokens, NDVI question 15 932 to 5 874, dated weather question 15 940 to 4 689 (61-71% fewer).
Shortlist recall on the planner cases' `must_use`: 28 of 28, 6.5 of 31 operations offered on average. The synonym list was
tuned on those same cases, so this recall is not a holdout. Real billed tokens (prompt, output, thinking, cached) are now
logged per call and returned on the `done` event.

One live run through the route on the owner's CPU-only Ollama (gemma4:26b-a4b-it-qat, `GEOAGENT_LLM_TIMEOUT_MS=900000`), question "Show me NDVI for this area.": 6 of 31 operations offered, 5 990 prompt tokens (Ollama's own count) and 105 output tokens, 48 s; the model answered in text without submitting a plan (a model-quality observation, not a token one). Gemini could not be measured: the account's prepaid credits are depleted (HTTP 402), so billed Gemini usage, thinking tokens and cache hits are unmeasured; the counts above are tokenizer counts of the request.
