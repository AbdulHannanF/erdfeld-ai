import { describe, expect, it } from 'vitest'
import type { CitableToolResult } from '@/lib/citations'
import type { GeoResult } from '@/lib/geo-result'
import type { MapLayer, ToolCallStatus } from '@/store/useStore'
import { caveats, citedFigures, humanizeKey, keyFigures, pluralise, runHeadline, stepOutcome, summariseRun } from '../derive'

const call = (o: Partial<ToolCallStatus>): ToolCallStatus => ({ toolName: 't', label: 'Step', status: 'completed', ...o })
const results: Record<string, CitableToolResult> = {
  r_1: { tool: 'fetch_dem', resultId: 'r_1', summaryData: { mean_elevation_m: 412.4, terrain_class: 'rolling', series: [{ label: 'a', value: 1 }] }, confidence: 'high' },
  r_2: { tool: 'fetch_ndvi', resultId: 'r_2', summaryData: { mean: 0.4137 }, confidence: 'low' },
}
const ref = (resultId: string, key: string) => ({ raw: '', resultId, key, index: 0 })
const layer = (resultId: string): MapLayer => ({ id: 'l', name: 'L', type: 'geojson', visible: true, opacity: 1, resultId })

describe('stepOutcome', () => {
  it('tells a fetch failure from a refusal and from "ran and found nothing"', () => {
    expect(stepOutcome(call({ status: 'running' }), results, [])).toBe('running')
    expect(stepOutcome(call({ status: 'error', errorText: 'HTTP 503' }), results, [])).toBe('failed')
    expect(stepOutcome(call({ status: 'error', verdict: { status: 'refused', checks: [] } }), results, [])).toBe('refused')
    expect(stepOutcome(call({ verdict: { status: 'flagged', checks: [] } }), results, [])).toBe('flagged')
    expect(stepOutcome(call({ resultId: 'r_empty' }), results, [])).toBe('no_data')
    expect(stepOutcome(call({ resultId: 'r_empty' }), results, [layer('r_empty')])).toBe('ok')
    expect(stepOutcome(call({ resultId: 'r_1' }), results, [])).toBe('ok')
  })
})

describe('summariseRun', () => {
  it('is answered when at least one step produced evidence', () => {
    const s = summariseRun([call({ resultId: 'r_1' }), call({ status: 'error', errorText: 'x' })], results, [], false)
    expect(s.state).toBe('answered')
    expect(s.reasons).toHaveLength(1)
  })

  it('is refused only when every step was refused, and carries the failed checks as the reason', () => {
    const verdict = { status: 'refused' as const, checks: [{ id: 'aoi_area', phase: 'static' as const, status: 'fail' as const, message: 'The area is too large.' }] }
    const s = summariseRun([call({ status: 'error', verdict, label: 'NDVI' })], results, [], false)
    expect(s.state).toBe('refused')
    expect(s.reasons[0]).toMatchObject({ label: 'NDVI', text: 'The area is too large.' })
  })

  it('is failed when the data could not be read, and cannot_determine when it was read but empty', () => {
    expect(summariseRun([call({ status: 'error', errorText: 'HTTP 503' })], results, [], false).state).toBe('failed')
    expect(summariseRun([call({ resultId: 'r_empty' })], results, [], false).state).toBe('cannot_determine')
  })

  it('is running while loading, whatever the steps say', () => {
    expect(summariseRun([call({ status: 'error' })], results, [], true).state).toBe('running')
  })
})

describe('figures', () => {
  it('writes cited scalars as sentences with their unit and the range the result recorded', () => {
    const details = { r_1: { uncertainty: { notes: [], ranges: { mean_elevation_m: [398, 431.5] } } } as unknown as GeoResult }
    const f = citedFigures([ref('r_1', 'mean_elevation_m'), ref('r_1', 'mean_elevation_m'), ref('r_1', 'terrain_class'), ref('r_1', 'series')], results, details)
    expect(f.map((x) => x.sentence)).toEqual([
      'Mean elevation is 412.4 m (range 398 m to 431.5 m).',
      'Terrain class is rolling.',
    ])
  })

  it('skips citations that do not resolve rather than inventing a value', () => {
    expect(citedFigures([ref('r_missing', 'x'), ref('r_1', 'nope')], results, {})).toEqual([])
  })

  it('the headline carries the range, or says low confidence when there is no range', () => {
    const withRange = citedFigures([ref('r_1', 'mean_elevation_m')], results, { r_1: { uncertainty: { notes: [], ranges: { mean_elevation_m: [398, 431] } } } as unknown as GeoResult })
    expect(runHeadline(withRange, [], results)?.text).toBe('412.4 m, range 398 m to 431 m')
    const low = citedFigures([ref('r_2', 'mean')], results, {})
    expect(runHeadline(low, [], results)).toMatchObject({ text: '0.414, low confidence', lowConfidence: true })
    expect(runHeadline([], [], results)).toBeNull()
  })

  it('a dataset search hit count is never the headline', () => {
    const search: Record<string, CitableToolResult> = { r_s: { tool: 'find_dataset', resultId: 'r_s', summaryData: { match_count: 8 } } }
    const figs = citedFigures([ref('r_s', 'match_count')], search, {})
    expect(figs).toHaveLength(1)
    expect(runHeadline(figs, [], search)).toBeNull()
  })

  it('humanizes keys without their unit suffix', () => {
    expect(humanizeKey('flood_area_km2')).toBe('Flood area')
    expect(humanizeKey('mean')).toBe('Mean')
  })
})

describe('caveats', () => {
  it('collects notes, warned or failed checks and low confidence, once each', () => {
    const details = {
      r_1: {
        uncertainty: { notes: ['Resolution is 30 m.', 'Resolution is 30 m.'] },
        validation: [
          { id: 'a', phase: 'dynamic', status: 'pass', message: 'ok' },
          { id: 'b', phase: 'dynamic', status: 'warn', message: 'Few clear pixels.' },
        ],
      } as unknown as GeoResult,
    }
    expect(caveats(['r_1', 'r_2'], results, details)).toEqual(['Resolution is 30 m.', 'Few clear pixels.', 'fetch ndvi has low confidence.'])
  })
})

describe('field headline and key figures', () => {
  const fieldsResult = (data: CitableToolResult['summaryData'], confidence: CitableToolResult['confidence'] = 'medium'): Record<string, CitableToolResult> => ({
    r_f: { tool: 'delineate_fields', resultId: 'r_f', summaryData: data, confidence },
  })
  const full = { field_count: 40, total_field_area_ha: 142.3, mean_field_area_ha: 3.56, grid_gsd_m: 10, median_confidence: 0.62 }

  it('reads "<count> <unit> · <area>" from the result fields, with the class only when one was recorded', () => {
    expect(runHeadline([], ['r_f'], fieldsResult(full))).toMatchObject({ text: '40 fields · 142.3 ha' })
    expect(runHeadline([], ['r_f'], fieldsResult({ ...full, dominant_class: 'summer crop' }))?.text).toBe('40 fields · 142.3 ha of summer crop')
  })

  it('pluralises the unit and never prints an area for no fields', () => {
    expect(runHeadline([], ['r_f'], fieldsResult({ ...full, field_count: 1 }))?.text).toBe('1 field · 142.3 ha')
    expect(runHeadline([], ['r_f'], fieldsResult({ field_count: 0, total_field_area_ha: 0 }))?.text).toBe('0 fields')
    expect(pluralise(2, 'class')).toBe('classes')
    expect(pluralise(2, 'city')).toBe('cities')
  })

  it('has no headline when the result recorded no field count, instead of guessing one', () => {
    expect(runHeadline([], ['r_f'], fieldsResult({ total_field_area_ha: 142 }))).toBeNull()
    expect(runHeadline([], ['r_f'], fieldsResult({ field_count: 'many' }))).toBeNull()
    expect(runHeadline([], ['r_missing'], fieldsResult(full))).toBeNull()
  })

  it('a cited count reads as a count, not as "40 field count"', () => {
    const rs = fieldsResult({ field_count: 40 })
    const figs = citedFigures([ref('r_f', 'field_count')], rs, {})
    expect(runHeadline(figs, [], rs)).toMatchObject({ text: '40 fields' })
    expect(runHeadline(figs, [], rs)?.label).toBeUndefined()
  })

  it('key figures are the recorded mean field size, pixel size and median confidence only', () => {
    expect(keyFigures(['r_f'], fieldsResult(full))).toEqual([
      { label: 'Mean field size', value: '3.56 ha' },
      { label: 'Pixel size', value: '10 m' },
      { label: 'Median confidence', value: '0.62' },
    ])
    expect(keyFigures(['r_f'], fieldsResult({ field_count: 40, grid_gsd_m: 10 }))).toEqual([{ label: 'Pixel size', value: '10 m' }])
    expect(keyFigures(['r_f'], fieldsResult({ field_count: 0, mean_field_area_ha: 0, median_confidence: 0 }))).toEqual([])
    expect(keyFigures([], fieldsResult(full))).toEqual([])
  })
})

describe('humanizeKey acronyms', () => {
  it('keeps remote-sensing acronyms upper-case', async () => {
    const { humanizeKey } = await import('../derive')
    expect(humanizeKey('mean_ndvi')).toBe('Mean NDVI')
    expect(humanizeKey('dnbr_mean')).toBe('dNBR mean')
  })
})
