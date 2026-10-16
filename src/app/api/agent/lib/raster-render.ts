/** Generic raster rendering helpers for `render_raster` and the index tools.
 *
 *  Pure (no I/O): band-name validation per sensor, expression parsing, titiler XYZ
 *  tile-URL construction, and the AOI-driven percentile stretch. The I/O (scene
 *  search, pixel reads) lives in `tools/raster.ts`.
 *
 *  UNITS. Continuous layers (one band, or band math) are evaluated on surface
 *  REFLECTANCE: each band reference `bN` is wrapped as `(bN*scale+offset)` in the
 *  titiler expression, using the transform resolved by `lib/reflectance.ts`. So the
 *  tile, the legend and the AOI statistics are all in the same units, and an index
 *  such as EVI (whose constants are defined in reflectance) means what it should.
 *  RGB composites are stretched per band in raw DN, which is what an image wants.
 */

import { compileBandExpression, toPositionalExpression } from './analysis/band-expression'
import type { SensorId } from './analysis/sensors'
import { RASTER_COLORMAPS, type RasterDescriptor } from '@/lib/raster-style'
import { S2_ASSET_KEYS, getStacItemHref, pickAssetKey } from './stac'
import { SPECTRAL_INDEX_TILE_CONFIG, TITILER_BASE } from './titiler'
import { indexBounds, resolveBandSetReflectance, scaleExpression, type ReflectanceTransform } from './reflectance'

export { scaleExpression }
import type { Confidence, Provenance, ResultLayer } from './types'

// ---------------------------------------------------------------------------
// Bands per sensor
// ---------------------------------------------------------------------------

interface BandDef {
  /** Canonical name shown to the user. */
  name: string
  /** STAC asset keys to try, in order (Earth Search lowercase, then PC-style). */
  assets: string[]
  /** Other spellings accepted on input (case-insensitive). */
  aliases?: string[]
  /** Short description for error messages. */
  desc: string
}

const S2_BANDS: BandDef[] = [
  { name: 'B01', assets: ['coastal', 'B01'], desc: 'coastal aerosol, 60 m' },
  { name: 'B02', assets: ['blue', 'B02'], aliases: ['blue'], desc: 'blue, 10 m' },
  { name: 'B03', assets: ['green', 'B03'], aliases: ['green'], desc: 'green, 10 m' },
  { name: 'B04', assets: ['red', 'B04'], aliases: ['red'], desc: 'red, 10 m' },
  { name: 'B05', assets: ['rededge1', 'B05'], aliases: ['rededge1'], desc: 'red edge 1, 20 m' },
  { name: 'B06', assets: ['rededge2', 'B06'], aliases: ['rededge2'], desc: 'red edge 2, 20 m' },
  { name: 'B07', assets: ['rededge3', 'B07'], aliases: ['rededge3'], desc: 'red edge 3, 20 m' },
  { name: 'B08', assets: ['nir', 'B08'], aliases: ['nir'], desc: 'NIR, 10 m' },
  { name: 'B8A', assets: ['nir08', 'B8A'], aliases: ['nir08'], desc: 'narrow NIR, 20 m' },
  { name: 'B09', assets: ['nir09', 'B09'], aliases: ['nir09'], desc: 'water vapour, 60 m' },
  { name: 'B11', assets: ['swir16', 'B11'], aliases: ['swir16', 'swir1'], desc: 'SWIR 1.6 um, 20 m' },
  { name: 'B12', assets: ['swir22', 'B12'], aliases: ['swir22', 'swir2'], desc: 'SWIR 2.2 um, 20 m' },
]

// Landsat asset keys are Planetary Computer's normalised common names, identical
// across TM/ETM+/OLI. Band numbers (B2..B7) are OLI (Landsat 8/9) numbering and are
// accepted as aliases only; the common names are the canonical, mission-independent form.
const LANDSAT_BANDS: BandDef[] = [
  { name: 'coastal', assets: ['coastal'], aliases: ['b1'], desc: 'coastal aerosol, Landsat 8/9 only' },
  { name: 'blue', assets: ['blue'], aliases: ['b2'], desc: 'blue' },
  { name: 'green', assets: ['green'], aliases: ['b3'], desc: 'green' },
  { name: 'red', assets: ['red'], aliases: ['b4'], desc: 'red' },
  { name: 'nir08', assets: ['nir08'], aliases: ['nir', 'b5'], desc: 'near infrared' },
  { name: 'swir16', assets: ['swir16'], aliases: ['swir1', 'b6'], desc: 'SWIR 1.6 um' },
  { name: 'swir22', assets: ['swir22'], aliases: ['swir2', 'b7'], desc: 'SWIR 2.2 um' },
]

const BANDS: Record<SensorId, BandDef[]> = {
  'sentinel-2-l2a': S2_BANDS,
  'landsat-c2-l2': LANDSAT_BANDS,
}

const SENSOR_LABEL: Record<SensorId, string> = {
  'sentinel-2-l2a': 'Sentinel-2 L2A',
  'landsat-c2-l2': 'Landsat Collection-2 L2',
}

export function validBandNames(sensor: SensorId): string[] {
  return BANDS[sensor].map((b) => b.name)
}

/** Find a band by canonical name or alias, case-insensitively. Also tolerates an
 *  unpadded Sentinel-2 number ("B8" -> B08, "B1" -> B01). */
export function findBand(sensor: SensorId, raw: string): BandDef | null {
  let key = raw.trim().toLowerCase()
  if (sensor === 'sentinel-2-l2a' && /^b\d$/.test(key)) key = `b0${key.slice(1)}`
  return BANDS[sensor].find((b) => b.name.toLowerCase() === key || b.aliases?.includes(key)) ?? null
}

function unknownBandError(sensor: SensorId, raw: string): string {
  const list = BANDS[sensor].map((b) => `${b.name} (${b.desc})`).join(', ')
  return `Band "${raw}" does not exist for ${SENSOR_LABEL[sensor]}. Valid bands: ${list}.`
}

/** Resolve the STAC asset key a band uses on a concrete item, or null if the item lacks it. */
export function assetKeyForBand(sensor: SensorId, bandName: string, item: any): string | null {
  const def = findBand(sensor, bandName)
  if (!def) return null
  for (const k of def.assets) if (item?.assets?.[k]?.href) return k
  return null
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

export type RasterSpec =
  | {
      ok: true
      mode: 'single' | 'expression' | 'rgb'
      /** Distinct canonical band names, in positional order (b1 = bands[0]). */
      bands: string[]
      /** Positional formula over `bands` (`b1`, `b2`, ...). Absent for rgb. */
      positional?: string
      /** The formula as the user wrote it, with canonical band names. Expression mode only. */
      expression?: string
    }
  | { ok: false; error: string }

export function parseRasterSpec(
  sensor: SensorId,
  input: { bands?: unknown; expression?: unknown },
): RasterSpec {
  const hasExpr = typeof input.expression === 'string' && input.expression.trim() !== ''
  const bandsIn = Array.isArray(input.bands) ? input.bands.map(String).filter((b) => b.trim() !== '') : []

  if (hasExpr && bandsIn.length) {
    return { ok: false, error: 'Pass either `bands` or `expression`, not both.' }
  }
  if (!hasExpr && bandsIn.length === 0) {
    return { ok: false, error: 'Pass `bands` (1 band, or 3 for an RGB composite) or an `expression` such as "(B11-B08)/(B11+B08)".' }
  }

  if (!hasExpr) {
    if (bandsIn.length !== 1 && bandsIn.length !== 3) {
      return { ok: false, error: `\`bands\` takes 1 band (single-band map) or 3 bands (RGB composite), got ${bandsIn.length}. Use \`expression\` for band math.` }
    }
    const resolved: string[] = []
    for (const raw of bandsIn) {
      const def = findBand(sensor, raw)
      if (!def) return { ok: false, error: unknownBandError(sensor, raw) }
      resolved.push(def.name)
    }
    if (bandsIn.length === 1) return { ok: true, mode: 'single', bands: resolved, positional: 'b1' }
    return { ok: true, mode: 'rgb', bands: resolved }
  }

  const expr = String(input.expression).trim()
  const order: string[] = []
  let bad: string | null = null
  const positional = expr.replace(/[A-Za-z][A-Za-z0-9_]*/g, (id) => {
    const def = findBand(sensor, id)
    if (!def) { bad ??= id; return id }
    let i = order.indexOf(def.name)
    if (i < 0) { order.push(def.name); i = order.length - 1 }
    return `b${i + 1}`
  })
  if (bad) return { ok: false, error: unknownBandError(sensor, bad) }
  if (order.length === 0) return { ok: false, error: 'The expression references no bands.' }
  try {
    compileBandExpression(positional)
  } catch (err: any) {
    return { ok: false, error: `Cannot evaluate expression "${expr}": ${err?.message ?? 'invalid'}. Supported: band names, numbers, + - * /, parentheses.` }
  }
  const canonical = expr.replace(/[A-Za-z][A-Za-z0-9_]*/g, (id) => findBand(sensor, id)?.name ?? id)
  return { ok: true, mode: 'expression', bands: order, positional, expression: canonical }
}

// ---------------------------------------------------------------------------
// Colormap + rescale validation
// ---------------------------------------------------------------------------

const EXTRA_COLORMAPS = ['orrd', 'hot', 'gray', 'jet', 'rainbow', 'bone', 'ylorrd', 'greens', 'reds']

/** Normalise a requested titiler colormap name, or null when it is not one we know. */
export function normalizeColormap(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const key = name.trim().toLowerCase()
  const base = key.endsWith('_r') ? key.slice(0, -2) : key
  return (RASTER_COLORMAPS as readonly string[]).includes(base) || EXTRA_COLORMAPS.includes(base) ? key : null
}

export const COLORMAP_CHOICES: string[] = [...RASTER_COLORMAPS, ...EXTRA_COLORMAPS]

/** Accept `[min,max]` or `[[min,max], ...]` (one pair, or one per band). */
export function parseRescale(input: unknown, bandCount: number): { ok: true; rescale: [number, number][] | null } | { ok: false; error: string } {
  if (input == null) return { ok: true, rescale: null }
  const pairs: unknown[] = Array.isArray(input) && input.length > 0 && Array.isArray(input[0]) ? input : [input]
  const out: [number, number][] = []
  for (const p of pairs) {
    const lo = Array.isArray(p) ? Number(p[0]) : NaN
    const hi = Array.isArray(p) ? Number(p[1]) : NaN
    if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(lo) || !Number.isFinite(hi) || !(lo < hi)) {
      return { ok: false, error: '`rescale` must be [min, max] with min < max (or one such pair per band).' }
    }
    out.push([lo, hi])
  }
  if (out.length !== 1 && out.length !== bandCount) {
    return { ok: false, error: `\`rescale\` needs 1 pair or ${bandCount} pairs (one per band), got ${out.length}.` }
  }
  return { ok: true, rescale: out.length === bandCount ? out : Array.from({ length: bandCount }, () => out[0]) }
}

// ---------------------------------------------------------------------------
// Tile URLs
// ---------------------------------------------------------------------------

export type TileTarget =
  | { kind: 'stac'; base: string; itemHref: string }
  | { kind: 'pc'; base: string; collection: string; itemId: string }

export interface TileUrlOpts {
  target: TileTarget
  /** Asset keys in positional order (b1 = assets[0]). */
  assets: string[]
  /** Titiler expression over `b1..bN` (single band / band math). Omit for RGB. */
  expression?: string
  /** One pair, or one per band for RGB. */
  rescale: [number, number][]
  /** Continuous layers only. */
  colormap?: string
}

/** XYZ template for a titiler `/stac/tiles` (Earth Search) or Planetary Computer
 *  `/item/tiles` endpoint. The `{z}/{x}/{y}` placeholders stay literal. */
export function buildRasterTileUrl(o: TileUrlOpts): string {
  const p = new URLSearchParams()
  let path: string
  if (o.target.kind === 'stac') {
    p.set('url', o.target.itemHref)
    path = `${o.target.base}/stac/tiles/WebMercatorQuad/{z}/{x}/{y}.png`
  } else {
    p.set('collection', o.target.collection)
    p.set('item', o.target.itemId)
    path = `${o.target.base}/item/tiles/WebMercatorQuad/{z}/{x}/{y}.png`
  }
  for (const a of o.assets) p.append('assets', a)
  if (o.expression) p.set('expression', o.expression)
  for (const [lo, hi] of o.rescale) p.append('rescale', `${lo},${hi}`)
  if (o.colormap) p.set('colormap_name', o.colormap)
  p.set('return_mask', 'true')
  return `${path}?${p}`
}

// ---------------------------------------------------------------------------
// Stretch
// ---------------------------------------------------------------------------

/** Linear-interpolated percentile (p in 0..100) of an ascending-sorted array. */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length
  if (n === 0) return NaN
  if (n === 1) return sorted[0]
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (n - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

export interface ValueSummary {
  n: number
  min: number
  max: number
  p2: number
  p98: number
  mean: number
}

/** Summary of the finite values; null when there are none. */
export function summarizeValues(values: ArrayLike<number>): ValueSummary | null {
  const finite: number[] = []
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Number.isFinite(v)) { finite.push(v); sum += v }
  }
  if (finite.length === 0) return null
  const sorted = Float64Array.from(finite).sort()
  return {
    n: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p2: percentile(sorted, 2),
    p98: percentile(sorted, 98),
    mean: sum / sorted.length,
  }
}

/** Round to 5 significant digits so URLs stay short but small ranges survive. */
export function roundSig(x: number, digits = 5): number {
  return Number(x.toPrecision(digits))
}

/** Display range from a summary. A flat distribution is widened so the colormap has
 *  something to span instead of titiler dividing by zero. */
export function stretchFromSummary(s: ValueSummary, mode: 'p2-p98' | 'minmax' = 'p2-p98'): [number, number] {
  let lo = mode === 'minmax' ? s.min : s.p2
  let hi = mode === 'minmax' ? s.max : s.p98
  if (!(hi > lo)) { lo = s.min; hi = s.max }
  if (!(hi > lo)) {
    const d = Math.max(Math.abs(lo) * 0.05, 1e-3)
    lo -= d; hi += d
  }
  return [roundSig(lo), roundSig(hi)]
}

// ---------------------------------------------------------------------------
// Spectral-index layers (compute_spectral_index / fetch_ndvi)
// ---------------------------------------------------------------------------

/** Tile layer for a Sentinel-2 spectral index with a data-driven stretch.
 *
 *  Replaces the fixed -1..1 1024 px PNG: the tiles are served at native resolution,
 *  masked to the AOI polygon on the client, and stretched to the AOI's own p2-p98 so a
 *  scene whose NDVI only spans 0.1-0.4 still shows its structure. When no clear-pixel
 *  statistics exist the index's mathematical bounds are used and the descriptor says
 *  the stretch is `fixed`. Returns null when the scene lacks a band the index needs. */
export function buildIndexRasterLayer(o: {
  id: string
  name: string
  item: any
  index: string
  /** Clear-pixel statistics (p2/p98); null when unavailable. */
  stats: { min?: number; max?: number; p2?: number; p98?: number; mean?: number; count?: number } | null
  bounds: [number, number, number, number]
  provenance: Provenance
  confidence: Confidence
}): ResultLayer | null {
  const cfg = SPECTRAL_INDEX_TILE_CONFIG[o.index.toUpperCase()]
  const itemHref = getStacItemHref(o.item)
  if (!cfg || !itemHref) return null
  const assets = cfg.bandKeys.map((keys) => pickAssetKey(o.item, keys))
  if (assets.some((a) => !a)) return null
  const keys = assets as string[]
  const { transforms } = resolveBandSetReflectance(o.item, keys, { isSentinel2: true })
  const positional = toPositionalExpression(cfg.exprTemplate)

  const s = o.stats
  const measured = !!s && typeof s.p2 === 'number' && typeof s.p98 === 'number'
  const rescale: [number, number] = measured
    ? stretchFromSummary({
        n: s!.count ?? 0,
        min: s!.min ?? s!.p2!,
        max: s!.max ?? s!.p98!,
        p2: s!.p2!,
        p98: s!.p98!,
        mean: s!.mean ?? 0,
      })
    : indexBounds(o.index)

  const tileUrl = buildRasterTileUrl({
    target: { kind: 'stac', base: TITILER_BASE, itemHref },
    assets: keys,
    expression: scaleExpression(positional, transforms),
    rescale: [rescale],
    colormap: cfg.colormap,
  })
  const datetime = String(o.item?.properties?.datetime ?? '').slice(0, 10) || undefined
  return {
    id: o.id,
    name: o.name,
    type: 'raster',
    tileUrl,
    bounds: o.bounds,
    aoiMask: true,
    raster: {
      kind: 'continuous',
      sensor: 'sentinel-2-l2a',
      collection: 'sentinel-2-l2a',
      sceneId: o.item?.id ? String(o.item.id) : undefined,
      datetime,
      bands: cfg.bandKeys.map((k) => k[1]),
      expression: cfg.exprTemplate.replace(/BAND(\d)/g, (_m, i) => cfg.bandKeys[Number(i)][1]),
      index: o.index.toUpperCase(),
      rescale: [rescale],
      stretch: measured ? 'p2-p98' : 'fixed',
      colormap: cfg.colormap,
    },
    provenance: o.provenance,
    confidence: o.confidence,
  }
}

/** The layer a tool can draw as soon as the scene is chosen, before the AOI statistics exist:
 *  the same tiles on the index's fixed mathematical range instead of the AOI's own p2-p98.
 *  Labelled as a preview in its name, confidence and provenance; the final layer (same id)
 *  replaces it on the map. */
export function buildIndexPreviewLayer(o: {
  id: string
  name: string
  item: any
  index: string
  bounds: [number, number, number, number]
  provenance: Provenance
}): ResultLayer | null {
  const layer = buildIndexRasterLayer({ ...o, stats: null, confidence: 'low' })
  if (!layer) return null
  return {
    ...layer,
    name: `${o.name} · statistics computing`,
    provenance: {
      ...o.provenance,
      method: 'Preview on the index\'s fixed range while the cloud-masked AOI statistics are computed; replaced by the final layer.',
    },
  }
}

// ---------------------------------------------------------------------------
// True-colour imagery (fetch_ndvi product "imagery")
// ---------------------------------------------------------------------------

/** Display window of a Sentinel-2 true-colour image: reflectance 0 to 0.3, the range the ESA
 *  TCI product uses, expressed in the scene's own digital numbers (the +1000 BOA offset of
 *  processing baseline 04.00 shifts both ends). */
export function trueColorRescale(item: any, keys: string[]): [number, number] {
  const t = resolveBandSetReflectance(item, keys, { isSentinel2: true }).transforms[0]
  const lo = t.offset < 0 ? Math.round(-t.offset / t.scale) : 0
  return [lo, lo + 3000]
}

/** AOI-clipped true-colour tile layer for a Sentinel-2 item (tiles at native resolution, hidden
 *  outside the polygon by the map), replacing the scene-wide preview image. Null when the item
 *  lacks a red, green or blue asset. */
export function buildTrueColorRasterLayer(o: {
  id: string
  name: string
  item: any
  bounds: [number, number, number, number]
  provenance: Provenance
  confidence: Confidence
}): ResultLayer | null {
  const itemHref = getStacItemHref(o.item)
  const keys = [S2_ASSET_KEYS.B04, S2_ASSET_KEYS.B03, S2_ASSET_KEYS.B02].map((k) => pickAssetKey(o.item, k))
  if (!itemHref || keys.some((k) => !k)) return null
  const assets = keys as string[]
  const window = trueColorRescale(o.item, assets)
  const rescale: [number, number][] = [window, window, window]
  return {
    id: o.id,
    name: o.name,
    type: 'raster',
    tileUrl: buildRasterTileUrl({ target: { kind: 'stac', base: TITILER_BASE, itemHref }, assets, rescale }),
    bounds: o.bounds,
    aoiMask: true,
    raster: {
      kind: 'rgb',
      sensor: 'sentinel-2-l2a',
      collection: 'sentinel-2-l2a',
      sceneId: o.item?.id ? String(o.item.id) : undefined,
      datetime: String(o.item?.properties?.datetime ?? '').slice(0, 10) || undefined,
      bands: ['B04', 'B03', 'B02'],
      rescale,
      stretch: 'fixed',
      units: 'DN',
    },
    provenance: o.provenance,
    confidence: o.confidence,
  }
}

/** Legend descriptor for the fixed-range NDVI tile (`buildNDVITileUrl`: -1..1 on rdylgn) that
 *  change and deforestation layers draw for their "after" scene. */
export function ndviTileDescriptor(item: any): RasterDescriptor {
  return {
    kind: 'continuous',
    sensor: 'sentinel-2-l2a',
    collection: 'sentinel-2-l2a',
    sceneId: item?.id ? String(item.id) : undefined,
    datetime: String(item?.properties?.datetime ?? '').slice(0, 10) || undefined,
    bands: ['B08', 'B04'],
    expression: '(B08-B04)/(B08+B04)',
    index: 'NDVI',
    rescale: [[-1, 1]],
    stretch: 'fixed',
    colormap: 'rdylgn',
    units: 'NDVI',
  }
}
