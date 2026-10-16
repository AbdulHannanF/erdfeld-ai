import { describe, expect, it } from 'vitest'
import { makeChart, styleLayer } from '../viz'
import { storeResult } from '../../lib/chart-data'
import type { ResultStore, ToolCtx } from '../../lib/types'

function ctxWith(): ToolCtx {
  const results: ResultStore = new Map()
  storeResult(results, 'fetch_temporal_stack-0', 'fetch_temporal_stack', {
    ndvi_by_date: [{ label: '2025-05-01', value: 0.3 }, { label: '2025-06-01', value: 0.5 }],
  }, [])
  storeResult(results, 'query_osm-1', 'query_osm', { count: 3 }, [
    {
      id: 'osm-fields', name: 'Fields', type: 'geojson',
      geojson: {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: { crop: 'maize', ndvi: 0.2 }, geometry: null },
          { type: 'Feature', properties: { crop: 'wheat', ndvi: 0.5 }, geometry: null },
          { type: 'Feature', properties: { crop: 'wheat', ndvi: 0.9 }, geometry: null },
        ],
      },
    },
  ])
  return { results } as unknown as ToolCtx
}

describe('style_layer', () => {
  it('returns a layer_style update for a numeric property (graduated by default)', async () => {
    const r = await styleLayer(ctxWith(), { result_id: 'query_osm-1', property: 'ndvi', colormap: 'rdylgn', num_classes: 3 })
    expect(r.layer_style).toMatchObject({
      layer_id: 'osm-fields',
      style: { property: 'ndvi', kind: 'graduated', colormap: 'rdylgn', numClasses: 3 },
    })
    expect(r.layer_style!.legend).toHaveLength(3)
    expect(r.layer).toBeUndefined()
  })
  it('addresses the layer by layer_id and infers categorical for text', async () => {
    const r = await styleLayer(ctxWith(), { layer_id: 'osm-fields', property: 'crop' })
    expect(r.layer_style!.style.kind).toBe('categorical')
    expect(r.layer_style!.legend.map((l) => l.label)).toEqual(['wheat', 'maize'])
  })
  it('an unknown property is an honest error listing the real ones', async () => {
    const r = await styleLayer(ctxWith(), { layer_id: 'osm-fields', property: 'median_ndvi' })
    expect(r.layer_style).toBeUndefined()
    expect(r.summary).toContain('"median_ndvi" does not exist')
    expect(r.summary).toContain('ndvi (number)')
  })
  it('refuses graduating text, unknown layers, results without vector features and bad input', async () => {
    const ctx = ctxWith()
    expect((await styleLayer(ctx, { layer_id: 'osm-fields', property: 'crop', kind: 'graduated' })).summary).toMatch(/categorical/)
    expect((await styleLayer(ctx, { layer_id: 'nope', property: 'ndvi' })).summary).toMatch(/No styleable layer.*osm-fields/)
    expect((await styleLayer(ctx, { result_id: 'fetch_temporal_stack-0', property: 'ndvi' })).summary).toMatch(/No styleable layer/)
    expect((await styleLayer(ctx, { property: 'ndvi' })).summary).toMatch(/layer_id/)
    expect((await styleLayer(ctx, { layer_id: 'osm-fields' })).summary).toMatch(/property/)
    expect((await styleLayer(ctx, { layer_id: 'osm-fields', property: 'ndvi', colormap: 'zzz' })).summary).toMatch(/Unknown colormap/)
    expect((await styleLayer(ctx, { layer_id: 'osm-fields', property: 'ndvi', classes: [{ value: 'a', color: '#fff' }] })).summary).toMatch(/categorical/)
  })
  it('accepts explicit categorical classes', async () => {
    const r = await styleLayer(ctxWith(), {
      layer_id: 'osm-fields', property: 'crop',
      classes: [{ value: 'maize', label: 'Maize', color: '#facc15' }, { value: 'wheat', color: '#a16207' }],
    })
    expect(r.layer_style!.style.classes).toEqual([
      { value: 'maize', label: 'Maize', color: '#facc15' },
      { value: 'wheat', label: 'wheat', color: '#a16207' },
    ])
  })
})

describe('make_chart', () => {
  const spec = {
    data: { name: 'fetch_temporal_stack-0#ndvi_by_date' },
    mark: 'line',
    encoding: { x: { field: 'date', type: 'temporal' }, y: { field: 'value', type: 'quantitative' } },
  }
  it('returns a chart with the real rows inlined', async () => {
    const r = await makeChart(ctxWith(), { spec, title: 'NDVI over time' })
    expect(r.charts).toHaveLength(1)
    expect(r.charts![0]).toMatchObject({ title: 'NDVI over time', layerId: undefined })
    expect(r.charts![0].spec.data.values).toEqual([
      { label: '2025-05-01', value: 0.3, date: '2025-05-01' },
      { label: '2025-06-01', value: 0.5, date: '2025-06-01' },
    ])
    expect(r.summary).toContain('fetch_temporal_stack-0#ndvi_by_date')
  })
  it('accepts a JSON-string spec and links #features charts to their layer', async () => {
    const featSpec = { data: { name: 'query_osm-1#features' }, mark: 'point', encoding: { x: { field: 'ndvi', type: 'quantitative' } } }
    const r = await makeChart(ctxWith(), { spec: JSON.stringify(featSpec) })
    expect(r.charts![0].layerId).toBe('osm-fields')
    expect(r.charts![0].spec.data.values[0]).toEqual({ crop: 'maize', ndvi: 0.2, _fid: 0 })
  })
  it('rejects invented numbers, unknown names, bad JSON and empty sessions', async () => {
    const ctx = ctxWith()
    const inline = await makeChart(ctx, { spec: { ...spec, data: { values: [{ date: '2025-01-01', value: 9 }] } } })
    expect(inline.charts).toBeUndefined()
    expect(inline.summary).toMatch(/Chart rejected: Inline `data.values` is not allowed/)
    const unknown = await makeChart(ctx, { spec: { ...spec, data: { name: 'zzz-1#a' } } })
    expect(unknown.summary).toMatch(/Unknown data name "zzz-1#a"[\s\S]*fetch_temporal_stack-0#ndvi_by_date/)
    expect((await makeChart(ctx, { spec: '{oops' })).summary).toMatch(/not valid JSON/)
    expect((await makeChart({ results: new Map() } as unknown as ToolCtx, { spec })).summary).toMatch(/no tool results/)
  })
})
