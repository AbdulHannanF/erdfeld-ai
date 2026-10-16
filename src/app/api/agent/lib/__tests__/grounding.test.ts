import { describe, expect, it } from 'vitest'

import type { ResultStore } from '../types'
import { checkAnswerGrounding } from '../grounding'
import { thinkingLevelFor } from '../gemini'

const store: ResultStore = new Map([
  ['r_00000000000000a1', { tool: 'fetch_ndvi', summary_data: { mean: 0.42, valid_pixel_pct: 98.8, scene_date: '2024-07-16', hist: [{ label: 'a', value: 12 }] }, layers: [] }],
])
const check = (s: string) => checkAnswerGrounding(s, store)

describe('checkAnswerGrounding', () => {
  it('passes a figure that matches its citation, including rounding and fraction-as-percent', () => {
    expect(check('Mean NDVI was 0.42 [[r_00000000000000a1#mean]].')).toEqual([])
    expect(check('About 98.8% of pixels were clear [[r_00000000000000a1#valid_pixel_pct]].')).toEqual([])
    expect(check('NDVI averaged 0.4 [[r_00000000000000a1#mean]].')).toEqual([]) // 0.4234 to one decimal is still the same figure
    expect(check('NDVI averaged 0.5 [[r_00000000000000a1#mean]].')).toHaveLength(1)
    expect(check('That is 42% green [[r_00000000000000a1#mean]].')).toEqual([])
  })

  it('accepts figures the run already knows as context, such as the drawn area', () => {
    const s = 'Across the 9.52 km² area the mean NDVI was 0.42 [[r_00000000000000a1#mean]].'
    expect(checkAnswerGrounding(s, store, [9.5213])).toEqual([])
    expect(checkAnswerGrounding(s, store)).toHaveLength(1)
  })

  it('flags a number with no citation, a wrong value, and a citation that points at nothing', () => {
    expect(check('The area is 37% bare soil.')[0].reason).toMatch(/no citation/)
    expect(check('Mean NDVI was 0.61 [[r_00000000000000a1#mean]].')[0].reason).toMatch(/does not match/)
    expect(check('Mean NDVI was 0.42 [[r_00000000000000a1#nope]].')[0].reason).toMatch(/no tool result contains/)
    expect(check('Mean NDVI was 0.42 [[r_ffffffffffffffff#mean]].')).toHaveLength(1)
  })

  it('does not flag years, dates, band names, durations, questions or sentences without numbers', () => {
    expect(check('Scene S2B_37MBU_20240716 from 2024-07-16 used B08 and B04 in 2024.')).toEqual([])
    expect(check('The step ran past its 240-second limit; try a 3- to 4-week window.')).toEqual([])
    expect(check('- **B05** (Red Edge 1 – 20 m)')).toEqual([])
    expect(check('1.\nWould you like a crop map instead?')).toEqual([])
    expect(check('- **B05**: Red edge 1 (20 m)')).toEqual([])
    expect(check('Bands 8 and 9 are near-infrared and water vapour.')).toEqual([])
    expect(check('Sentinel-2 images the area at 10 m, in band 8.')).toEqual([])
    expect(check('The footprint is 10 m² per pixel.')).toHaveLength(1) // an area, not a pixel size
    expect(check('Would you like the trend for the last 5 years?')).toEqual([])
    expect(check('Cloud cover was the problem here.')).toEqual([]) // wording is held to the facts by the prompt, not checked here
  })

  it('reports each unbacked sentence separately', () => {
    expect(check('Mean NDVI was 0.42 [[r_00000000000000a1#mean]]. Roads cover 17 km. Trees cover 31%.')).toHaveLength(2)
  })
})

describe('thinkingLevelFor', () => {
  it('uses the per-phase variable, then the shared one, then the default', () => {
    expect(thinkingLevelFor('plan', { GEOAGENT_GEMINI_THINKING_PLAN: 'low', GEOAGENT_GEMINI_THINKING: 'high' })).toBe('LOW')
    expect(thinkingLevelFor('synthesis', { GEOAGENT_GEMINI_THINKING_PLAN: 'low', GEOAGENT_GEMINI_THINKING: 'high' })).toBe('HIGH')
    expect(thinkingLevelFor('plan', { GEOAGENT_GEMINI_THINKING: 'nonsense' })).toBe(thinkingLevelFor('plan', {}))
  })
})


// ---------------------------------------------------------------------------
// Real flagged lines from the 2026-10-15 live evaluation (eval/live/results-2026-10-15.jsonl).
// The old check flagged every one of these; none is a fabricated measurement.
// ---------------------------------------------------------------------------

const live = new Map([
  ['r_5adc09f13881da73', { tool: 'composite', layers: [], summary_data: { item_count: 12, scene_days: 12, p2: 0.056776, p98: 0.89247, mean: 0.57328, max: 0.92427, min: -0.33282, valid_pixel_pct: 94.62, area_km2: 36.2, dropped_small: 140, threshold_db: -18 } }],
  ['r_c46b93a869d29a56', { tool: 'composite', layers: [], summary_data: { mean: 0.1953, median: 0.1278, p25: 0.0897, p75: 0.2491, p95: 0.5468, max: 0.9125 } }],
  ['r_00000000000000b2', { tool: 'fetch_elevation_derivatives', layers: [], summary_data: { max_elevation_m: 4105, profile: [{ label: '0 km', value: 2966 }, { label: '3.83 km', value: 4105 }], area_km2: 16.1, building_count: 2374, centroid_lat: 13.51, monthly_climatology_mm: [{ label: 'Jun', value: 58 }, { label: 'Jul', value: 80 }, { label: 'Aug', value: 90 }, { label: 'Sep', value: 23 }, { label: 'Oct', value: 9 }] } }],
])
const liveStore = live as unknown as ResultStore
const QUESTION = 'Mean NDVI of this area in February 2024, and how much of it burned between 1 August and 20 August?'
const liveCheck = (s: string, texts: string[] = [QUESTION]) => checkAnswerGrounding(s, liveStore, [36.2, 16.1], texts)

describe('checkAnswerGrounding on the live evaluation flagged lines', () => {
  const FALSE_POSITIVES: Array<[string, string]> = [
    ['percentile ordinals', '**Percentile Bounds:** 2nd percentile (p2) was 0.057[[r_5adc09f13881da73#p2]], while the 98th percentile (p98) reached 0.892[[r_5adc09f13881da73#p98]].'],
    ['quartile names', 'The median NDVI of 0.128[[r_c46b93a869d29a56#median]] sits below the mean of 0.195[[r_c46b93a869d29a56#mean]], with the lower 25% below 0.090[[r_c46b93a869d29a56#p25]].'],
    ['p95 label', 'The upper tail reaches 0.913[[r_c46b93a869d29a56#max]], with the 95th percentile at 0.547[[r_c46b93a869d29a56#p95]].'],
    ['a figure written rounded half-up from a cited value', 'The scene maximum was 0.913 [[r_c46b93a869d29a56#max]].'],
    ['a day count and a date range', 'The composite blends clear observations across 6 dates (2024-02-01 to 2024-02-26).'],
    ['a +/- window', 'The clearest acquisition within ±30 days of mid-February was captured on 2024-03-12.'],
    ['a day-month date', 'By the time of the 13 September acquisition, much of the peak surge had discharged into the sea.'],
    ['month names and a year', 'Between 31 December 2019 and 6 January 2020 no Sentinel-2 pass achieved clear sky, and in March 2031 there is nothing yet.'],
    ['a month day range', 'The composite is the per-pixel median over the August 1-31 window.'],
    ['a 6-day window', 'Optical detection during this exact 6-day window was entirely obscured.'],
    ['an approximate window', 'The clearest scenes found within the ~45-day target windows were acquired in 2021 and 2024.'],
    ['a look-back window', 'The standard tool interfaces with near-real-time feeds (1-10 day look-back window).'],
    ['a threshold comparison', 'Land area (NDWI <= 0) covers most of the scene, and baseline vegetation has NBR >= 0.15 in the earlier scene.'],
    ['a class definition', 'Moderate slopes (15-30%) are common and very steep terrain (>60% slope) is rare.'],
    ['a min-area filter that the plan set (500 is in the arguments)', 'Pixel groups smaller than 500 m² were filtered out.'],
    ['coordinates', 'ERA5 is sampled at the AOI centroid (13.5100°N, 2.1100°E) on a ~25 km grid cell.'],
    ['lat/lon words', 'The point is lat 33.45, lon -112.07.'],
    ['a pixel size in a resolution sentence', 'Spatial resolution: approximately 10 meters, derived from a 9-class Sentinel-2 product.'],
    ['a quoted sub-metre note', 'The classifier notes that species identification requires sub-meter (<1 m) imagery; at 10 m resolution only vegetation type is possible.'],
    ['a band table', '- **B01** (Coastal aerosol, 60 m)'],
    ['a licence id', 'It is released under CC-BY-4.0.'],
    ['a list marker left alone by the sentence split', '**2.'],
    ['a complement of a cited share', 'Approximately 5.4% of the AOI lacked clear observations [[r_5adc09f13881da73#valid_pixel_pct]].'],
    ['a density from a count and the area', 'Approximately 147.5 buildings per km² across the AOI.'],
    ['a season total from cited monthly values', 'Expected June-September rainfall totals 251 mm [[r_00000000000000b2#monthly_climatology_mm]].'],
    ['a figure the plan or tool arguments contain', 'The threshold was 0.2 as requested.'],
    ['a profile value in the tool result', 'The profile climbs from 2966 m at the western boundary to 4105 m at 3.83 km.'],
  ]
  it.each(FALSE_POSITIVES)('does not flag: %s', (_label, sentence) => {
    expect(liveCheck(sentence, [QUESTION, '{"min_ndvi":0.2,"min_area_m2":500}'])).toEqual([])
  })

  it('does not flag a figure the question or the tool text already states', () => {
    expect(liveCheck('The fire burned between 1 August and 20 August.')).toEqual([])
    expect(liveCheck('Only 87.5% of the area was clear in the second epoch.', [QUESTION, 'second epoch: 87.5% clear'])).toEqual([])
  })

  const FABRICATIONS = [
    'The scene mean NDVI was 0.87, far above the regional norm.', // nowhere in any result
    'About 63% of the area burned.',
    'The summit reaches 4478 m.', // true in the world, absent from every result: still unsupported by this run
    'Flooded buildings number 1,284.',
    'Mean NDVI was 0.61 [[r_c46b93a869d29a56#mean]].', // a citation that does not match, and 0.61 is nowhere else
  ]
  it.each(FABRICATIONS)('still flags the unsupported figure: %s', (sentence) => {
    expect(liveCheck(sentence)).toHaveLength(1)
  })

  it('flags a citation that points at nothing even when the figure exists elsewhere', () => {
    expect(liveCheck('Mean NDVI was 0.573 [[r_5adc09f13881da73#nope]].')).toHaveLength(1)
  })
})
