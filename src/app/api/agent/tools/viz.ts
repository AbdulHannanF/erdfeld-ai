/** make_chart / style_layer — the versatile visualization tools.
 *
 *  Neither tool fetches or computes data. Both work on results this request already
 *  produced (or layers the client sent in the manifest):
 *   - `make_chart` turns a Vega-Lite spec that *references* data by name into a chart
 *     whose rows are the real tool output (see lib/chart-data.ts);
 *   - `style_layer` colours an existing layer's features by one of their properties and
 *     returns a `layer_style` update the client applies without re-adding the layer.
 *  Failures are honest errors that name what is available — nothing is guessed.
 */

import { genId } from '../lib/geometry'
import { resolveChartSpec } from '../lib/chart-data'
import type { ToolCtx, ToolOutput } from '../lib/types'
import {
  featureProperties,
  legendItems,
  resolveVectorStyle,
  type VectorClass,
  type VectorStyle,
} from '@/lib/vector-style'

function parseSpec(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { return null }
}

export async function makeChart(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const store = ctx.results
  if (!store || store.size === 0) {
    return { summary: 'Cannot make a chart: no tool results exist yet to take data from. Run a tool that produces figures or features first (in the toolbox, pick the result to chart).', refused: true }
  }
  const spec = parseSpec(args.spec)
  if (spec === null) return { summary: 'make_chart: `spec` is not valid JSON.', refused: true }

  const res = resolveChartSpec(spec, store)
  if (!res.ok) return { summary: `Chart rejected: ${res.error}`, refused: true }

  const rawTitle = (spec as any)?.title
  const title = String(args.title ?? (typeof rawTitle === 'string' ? rawTitle : rawTitle?.text) ?? 'Chart').slice(0, 120)
  const rowCount = (res.spec.data?.values?.length as number | undefined) ?? undefined
  return {
    summary:
      `Chart "${title}" built from ${res.names.join(', ')}${rowCount !== undefined ? ` (${rowCount} rows)` : ''}; ` +
      `it is shown in the dashboard and under this answer. Describe only what the chart shows — the values come from those results.` +
      (res.warnings.length ? `\nVega-Lite warnings: ${res.warnings.slice(0, 3).join(' | ')}` : ''),
    charts: [{ id: `chart-${genId()}`, title, spec: res.spec, layerId: res.layerId }],
  }
}

export async function styleLayer(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const store = ctx.results
  const layerId = typeof args.layer_id === 'string' ? args.layer_id : undefined
  const resultId = typeof args.result_id === 'string' ? args.result_id : undefined
  if (!layerId && !resultId) return { summary: 'style_layer needs `layer_id` or `result_id` (see the [layer_id: …] hints and the Layer Manifest).', refused: true }
  if (typeof args.property !== 'string' || !args.property) return { summary: 'style_layer needs `property`: the feature property to colour by.', refused: true }

  let target: { id: string; name: string; rows: Array<Record<string, any>> } | undefined
  for (const [rid, r] of store ?? []) {
    if (resultId && rid !== resultId) continue
    target = r.layers.find((l) => (!layerId || l.id === layerId) && l.rows.length > 0)
    if (target) break
  }
  if (!target) {
    const known = [...(store ?? [])].flatMap(([rid, r]) => r.layers.map((l) => `${l.id} (result ${rid})`))
    return {
      refused: true,
      summary: `No styleable layer matches ${layerId ? `layer_id "${layerId}"` : `result_id "${resultId}"`}: only layers with vector features can be coloured by an attribute. ` +
        (known.length ? `Available: ${known.join(', ')}.` : 'This session has no vector layers yet.'),
    }
  }

  const kind = args.kind === 'graduated' || args.kind === 'categorical' ? args.kind : undefined
  if (args.kind !== undefined && !kind) return { summary: 'style_layer: `kind` must be "graduated" or "categorical".', refused: true }
  const fc = { features: target.rows.map((properties) => ({ properties })) }
  const inferred = kind ?? (featureProperties(fc).find((p) => p.name === args.property)?.type === 'number' ? 'graduated' : 'categorical')
  if (inferred === 'graduated' && Array.isArray(args.classes) && args.classes.length) {
    return { summary: 'style_layer: `classes` applies to kind "categorical"; graduated classes come from the data (use `method` and `num_classes`).', refused: true }
  }

  const style: VectorStyle = { property: args.property, kind: inferred }
  if (typeof args.colormap === 'string') style.colormap = args.colormap
  if (args.method === 'quantile' || args.method === 'equal') style.method = args.method
  if (args.num_classes !== undefined) style.numClasses = Number(args.num_classes)
  if (Array.isArray(args.classes) && args.classes.length) {
    const classes: VectorClass[] = []
    for (const c of args.classes) {
      if (!c || (typeof c.value !== 'string' && typeof c.value !== 'number') || typeof c.color !== 'string') {
        return { summary: 'style_layer: each class needs `value` (string or number) and `color` (CSS colour).', refused: true }
      }
      classes.push({ value: c.value, label: typeof c.label === 'string' ? c.label : String(c.value), color: c.color })
    }
    style.classes = classes
  }

  const resolved = resolveVectorStyle(style, fc)
  if (!resolved.ok) return { summary: `Cannot style "${target.name}": ${resolved.error}`, refused: true }

  const legend = legendItems(resolved.value)
  return {
    summary:
      `Coloured "${target.name}" by ${style.property} (${style.kind}${style.kind === 'graduated' ? `, ${style.method ?? 'quantile'}` : ''}). ` +
      `Legend: ${legend.map((l) => l.label).join(' | ')}. The legend is shown on the layer; the map updates in place.`,
    layer_style: { layer_id: target.id, style, legend },
  }
}
