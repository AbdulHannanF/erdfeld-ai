/** Client handling of the visualization SSE events (`chart`, `layer_style`).
 *
 *  Kept out of the hook so the store effects are testable without React. Returns true
 *  when the event changed the store; malformed events and styles for layers that are
 *  not on the map are ignored (the server already validated against real features).
 */

import { useStore, type MapLayer } from '@/store/useStore'

export function applyVizEvent(data: Record<string, any>): boolean {
  const store = useStore.getState()
  if (data.type === 'chart') {
    if (typeof data.chart_id !== 'string' || !data.spec || typeof data.spec !== 'object') return false
    store.addChart({
      id: data.chart_id,
      title: typeof data.title === 'string' && data.title ? data.title : 'Chart',
      spec: data.spec,
      layerId: typeof data.layer_id === 'string' ? data.layer_id : undefined,
    })
    return true
  }
  if (data.type === 'layer_style') {
    const style = data.vector_style
    if (typeof data.layer_id !== 'string' || !style || typeof style.property !== 'string') return false
    if (!store.layers.some((l) => l.id === data.layer_id)) return false
    store.setLayerVectorStyle(data.layer_id, style)
    return true
  }
  return false
}

/** Layers with at most this many features send their properties with the query. */
export const MAX_MANIFEST_FEATURES = 2000

/** What a reusable vector layer contributes to the request manifest so the server can
 *  chart / style it in a later turn: its id and each feature's scalar properties (the
 *  row index is the map feature id). Larger layers send nothing — the server then says
 *  honestly that the data is not available. */
export function manifestFeatures(layer: MapLayer): { layer_id?: string; feature_rows?: Array<Record<string, string | number | boolean | null>> } {
  const features = layer.geojson?.features
  if (layer.type !== 'geojson' || !features?.length || features.length > MAX_MANIFEST_FEATURES) return {}
  return {
    layer_id: layer.id,
    feature_rows: features.map((f) => {
      const row: Record<string, string | number | boolean | null> = {}
      for (const [k, v] of Object.entries(f.properties ?? {})) {
        if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) row[k] = v as string | number | boolean | null
      }
      return row
    }),
  }
}
