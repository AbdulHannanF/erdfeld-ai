import { describe, expect, it } from 'vitest'

import type { ResultLayer } from '@/app/api/agent/lib/types'

import { GEO_RESULT_SCHEMA, type GeoResult } from '../geo-result'
import { geoResultMessages, geoResultVizMessages, layerEventPayload } from '../layer-event'
import { useStore } from '../../store/useStore'

const layer: ResultLayer = {
  id: 'ndvi-active', name: 'NDVI', type: 'raster', tileUrl: 'https://t/{z}/{x}/{y}.png', bounds: [1, 2, 3, 4], aoiMask: true,
  provenance: { source: 'Sentinel-2 L2A (AWS Element84 Earth Search) — NDVI', method: 'm', clip: 'polygon' },
}
const result = (over: Partial<GeoResult> = {}): GeoResult => ({
  schema: GEO_RESULT_SCHEMA, result_id: 'r_1', op: { name: 'fetch_ndvi', version: '1.0.0' }, status: 'flagged', summary: 'NDVI mean 0.4',
  layers: [layer], stats: { mean: 0.4 }, provenance: { sources: [], items: ['S2_x'], method: 'm', inputs_hash: 'h' },
  validation: [{ id: 'index_range', phase: 'dynamic', status: 'fail', message: 'mean outside the index range' }], ...over,
})

describe('layerEventPayload', () => {
  it('carries the snake_case fields the client reads, plus the provisional flag', () => {
    const p = layerEventPayload(layer, { provisional: true, tool: 'fetch_ndvi' })
    expect(p).toMatchObject({ type: 'layer', layer_id: 'ndvi-active', tile_url: layer.tileUrl, aoi_mask: true, provisional: true, tier: 'free-10m' })
  })
})

describe('geoResultMessages (a GeoResult drawn the way an agent result is)', () => {
  it('yields the completed tool_call with the verdict, one layer event per layer, and a zoom', () => {
    const msgs = geoResultMessages(result())
    expect(msgs.map((m) => m.type)).toEqual(['tool_call', 'layer', 'zoom_to'])
    expect(msgs[0]).toMatchObject({ status: 'completed', result_id: 'r_1', result_status: 'flagged', summary_data: { mean: 0.4 } })
    expect(msgs[0].validation[0].id).toBe('index_range')
    expect(msgs[1]).toMatchObject({ layer_id: 'ndvi-active', provisional: false, result_status: 'flagged', result_id: 'r_1' })
    expect(msgs[2].bbox).toEqual([1, 2, 3, 4])
  })

  it('marks a refused result as an error and draws nothing', () => {
    const msgs = geoResultMessages(result({ status: 'refused', layers: [], stats: undefined }))
    expect(msgs.map((m) => m.type)).toEqual(['tool_call'])
    expect(msgs[0].status).toBe('error')
  })
})

describe('a preview and its final layer are one layer in the store', () => {
  it('addLayer merges by id, replaces the stretch, clears provisional and any tile-failure flag', () => {
    const s = useStore.getState()
    s.addLayer({ id: 'ndvi-active', name: 'NDVI · statistics computing', type: 'raster', tileUrl: 'u1', visible: true, opacity: 0.75, provisional: true })
    s.setLayerExpired('ndvi-active', true)
    s.addLayer({ id: 'ndvi-active', name: 'NDVI', type: 'raster', tileUrl: 'u2', visible: true, opacity: 0.75, provisional: false, resultId: 'r_1' })
    const same = useStore.getState().layers.filter((l) => l.id === 'ndvi-active')
    expect(same).toHaveLength(1)
    expect(same[0]).toMatchObject({ name: 'NDVI', tileUrl: 'u2', provisional: false, resultId: 'r_1', expired: false })
    s.removeLayer('ndvi-active')
  })
})

describe('geoResultVizMessages (the chart and restyle events of a queued make_chart / style_layer)', () => {
  it('yields the layer_style and one chart event per chart, in the shape the agent route sends', () => {
    const msgs = geoResultVizMessages(result({
      status: 'ok', layers: [],
      layer_style: { layer_id: 'layer-a', style: { property: 'height', kind: 'graduated' }, legend: [] },
      charts: [{ id: 'chart-1', title: 'Heights', spec: { mark: 'bar' }, layerId: 'layer-a' }],
    }))
    expect(msgs).toEqual([
      { type: 'layer_style', layer_id: 'layer-a', vector_style: { property: 'height', kind: 'graduated' }, result_id: 'r_1' },
      { type: 'chart', chart_id: 'chart-1', title: 'Heights', spec: { mark: 'bar' }, layer_id: 'layer-a', result_id: 'r_1' },
    ])
  })
  it('a result with neither yields nothing, and geoResultMessages never carries them (an agent run emits charts itself)', () => {
    expect(geoResultVizMessages(result())).toEqual([])
    const withChart = result({ charts: [{ id: 'c', title: 't', spec: {} }] })
    expect(geoResultMessages(withChart).map((m) => m.type)).toEqual(['tool_call', 'layer', 'zoom_to'])
  })
})
