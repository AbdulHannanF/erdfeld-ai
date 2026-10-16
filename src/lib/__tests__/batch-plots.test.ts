import { describe, expect, it } from 'vitest'

import { MAX_BATCH_PLOTS as SERVER_MAX } from '../api-schemas'
import { MAX_BATCH_PLOTS, plotsFromFeatures, squareAround } from '../batch-plots'
import { VERDICT_COLOR } from '../case-batch'
import { CATEGORICAL_PALETTE } from '../categorical-palette'
import { parseSse } from '../job-events'

const ring = [[74.4, 31], [74.403, 31], [74.403, 30.997], [74.4, 30.997], [74.4, 31]]
const feat = (geometry: GeoJSON.Geometry | null, properties: Record<string, unknown> = {}): GeoJSON.Feature => ({ type: 'Feature', geometry: geometry as any, properties })
const fc = (...features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features })

describe('plotsFromFeatures', () => {
  it('takes polygons as plots, names them, and reads parameter columns per plot', () => {
    const r = plotsFromFeatures(fc(
      feat({ type: 'Polygon', coordinates: [ring] }, { name: 'North 4', date: '2025-09-04', tolerance_days: 3, other: 'x' }),
      feat({ type: 'Polygon', coordinates: [ring] }, { date: '', id: 7 }),
    ), ['date', 'tolerance_days'])
    expect(r.plots.map((p) => p.name)).toEqual(['North 4', '7'])
    expect(r.plots[0].params).toEqual({ date: '2025-09-04', tolerance_days: 3 })
    expect(r.plots[1].params).toBeUndefined()
    expect(r.paramColumns.sort()).toEqual(['date', 'tolerance_days'])
  })

  it('skips what is not one plot, with the reason, and never guesses a size for a point', () => {
    const geoms = fc(
      feat({ type: 'MultiPolygon', coordinates: [[ring], [ring]] }), feat({ type: 'MultiPolygon', coordinates: [[ring]] }),
      feat({ type: 'LineString', coordinates: ring }), feat({ type: 'Point', coordinates: [74.4, 31] }), feat(null),
    )
    const r = plotsFromFeatures(geoms, [])
    expect(r.plots).toHaveLength(1)
    expect(r.skipped.map((s) => s.index)).toEqual([0, 2, 3, 4])
    expect(r.skipped[2].reason).toMatch(/no plot size/)
    expect(r.pointCount).toBe(1)
    const buffered = plotsFromFeatures(geoms, [], { halfSideM: 100 })
    expect(buffered.plots).toHaveLength(2)
  })

  it('builds a square of the stated size around a point', () => {
    const [[a, , c]] = squareAround([74.4, 31], 100).coordinates
    expect(Math.abs(c[1] - a[1]) * 111_320).toBeCloseTo(200, 0)
    expect(Math.abs(c[0] - a[0]) * 111_320 * Math.cos((31 * Math.PI) / 180)).toBeCloseTo(200, 0)
  })

  it('flags more plots than a batch may hold, and matches the server cap', () => {
    const many = fc(...Array.from({ length: MAX_BATCH_PLOTS + 1 }, () => feat({ type: 'Polygon', coordinates: [ring] })))
    expect(plotsFromFeatures(many, []).tooMany).toBe(true)
    expect(MAX_BATCH_PLOTS).toBe(SERVER_MAX)
  })
})

describe('verdict colours', () => {
  it('are palette data colours, never brand teal, with Cannot determine neutral grey', () => {
    expect(VERDICT_COLOR.supported).toBe(CATEGORICAL_PALETTE[0])
    expect(VERDICT_COLOR.contradicted).toBe(CATEGORICAL_PALETTE[1])
    const g = VERDICT_COLOR.cannot_determine.slice(1).match(/../g)!.map((h) => parseInt(h, 16))
    expect(Math.max(...g) - Math.min(...g)).toBeLessThan(24)
  })
})

describe('parseSse', () => {
  it('parses complete events, drops keepalives and keeps the unfinished tail', () => {
    const { events, rest } = parseSse(': keepalive\n\nid: 3\nevent: job_done\ndata: {"progress":{"done":1}}\n\nid: 4\nevent: batch_do')
    expect(events).toEqual([{ id: 3, type: 'job_done', data: { progress: { done: 1 } } }])
    expect(rest).toBe('id: 4\nevent: batch_do')
  })
})
