/** Data-driven vector styling: descriptor -> MapLibre expression + legend.
 *
 *  Shared by the server (`style_layer` validates the property against the layer's
 *  features) and the browser (MapPanel paints with the expression, LayerLegend draws the
 *  classes, LayerPanel edits the descriptor). Pure: no DOM, no node APIs.
 *
 *  A `VectorStyle` colours features by ONE property: `graduated` bins a numeric property
 *  into classes (MapLibre `step`), `categorical` maps distinct values to colours
 *  (MapLibre `match`). Classes are always derived from the layer's own data, never typed
 *  in by the model.
 */

import { colormapStops, formatStretchValue } from '@/lib/raster-style'
import { CATEGORICAL_PALETTE } from '@/lib/categorical-palette'

export type VectorStyleKind = 'graduated' | 'categorical'
export type BreakMethod = 'quantile' | 'equal'

export interface VectorClass { value: string | number; label: string; color: string }

export interface VectorStyle {
  /** GeoJSON feature property that drives the colour. */
  property: string
  kind: VectorStyleKind
  /** Ramp name (see RASTER_COLORMAPS; `_r` reverses). Default viridis (graduated) /
   *  a qualitative palette (categorical). */
  colormap?: string
  /** Graduated: ascending interior break values. Default: computed from the data. */
  breaks?: number[]
  /** Categorical: explicit value -> colour map. Default: the most frequent values. */
  classes?: VectorClass[]
  /** How default graduated breaks are computed (default quantile). */
  method?: BreakMethod
  /** Number of graduated classes when `breaks` is not given (2-9, default 5). */
  numClasses?: number
}

export interface LegendItem { color: string; label: string }

/** A style with everything resolved against the data: ready for MapLibre and the legend. */
export interface ResolvedVectorStyle {
  property: string
  kind: VectorStyleKind
  colormap?: string
  /** Graduated: ascending interior breaks (classes = breaks.length + 1). */
  breaks: number[]
  /** Graduated: one colour per class. */
  colors: string[]
  /** Categorical: the mapped values. Values outside this list get `fallback`. */
  classes: VectorClass[]
  /** Categorical: true when some data values are not covered by `classes`. */
  hasOther: boolean
  /** Colour for features whose property is missing / non-numeric / unmapped. */
  fallback: string
  /** Graduated: data range, for the outer legend labels. */
  min?: number
  max?: number
}

export const DEFAULT_GRADUATED_COLORMAP = 'viridis'
export const NO_DATA_COLOR = '#71717a'
export const MAX_CATEGORIES = 12
export const MIN_CLASSES = 2
export const MAX_CLASSES = 9
export const DEFAULT_CLASSES = 5

export { CATEGORICAL_PALETTE }

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
}

/** Colour at position `t` (0..1) along a named colormap; null when the name is unknown. */
export function sampleColormap(name: string, t: number): string | null {
  const stops = colormapStops(name)
  if (!stops) return null
  if (stops.length === 1) return stops[0]
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(x))
  const f = x - i
  const a = hexToRgb(stops[i])
  const b = hexToRgb(stops[i + 1])
  return rgbToHex(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f)
}

/** `n` colours evenly spaced along a colormap (a lone colour sits mid-ramp). */
export function rampColors(name: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => sampleColormap(name, n === 1 ? 0.5 : i / (n - 1)) ?? NO_DATA_COLOR)
}

// ---------------------------------------------------------------------------
// Feature properties
// ---------------------------------------------------------------------------

export interface PropertyInfo { name: string; type: 'number' | 'string' }

type FC = { features?: Array<{ properties?: Record<string, unknown> | null }> } | null | undefined

/** Properties usable for styling: `number` when every non-null value is a finite number,
 *  `string` for strings/booleans. Objects and mixed columns are skipped. Scans the first
 *  `limit` features. */
export function featureProperties(fc: FC, limit = 5000): PropertyInfo[] {
  const seen = new Map<string, 'number' | 'string' | 'mixed'>()
  for (const f of (fc?.features ?? []).slice(0, limit)) {
    for (const [k, v] of Object.entries(f.properties ?? {})) {
      if (v == null || v === '') continue
      const t: 'number' | 'string' | null =
        typeof v === 'number' && Number.isFinite(v) ? 'number'
        : typeof v === 'string' || typeof v === 'boolean' ? 'string'
        : null
      const prev = seen.get(k)
      if (t === null) seen.set(k, 'mixed')
      else if (prev === undefined) seen.set(k, t)
      else if (prev !== t) seen.set(k, 'mixed')
    }
  }
  return [...seen].filter(([, t]) => t !== 'mixed').map(([name, type]) => ({ name, type: type as 'number' | 'string' }))
}

function numericValues(fc: FC, property: string): number[] {
  const out: number[] = []
  for (const f of fc?.features ?? []) {
    const v = f.properties?.[property]
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v)
  }
  return out
}

function categoryCounts(fc: FC, property: string): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const f of fc?.features ?? []) {
    const v = f.properties?.[property]
    if (v == null || v === '') continue
    const key = String(v)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
}

// ---------------------------------------------------------------------------
// Breaks
// ---------------------------------------------------------------------------

function dedupeAscending(xs: number[]): number[] {
  const out: number[] = []
  for (const x of [...xs].sort((a, b) => a - b)) if (Number.isFinite(x) && (!out.length || x > out[out.length - 1])) out.push(x)
  return out
}

/** `n - 1` interior quantile breaks (linear interpolation); duplicates collapse, so ties
 *  in the data can yield fewer than `n` classes. */
export function quantileBreaks(values: number[], n: number): number[] {
  if (values.length === 0 || n < 2) return []
  const s = [...values].sort((a, b) => a - b)
  const out: number[] = []
  for (let i = 1; i < n; i++) {
    const pos = (i / n) * (s.length - 1)
    const lo = Math.floor(pos)
    const hi = Math.min(s.length - 1, lo + 1)
    out.push(s[lo] + (s[hi] - s[lo]) * (pos - lo))
  }
  return dedupeAscending(out).filter((b) => b > s[0] && b <= s[s.length - 1])
}

/** `n - 1` interior equal-interval breaks between the data min and max. */
export function equalBreaks(values: number[], n: number): number[] {
  if (values.length === 0 || n < 2) return []
  let lo = Infinity
  let hi = -Infinity
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v }
  if (!(hi > lo)) return []
  return Array.from({ length: n - 1 }, (_, i) => lo + ((hi - lo) * (i + 1)) / n)
}

export function clampClassCount(n: number | undefined): number {
  const k = Math.round(Number(n))
  return Number.isFinite(k) ? Math.min(MAX_CLASSES, Math.max(MIN_CLASSES, k)) : DEFAULT_CLASSES
}

// ---------------------------------------------------------------------------
// Validation + resolution
// ---------------------------------------------------------------------------

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string }

/** Check `property` exists on the layer's features and suits `kind`. The error names the
 *  properties that do exist, so the caller can retry with a valid one. */
export function validateStyleProperty(
  fc: FC,
  property: string,
  kind?: VectorStyleKind,
): Validation<{ property: string; kind: VectorStyleKind }> {
  const props = featureProperties(fc)
  const info = props.find((p) => p.name === property)
  const listing = props.length
    ? props.map((p) => `${p.name} (${p.type})`).join(', ')
    : 'none (the features carry no numeric or text properties)'
  if (!info) return { ok: false, error: `Property "${property}" does not exist on this layer's features. Available: ${listing}.` }
  if (kind === 'graduated' && info.type !== 'number') {
    return { ok: false, error: `Property "${property}" holds text, so it cannot be graduated; use kind "categorical". Numeric properties: ${props.filter((p) => p.type === 'number').map((p) => p.name).join(', ') || 'none'}.` }
  }
  return { ok: true, value: { property, kind: kind ?? (info.type === 'number' ? 'graduated' : 'categorical') } }
}

/** Resolve a descriptor against the layer's data. Fails (rather than guessing) on an
 *  unknown property, an unknown colormap, or a graduated style over non-numeric data. */
export function resolveVectorStyle(style: VectorStyle, fc: FC): Validation<ResolvedVectorStyle> {
  const v = validateStyleProperty(fc, style.property, style.kind)
  if (!v.ok) return v
  if (style.colormap && !colormapStops(style.colormap)) {
    return { ok: false, error: `Unknown colormap "${style.colormap}". Use one of: viridis, magma, inferno, plasma, cividis, greys, rdylgn, rdbu, spectral, terrain, blues, ylgn (append _r to reverse).` }
  }
  const base = { property: style.property, kind: style.kind, colormap: style.colormap, fallback: NO_DATA_COLOR }

  if (style.kind === 'graduated') {
    const values = numericValues(fc, style.property)
    if (values.length === 0) return { ok: false, error: `Property "${style.property}" has no numeric values to grade.` }
    const n = clampClassCount(style.numClasses)
    const breaks = style.breaks?.length
      ? dedupeAscending(style.breaks)
      : (style.method === 'equal' ? equalBreaks(values, n) : quantileBreaks(values, n))
    const cm = style.colormap ?? DEFAULT_GRADUATED_COLORMAP
    let min = Infinity
    let max = -Infinity
    for (const x of values) { if (x < min) min = x; if (x > max) max = x }
    return { ok: true, value: { ...base, breaks, colors: rampColors(cm, breaks.length + 1), classes: [], hasOther: false, min, max } }
  }

  const counts = categoryCounts(fc, style.property)
  if (counts.length === 0) return { ok: false, error: `Property "${style.property}" has no values to classify.` }
  let classes: VectorClass[]
  if (style.classes?.length) {
    classes = style.classes.map((c) => ({ value: c.value, label: c.label || String(c.value), color: c.color }))
  } else {
    const top = counts.slice(0, MAX_CATEGORIES)
    const colors = style.colormap ? rampColors(style.colormap, top.length) : top.map((_, i) => CATEGORICAL_PALETTE[i % CATEGORICAL_PALETTE.length])
    classes = top.map(([value], i) => ({ value, label: value, color: colors[i] }))
  }
  const mapped = new Set(classes.map((c) => String(c.value)))
  return { ok: true, value: { ...base, breaks: [], colors: [], classes, hasOther: counts.some(([k]) => !mapped.has(k)) } }
}

// ---------------------------------------------------------------------------
// MapLibre expression + legend
// ---------------------------------------------------------------------------

/** MapLibre colour expression for a resolved style: `step` over a numeric property
 *  (missing / non-numeric -> fallback) or `match` over the stringified value. */
export function buildColorExpression(r: ResolvedVectorStyle): any[] {
  if (r.kind === 'graduated') {
    const step: any[] = ['step', ['get', r.property], r.colors[0]]
    r.breaks.forEach((b, i) => step.push(b, r.colors[i + 1]))
    return ['case', ['==', ['typeof', ['get', r.property]], 'number'], step, r.fallback]
  }
  if (r.classes.length === 0) return ['literal', r.fallback]
  const match: any[] = ['match', ['to-string', ['get', r.property]]]
  const seen = new Set<string>()
  for (const c of r.classes) {
    const key = String(c.value)
    if (seen.has(key)) continue
    seen.add(key)
    match.push(key, c.color)
  }
  match.push(r.fallback)
  return match
}

/** Legend rows for a resolved style (graduated: one range per class). */
export function legendItems(r: ResolvedVectorStyle): LegendItem[] {
  if (r.kind === 'graduated') {
    const edges = [r.min ?? r.breaks[0] ?? 0, ...r.breaks, r.max ?? r.breaks[r.breaks.length - 1] ?? 0]
    return r.colors.map((color, i) => ({ color, label: `${formatStretchValue(edges[i])} – ${formatStretchValue(edges[i + 1])}` }))
  }
  const items = r.classes.map((c) => ({ color: c.color, label: c.label }))
  if (r.hasOther) items.push({ color: r.fallback, label: 'Other' })
  return items
}

/** Resolve + build in one step; null when the style does not fit the data. */
export function vectorStylePaint(style: VectorStyle | undefined, fc: FC): { expression: any[]; resolved: ResolvedVectorStyle } | null {
  if (!style) return null
  const r = resolveVectorStyle(style, fc)
  return r.ok ? { expression: buildColorExpression(r.value), resolved: r.value } : null
}
