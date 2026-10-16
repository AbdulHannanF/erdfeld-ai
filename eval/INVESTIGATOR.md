# Autonomous investigator: 3-case smoke test

This is a smoke test that the pipeline runs end to end on live data with a live model. It is **not an
accuracy claim**: three cases cannot measure accuracy, the likelihood ratios in
`src/app/api/agent/investigator/catalogue.ts` are expert-set (not calibrated against labelled outcomes),
and the posteriors are therefore ordered beliefs, not calibrated probabilities.

- Command: `npx vite-node --config vitest.config.ts scripts/investigate-smoke.mts [--only kasur,lahaina,development] [--no-llm]`
- Model: `gemini-3.8-flash` (triage, step rationale, vision reading, narrative, and a separate `googleSearch` corroboration call). Time budget 180 s, at most 6 operations.
- Environment: no database, so the evidence store was unavailable (no cache, no ledger run id).
- Full event streams: `eval/investigator-smoke/{kasur,lahaina,development}.json`; the `*-nollm.json` files are runs with the model disabled (family given, catalogue priors).
- Date of runs: 2026-10-14.

| Case | Window | Expected | Result | Stop | Wall time |
|---|---|---|---|---|---|
| Sutlej near Kasur, [74.40,30.95,74.56,31.08] | 2025-08-01..09-30 | flood | **Flood event**, posterior 0.89 (3 ops: JRC history, vision, NDWI rise) | confident | 66 s |
| Lahaina, Maui, [-156.69,20.86,-156.66,20.89] | 2023-08-01..08-31 | fire | **Cannot determine**, leader "non-fire change" 0.42 (4 measurements) | no informative evidence left | 60 s |
| Western Sydney Airport terminal precinct, [150.700,-33.900,150.730,-33.876] | 2023-06-01..2025-06-01 | new structures | run A: **New construction** 0.91 (2 ops, confident). Run B (rerun): **Cannot determine** 0.43 (5 ops) | confident / no informative evidence | 46 s / 78 s |

Source for the third case: Western Sydney International (Nancy-Bird Walton) Airport, Badgerys Creek NSW;
coordinates from Wikipedia ("Western Sydney Airport", -33.888, 150.715). The terminal, apron and landside
works were built through 2023-2025 ahead of the planned 2026 opening, per the airport company's
published construction updates. The ground truth is therefore "new structures", not a surveyed building list.

## What the runs show

- **Kasur** reached the expected answer. Two caveats: the first update came from JRC surface-water history
  alone (a site with almost no usual water), and the vision reading was capped at a likelihood ratio of 2 and
  moved belief by almost nothing here. The corroboration found dated reports (The Nation, OCHA) inside the window.
- **Lahaina** did not reach the expected answer, and said so. The drawn box is mostly town: dNBR averaged over
  it was 0.04 (a burned town is not the vegetation burn the dNBR bins were set for), 18.7% of clear pixels lost NBR,
  and the vision reading did see a burn scar or smoke plume. Those together left "non-fire change" slightly ahead
  with 0.42, below the 0.6 verdict threshold, so the verdict is "cannot determine". The active-fire hotspot item
  was correctly skipped (the near-real-time source covers only the last 10 days). Web corroboration (NASA Earth
  Observatory, LA Times) reports the fire, but corroboration never updates a posterior. This is a real weakness:
  with the catalogue as written, a fire that burned structures is under-detected by dNBR.
- **Development** was not stable across two runs. Run A read the vision image as "new or unfinished buildings"
  and stopped confident on construction (0.91). Run B ran a different op order, read the image as "established
  buildings" and could not decide (0.43). The model proposes the priors and reads the picture, so the runs differ;
  the belief arithmetic itself is deterministic given the measured features. One confident verdict from a
  non-repeating step is a reason for caution, not a result.
- Mapped-building counts are not treated as proof of new construction: the catalogue states that OSM and the
  built-surface layers carry no construction date, may lag reality, and cap that item's likelihood ratio.

## Known limits

- Three cases; no calibration; no held-out set. Do not quote the posteriors as probabilities.
- The corroboration search returns Google redirect links; the server follows them once (best effort) to show
  the page's own address, otherwise the redirect is shown. Publication dates are the search model's reading of
  each page and are unverified.
- The discovery scan ran live once, in an earlier Kasur run in which the triage treated the open question as event-less: it scanned nine cells by NDVI change and then investigated the vegetation-loss family (verdict: harvest, 0.63), which is the wrong family for a river flood. The triage prompt and the discovery question were changed so the asked question survives; the scan itself is otherwise covered only by unit tests with mocked operations. The scan's NDVI measure biases it toward vegetation questions.

## Update 2026-10-14: why Lahaina was missed, and what changed

The table and notes above are the first runs and are kept as they were. The Lahaina miss had two causes.
The first was not the one the notes above guessed.

1. **Scene selection (the main cause).** A change analysis took, for each date, the clearest of the newest
   scenes within +/-30 days of it. For the window 2023-08-01..08-31 the "before" scene was **2023-08-28**
   (after the 8 August fire) and the "after" scene 2023-09-17, so both were post-fire and the pair
   measured almost nothing. Measured directly on the same box: whole-area dNBR 0.04 with those scenes,
   **0.14** (56.8% of clear pixels fell by more than 0.1 NBR) once the before scene is taken from the 45 days
   up to 2023-08-01 (it was 2023-07-29) and the after scene from the 45 days from 2023-08-31. This affected
   every family that compares two dates, not only fire. Fix: `analyze_raster` `change` takes `bracket: true`
   (before scene on or before `date`, after scene on or after `date2`); every catalogue change item uses it,
   because the investigator's window is where the event happened.
2. **Dilution by surfaces that cannot burn.** NBR on roofs and asphalt is near 0 and barely moves, so a
   mean over a town understates the burn. `analyze_raster` `change` takes `baseline_min`: only pixels whose
   index on the before date was at least that value are counted, the share kept is reported
   (`baseline_pixels_pct`), and fewer than 30 pixels is refused as too few. The fire items now read dNBR and
   the lost-NBR share on pixels with NBR >= 0.15 before the event (cut rationale in `catalogue.ts`: vegetation
   about 0.2 to 0.8, senescent grass 0.1 to 0.3, roofs/asphalt/bare rock about -0.1 to 0.1). On Lahaina this
   keeps 24.2% of the clear pixels and gives dNBR 0.25 with 76.3% of them falling.

Not added, on purpose: a building-loss measure (the engine has none with a date; WorldCover is a 2021
snapshot and Overture/OSM footprints carry no construction or damage date), and a historical burned-area
product. The registry lists MODIS MCD64A1 (500 m, no in-app reader) and Copernicus CLMS Burnt Area (300 m,
needs a Copernicus token); at 300-500 m a drawn area of a few kilometres is a handful of pixels. The FIRMS
archive was not wired in either: no `FIRMS_MAP_KEY` was available to verify it. The fire limits now say
that burnt roofs and walls are not measured.

Engine-only re-run (`--no-llm`, no model, so no vision reading and no corroboration), 2026-10-14, files in
`eval/investigator-smoke/2026-10-14-burnable/`:

| Case | Before this change (`*-nollm.json`) | After |
|---|---|---|
| Lahaina | Cannot determine | **Wildfire or burn scar, 0.79** (dNBR 0.25 on vegetated pixels, 76% of them fell; stop: no informative evidence left) |
| Kasur | Flood event | Flood event, 0.70 (unchanged) |
| Western Sydney | Cannot determine | Cannot determine (unchanged) |

**The live-model re-run of the three smoke investigations was not done**: the Gemini key's prepayment credits
were depleted (HTTP 402) on 2026-10-14, so the model-assisted numbers above (0.89 / 0.42 / 0.91 and 0.43)
are still the latest model-assisted results and are not evidence for this change. The Lahaina result above
is one case, and it is the case that exposed the defect: it shows the fix does what it should on that box, not
that fire detection is accurate. The likelihood tables were not changed; the dNBR and extent bins and their
per-hypothesis probabilities are the old expert-set ones, now fed values measured on the ground those bins
were written for. They are still not calibrated.

The investigator's model calls now use the agent's per-phase thinking level
(`GEOAGENT_GEMINI_THINKING_PLAN` for triage, `..._SYNTHESIS` for the rest, or `GEOAGENT_GEMINI_THINKING`)
instead of a hardcoded LOW; the default is still `low`.
