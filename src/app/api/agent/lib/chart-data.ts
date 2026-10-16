/** `make_chart` data resolution + Vega-Lite validation.
 *
 *  The model writes the *shape* of a chart (marks, encodings, transforms); the numbers
 *  come from this request's own tool results. A spec references data by name —
 *  `{"data": {"name": "<result_id>#<summary_key>"}}` or `{"data": {"name": "<result_id>#features"}}` —
 *  and this module swaps each reference for the real rows. Inline `values`, `url`
 *  and `datasets` are rejected outright, so an invented number cannot reach a chart.
 */

import { compile } from 'vega-lite'
import { FID_FIELD } from '@/lib/chart-spec'
import type { ResultLayer, ResultStore, StoredResult, SummaryDatum } from './types'

/** Rows per dataset a chart may carry (keeps the SSE event and the browser light). */
export const MAX_CHART_ROWS = 5000
/** Feature rows a layer contributes to the store / the client manifest. */
export const MAX_FEATURE_ROWS = 5000

type Row = Record<string, any>
const DATE_LABEL = /^\d{4}-\d{2}(-\d{2})?$/

const KNOWN_MARKS = new Set([
  'arc', 'area', 'bar', 'image', 'line', 'point', 'rect', 'rule', 'text', 'tick', 'trail',
  'circle', 'square', 'geoshape', 'boxplot', 'errorband', 'errorbar',
])

// ---------------------------------------------------------------------------
// Store construction
// ---------------------------------------------------------------------------

function scalarRow(props: Record<string, unknown> | null | undefined, fid: number): Row {
  const row: Row = {}
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) row[k] = v
  }
  row[FID_FIELD] = fid
  return row
}

/** Feature properties of a GeoJSON layer as chart rows; `_fid` = index in the collection. */
export function featureRowsOf(layer: Pick<ResultLayer, 'geojson'>): Row[] {
  const features: any[] = Array.isArray(layer.geojson?.features) ? layer.geojson.features : []
  return features.slice(0, MAX_FEATURE_ROWS).map((f, i) => scalarRow(f?.properties, i))
}

/** Record a tool result so later `make_chart` / `style_layer` calls can address it. */
export function storeResult(
  store: ResultStore,
  resultId: string,
  tool: string,
  summaryData: Record<string, SummaryDatum> | undefined,
  layers: ResultLayer[],
): void {
  store.set(resultId, {
    tool,
    summary_data: summaryData,
    layers: layers
      .filter((l) => l.type === 'geojson' && l.geojson?.features?.length)
      .map((l) => ({ id: l.id, name: l.name, rows: featureRowsOf(l) })),
  })
}

/** Layers the client already holds (manifest) become addressable too. Properties arrive
 *  as plain rows; `_fid` is re-derived from the row's position. */
export function storeManifestLayer(
  store: ResultStore,
  m: { result_id: string; tool: string; name: string; summary_data?: Record<string, SummaryDatum>; layer_id?: string; feature_rows?: Row[] },
): void {
  if (store.has(m.result_id)) return
  const rows = (m.feature_rows ?? []).map((r, i) => scalarRow(r, i))
  store.set(m.result_id, {
    tool: m.tool,
    summary_data: m.summary_data,
    layers: m.layer_id && rows.length ? [{ id: m.layer_id, name: m.name, rows }] : [],
  })
}

// ---------------------------------------------------------------------------
// Names -> rows
// ---------------------------------------------------------------------------

/** Tidy rows for one summary figure: arrays of {label, value} keep both (plus `date` when
 *  the label is an ISO date/month); scalars become a single {label: key, value} row. */
export function summaryRows(key: string, value: SummaryDatum | undefined): Row[] | null {
  if (value === undefined) return null
  if (Array.isArray(value)) {
    return value.map((p) => ({ label: p.label, value: p.value, ...(DATE_LABEL.test(p.label) ? { date: p.label } : {}) }))
  }
  return [{ label: key, value }]
}

function firstLayer(r: StoredResult | undefined) {
  return r?.layers.find((l) => l.rows.length > 0)
}

/** Rows for `<result_id>#<key>`, or null when the name does not exist. */
export function resolveDataName(name: string, store: ResultStore): { rows: Row[]; layerId?: string } | null {
  const at = name.indexOf('#')
  if (at <= 0) return null
  const r = store.get(name.slice(0, at))
  const key = name.slice(at + 1)
  if (!r) return null
  if (key === 'features') {
    const l = firstLayer(r)
    return l ? { rows: l.rows, layerId: l.id } : null
  }
  const rows = summaryRows(key, r.summary_data?.[key])
  return rows ? { rows, layerId: undefined } : null
}

/** Every name `make_chart` can reference, with a one-line shape, for honest error messages. */
export function listDataNames(store: ResultStore): string[] {
  const out: string[] = []
  for (const [id, r] of store) {
    for (const [k, v] of Object.entries(r.summary_data ?? {})) {
      out.push(Array.isArray(v) ? `${id}#${k} (${v.length} rows: label, value)` : `${id}#${k} (1 row: label, value)`)
    }
    const l = firstLayer(r)
    if (l) out.push(`${id}#features (${l.rows.length} rows: ${Object.keys(l.rows[0]).join(', ')})`)
  }
  return out
}

/** One-line hint appended to a tool result so the model knows what it can chart / style. */
export function buildLayerHint(resultId: string, r: StoredResult): string {
  const l = firstLayer(r)
  if (!l) return ''
  const fields = Object.keys(l.rows[0]).filter((k) => k !== FID_FIELD).slice(0, 24).join(', ')
  return `\n[layer_id: ${l.id} · result_id: ${resultId} · ${l.rows.length} features · properties: ${fields || 'none'} · chartable as ${resultId}#features]`
}

// ---------------------------------------------------------------------------
// Spec resolution
// ---------------------------------------------------------------------------

export type ChartResolution =
  | { ok: true; spec: Record<string, any>; layerId?: string; warnings: string[]; names: string[] }
  | { ok: false; error: string }

function visitData(node: any, fn: (holder: any) => void): void {
  if (Array.isArray(node)) { node.forEach((n) => visitData(n, fn)); return }
  if (!node || typeof node !== 'object') return
  if (node.data && typeof node.data === 'object' && !Array.isArray(node.data)) fn(node)
  for (const v of Object.values(node)) visitData(v, fn)
}

function markIssue(node: any): string | null {
  if (Array.isArray(node)) { for (const n of node) { const e = markIssue(n); if (e) return e } return null }
  if (!node || typeof node !== 'object') return null
  if ('mark' in node) {
    const t = typeof node.mark === 'string' ? node.mark : node.mark?.type
    if (!KNOWN_MARKS.has(t)) return `Unknown mark "${String(t)}". Use one of: ${[...KNOWN_MARKS].join(', ')}.`
  }
  for (const k of ['layer', 'hconcat', 'vconcat', 'concat']) {
    if (Array.isArray(node[k])) { const e = markIssue(node[k]); if (e) return e }
  }
  if (node.spec) return markIssue(node.spec)
  return null
}

/** Encoding-channel fields that name no column of the (untransformed) data. */
function missingFields(spec: any, columns: Set<string>): string[] {
  if (JSON.stringify(spec).includes('"transform"') || JSON.stringify(spec).includes('"repeat"')) return []
  const missing = new Set<string>()
  const scan = (node: any) => {
    if (Array.isArray(node)) { node.forEach(scan); return }
    if (!node || typeof node !== 'object') return
    if (typeof node.field === 'string') {
      const base = node.field.split(/[.[]/)[0]
      if (!columns.has(base)) missing.add(node.field)
    }
    Object.values(node).forEach(scan)
  }
  scan(spec.encoding)
  for (const key of ['layer', 'hconcat', 'vconcat', 'concat']) if (Array.isArray(spec[key])) spec[key].forEach((s: any) => scan(s?.encoding))
  if (spec.spec) scan(spec.spec.encoding)
  return [...missing]
}

/** Compile with vega-lite in Node: throws become one honest message, warnings are returned. */
export function validateVegaLite(spec: Record<string, any>): { ok: true; warnings: string[] } | { ok: false; error: string } {
  const issue = markIssue(spec)
  if (issue) return { ok: false, error: issue }
  const warnings: string[] = []
  const errors: string[] = []
  const logger: any = {
    level: () => logger,
    warn: (...a: any[]) => { warnings.push(a.map(String).join(' ')); return logger },
    info: () => logger,
    debug: () => logger,
    error: (...a: any[]) => { errors.push(a.map(String).join(' ')); return logger },
  }
  try {
    compile(spec as any, { logger })
  } catch (err: any) {
    return { ok: false, error: `Vega-Lite rejected the spec: ${err?.message ?? 'compile failed'}.` }
  }
  if (errors.length) return { ok: false, error: `Vega-Lite rejected the spec: ${errors.join('; ')}.` }
  return { ok: true, warnings }
}

/** Replace every `{"data": {"name": ...}}` with the real rows, then validate. */
export function resolveChartSpec(rawSpec: unknown, store: ResultStore): ChartResolution {
  if (!rawSpec || typeof rawSpec !== 'object' || Array.isArray(rawSpec)) {
    return { ok: false, error: 'make_chart needs `spec`: a Vega-Lite spec object.' }
  }
  const spec = JSON.parse(JSON.stringify(rawSpec)) as Record<string, any>
  if (spec.datasets !== undefined) {
    return { ok: false, error: 'Top-level `datasets` is not allowed. Reference result data by name: {"data": {"name": "<result_id>#<key>"}}.' }
  }

  const names: string[] = []
  const holders: any[] = []
  let problem: string | null = null
  visitData(spec, (h) => {
    holders.push(h)
    const d = h.data
    if ('values' in d) problem = 'Inline `data.values` is not allowed: chart data must come from tool results. Use {"data": {"name": "<result_id>#<key>"}} instead.'
    else if ('url' in d) problem = '`data.url` is not allowed: charts may only use data from this session\'s tool results. Use {"data": {"name": "<result_id>#<key>"}}.'
    else if (typeof d.name !== 'string') problem = 'Every `data` must be {"name": "<result_id>#<summary_key>"} or {"name": "<result_id>#features"}.'
    else names.push(d.name)
  })
  if (problem) return { ok: false, error: problem }
  if (names.length === 0) {
    return { ok: false, error: 'The spec references no data. Add {"data": {"name": "<result_id>#<key>"}}. ' + availability(store) }
  }

  const columns = new Set<string>()
  let layerId: string | undefined
  for (const h of holders) {
    const name = h.data.name as string
    const hit = resolveDataName(name, store)
    if (!hit) return { ok: false, error: `Unknown data name "${name}". ${availability(store)}` }
    if (hit.rows.length === 0) return { ok: false, error: `Data "${name}" has no rows to chart.` }
    if (hit.rows.length > MAX_CHART_ROWS) return { ok: false, error: `Data "${name}" has ${hit.rows.length} rows; the limit is ${MAX_CHART_ROWS}. Chart an aggregated summary instead.` }
    Object.keys(hit.rows[0]).forEach((c) => columns.add(c))
    if (hit.layerId && !layerId) layerId = hit.layerId
    h.data = { values: hit.rows }
  }

  const missing = missingFields(spec, columns)
  if (missing.length) {
    return { ok: false, error: `The spec uses field(s) ${missing.map((m) => `"${m}"`).join(', ')} that the data does not have. Available fields: ${[...columns].join(', ')}.` }
  }

  const valid = validateVegaLite(spec)
  if (!valid.ok) return valid
  return { ok: true, spec, layerId, warnings: valid.warnings, names }
}

function availability(store: ResultStore): string {
  const names = listDataNames(store)
  return names.length
    ? `Available data names: ${names.slice(0, 40).join('; ')}.`
    : 'No result data is available yet: run a tool that produces figures or features first.'
}
