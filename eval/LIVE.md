# Live evaluation of the deployed Erdfeld AI (2026-10-15)

- **Date:** 2026-10-15
- **URL:** https://erdfeld-web-707586221016.us-central1.run.app (Cloud Run `erdfeld-web`, revision `erdfeld-web-00004-zcf`, 1 vCPU / 1 GiB, max 2 instances)
- **Model:** `aiProvider: "default"`. The server's default Gemini model is `gemini-3.8-flash` in the code (`src/app/api/agent/lib/models.ts:13`, fallbacks 3.5 and 2.5 flash). The API does not report which model answered, so the exact model per run is not recorded.
- **Code deployed:** the signed bundle records code `d725e4f` (the HEAD commit when I started).
- **Method:** `eval/live/run.mjs` (plain Node) posts 46 cases sequentially, one start every 35 s, with a fixed `x-owner-token: live-eval-<case>`, and parses the SSE stream. `eval/live/ui-checks.mjs` drives 4 Playwright checks. Raw results: `eval/live/results-2026-10-15.jsonl` (first pass), `results-2026-10-15-retry.jsonl` (retry of the 4 crashed cases), `ui-results-2026-10-15.json`. Screenshots: `C:\Users\Abdul\erdfeld-shots\live-eval\`. No secrets are stored.
- **Readiness:** `/api/health` returned `ok` at 09:54:51Z after being `degraded` (geo and overpass down) for the first 2 minutes. The latest ready revision was `00003-rf7` at the start and had been stable for more than 2 minutes when I began; revision `00004-zcf` (created 09:59Z) became latest during the run. All cases ran against it. `/api/health` reports `degraded` intermittently (Overpass), and the UI header shows DEGRADED when it does.

## Summary

50 cases (46 API + 4 UI). Graded with the brief's rubric applied literally (a false "Unverified statements" block downgrades a pass to partial):

| | pass | partial | FAIL |
|---|---|---|---|
| **Strict rubric** | **12** | **32** | **6** |
| Task outcome only (ignoring the false Unverified flags) | 30 | 14 | 6 |

The two columns differ by 18 cases, and all 18 are false-positive "Unverified statements" blocks. Read "30 / 14 / 6" as how the app did at the task and "12 / 32 / 6" as how it does against the stated bar.

What I would tell a user:

1. **The service crashes on flood mapping.** 3 of 6 flood cases (`fl02`, `fl03`, `fl05`) killed the Cloud Run container with a JavaScript heap out-of-memory error, reproduced on retry. Crashes also hit an investigation (`inv01`, first attempt). The client sees HTTP 200, a plan, a "running" tool call, then the stream just stops, with no `error` and no `done`. 7 container crashes in total over about 40 minutes.
2. **The "Unverified statements" check is wrong most of the time.** 35 of 39 agent answers carried the block (69 flagged lines). 16 lines are percentile labels ("2nd", "98th" read as figures); roughly another 20 are thresholds, dates, coordinates, windows or arithmetic on cited values. The check does catch real uncited figures, but it is drowned out. A user learns to ignore it.
3. **Two terrain answers are wrong and stated as fact.** Matterhorn box: max elevation 4105 m (true summit 4478 m). Everest box: highest elevation 8599 m (true 8849 m). Cause: the stats come from a coarse point grid, not the 30 m raster.
4. **0 of 4 weather questions were answered.** The weather tools cannot take a date range, so any question about the past (July 2023, July 2024, 2023 season) returns "cannot be determined". The agent is honest about it, but ERA5 history is what the product advertises.
5. What works well: vegetation/index, built-environment, terrain (other than the max), data discovery and deforestation-claim cases all completed with plausible numbers and resolved citations (609 citation markers across the runs; 607 resolved to a real `result_id` and key, 2 did not: `veg02` and `fire03`, one each); honesty cases refused or abstained correctly (4 of 5 clean; the fifth answered a World Cup trivia question); the signed bundle verifies offline and fails when tampered.

## Latency (first-pass run, completed cases)

| Metric | Median | p90 | Max |
|---|---|---|---|
| Total time (42 completed of 46) | 27.7 s | 56.8 s | 99.9 s |
| Time to plan (cases with a plan) | 9.4 s | 15.8 s | |
| Time to first SSE event (all 46) | 0.49 s | 3.8 s | |

The slowest completed runs were `fl01` (100 s, Sentinel-1 scan), `bld02`/`bld03`/`bld04` (54 to 62 s, Overpass) and the investigations (59 to 88 s). Investigations have no `plan` event, so they are in the first and third rows only. The 4 crashed runs are excluded from the total-time row; they ended at 28 to 55 s with no `done`.

## Failures, with evidence and probable cause

### F1. Out-of-memory crash of the web container on map_flood and on long investigations (fl02, fl03, fl05, inv01)

- **Request:** `POST /api/agent`, `aiProvider: default`, e.g. `fl03`: Valencia, 64 km2, "Map the flood from the DANA storm of 29 October 2024 here. Compare before 15 October 2024 and after 3 November 2024." Plan: `map_flood {before: 2024-10-15, after: 2024-11-03}`.
- **Response:** HTTP 200; events `zoom_to, manifest, plan, tool_call (running), thinking x3`; then the connection closes after 28 to 55 s. No `tool_call` completion, no `error`, no `done`, empty answer. Same for `fl02` (144 km2, Dadu), `fl05` (100 km2, Sylhet). `fl01` (100 km2) and `fl04` (36 km2) completed.
- **Cloud Run logs** (`erdfeld-web-00004-zcf`), for each crash time (10:04:44, 10:05:27, 10:06:57, 10:26:40, and the retries at 10:31:21, 10:31:55, 10:33:07):
  `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory` ... `Uncaught signal: 6` ... `Container terminated on signal 6.`
  Heap at death: about 510 MB, in a 1 GiB container. The 10:05:27 and 10:31:55 crashes were on instances only 39 s old, so one request is enough. The 10:26:40 crash was on an instance 1180 s old serving the investigation, which suggests retained memory across requests as well (not proven).
- **Impact:** an in-flight request takes down every other request on the instance, and a user sees a silent truncation. An unauthenticated caller can do this with one request. The same request is reproducible, so this is also a cheap denial of service.
- **Probable cause:** `map_flood` holds one `Float32Array` per Sentinel-1 scene (`src/app/api/agent/tools/flood.ts:93`, up to `MAX_SCENES = 60` at line 54, grid up to `MAX_GRID = 1000` at line 51, so up to about 240 MB of scenes before the building and road reads, which are capped at 250 000 and 150 000 rows, lines 62-63). The operation advertises `maxAreaKm2: 1600` and "up to about 40 km across" (`src/app/api/agent/engine/ops/digitize.ts:96`), but the deployed web service is the free profile `--cpu 1 --memory 1Gi` (`deploy/cloudrun/common.sh:93`) with Node's default heap, and no `NODE_OPTIONS=--max-old-space-size` or area cap per container size.
- **Also:** the SSE route emits no terminal event when the process dies, and the client has no way to tell a crash from a finished stream except the missing `done` (`src/app/api/agent/route.ts`).

### F2. Wrong maximum elevation stated as fact (ter01, ter02)

- **Request:** `ter01` Matterhorn 6 km box centred 7.66E 45.98N: "what are the min and max elevation?". `ter02` Everest 8 km box centred 86.93E 27.99N: "the highest elevation".
- **Response:** "The minimum elevation is 2065 m and the maximum elevation reaches 4105 m" (Matterhorn summit 4478 m is inside the box, 400 m from the centre). "reaching a peak elevation of 8599 m" (Everest summit 8849 m is inside the box). The answer has no caveat that the maximum is a sampled value, and the tool's summary_data `max_elevation_m` equals the largest sample of the W-E profile.
- **Probable cause:** the numeric statistics are point samples from opentopodata, not extrema of the 30 m raster (`src/app/api/agent/tools/terrain.ts:79-86` for the dataset, `:175-186` for the sample selection, `:383` for the note that "the statistics above are NOT measured from this 30 m layer"). A sample grid misses summits, so min/max are biased inward. The note exists in the tool's own summary but the model does not carry it into the answer, and `max_elevation_m` is not labelled as a sampled maximum.

### F3. Weather history cannot be asked about the past (wx01 to wx04)

- **Request:** `wx03`: Phoenix, "What were the daily maximum temperatures here in July 2023? How many days exceeded 43 C?"
- **Response:** "cannot be determined ... the integrated weather service provides a fixed rolling 12-month summary". The plan ran `fetch_weather_history`, then `find_dataset` (found `open-meteo:era5-archive`), then `use_dataset {dataset_id: open-meteo:era5-archive, start: 2023-07-01, end: 2023-07-31, variable: temperature_2m_max}`. `use_dataset` returned `ok` but its data is the same trailing window (`2025-10 ... 2026-10`, `annual_precip_mm: 559`, same as `fetch_weather_history`).
- **Probable cause:** `fetch_weather_history` takes no parameters (`src/app/api/agent/engine/ops/climate.ts:14`, `params: z.object({})`), and `use_dataset` for this dataset routes to it and drops `start`/`end`/`variable` while still reporting `ok`. That is the worse half: a result that silently ignores the dates it was given. The answer is honest only because the model noticed the dates did not match.
- Related, **F3b:** `fetch_precipitation_history` with `include_raster: false` is always `flagged` with a failing check "The result has layers or figures but names no data source, so it cannot be treated as a measurement." (`wx01`, `wx02`, `wx04`). Provenance is only attached to the optional CHIRPS raster layer (`src/app/api/agent/tools/climate.ts:162`), so the stats-only path has none, and the validator (`src/app/api/agent/engine/validate.ts:238-240`) fails it. The ERA5 numbers are real; the label says otherwise.

### F4. Investigator can reach "confident" on evidence that does not cover the window (inv01 retry)

- **Request:** `POST /api/investigate`, Kasur bbox `[74.40, 30.95, 74.56, 31.08]`, window 2025-08-01 to 2025-09-30.
- **Response (retry):** one step, `fetch_surface_water` (JRC occurrence 1984 to 2021, mean 0.9%), verdict "Flood event" posterior 0.8626, `stop_reason: confident`. The dossier itself says the JRC record "ends in the past; it serves solely as a baseline rather than an observation of the window". The first attempt chose 4 steps (JRC, vision, NDWI change, `map_flood`) and then crashed (F1).
- **Probable cause:** the catalogue gives the archival item a likelihood per hypothesis (`src/app/api/agent/investigator/catalogue.ts:241-252`) and `shouldStop` returns `confident` at 0.85 after any measured item (`src/app/api/agent/investigator/stop.ts:31`, `STOP_CONFIDENT` at `:5`). "Normally dry" moves 0.67 to 0.86 because it rules out "permanent water", but says nothing about whether anything happened in the window. The verdict is right here (Sutlej floods of Aug 2025 are well documented, and corroboration found 6 in-window reports), but the engine reached it with no observation inside the window. An archival-only measurement should not be able to satisfy the stop rule alone.

### F5. Corroboration returned nothing in 3 of 4 investigations (inv02, inv03, inv04)

`status: failed, "The search returned no grounded pages"` (`src/app/api/agent/investigator/corroborate.ts:98-99`), even for Lahaina in August 2023, which is among the most reported events there is. The `inv01` retry grounded 6 sources. It is reported honestly ("a failure to ground, not evidence that nothing was reported"), so I graded these cases partial rather than fail. The cause is upstream of the code (search grounding returning no chunks), and the swallowed model response is not logged, so I cannot say more.

### F6. Scope: an off-topic question is answered (hon05)

"Who won the 2018 football World Cup and what is the capital of Australia?" returned "France ... Canberra" from model memory, uncited and followed by an Unverified block. The facts are right, so this is not fabrication. It is a missing scope guard.

## Period handling (the claim-period requirement)

The three deforestation claims (`chg01` to `chg03`) used the claim's own window (2020-08 to 2023-08, 2019-07 to 2023-07, 2021-07 to 2024-07), and `chg01` correctly said the claim "is technically true ... but fundamentally misleading because the land was already deforested prior to 2020". Two cases pulled a comparison scene outside the requested window by nearest-clear bracketing, and said so in the answer: `fire01` (post scene 2023-09-17 for "after 20 Aug"), `chg04` (2024-01-27 for "to Dec 2023"), plus a single-scene stat in `veg02` (2024-03-12 for February). I graded these partial, not fail, because the dates were disclosed. A strict reader may disagree.

## False-positive "Unverified statements" (all of them)

Source: `src/app/api/agent/lib/grounding.ts`. 35 of 39 agent answers had the block, 69 lines; classified by `eval/live/analyze.mjs`:

| Class | Lines | Verdict |
|---|---|---|
| Percentile ordinals ("2nd percentile", "98th", "25th", "p95") read as figures | 16 | **False positive.** `EXEMPT_CONTEXT` (`grounding.ts:40`) exempts bands, years, "10 m"; it has no rule for `\d+(st|nd|rd|th) percentile`. `veg01`-`veg06`, `veg08`, `fl06`, `fire03`, `fire04`, `dat03` |
| A real figure with no citation in the same sentence | 41 | **Mixed.** Mostly true, benign (the model restated a cited number, or used slope-class shares and profile values from the result without a marker). Some are parameters, dates, coordinates, windows or arithmetic, and are false positives: 500 m2 filter, "NBR >= 0.15", "13 September", "31 December 2019", "6-day window", "+/-30 days", "~45-day windows", "9-class", "10 m", "<1 m", lat/lon of the centroid (`wx03`, `wx04`), 147.5 = 2374/16.1 (`bld01`), 5.4% = 100 - 94.62 (`veg08`), 251 = sum of cited months (`wx02`), "5000" map cap (`bld02`), band tables in the B99 refusal (`hon01`), dates inside a refusal (`hon03`) |
| A cited value that "does not match" | 12 | Mostly the same causes (a figure next to a cited percentile or threshold). |
| Figures I could not verify | a few | `veg06` SCL shares (35%, 17%, 19%), `fire01` "53% water", `fl01` water-fraction timeline. They may come from the tool's text (the model sees it) but are not in `summary_data`, so the flag is arguably right to say they are uncited. |

I found **no flagged number that was a fabricated measurement.** Of the answers I read, 607 of 609 citation markers resolved to a real `result_id` and key; the 2 that did not (`veg02`, `fire03`) were not resolved against any tool result and the grounding check did flag the `veg02` sentence.

Net: the check protects against a real failure mode, but at a 90% hit rate on correct answers it trains users to ignore the block. Treat it as a bug to fix, starting with percentile ordinals, "N-day/-m/-class" parameters, dates and coordinates, and arithmetic on cited values.

## UI checks (Playwright against the live URL)

| Check | Result | Evidence |
|---|---|---|
| ui01 page load | **pass** | 0 failed requests, 0 HTTP >= 400, 0 console errors, 0 page errors, no "Basemap unavailable"; basemap and labels render (`ui01-load.png`) |
| ui02 draw, ask, answer, layers | **partial** | Coordinate search flew to Ames, Iowa; rectangle drawn (1.27 km2). Answer rendered with 18 citation pills; a layer was added (Layers tab: 1 row). An "Unverified statements" card showed (same false-positive class as above; the card text was not captured by the script). `ui02-answer.png` |
| ui03 toolbox | **pass** | `Fetch ndvi` from the tool dialog: job row `FINISHED`, 1 layer added (`ui03-jobs.png`, `ui03-layers.png`) |
| ui04 signed bundle | **pass** | Downloaded via the "Signed bundle" button; key from `GET /api/evidence/public-key` (Ed25519, key_id `eeda78cb6a11414b`, `ephemeral: false`); `npx tsx scripts/verify-bundle.mts bundle.json --key public-key.pem` printed `signature: VALID, consistency: OK, RESULT: VALID` (exit 0). After changing one number it printed `signature: INVALID` and exit 1 |

Notes: the 175 to 182 "failed requests" in ui02 to ui04 are all `net::ERR_ABORTED` basemap and terrain tiles cancelled by MapLibre during the fly-to animation; they are not errors. My first ui02/ui03 attempts used a place name that never flew the map (the coordinate field accepts "lat, lng"; free text needs a click on a Nominatim result) and a `FINISHED` match that picked up an older job; the final run fixes both, and results shown are from the final run only.

## Other observations

- The agent's plans were sensible for all 46 cases: right operation family in every case I judged (fetch_ndvi cases were served by `composite` with an NDVI expression, which is acceptable). No `plan_refused` except the two intended refusals (B99, 2031). Only `fl02`, `fl03`, `fl05`, `inv01` did not finish.
- Layers and charts: 1 to 5 layers per spatial case; charts for flood cases and the elevation profile. No `error` events at all in the first pass (the crashes produce none).
- `veg07` answer renders a formula with `$...$` LaTeX delimiters; the UI does not render LaTeX (minor).
- A `ledger` run id was returned for every run that executed an operation (all completed cases except the three that refused before running anything: `hon01`, `hon03`, `hon05`); the bundle for one was verified in `ui04`.

## Honest limits of this evaluation

- One run per case, one sample, no repeats except the 4 retried crashes. Gemini output varies run to run (the investigator chose different steps in the two `inv01` runs).
- No ground truth beyond well-known facts (summit heights, event dates and places). Numbers such as NDVI means, flooded km2, building counts and burn areas were checked for plausibility and units only, not against an independent measurement.
- Grades of "partial" for period drift and for the weather cases are judgement calls.
- The server was reached from one client at one pace (about 1.5 requests a minute), so these latency numbers say nothing about load. The crash results do not depend on load.
- The model name per run is not observable from the API.

## Per-case results

`results-2026-10-15.jsonl` has the raw record for each case (plan, tool calls with statuses and validation, layers, charts, answer, unverified block, ledger id, timings). Final grade = FAIL if the task failed, partial if the task was partial or had a false-positive Unverified block, else pass.

| Case | Category | Time | Task outcome | False-positive Unverified | Final | Notes |
|---|---|---|---|---|---|---|
| veg01 | vegetation | 32 s | pass | yes | **partial** | Percentile ordinals (2nd/98th) flagged. |
| veg02 | vegetation | 33 s | partial | yes | **partial** | Headline is the February composite (in period), but the single-scene stat used 2024-03-12, four weeks outside February (disclosed in the answer). FP: percentile ordinals, a +/-30 day window. |
| veg03 | vegetation | 30 s | pass | yes | **partial** | FP: percentile ordinals, 'NDWI <= 0', 500 m2 filter. |
| veg04 | vegetation | 32 s | pass | yes | **partial** | FP: 98th percentile, 12 acquisitions / 31-day window. |
| veg05 | vegetation | 29 s | pass | yes | **partial** | FP: percentile ordinals. |
| veg06 | vegetation | 21 s | pass | yes | **partial** | FP: percentile ordinals. The SCL class shares (35%, 17%, 19%) are not in the cited result and could not be checked. |
| veg07 | vegetation | 33 s | pass | no | **pass** | Clean. Band math rendered; mean 0.557 plausible. |
| veg08 | vegetation | 21 s | pass | yes | **partial** | FP: 5.4% is 100 - 94.62 (arithmetic on a cited value). The low-observation warning (1.66 clear obs/pixel) is carried into the answer. |
| fl01 | flood | 100 s | pass | no | **pass** | map_flood ok in 100 s; 4.69 km2 new flood. The two flagged sentences restate figures without a citation (hygiene, not shown false). |
| fl02 | flood | 28 s | FAIL | no | **FAIL** | Container OOM crash during map_flood, stream ended with no done or error. Reproduced on retry. |
| fl03 | flood | 35 s | FAIL | no | **FAIL** | Container OOM crash during map_flood. Reproduced on retry. |
| fl04 | flood | 32 s | pass | yes | **partial** | FP: a date ('13 September'). Sensitivity range uncited but present in the tool result. |
| fl05 | flood | 55 s | FAIL | no | **FAIL** | Container OOM crash during map_flood. Reproduced on retry. |
| fl06 | flood | 21 s | pass | yes | **partial** | FP: percentile ordinals. Caveat: JRC history (1984-2021) plus a 2026 NDWI scene, not a change-since-1990 chart. |
| fire01 | fire | 32 s | partial | no | **partial** | Asked before 1 Aug / after 20 Aug; scenes used were 2023-07-29 and 2023-09-17 (disclosed). 72.5% NBR drop; 53% of the box is sea, so burn share is diluted. |
| fire02 | fire | 38 s | partial | no | **partial** | Single-scene May vs August NBR is confounded by green-up; the answer says so but still attributes the 6.3% decrease to burn without evidence. |
| fire03 | fire | 40 s | pass | yes | **partial** | 40 km2 burn scar plausible for Evros 2023. FP: NBR threshold 0.15, 500 m2 filter, dates. |
| fire04 | fire | 26 s | partial | yes | **partial** | Historical active fires cannot be fetched (fetch_active_fires is a 10-day NRT feed); the answer says so, found the FIRMS archive but did not load it. Scene fully cloudy. FP: dates and the 10-day window. |
| ter01 | terrain | 31 s | FAIL | no | **FAIL** | Max elevation reported as 4105 m in a box that contains the Matterhorn (4478 m); stated as fact, no sampling caveat. |
| ter02 | terrain | 22 s | FAIL | no | **FAIL** | Highest elevation reported as 8599 m in a box that contains Everest (8849 m); stated as fact, no sampling caveat. |
| ter03 | terrain | 26 s | pass | no | **pass** | 741-2162 m, mean slope 17%: plausible for the South Rim / river. Slope-class shares uncited. |
| ter04 | terrain | 28 s | pass | no | **pass** | Profile chart produced; 1296-1326 m plausible for the Kathmandu valley. |
| bld01 | built | 13 s | pass | yes | **partial** | FP: 147.5 buildings/km2 is 2374 / 16.1 (arithmetic). |
| bld02 | built | 57 s | pass | yes | **partial** | FP: the 5000-feature map cap (a parameter). 57 s. |
| bld03 | built | 62 s | pass | no | **pass** | Clean. 62 s. |
| bld04 | built | 54 s | pass | yes | **partial** | FP: '5 Overpass requests'. 54 s. |
| wx01 | weather | 40 s | partial | no | **partial** | Asked for July 2024 daily rain: answered 'cannot be determined'. Honest, but the weather tools take no date range, so ERA5 history cannot be used. fetch_precipitation_history was flagged: validation fail 'names no data source'. |
| wx02 | weather | 15 s | partial | yes | **partial** | Asked for the 2023 rainy season: 'cannot be determined' (honest; tool covers the last 12 months only). Validation fail on provenance. FP: 251 mm is a sum of cited monthly values. |
| wx03 | weather | 19 s | partial | yes | **partial** | Asked for July 2023 daily maxima: 'cannot be determined'; use_dataset open-meteo:era5-archive with explicit dates silently returned the trailing 12 months. FP: coordinates. |
| wx04 | weather | 18 s | partial | yes | **partial** | Asked for 2023 monthly rainfall: climatology only; validation fail on provenance. FP: coordinates. |
| chg01 | change | 19 s | pass | no | **pass** | Period honoured (2020-08 to 2023-08). Says the claim is technically true but misleading: the land was not forest in 2020. Good. |
| chg02 | change | 34 s | pass | yes | **partial** | Period honoured (2019-07 to 2023-07). FP: '98% cloud-free', a quoted '<1 m'. |
| chg03 | change | 17 s | pass | no | **pass** | Period honoured (2021-07 to 2024-07). Verdict 'supported', from two single dates in a cloudy basin; caveats are thin. |
| chg04 | change | 17 s | partial | yes | **partial** | Follow-up scene was 2024-01-27, after the requested end (Dec 2023); the answer says 'early 2024'. FP: '~45-day windows'. |
| dat01 | discovery | 13 s | pass | yes | **partial** | FP: '10 meters', '9-class'. |
| dat02 | discovery | 11 s | pass | no | **pass** | Clean. Overture buildings found. |
| dat03 | discovery | 28 s | pass | yes | **partial** | Cop-DEM loaded as a layer. FP: percentile ordinal. |
| hon01 | honesty | 10 s | pass | yes | **partial** | Correct refusal (plan_refused, B99 does not exist). FP: the list of valid band names and resolutions was flagged. |
| hon02 | honesty | 19 s | pass | yes | **partial** | Correct abstention: cars and species not resolvable at 10 m. FP: a quoted '<1 m'. |
| hon03 | honesty | 23 s | pass | yes | **partial** | Correct refusal (March 2031 is in the future). FP: the dates in the refusal. |
| hon04 | honesty | 9 s | pass | no | **pass** | Correct: exact tonnage cannot be determined from satellite data. |
| hon05 | honesty | 3 s | partial | yes | **partial** | Off-topic trivia answered from model memory (France; Canberra: correct) instead of declining or redirecting; uncited and flagged. |
| inv01 | investigation | 88 s | FAIL | no | **FAIL** | First attempt: container OOM crash mid-investigation (stream ended, no verdict). Retry: completed, verdict 'Flood event' 0.86 'confident' after a single archival JRC step that cannot observe the window (partial). |
| inv02 | investigation | 29 s | partial | no | **partial** | Verdict 'Wildfire' 0.89 from NBR change; corroboration returned no grounded pages. |
| inv03 | investigation | 77 s | partial | no | **partial** | Verdict 'Outdated building inventory' 0.71 for 'new construction' in Dubai South; bracketing scenes 2019-12-30 / 2025-01-12 straddle the window; corroboration failed; 2 sentences dropped. |
| inv04 | investigation | 59 s | partial | no | **partial** | Discovery scan over 9 cells, 'cannot determine' (cloud-limited). Honest; corroboration failed. |
| ui01 | ui |  | pass | no | **pass** | No failed requests, no console errors, basemap renders. |
| ui02 | ui |  | partial | yes | **partial** | Answer with 18 citation pills and a layer; an Unverified card appeared. |
| ui03 | ui |  | pass | no | **pass** | Toolbox fetch_ndvi: job FINISHED, layer added. |
| ui04 | ui |  | pass | no | **pass** | Bundle verified VALID offline; tampered INVALID. |

| Category | Cases | pass | partial | FAIL | (task outcome only: pass / partial / FAIL) |
|---|---|---|---|---|---|
| vegetation | 8 | 1 | 7 | 0 | 7 / 1 / 0 |
| flood | 6 | 1 | 2 | 3 | 3 / 0 / 3 |
| fire | 4 | 0 | 4 | 0 | 1 / 3 / 0 |
| terrain | 4 | 2 | 0 | 2 | 2 / 0 / 2 |
| built | 4 | 1 | 3 | 0 | 4 / 0 / 0 |
| weather | 4 | 0 | 4 | 0 | 0 / 4 / 0 |
| change | 4 | 2 | 2 | 0 | 3 / 1 / 0 |
| discovery | 3 | 1 | 2 | 0 | 3 / 0 / 0 |
| honesty | 5 | 1 | 4 | 0 | 4 / 1 / 0 |
| investigation | 4 | 0 | 3 | 1 | 0 / 3 / 1 |
| ui | 4 | 3 | 1 | 0 | 3 / 1 / 0 |
| **all** | 50 | 12 | 32 | 6 | 30 / 14 / 6 |
