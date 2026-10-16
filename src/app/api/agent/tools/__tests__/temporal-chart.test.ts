/** fetch_temporal_stack declares output "chart": it returns a real Vega-Lite time series (the figures
 *  also stay citable in summary_data), and draws nothing through a date with no clear pixel. */

import { describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/index-stats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/index-stats')>()
  return { ...actual, maskedIndexStats: vi.fn() }
})

import { validateVegaLite } from '../../lib/chart-data'
import { maskedIndexStats } from '../../lib/index-stats'
import { buildNdviSeriesChart, fetchTemporalStack } from '../satellite'

const series = [
  { label: '2026-05-02', value: 0.31 }, { label: '2026-06-11', value: 0.52 }, { label: '2026-07-21', value: 0.64 },
]
const cloud = [{ label: '2026-05-02', value: 4 }, { label: '2026-06-11', value: 12 }, { label: '2026-07-21', value: 0 }]

describe('buildNdviSeriesChart', () => {
  it('is a valid Vega-Lite line with points over a temporal axis, one row per clear acquisition', () => {
    const chart = buildNdviSeriesChart(series, cloud)!
    expect(chart.id).toMatch(/^chart-/)
    expect(chart.title).toMatch(/NDVI/)
    expect(validateVegaLite(chart.spec).ok).toBe(true)
    expect(chart.spec.data.values).toEqual([
      { date: '2026-05-02', ndvi: 0.31, aoi_cloud_pct: 4 },
      { date: '2026-06-11', ndvi: 0.52, aoi_cloud_pct: 12 },
      { date: '2026-07-21', ndvi: 0.64, aoi_cloud_pct: 0 },
    ])
    expect(chart.spec.encoding.x).toMatchObject({ field: 'date', type: 'temporal' })
    expect(chart.spec.encoding.y).toMatchObject({ field: 'ndvi', type: 'quantitative' })
    expect(chart.spec.layer.map((l: any) => l.mark.type)).toEqual(['line', 'point'])
  })

  it('one acquisition is not a series: no chart', () => {
    expect(buildNdviSeriesChart(series.slice(0, 1), cloud)).toBeNull()
    expect(buildNdviSeriesChart([], [])).toBeNull()
  })
})

describe('fetch_temporal_stack', () => {
  const items = ['2026-05-02', '2026-06-11', '2026-07-21', '2026-08-30'].map((d) => ({
    id: `S2_${d}`, bbox: [10, 10, 10.2, 10.2],
    properties: { datetime: `${d}T08:00:00Z`, 'eo:cloud_cover': 8 },
    links: [{ rel: 'self', href: `https://earth-search/items/S2_${d}` }],
    assets: { nir: { href: 'n' }, red: { href: 'r' } },
  }))
  const AOI = { type: 'Polygon', coordinates: [[[10, 10], [10.2, 10], [10.2, 10.2], [10, 10.2], [10, 10]]] }
  const ctx = (): any => ({ aoi: AOI, bbox: [10, 10, 10.2, 10.2], centroid: { lat: 10.1, lng: 10.1 }, areaKm2: 480, emit: vi.fn(), runTool: vi.fn() })

  it('emits the chart, leaves a gap for the clouded date, and keeps the figures citable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: items }))))
    const mean: Record<string, number> = { 'S2_2026-05-02': 0.31, 'S2_2026-06-11': 0.52, 'S2_2026-07-21': 0.64 }
    vi.mocked(maskedIndexStats).mockImplementation(async (item: any) => {
      if (item.id === 'S2_2026-08-30') return { ok: false, failure: { reason: 'too_cloudy', clearPct: 5, message: 'cloud' } } as any
      return { ok: true, stats: { mean: mean[item.id], clearPct: 90 } } as any
    })
    const res = await fetchTemporalStack(ctx(), { months: 6 })
    vi.unstubAllGlobals()
    expect(res.charts).toHaveLength(1)
    const rows = res.charts![0].spec.data.values
    expect(rows.map((r: any) => r.date)).toEqual(['2026-05-02', '2026-06-11', '2026-07-21']) // the clouded date is a gap, not a point
    expect(rows.map((r: any) => r.ndvi)).toEqual([0.31, 0.52, 0.64])
    expect(res.summary_data!.ndvi_by_date).toHaveLength(3)
    expect(res.layer!.aoiMask).toBe(true)
  })
})
