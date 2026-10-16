import { describe, expect, it } from 'vitest'

import type { OperationInfo, SchemaProp } from '../operations-client'
import { isDatePinnable, planPins, type PinScene } from '../scene-pins'

const op = (name: string, props: Record<string, SchemaProp>, sensors: string[]): OperationInfo => ({
  name, version: '1', description: '', params: { properties: props, required: [] }, output: 'raster', sensors,
  resolution_m: 10, limits: { maxAreaKm2: 5000, minAreaKm2: null, earliest: null, needsDates: true }, cost: { typicalSeconds: 10 }, limitations: [], confidence: '',
})

const str: SchemaProp = { type: 'string' }
const FETCH_NDVI = op('fetch_ndvi', { product: { type: 'string', enum: ['ndvi', 'imagery'] }, date: str, scene_id: str }, ['sentinel-2-l2a'])
const RENDER = op('render_raster', { sensor: { type: 'string', enum: ['sentinel-2-l2a', 'landsat-c2-l2'] }, date: str, scene_id: str, start: str, end: str }, ['sentinel-2-l2a', 'landsat-c2-l2'])
const THERMAL = op('fetch_thermal', { start: str, end: str }, ['landsat-c2-l2'])
const CHANGE = op('detect_change', { before: str, after: str }, ['sentinel-2-l2a'])
const ANALYZE = op('analyze_raster', { operation: { type: 'string' }, date: str, date2: str }, ['sentinel-2-l2a'])
const BUILT = op('fetch_built_surface', {}, ['ghsl'])

const s = (id: string, date: string, sensor: PinScene['sensor'] = 'sentinel-2'): PinScene => ({ id, date, sensor })
const A = s('S2A_A', '2019-03-01')
const B = s('S2B_B', '2024-03-02')

describe('planPins', () => {
  it('pins one run per chosen scene with the exact item and its date', () => {
    const p = planPins(FETCH_NDVI, [B, A], 'Fetch ndvi')
    expect(p.problems).toEqual([])
    expect(p.runs.map((r) => r.args)).toEqual([{ scene_id: 'S2A_A', date: '2019-03-01' }, { scene_id: 'S2B_B', date: '2024-03-02' }])
    expect(p.runs[0].label).toBe('Fetch ndvi 2019-03-01')
    expect(p.pinned).toEqual(['scene_id', 'date'])
  })

  it('names the sensor for an operation that takes one', () => {
    const p = planPins(RENDER, [s('LC08_X', '2020-05-05', 'landsat')], 'Render raster')
    expect(p.runs[0].args).toEqual({ sensor: 'landsat-c2-l2', scene_id: 'LC08_X', date: '2020-05-05' })
  })

  it('uses a one-day window for an operation with a period only', () => {
    const p = planPins(THERMAL, [s('LC08_X', '2020-05-05', 'landsat')], 'Fetch thermal')
    expect(p.runs[0].args).toEqual({ start: '2020-05-05', end: '2020-05-05' })
  })

  it('maps two scenes onto a before and after pair, the earlier first, as one run', () => {
    const p = planPins(CHANGE, [B, A], 'Detect change')
    expect(p.runs).toHaveLength(1)
    expect(p.runs[0].args).toEqual({ before: '2019-03-01', after: '2024-03-02' })
    const q = planPins(ANALYZE, [A, B], 'Analyze raster')
    expect(q.runs[0].args).toEqual({ date: '2019-03-01', date2: '2024-03-02' })
  })

  it('refuses a pair operation for one or three scenes, one sensor mix or one date', () => {
    expect(planPins(CHANGE, [A], 'Detect change').problems[0]).toMatch(/exactly two/)
    expect(planPins(CHANGE, [A, B, s('S2C', '2021-01-01')], 'Detect change').problems[0]).toMatch(/exactly two/)
    expect(planPins(CHANGE, [A, s('L', '2020-01-01', 'landsat')], 'Detect change').problems[0]).toMatch(/Landsat|reads/)
    expect(planPins(CHANGE, [A, s('S2X', '2019-03-01')], 'Detect change').problems[0]).toMatch(/two different dates/)
  })

  it('refuses a scene of a sensor the operation does not read, rather than pinning it to another', () => {
    expect(planPins(FETCH_NDVI, [s('LC08_X', '2020-05-05', 'landsat')], 'Fetch ndvi').problems[0]).toMatch(/reads sentinel-2-l2a, not Landsat/)
    expect(planPins(RENDER, [s('S1A', '2020-05-05', 'sentinel-1')], 'Render raster').problems[0]).toMatch(/does not read Sentinel-1/)
  })

  it('refuses an operation with no date argument and an empty choice', () => {
    expect(isDatePinnable(BUILT)).toBe(false)
    expect(planPins(BUILT, [A], 'Fetch built surface').problems[0]).toMatch(/no date or scene argument/)
    expect(planPins(FETCH_NDVI, [], 'Fetch ndvi').problems[0]).toMatch(/at least one scene/)
  })
})
