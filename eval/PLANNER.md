# Planner evaluation

Does the planner (the first model turn of the agent loop) choose the right operations with valid
arguments, decline what cannot be answered, and use `submit_plan` rather than calling tools
directly? Nothing is executed: the turn is recorded and checked with the real static
`validatePlan`, so a run costs only model tokens and fetches no satellite data.

## Scores

One live, plan-only sample per case on 2026-10-13, 43 cases, `gemini-3.8-flash`, no provider errors.
The date in the prompt is pinned to 2026-10-13 so "next month" and "last September" mean the same
thing on every run.

| planner thinking level | passed | 95% interval | median plan latency |
|---|---:|---:|---:|
| `low` (the default) | **41 / 43 = 95%** | 85-99% | 2.9 s |
| `medium` | 40 / 43 = 93% | 81-98% | 7.2 s |

By check (`low`): no direct tool call 43/43, plan passes the validator 31/31, operation choice 38/38,
arguments 14/14, dates 3/3, step count 20/21, refusal correctness 41/42, answer from the manifest 1/1.

By family (`low`): flood 4/4, indices 6/6, raw bands 5/5, composites 5/5, claims 3/3, refusals 7/7,
cannot-determine 2/3, OSM 3/3, terrain 2/3, weather 3/3, reuse 1/1.

### What failed, and how to read it

- **cd01** (both runs): asked for the exact wheat yield in tonnes, the model planned `delineate_fields`
  plus `classify_land_cover` (`low`) or `find_dataset` plus `classify_land_cover` (`medium`) instead of
  declining. `find_dataset` and `delineate_fields` are accepted redirects; `classify_land_cover` is not
  an answer to a yield question. A real miss. Whether the write-up then says "yield cannot be
  determined" is not measured here.
- **tr02** (both runs): "How steep is the ground? Is it buildable?" got `fetch_elevation_derivatives`
  plus `fetch_built_surface`. The case says at most one step; two is arguably reasonable for
  "buildable". The case was written before the run and was not loosened afterwards, so it counts as a
  miss. It says more about the case than the model.
- **rf07** (`medium` only): Sentinel-2 from summer 1995. The model planned two `find_dataset` calls.
  That is not a decline, a validator refusal or the listed redirect (`render_raster` with Landsat).
  Within noise: `low` redirected correctly.

### Limits of these numbers

- 43 cases and one sample each: the interval is wide, and `low` against `medium` (41 against 40) is
  a tie, not a win. The choice of `low` rests on latency (2.5x faster) with no measured loss.
- The cases were written by hand from the operation contracts, by the authors of the prompt. Nobody
  independent has reviewed them, and most are routine requests. A high score here does not mean the
  planner handles an unfamiliar one.
- Only the first turn is judged. Whether the later analysis carries the caveats, or whether the
  executed tool returns a good number, is not measured. (`eval/RESULTS.md` has the live five-question run.)
- The tool set seen by the planner includes `composite`, which a deployment registers only while
  `GEO_SERVICE_URL` is set. The harness sets a placeholder so its cases run; plan-only mode never
  calls the service.
- Models are not deterministic. The recordings make the scoring repeatable, not the model.

## Update 2026-10-14: the stated period

Live finding (smoke Q3, "Over 20% of the tree cover in this area was lost between 2020 and 2023"): the plan ran
`detect_deforestation`, which took no dates and always compared 1-2 years ago with the latest imagery (2025-2026),
so it could not test the claim. Causes: the operation had no date parameters, and its prompt row said only
"two-year Sentinel-2 comparison", so the planner had nothing to pass. Changes: `detect_deforestation` and
`detect_change` take `before` / `after`; the prompt says to pass dates inside a stated period; and `validatePlan`
refuses a time-bound step (including one left on the default latest-imagery window) whose window does not overlap
the years the question names (`engine/period.ts`; only explicit four-digit years are read, so "last September"
never triggers it).

Two cases were added (`cl04`, the Q3 claim; `cl05`, a plain question for 2018-2021), 45 in all. The 2026-10-13
recording below predates the change and has no result for them. Replaying it with the new validator turns `cl01`
from pass to fail (its recorded plan used `detect_deforestation` with no dates), which is the defect itself, and
the baseline was refreshed to say so. **Not verified live**: the Gemini key had no credits left on 2026-10-14
(HTTP 402), so neither Q3 nor a plan-only run of cl01, cl04 and cl05 could be re-recorded. Until they are, the
scores above describe the old prompt, and the 43-case counts below exclude the two new cases.

## Cases

`eval/planner/cases.jsonl`: 45 cases (43 scored in the recording above), AOIs in `eval/planner/aois.json`.

| family | cases | expect a refusal |
|---|---:|---:|
| flood | 4 | 0 |
| indices | 6 | 0 |
| raw bands | 5 | 0 |
| composites | 5 | 0 |
| claims | 5 | 0 |
| refusals (bad band, impossible resolution, future date, pre-2015 Sentinel-2) | 7 | 7 |
| cannot-determine | 3 | 3 |
| OSM / buildings | 3 | 0 |
| terrain | 3 | 0 |
| weather | 3 | 1 |
| reuse (answer from the layer manifest) | 1 | 0 |

A case states what it expects: operations that must (or must not) appear, argument matchers, a date
window, a step ceiling, or `expect_refusal` (the model declines, the validator refuses the plan, or the
plan consists only of the listed `or_use` redirects). Each case has a `note` with the contract behind it.

## Checks

| check | passes when |
|---|---|
| `no_direct` | the model used `submit_plan`, not a bare tool call |
| `plan_valid` | the plan parses and passes `validatePlan` (a case that expects a refusal skips this) |
| `op_choice` | required operations present, forbidden ones absent |
| `args` | some step of the operation matches every argument matcher |
| `dates` | every explicit date lies in the window, and there is one |
| `steps` | within the step ceiling |
| `refusal` | declined what should be declined, and did not decline what has an answer |
| `reuse` | answered from the manifest with no tool call |

A provider error counts as an error and leaves the rates; it is never scored as a miss.

## Run it

```bash
# live, plan-only; writes eval/planner/recordings/<provider>-<model>-think-<level>-<date>.jsonl
GEMINI_API_KEY=... npx vite-node -c vitest.config.ts eval/planner/run.mts -- --live --provider gemini --model gemini-3.8-flash --thinking low
# options: --only fl01,rf03   --concurrency 3   --verbose

# replay a recording offline with the current validator, scorer and cases (no key, no network)
npx vite-node -c vitest.config.ts eval/planner/run.mts -- --replay eval/planner/recordings/<file>.jsonl --verbose
```

A recording stores the decoded turn (text and tool calls) and a hash of the request the model saw.
Replay re-scores it with today's code, so it catches a validator, scorer or case change that breaks a
plan the model made. It cannot see the effect of a prompt change; for that, record again. A replay
reports `stale` for cases whose request hash no longer matches the current prompt and tools.

CI: `npx vitest run eval/planner` replays the recording named in `eval/planner/baseline.json` and
fails if a case that passed there fails now. After a deliberate change, re-record, check the scores
and refresh the baseline with `--replay <file> --write-baseline`.
