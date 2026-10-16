/**
 * Client handling of the `chart` and `layer_style` SSE events, against the real store.
 * Also pins the manifest contribution of vector layers and the chart snapshot that keeps
 * a finalized answer's charts after the next query clears the live slice.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { useStore, type MapLayer } from '@/store/useStore'
import { MAX_MANIFEST_FEATURES, applyVizEvent, manifestFeatures } from '../viz-events'

const vecLayer = (id: string, over: Partial<MapLayer> = {}): MapLayer => ({
  id, name: id, type: 'geojson', visible: true, opacity: 0.75,
  geojson: {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { ndvi: 0.3, crop: 'maize', meta: { a: 1 } }, geometry: { type: 'Point', coordinates: [0, 0] } },
      { type: 'Feature', properties: { ndvi: 0.7, crop: 'wheat' }, geometry: { type: 'Point', coordinates: [1, 1] } },
    ],
  },
  ...over,
})

beforeEach(() => {
  useStore.getState().resetSession()
})

describe('chart event', () => {
  const ev = { type: 'chart', chart_id: 'chart-1', title: 'NDVI', spec: { mark: 'bar', data: { values: [{ a: 1 }] } }, layer_id: 'L1', result_id: 'make_chart-2' }

  it('adds the chart to the live slice', () => {
    expect(applyVizEvent(ev)).toBe(true)
    expect(useStore.getState().charts).toEqual([{ id: 'chart-1', title: 'NDVI', spec: ev.spec, layerId: 'L1' }])
  })
  it('replaces a chart re-sent with the same id and defaults a missing title', () => {
    applyVizEvent(ev)
    applyVizEvent({ ...ev, title: '' })
    expect(useStore.getState().charts).toHaveLength(1)
    expect(useStore.getState().charts[0].title).toBe('Chart')
  })
  it('ignores malformed events', () => {
    expect(applyVizEvent({ type: 'chart', title: 'x', spec: {} })).toBe(false)
    expect(applyVizEvent({ type: 'chart', chart_id: 'c', spec: 'nope' })).toBe(false)
    expect(useStore.getState().charts).toEqual([])
  })
  it('the finalized message keeps its charts after the live slice is cleared', () => {
    const s = useStore.getState()
    s.addMessage({ id: 'a1', role: 'assistant', content: '', timestamp: 1 })
    applyVizEvent(ev)
    s.appendStreamingContent('Here is the chart.')
    s.mergeStreamingToMessages()
    s.clearCharts()
    const msg = useStore.getState().messages[0]
    expect(msg.charts?.map((c) => c.id)).toEqual(['chart-1'])
    expect(useStore.getState().charts).toEqual([])
  })
  it('resetSession clears charts and the highlight', () => {
    applyVizEvent(ev)
    useStore.getState().setHighlight({ layerId: 'L1', fid: 2 })
    useStore.getState().resetSession()
    expect(useStore.getState().charts).toEqual([])
    expect(useStore.getState().highlight).toBeNull()
  })
})

describe('layer_style event', () => {
  const ev = { type: 'layer_style', layer_id: 'L1', vector_style: { property: 'ndvi', kind: 'graduated', colormap: 'rdylgn' } }

  it('sets the style on an existing layer without touching its data', () => {
    useStore.getState().addLayer(vecLayer('L1'))
    const before = useStore.getState().layers[0].geojson
    expect(applyVizEvent(ev)).toBe(true)
    const l = useStore.getState().layers[0]
    expect(l.vectorStyle).toEqual(ev.vector_style)
    expect(l.geojson).toBe(before)
  })
  it('ignores a style for a layer that is not on the map, and malformed styles', () => {
    expect(applyVizEvent(ev)).toBe(false)
    useStore.getState().addLayer(vecLayer('L1'))
    expect(applyVizEvent({ type: 'layer_style', layer_id: 'L1', vector_style: {} })).toBe(false)
    expect(applyVizEvent({ type: 'layer_style', vector_style: ev.vector_style })).toBe(false)
    expect(useStore.getState().layers[0].vectorStyle).toBeUndefined()
  })
  it('a client-side restyle (LayerPanel) replaces and clears the style', () => {
    useStore.getState().addLayer(vecLayer('L1'))
    applyVizEvent(ev)
    useStore.getState().setLayerVectorStyle('L1', { property: 'crop', kind: 'categorical' })
    expect(useStore.getState().layers[0].vectorStyle).toEqual({ property: 'crop', kind: 'categorical' })
    useStore.getState().setLayerVectorStyle('L1', undefined)
    expect(useStore.getState().layers[0].vectorStyle).toBeUndefined()
  })
  it('ignores unrelated events', () => {
    expect(applyVizEvent({ type: 'token', content: 'x' })).toBe(false)
  })
})

describe('manifestFeatures', () => {
  it('sends scalar feature properties and the layer id for small vector layers', () => {
    expect(manifestFeatures(vecLayer('L1'))).toEqual({
      layer_id: 'L1',
      feature_rows: [{ ndvi: 0.3, crop: 'maize' }, { ndvi: 0.7, crop: 'wheat' }],
    })
  })
  it('sends nothing for rasters, empty layers and layers over the cap', () => {
    expect(manifestFeatures({ ...vecLayer('r'), type: 'raster' })).toEqual({})
    expect(manifestFeatures(vecLayer('e', { geojson: { type: 'FeatureCollection', features: [] } }))).toEqual({})
    const big = { type: 'FeatureCollection' as const, features: Array.from({ length: MAX_MANIFEST_FEATURES + 1 }, () => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: [0, 0] } })) }
    expect(manifestFeatures(vecLayer('b', { geojson: big }))).toEqual({})
  })
})
