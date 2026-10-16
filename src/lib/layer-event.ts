/** The `layer` message the client store consumes: one builder for every producer.
 *
 *  The agent route builds it for the SSE `layer` event (final and provisional); the quick-layer
 *  path builds it from a `GeoResult` in the browser. Pure, no node APIs, so both sides import it.
 *
 *  The client keys layers by `layer_id` and `addLayer` merges by id, so a preview and the final
 *  layer of the same result are ONE layer on the map: the final event replaces the preview's
 *  fields (the stretch, the verdict, the citable figures) in place. `provisional: true` marks
 *  the preview; the final event carries `provisional: false`.
 */

import type { ResultLayer, SummaryDatum } from '@/app/api/agent/lib/types'
import { classifyDataTier } from '@/lib/data-tiers'
import { failingChecks, type GeoResult, type ValidationCheck } from '@/lib/geo-result'

export interface LayerEventExtras {
  provisional: boolean
  tool: string
  result_id?: string
  summary_data?: Record<string, SummaryDatum>
  result_status?: string
  validation?: ValidationCheck[]
}

export function layerEventPayload(layer: ResultLayer, extras: LayerEventExtras) {
  // C2 — the honest data tier + resolution derive from the layer's source.
  const tier = classifyDataTier(layer.provenance?.source)
  return {
    type: 'layer' as const,
    layer_id: layer.id,
    layer_type: layer.type,
    name: layer.name,
    tile_url: layer.tileUrl,
    geojson: layer.geojson,
    bounds: layer.bounds,
    intensity_property: layer.intensityProperty,
    image_base64: layer.imageBase64,
    provenance: layer.provenance,
    confidence: layer.confidence,
    tier: tier.tier,
    tier_label: tier.label,
    resolution_m: tier.resolutionM,
    render: layer.render,
    height_property: layer.heightProperty,
    palette: layer.palette,
    raster: layer.raster,
    aoi_mask: layer.aoiMask,
    vector_style: layer.vectorStyle,
    default_visible: layer.defaultVisible,
    ...extras,
  }
}

/** The client messages a finished `GeoResult` stands for when it did not arrive over SSE:
 *  the same `tool_call` completion (figures + verdict) and `layer` events the agent route sends. */
export type ResultMessage = Record<string, any> & { type: 'tool_call' | 'layer' | 'zoom_to' | 'chart' | 'layer_style' }

/** The `chart` and `layer_style` events a result stands for, in the shape the agent route sends them
 *  (`loop.ts`). Kept apart from `geoResultMessages`: an agent-run consumer emits charts itself and
 *  would draw each twice. A queued `make_chart` / `style_layer` job is drawn with both. */
export function geoResultVizMessages(result: GeoResult): ResultMessage[] {
  return [
    ...(result.layer_style
      ? [{ type: 'layer_style' as const, layer_id: result.layer_style.layer_id, vector_style: result.layer_style.style, result_id: result.result_id }]
      : []),
    ...(result.charts ?? []).map((chart) => ({
      type: 'chart' as const, chart_id: chart.id, title: chart.title, spec: chart.spec, layer_id: chart.layerId, result_id: result.result_id,
    })),
  ]
}

export function geoResultMessages(result: GeoResult): ResultMessage[] {
  const flags = failingChecks(result.validation)
  const didNotRun = result.status === 'refused' || result.status === 'failed'
  const primary = result.layers[0]
  return [
    {
      type: 'tool_call' as const,
      tool_name: result.op.name,
      status: didNotRun ? 'error' : 'completed',
      result_summary: result.summary.slice(0, 120),
      result_id: result.result_id,
      result_status: result.status,
      validation: flags,
      summary_data: result.stats,
      provenance: primary?.provenance,
      provenance_items: result.provenance.items,
      confidence: primary?.confidence,
    },
    ...result.layers.map((layer) =>
      layerEventPayload(layer, {
        provisional: false,
        result_id: result.result_id,
        tool: result.op.name,
        summary_data: result.stats,
        result_status: result.status,
        validation: flags,
      }),
    ),
    ...(primary?.bounds ? [{ type: 'zoom_to' as const, bbox: primary.bounds }] : []),
  ]
}
