/** stac-cog reader: any STAC API collection whose assets are cloud-optimised GeoTIFFs.
 *
 *  search items over the AOI/time -> choose by date proximity (and AOI clarity for optical)
 *  -> pick the asset -> sign when the host needs it (Planetary Computer) -> polygon-clipped
 *  pixel grid from titiler -> statistics computed here (so SAR can be converted to dB per pixel
 *  and categorical data counted per class) -> tile layer with a p2-p98 stretch.
 *
 *  Gated hosts (NASA CMR-STAC, Copernicus Data Space) are searched anonymously so the answer
 *  can state real granule facts, but pixels are only read when the credential exists.
 */

import { PC_DATA } from '../../analysis/sensors'
import { fetchWithRetry } from '../../cache'
import { CLEAR_CLASSES, MIN_USABLE_CLEAR_PCT, clearPixelFilter, gridCoveragePct, landsatQaClarity, type SceneClarity } from '../../cloud'
import { categoricalStyle, classesFromCollection, pickRasterAsset, signIfNeeded, type ClassDef } from '../../discovery/use-dataset'
import { genId } from '../../geometry'
import { getLogger } from '../../logger'
import { fetchCogFeatureGrid, toGeometry, type PixelGrid } from '../../pixels'
import { stretchFromSummary } from '../../raster-render'
import { toRfc3339Interval } from '../../stac'
import { TITILER_BASE, fetchCogPolygonStats } from '../../titiler'
import type { Confidence, Provenance, ResultLayer, SummaryDatum } from '../../types'
import type { DatasetEntry } from '../types'
import { formatResolution } from '../format'
import { authRequiredResult, authToken, dayMs, declaredExtent, describe, fmtDate, honest, noCoverageResult, r } from './common'
import type { ClassRow, CoverageInfo, ReadOpts, ReaderAoi, ReadResult, ReadStats } from './types'

const log = getLogger('registry/readers/stac')

const MAX_SIZE = 384
const MAX_GROUP_ITEMS = 6

// ---------------------------------------------------------------------------
// Profiles: per-collection hints the generic reader cannot guess
// ---------------------------------------------------------------------------

export interface StacProfile {
  /** Preferred asset keys, best first. */
  assets?: string[]
  /** A `variable` matching this means "the default asset" (e.g. "canopy height"). */
  aliases?: RegExp
  /** Human label for the measured quantity. */
  label?: string
  unit?: string
  colormap?: string
  /** Heights above ground: below-ground noise is set to 0 and the stretch starts at 0. */
  height?: boolean
  /** Class vocabulary the collection's description states but its metadata does not carry. */
  classes?: ClassDef[]
  /** Never group neighbouring items into a mosaic. */
  single?: boolean
}

// ---------------------------------------------------------------------------
// STAC plumbing
// ---------------------------------------------------------------------------

export function parseAccessUrl(url: string): { root: string; collection: string } | null {
  const m = url.match(/^(.*?)\/collections\/([^/?#]+)/)
  if (!m) return null
  return { root: m[1].replace(/\/+$/, ''), collection: decodeURIComponent(m[2]) }
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** The STAC `datetime` filter for the request, and whether it may be relaxed to "nearest". */
export function datetimeWindow(opts: ReadOpts): { datetime?: string; relax: boolean; target?: number } {
  const expand = (s: string, end: boolean) =>
    /^\d{4}$/.test(s) ? `${s}-${end ? '12-31' : '01-01'}` : /^\d{4}-\d{2}$/.test(s) ? `${s}-${end ? '28' : '01'}` : s
  if (opts.start || opts.end) {
    const a = opts.start ? expand(opts.start, false) : '..'
    const b = opts.end ? expand(opts.end, true) : '..'
    return { datetime: toRfc3339Interval(`${a}/${b}`), relax: false }
  }
  if (opts.date) {
    const t = dayMs(expand(opts.date, false))
    if (t === null) return { relax: false }
    return { datetime: toRfc3339Interval(`${isoDay(t - 45 * 86400e3)}/${isoDay(t + 45 * 86400e3)}`), relax: true, target: t }
  }
  return { relax: false }
}

export function itemTime(item: any): number | null {
  const p = item?.properties ?? {}
  if (p.datetime) return dayMs(p.datetime)
  const a = dayMs(p.start_datetime)
  const b = dayMs(p.end_datetime)
  if (a !== null && b !== null) return (a + b) / 2
  return a ?? b
}

/** Best first: closest to `target` when given, otherwise newest. Undated items go last. */
export function rankItems(items: any[], target?: number | null): any[] {
  const keyed = items.map((it, i) => ({ it, i, t: itemTime(it) }))
  keyed.sort((x, y) => {
    if (x.t === null && y.t === null) return x.i - y.i
    if (x.t === null) return 1
    if (y.t === null) return -1
    const d = target != null ? Math.abs(x.t - target) - Math.abs(y.t - target) : y.t - x.t
    return d !== 0 ? d : x.i - y.i
  })
  return keyed.map((k) => k.it)
}

/** Items of one acquisition (same project and day): neighbouring DEM tiles, S1 frames. */
export function groupItems(ranked: any[]): any[][] {
  const groups = new Map<string, any[]>()
  for (const it of ranked) {
    const t = itemTime(it)
    const key = `${it?.properties?.['3dep:usgs_id'] ?? ''}|${t === null ? 'undated' : isoDay(t)}`
    const g = groups.get(key)
    if (g) g.push(it)
    else groups.set(key, [it])
  }
  return [...groups.values()]
}

interface SearchOutcome { items: any[]; relaxed?: boolean; error?: string }

async function searchOnce(root: string, collection: string, bbox: number[], datetime: string | undefined): Promise<any[]> {
  const send = async (sort: boolean) => {
    const body: Record<string, unknown> = { collections: [collection], bbox, limit: 100 }
    if (datetime) body.datetime = datetime
    if (sort) body.sortby = [{ field: 'datetime', direction: 'desc' }]
    return fetchWithRetry(`${root}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/geo+json, application/json' },
      body: JSON.stringify(body),
    }, { timeoutMs: 45_000 })
  }
  let res = await send(true)
  if (res.status === 400 || res.status === 422) res = await send(false) // some servers reject sortby
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${root}/search`)
  const json: any = await res.json()
  return Array.isArray(json?.features) ? json.features : []
}

export async function searchItems(root: string, collection: string, bbox: number[], opts: ReadOpts): Promise<SearchOutcome> {
  const w = datetimeWindow(opts)
  try {
    let items = await searchOnce(root, collection, bbox, w.datetime)
    if (items.length === 0 && w.datetime && w.relax) {
      items = await searchOnce(root, collection, bbox, undefined)
      return { items, relaxed: items.length > 0 }
    }
    return { items }
  } catch (err: any) {
    return { items: [], error: `${root} was unreachable or refused the search: ${err?.message ?? 'network error'}` }
  }
}

const collectionCache = new Map<string, Promise<any | null>>()
function fetchCollection(root: string, id: string): Promise<any | null> {
  const key = `${root}|${id}`
  let p = collectionCache.get(key)
  if (!p) {
    p = fetchWithRetry(`${root}/collections/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } }, { timeoutMs: 30_000 })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
    collectionCache.set(key, p)
    p.then((v) => { if (!v) collectionCache.delete(key) })
  }
  return p
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

const META_KEY = /tilejson|rendered_preview|thumbnail|preview|overview|metadata|mtl|^ang$|^qa$|\.xml$|\.json$/i
const COG_TYPE = /tiff|geotiff|cog/i

export interface DataAsset { key: string; href: string; type?: string; asset: any }

/** Raster-looking assets of an item (no previews, tilejson, metadata or non-GeoTIFF files). */
export function listDataAssets(item: any): DataAsset[] {
  const out: DataAsset[] = []
  for (const [key, a] of Object.entries<any>(item?.assets ?? {})) {
    if (!a?.href || META_KEY.test(key)) continue
    const type = String(a.type ?? '')
    if (/json|html|xml|text|png|jpeg|hdf|netcdf|zip|laszip|zarr/i.test(type) && !COG_TYPE.test(type)) continue
    if (!COG_TYPE.test(type) && !/\.tif{1,2}($|\?)/i.test(a.href)) continue
    out.push({ key, href: a.href, type: a.type, asset: a })
  }
  return out
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export function matchAsset(assets: DataAsset[], variable: string): DataAsset | null {
  const v = variable.trim()
  const nv = norm(v)
  if (!nv) return null
  return (
    assets.find((a) => a.key.toLowerCase() === v.toLowerCase()) ??
    assets.find((a) => norm(a.key) === nv) ??
    assets.find((a) => (a.asset['eo:bands'] ?? []).some((b: any) => norm(String(b?.common_name ?? '')) === nv || norm(String(b?.name ?? '')) === nv)) ??
    [...assets].sort((a, b) => a.key.length - b.key.length).find((a) => norm(a.key).includes(nv)) ??
    null
  )
}

function defaultHints(entry: DatasetEntry, profile: StacProfile): Array<string | RegExp> {
  const id = entry.id
  const out: Array<string | RegExp> = [...(profile.assets ?? [])]
  if (/sentinel-1|palsar|sar/i.test(id) || (entry.themes.includes('sar') && !entry.themes.includes('elevation'))) out.push('vv', 'hh', 'VV', 'HH')
  if (/modis-13/.test(id)) out.push(/ndvi$/i)
  if (/jrc-gsw/.test(id)) out.push('occurrence')
  return out
}

export function resolveAsset(
  item: any, entry: DatasetEntry, variable: string | undefined, profile: StacProfile,
): { asset: DataAsset; auto: boolean; others: string[] } | { error: string } {
  const assets = listDataAssets(item)
  const keys = assets.map((a) => a.key)
  if (assets.length === 0) {
    const all = Object.entries<any>(item?.assets ?? {}).map(([k, a]) => `${k} (${String(a?.type ?? 'unknown').split(';')[0]})`)
    return { error: `The matching item has no cloud-optimised GeoTIFF asset to read. Its assets: ${all.slice(0, 8).join(', ') || 'none'}.` }
  }
  if (variable && !(profile.aliases?.test(variable))) {
    const hit = matchAsset(assets, variable)
    if (!hit) return { error: `No asset or band matches variable "${variable}". Available: ${keys.slice(0, 20).join(', ')}.` }
    return { asset: hit, auto: false, others: keys.filter((k) => k !== hit.key) }
  }
  for (const h of defaultHints(entry, profile)) {
    const hit = typeof h === 'string' ? assets.find((a) => a.key === h) : assets.find((a) => h.test(a.key))
    if (hit) return { asset: hit, auto: assets.length > 1 && !variable, others: keys.filter((k) => k !== hit.key) }
  }
  const picked = pickRasterAsset({ assets: Object.fromEntries(assets.map((a) => [a.key, a.asset])) })
  const hit = (picked && assets.find((a) => a.key === picked.key)) ?? assets[0]
  return { asset: hit, auto: assets.length > 1 && !variable, others: keys.filter((k) => k !== hit.key) }
}

// ---------------------------------------------------------------------------
// Value transforms (SAR dB, scale/offset)
// ---------------------------------------------------------------------------

export interface Transform {
  id: 'identity' | 'sar-power-db' | 'palsar-db' | 'scale-offset'
  unit?: string
  /** Applied per pixel; NaN drops the pixel. */
  apply: (v: number) => number
  /** titiler band-math over `src` (b1 or an asset name); null when identity. */
  expr: (src: string) => string | null
  note?: string
}

const IDENTITY: Transform = { id: 'identity', apply: (v) => v, expr: () => null }

export function transformFor(entry: DatasetEntry, key: string, itemAsset: any, collectionAsset: any): Transform {
  const pol = /^(vv|vh|hh|hv)$/i.test(key)
  if (pol && /sentinel-1-rtc/.test(entry.id)) {
    return {
      id: 'sar-power-db', unit: 'dB',
      apply: (v) => (v > 0 ? 10 * Math.log10(v) : NaN),
      expr: (s) => `10*log10(${s})`,
      note: `Sentinel-1 RTC stores linear power (gamma-nought); values are converted to dB per pixel (10·log10), then averaged. ${key.toUpperCase()} polarisation.`,
    }
  }
  if (pol && /alos-palsar-mosaic/.test(entry.id)) {
    return {
      id: 'palsar-db', unit: 'dB',
      apply: (v) => (v > 0 ? 20 * Math.log10(v) - 83 : NaN),
      expr: (s) => `20*log10(${s})-83`,
      note: `PALSAR mosaic stores 16-bit amplitude DN; converted to gamma-nought dB with JAXA's calibration γ0 = 20·log10(DN) − 83. ${key.toUpperCase()} polarisation.`,
    }
  }
  const rb = itemAsset?.['raster:bands']?.[0] ?? collectionAsset?.['raster:bands']?.[0]
  const scale = Number(rb?.scale)
  const offset = Number(rb?.offset)
  const sc = Number.isFinite(scale) && scale !== 0 ? scale : 1
  const off = Number.isFinite(offset) ? offset : 0
  if (sc !== 1 || off !== 0) {
    return {
      id: 'scale-offset', apply: (v) => v * sc + off,
      expr: (s) => `${s}*${sc}${off ? `${off > 0 ? '+' : ''}${off}` : ''}`,
      note: `Stored values are scaled: value = DN × ${sc}${off ? ` + ${off}` : ''} (from the asset's raster:bands).`,
    }
  }
  return IDENTITY
}

const ELEVATION_KEY = /^(data|elevation|dem|dsm|dtm|height)$/i

function unitOf(entry: DatasetEntry, key: string, tf: Transform, itemAsset: any, collectionAsset: any, profile: StacProfile): string | undefined {
  if (tf.unit) return tf.unit
  if (profile.unit) return profile.unit
  const raw = itemAsset?.['raster:bands']?.[0]?.unit ?? collectionAsset?.['raster:bands']?.[0]?.unit
  const fromVar = entry.variables.find((v) => norm(v.name) === norm(key))?.unit
  const u = String(fromVar ?? raw ?? '')
  if (!u && entry.themes.includes('elevation') && ELEVATION_KEY.test(key)) return 'm' // DEM assets rarely declare their unit
  return /^met(re|er)s?$/i.test(u) ? 'm' : u || undefined
}

// ---------------------------------------------------------------------------
// Colormaps and tiles
// ---------------------------------------------------------------------------

export function pickColormap(entry: DatasetEntry, key: string, tf: Transform, profile: StacProfile): string {
  if (profile.colormap) return profile.colormap
  if (tf.unit === 'dB') return 'greys_r'
  const text = `${key} ${entry.id}`.toLowerCase()
  if (/ndvi|evi|lai|fapar|vegetation|greenness/.test(text)) return 'rdylgn'
  if (/occurrence|surface-water|flood|inundat/.test(text)) return 'blues'
  if (/population|pop[-_ ]?den/.test(text)) return 'magma'
  if (/\blst\b|temperature|thermal/.test(text)) return 'inferno'
  const t = entry.themes
  if (t.includes('elevation') && ELEVATION_KEY.test(key)) return 'terrain'
  if (t.includes('population')) return 'magma'
  if (t.includes('temperature')) return 'inferno'
  if (t.includes('vegetation') || t.includes('forest') || t.includes('agriculture')) return 'rdylgn'
  if (t.includes('water') || t.includes('hydrology') || t.includes('precipitation')) return 'blues'
  return 'viridis'
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface TileSpec {
  entry: DatasetEntry
  /** Planetary Computer data API when set: no expiring SAS token in the URL. */
  pc?: { collection: string; itemId: string }
  key: string
  signedHref: string
  transform: Transform
  rescale?: [number, number]
  colormap?: string
  /** categorical: value -> colour. */
  colormapJson?: Record<string, string>
  algorithm?: 'hillshade'
}

/** XYZ template. `{z}/{x}/{y}` stay literal. */
export function buildTileUrl(s: TileSpec): string {
  const p = new URLSearchParams()
  let path: string
  const expr = s.transform.expr(s.pc && IDENT.test(s.key) ? s.key : 'b1')
  const pcOk = s.pc && (!s.transform.expr('b1') || IDENT.test(s.key))
  if (pcOk && s.pc) {
    p.set('collection', s.pc.collection)
    p.set('item', s.pc.itemId)
    p.append('assets', s.key)
    if (expr) { p.set('expression', expr); p.set('asset_as_band', 'true') }
    path = `${PC_DATA}/item/tiles/WebMercatorQuad/{z}/{x}/{y}.png`
  } else {
    p.set('url', s.signedHref)
    if (expr) p.set('expression', expr)
    path = `${TITILER_BASE}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png`
  }
  if (s.algorithm) { p.set('algorithm', s.algorithm); p.set('buffer', '2') } // shading needs neighbouring pixels at tile edges
  if (s.rescale) p.append('rescale', `${s.rescale[0]},${s.rescale[1]}`)
  if (s.colormap) p.set('colormap_name', s.colormap)
  if (s.colormapJson) p.set('colormap', JSON.stringify(s.colormapJson))
  p.set('return_mask', 'true')
  return `${path}?${p}`
}

// ---------------------------------------------------------------------------
// Optical clarity (SCL / QA_PIXEL)
// ---------------------------------------------------------------------------

function resample(src: Float64Array, sw: number, sh: number, dw: number, dh: number): Float64Array {
  if (sw === dw && sh === dh) return src
  const out = new Float64Array(dw * dh)
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / dh))
    for (let x = 0; x < dw; x++) out[y * dw + x] = src[sy * sw + Math.min(sw - 1, Math.floor((x + 0.5) * sw / dw))]
  }
  return out
}

function sclClarity(grid: PixelGrid, geom: any): SceneClarity | null {
  let total = 0
  let clear = 0
  const px = grid.width * grid.height
  for (let i = 0; i < px; i++) {
    if (!grid.mask[i]) continue
    const c = Math.round(grid.values[i])
    if (c === 0) continue
    total++
    if (CLEAR_CLASSES.has(c)) clear++
  }
  if (total === 0) return null
  const pct = (clear / total) * 100
  return {
    kind: 'scl', clearPct: pct, cloudPct: 100 - pct, snowPct: 0, waterPct: 0, totalPx: total, clearPx: clear,
    coveragePct: gridCoveragePct(geom, total, grid.width, grid.height), breakdown: [], grid,
  }
}

function qualityAssetOf(item: any): { key: string; kind: 'scl' | 'landsat-qa' } | null {
  const a = item?.assets ?? {}
  for (const k of ['SCL', 'scl']) if (a[k]?.href) return { key: k, kind: 'scl' }
  for (const k of ['qa_pixel', 'QA_PIXEL']) if (a[k]?.href) return { key: k, kind: 'landsat-qa' }
  return null
}

async function itemClarity(item: any, geom: any): Promise<SceneClarity | null> {
  const q = qualityAssetOf(item)
  if (!q) return null
  try {
    const grid = await fetchCogFeatureGrid({ cogUrl: await signIfNeeded(item.assets[q.key].href), geom, maxSize: 96, cacheTag: 'ds-q' })
    return q.kind === 'scl' ? sclClarity(grid, geom) : landsatQaClarity(grid)
  } catch (err: any) {
    log.warn({ item: item?.id, err: err?.message }, 'clarity read failed')
    return null
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface MergedRead {
  width: number
  height: number
  /** NaN where nothing valid. */
  values: Float64Array
  validPx: number
  used: any[]
  mosaicked: boolean
  /** The COG has an embedded colormap and titiler returned RGBA instead of raw class values. */
  expanded: boolean
}

export async function readItems(items: any[], key: string, geom: any): Promise<MergedRead | { error: string }> {
  let merged: Float64Array | null = null
  let W = 0
  let H = 0
  let mosaicked = true
  const extra: number[] = []
  const used: any[] = []
  let expanded = false
  let lastErr = ''
  for (const item of items) {
    const href = item?.assets?.[key]?.href
    if (!href) continue
    let grid: PixelGrid
    try {
      grid = await fetchCogFeatureGrid({ cogUrl: await signIfNeeded(href), geom, maxSize: MAX_SIZE, cacheTag: 'ds' })
    } catch (err: any) {
      lastErr = err?.message ?? 'read failed'
      continue
    }
    if (grid.bands > 2) expanded = true // palette COGs come back as RGBA, not as their values
    const px = grid.width * grid.height
    if (!merged) {
      merged = new Float64Array(px).fill(NaN)
      W = grid.width
      H = grid.height
    }
    let contributed = 0
    if (grid.width === W && grid.height === H) {
      for (let i = 0; i < px; i++) {
        if (Number.isNaN(merged[i]) && grid.mask[i] > 0 && Number.isFinite(grid.values[i])) { merged[i] = grid.values[i]; contributed++ }
      }
    } else {
      mosaicked = false
      for (let i = 0; i < px; i++) if (grid.mask[i] > 0 && Number.isFinite(grid.values[i])) { extra.push(grid.values[i]); contributed++ }
    }
    if (contributed > 0) used.push(item)
  }
  if (!merged) return { error: lastErr ? `titiler could not read the asset: ${lastErr}` : 'no readable asset on the matched items' }
  let validPx = 0
  for (let i = 0; i < merged.length; i++) if (!Number.isNaN(merged[i])) validPx++
  if (extra.length) {
    const grown = new Float64Array(merged.length + extra.length)
    grown.set(merged)
    grown.set(extra, merged.length)
    merged = grown
    validPx += extra.length
  }
  return { width: W, height: H, values: merged, validPx, used, mosaicked, expanded }
}

function classRows(values: number[], classes: ClassDef[] | null): ClassRow[] {
  const counts = new Map<number, number>()
  for (const v of values) { const c = Math.round(v); counts.set(c, (counts.get(c) ?? 0) + 1) }
  const total = values.length
  return [...counts.entries()]
    .map(([value, count]) => ({ value, name: classes?.find((c) => c.value === value)?.name ?? `class ${value}`, count, pct: (count / total) * 100 }))
    .sort((a, b) => b.count - a.count)
}

export function hostName(root: string): string {
  try { return new URL(root).host } catch { return root }
}

async function anonymousProbe(href: string, headers: Record<string, string> = {}): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch(href, { headers: { Range: 'bytes=0-1', ...headers }, signal: AbortSignal.timeout(20_000) })
    const ct = res.headers.get('content-type') ?? ''
    const login = /urs\.earthdata|login|oauth/i.test(res.url) || /text\/html/i.test(ct)
    return { ok: (res.status === 200 || res.status === 206) && !login, status: res.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

function granuleSummary(entry: DatasetEntry, items: any[]): string {
  const ranked = rankItems(items)
  const dated = ranked.map(itemTime).filter((t): t is number => t !== null)
  const first = ranked[0]
  const assetList = Object.entries<any>(first?.assets ?? {}).filter(([k]) => !META_KEY.test(k)).slice(0, 3).map(([k, a]) => `${k}: ${a.href}`)
  return (
    `The public STAC search found **${items.length}${items.length >= 100 ? '+' : ''} granule(s)** over the AOI` +
    `${dated.length ? ` (${isoDay(Math.min(...dated))} to ${isoDay(Math.max(...dated))})` : ''}; ` +
    `newest: \`${first?.id}\`${fmtDate(first?.properties?.datetime) ? ` (${fmtDate(first.properties.datetime)})` : ''}.` +
    `${assetList.length ? ` Assets: ${assetList.join('; ')}.` : ''}`
  )
}

// ---------------------------------------------------------------------------
// Measured values: from the pixel grid, or from titiler's statistics endpoint
// ---------------------------------------------------------------------------

interface Summary { count: number; mean: number; median: number; std: number; min: number; max: number; p2: number; p98: number; p5?: number; p95?: number }

interface Measured {
  path: 'grid' | 'statistics'
  count: number
  /** % of the polygon with valid pixels; null when the path cannot measure it. */
  cov: number | null
  sampled?: boolean
  summary?: Summary
  rows?: ClassRow[]
}

async function measureByStatistics(
  item: any, key: string, geom: any, categorical: boolean, tf: Transform, classes: ClassDef[] | null,
): Promise<Measured | { error: string }> {
  if (tf.id !== 'identity' && tf.id !== 'scale-offset') return { error: `This asset has an embedded colormap and needs a ${tf.id} conversion that the statistics path cannot apply.` }
  const stats = await fetchCogPolygonStats(await signIfNeeded(item.assets[key].href), geom, categorical ? { categorical: 'true' } : undefined)
  if (!stats) return { error: 'titiler could not compute statistics for this asset over the polygon (it may not be a readable cloud-optimised GeoTIFF).' }
  if (categorical) {
    const h = stats.histogram
    if (!Array.isArray(h) || h.length < 2) return { error: 'titiler returned no class histogram for this asset.' }
    const total = h[0].reduce((s, n) => s + (Number(n) || 0), 0)
    const rows = h[0]
      .map((count, i) => ({ value: Math.round(Number(h[1][i])), count: Number(count) || 0 }))
      .filter((x) => x.count > 0)
      .map((x) => ({ ...x, name: classes?.find((c) => c.value === x.value)?.name ?? `class ${x.value}`, pct: (x.count / total) * 100 }))
      .sort((a, b) => b.count - a.count)
    if (!rows.length) return { error: 'The polygon holds no valid class pixels.' }
    return { path: 'statistics', count: total, cov: null, rows }
  }
  const f = (v: number | undefined) => (typeof v === 'number' ? tf.apply(v) : NaN)
  const scale = Math.abs(tf.apply(1) - tf.apply(0))
  const [mn, mx] = [f(stats.min), f(stats.max)].sort((a, b) => a - b)
  const summary: Summary = {
    count: stats.valid_pixels ?? stats.count ?? 0, mean: f(stats.mean), median: f(stats.median), std: (stats.std ?? NaN) * scale,
    min: mn, max: mx, p2: f(stats.percentile_2), p98: f(stats.percentile_98),
  }
  if (![summary.mean, summary.min, summary.max, summary.p2, summary.p98].every(Number.isFinite) || summary.count <= 0) {
    return { error: 'titiler returned incomplete statistics for this asset.' }
  }
  return { path: 'statistics', count: summary.count, cov: null, summary }
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

export async function readStac(
  entry: DatasetEntry, aoi: ReaderAoi, opts: ReadOpts, profile: StacProfile = {},
): Promise<ReadResult> {
  const loc = parseAccessUrl(entry.access.url)
  if (!loc) {
    return honest(entry, 'unavailable', {
      headline: `Cannot locate the STAC collection for "${entry.title}"`,
      body: [`The registry access URL (${entry.access.url}) is not a STAC \`/collections/<id>\` URL.`],
    })
  }
  const geom = toGeometry(aoi.aoi)
  if (!geom) return honest(entry, 'error', { headline: 'The AOI is not a polygon', body: ['Statistics need a Polygon or MultiPolygon AOI.'] })

  const need = entry.access.requires_auth
  const token = need ? authToken(need, entry.source) : null

  const search = await searchItems(loc.root, loc.collection, aoi.bbox, opts)
  if (search.error) return honest(entry, 'error', { headline: `Could not search "${entry.title}"`, body: [search.error] })
  if (search.items.length === 0) {
    const w = datetimeWindow(opts)
    return noCoverageResult(entry, aoi,
      `"${loc.collection}" has no items over this AOI${w.datetime && !w.relax ? ` in the requested period (${opts.start ?? '..'} to ${opts.end ?? '..'})` : ''}. ` +
      `The declared extent covers it, but declared extent is not coverage: this dataset simply has no data here.`)
  }

  if (need && !token?.have) return authRequiredResult(entry, need, granuleSummary(entry, search.items))

  const target = datetimeWindow(opts).target ?? null
  const ranked = rankItems(search.items, target)
  const collection = await fetchCollection(loc.root, loc.collection)

  // Resolve the asset on the best item.
  const lead = ranked[0]
  const res = resolveAsset(lead, entry, opts.variable, profile)
  if ('error' in res) return honest(entry, 'error', { headline: `Cannot choose an asset for "${entry.title}"`, body: [res.error] })
  const { asset, auto, others } = res
  const key = asset.key
  const collectionAsset = collection?.item_assets?.[key]

  // A credential is configured but pixel reads still need an Authorization header on the data host.
  if (need && token?.have) {
    const anon = await anonymousProbe(asset.href)
    if (!anon.ok) {
      const authed = asset.href.startsWith('http') ? await anonymousProbe(asset.href, { Authorization: `Bearer ${token.value}` }) : { ok: false, status: 0 }
      return honest(entry, 'unavailable', {
        headline: `"${entry.title}": credential found, but pixels cannot be read in-app`,
        body: [
          granuleSummary(entry, search.items),
          authed.ok
            ? `${token.env} is accepted by the data host (HTTP ${authed.status}), but the hosted titiler cannot forward an Authorization header, so polygon statistics cannot be computed here. Use a self-hosted titiler (TITILER_ENDPOINT) with the bearer configured, or the Python geo service (queue Q-22).`
            : `The asset at ${asset.href.slice(0, 120)} was not readable with ${token.env} (${asset.href.startsWith('http') ? `HTTP ${authed.status || 'no response'}` : 'an s3:// URI needs S3 keys, not a token'}).`,
        ],
        needs: 'authenticated-reader',
        coverage: { verdict: 'covered', declared: declaredExtent(entry), found: `${search.items.length} granule(s)`, items_matched: search.items.length },
      })
    }
  }

  const tf = transformFor(entry, key, asset.asset, collectionAsset)
  const declared = profile.classes ?? classesFromCollection({ ...(collection ?? {}), item_assets: { ...(collection?.item_assets ?? {}), [key]: { ...(collectionAsset ?? {}), ...asset.asset } } } as any, key)
  const categorical = !!declared

  // Candidate groups, best first. Optical scenes are ranked by AOI clarity instead of date alone.
  let groups = profile.single ? ranked.map((i) => [i]) : groupItems(ranked).map((g) => g.slice(0, MAX_GROUP_ITEMS))
  const clarityOf = new Map<any, SceneClarity>()
  let examined = ''
  if (qualityAssetOf(lead)) {
    groups = ranked.slice(0, 12).map((i) => [i])
    const cand = groups.slice(0, 5)
    const scored = await Promise.all(cand.map(async (g) => ({ g, c: await itemClarity(g[0], geom) })))
    const usable = scored.filter((s) => s.c && s.c.clearPct >= MIN_USABLE_CLEAR_PCT && (s.c.coveragePct ?? 100) >= 60)
    examined = scored.map((s) => `${fmtDate(s.g[0]?.properties?.datetime)} ${s.c ? `${s.c.clearPct.toFixed(0)}% clear` : 'unscored'}`).join(', ')
    if (usable.length === 0) {
      return noCoverageResult(entry, aoi,
        `No usable optical scene over this AOI: every candidate was cloud-affected or clipped the polygon (${examined}). Try another date or a SAR dataset.`)
    }
    usable.sort((a, b) => (Math.abs(b.c!.clearPct - a.c!.clearPct) > 10 ? b.c!.clearPct - a.c!.clearPct : 0))
    groups = [usable[0].g]
    clarityOf.set(usable[0].g[0], usable[0].c!)
  }

  // Read groups until one observes enough of the polygon.
  let best: { group: any[]; read: MergedRead; cov: number } | null = null
  let readErr = ''
  let paletteGroup: any[] | null = null
  for (const group of groups.slice(0, 3)) {
    const read = await readItems(group, key, geom)
    if ('error' in read) { readErr = read.error; continue }
    if (read.expanded) { paletteGroup = group; break }
    const cov = gridCoveragePct(geom, read.validPx, read.width, read.height)
    if (!best || cov > best.cov) best = { group, read, cov }
    if (cov >= 60) break
  }

  let m: Measured
  let lead2: any
  let used: any[]
  let group: any[]
  if (paletteGroup) {
    // Embedded colormap: ask titiler for the raw band's statistics instead of the pixel grid.
    const sm = await measureByStatistics(paletteGroup[0], key, geom, categorical, tf, declared)
    if ('error' in sm) return honest(entry, 'error', { headline: `Could not read "${entry.title}"`, body: [sm.error] })
    m = sm; lead2 = paletteGroup[0]; used = [lead2]; group = paletteGroup
  } else {
    if (!best || best.read.validPx === 0) {
      return honest(entry, 'error', {
        headline: `Found items for "${entry.title}" but read no valid pixels`,
        body: [readErr || 'The matched items carry only nodata inside the polygon (for example the AOI falls in a gap between scene footprints).'],
        coverage: { verdict: 'partial', declared: declaredExtent(entry), found: `${search.items.length} item(s), no valid pixels`, items_matched: search.items.length, aoi_valid_pct: 0 },
      })
    }
    // Quality mask (optical): keep clear pixels only.
    let values = best.read.values
    const q = clarityOf.get(best.group[0])
    if (q) {
      const keep = clearPixelFilter(q)
      const mask = resample(Float64Array.from({ length: q.grid.width * q.grid.height }, (_, i) => (keep(i) ? 1 : 0)), q.grid.width, q.grid.height, best.read.width, best.read.height)
      values = values.map((v, i) => (mask[i] ? v : NaN))
    }
    const tv: number[] = []
    for (let i = 0; i < values.length; i++) {
      const v = values[i]
      if (!Number.isFinite(v)) continue
      let t = categorical ? v : tf.apply(v)
      if (profile.height && t < 0) t = 0
      if (Number.isFinite(t)) tv.push(t)
    }
    if (tv.length === 0) {
      return honest(entry, 'error', { headline: `No valid ${tf.unit === 'dB' ? 'backscatter' : ''} values after masking`, body: ['Every pixel inside the polygon was nodata, non-positive (cannot be expressed in dB) or masked as cloud.'] })
    }
    m = {
      path: 'grid', count: tv.length, cov: best.cov,
      sampled: best.read.width >= MAX_SIZE || best.read.height >= MAX_SIZE,
      ...(categorical ? { rows: classRows(tv, declared) } : { summary: describe(tv)! }),
    }
    lead2 = best.group[0]; used = best.read.used; group = best.group
  }
  const clarity = clarityOf.get(lead2)
  const cov = m.cov

  const date = fmtDate(lead2?.properties?.datetime ?? lead2?.properties?.start_datetime ?? lead2?.properties?.end_datetime)
  const unit = categorical ? undefined : unitOf(entry, key, tf, asset.asset, collectionAsset, profile)
  const label = profile.label ?? opts.variable ?? (entry.themes.includes('elevation') && ELEVATION_KEY.test(key) ? 'Elevation' : tf.unit === 'dB' ? `${key.toUpperCase()} backscatter` : key)
  const coverage: CoverageInfo = {
    verdict: cov === null || cov >= 90 ? 'covered' : 'partial',
    declared: declaredExtent(entry),
    found: `${search.items.length} item(s) over the AOI; ${group.length} read; ${cov === null ? 'polygon coverage not measured on this path' : `${cov.toFixed(0)}% of the polygon has valid pixels`}`,
    items_matched: search.items.length,
    ...(cov === null ? {} : { aoi_valid_pct: r(cov, 1) }),
  }

  let stats: ReadStats
  const sd: Record<string, SummaryDatum> = {
    read: 'ok', dataset: entry.id, asset: key, ...(date ? { date } : {}), pixel_count: m.count, ...(cov === null ? {} : { aoi_valid_pct: r(cov, 1) }),
  }
  let body: string
  const style = m.rows ? categoricalStyle(declared, m.rows.map((c) => ({ value: c.value, name: c.name }))) : null
  let rescale: [number, number] | undefined
  if (m.rows) {
    const rows = m.rows
    stats = { kind: 'categorical', variable: label, count: m.count, classes: rows }
    sd.dominant_class = rows[0].name
    sd.dominant_pct = r(rows[0].pct, 1)
    sd.class_pct = rows.slice(0, 10).map((c) => ({ label: c.name, value: r(c.pct, 1) }))
    body = `**Class breakdown over the AOI (${aoi.areaKm2.toFixed(2)} km²):**\n\n` +
      rows.slice(0, 12).map((c) => `- **${c.name}** (value ${c.value}): ${c.pct.toFixed(1)}% (${c.count.toLocaleString()} px)`).join('\n') +
      (declared ? '' : '\n\n_The collection declares no class names; raw values are shown._')
  } else {
    const d = m.summary!
    stats = { kind: 'continuous', variable: label, unit, ...d }
    rescale = profile.height ? [0, Math.max(d.p98, 1)] : stretchFromSummary({ n: d.count, min: d.min, max: d.max, p2: d.p2, p98: d.p98, mean: d.mean })
    rescale = [r(rescale[0], 4), r(rescale[1], 4)]
    sd.mean = r(d.mean, 3); sd.median = r(d.median, 3); sd.min = r(d.min, 3); sd.max = r(d.max, 3); sd.std = r(d.std, 3)
    if (d.p95 !== undefined) sd.p95 = r(d.p95, 3)
    if (unit) sd.unit = unit
    if (profile.height) { sd.mean_height_m = r(d.mean, 2); if (d.p95 !== undefined) sd.p95_height_m = r(d.p95, 2) }
    const u = unit ? ` ${unit}` : ''
    body = `**${label} over the AOI polygon (${aoi.areaKm2.toFixed(2)} km², ${m.count.toLocaleString()} valid px):**\n\n` +
      `- mean **${d.mean.toFixed(2)}${u}** · median ${d.median.toFixed(2)}${u} · σ ${d.std.toFixed(2)}\n` +
      `- min ${d.min.toFixed(2)} · ${d.p5 !== undefined ? `p5 ${d.p5.toFixed(2)} · ` : ''}${d.p95 !== undefined ? `p95 ${d.p95.toFixed(2)} · ` : `p2 ${d.p2.toFixed(2)} · p98 ${d.p98.toFixed(2)} · `}max ${d.max.toFixed(2)}${u}`
  }

  // Layer(s)
  const isPc = entry.source === 'planetary-computer' || /planetarycomputer\.microsoft\.com/.test(loc.root)
  const provenance: Provenance = {
    source: `${entry.title} via ${hostName(loc.root)}${entry.license && entry.license !== 'various' ? ` (${entry.license})` : ''}`,
    method: `STAC item search over the AOI bbox -> ${group.length > 1 ? `${group.length} neighbouring items of the same acquisition` : `item ${lead2?.id}`}, asset "${key}" -> ${m.path === 'grid' ? 'titiler /cog/feature.npy with the drawn polygon as a cutline -> statistics computed on the clipped pixels' : 'titiler POST /cog/statistics with the drawn polygon as a cutline (the asset has an embedded colormap, so the raw band is read through the statistics endpoint)'}${tf.id !== 'identity' ? ` (${tf.id})` : ''}`,
    clip: 'polygon',
    ...(date ? { date } : {}),
    resolution_limit: `${formatResolution(entry.resolution_m)} native; ${m.path === 'grid' ? `statistics use at most ${MAX_SIZE}x${MAX_SIZE} px of the clipped window${m.sampled ? ' (large AOI: sampled, not every pixel)' : ''}` : 'statistics use titiler\'s own window (at most 1024 px)'}. Discovered dataset: check the collection's documentation for caveats.`,
  }
  const confidence: Confidence = (cov === null || cov >= 90) && (!clarity || clarity.clearPct >= 70) ? 'high' : 'medium'

  let layers: ResultLayer[] | undefined
  if (opts.render !== false) {
    layers = []
    const signedFor = new Map<string, string>()
    const mk = (item: any, idx: number, algorithm?: 'hillshade'): ResultLayer => {
      const href = signedFor.get(item.id) ?? item.assets[key].href
      const colormap = algorithm ? undefined : categorical ? undefined : pickColormap(entry, key, tf, profile)
      const url = buildTileUrl({
        entry, key, signedHref: href, transform: algorithm ? IDENTITY : tf,
        pc: isPc ? { collection: item.collection ?? loc.collection, itemId: item.id } : undefined,
        ...(algorithm ? { algorithm } : categorical && style ? { colormapJson: style.colormap } : { rescale, colormap }),
      })
      const nm = `${entry.title}${algorithm ? ' (hillshade)' : ''}${group.length > 1 && used.length > 1 ? ` ${idx + 1}/${used.length}` : ''}`
      return {
        id: `dataset-${genId()}`, name: nm.slice(0, 48), type: 'raster', tileUrl: url, bounds: aoi.bbox, aoiMask: true, provenance, confidence,
        raster: algorithm ? { kind: 'continuous', collection: loc.collection, datetime: date || undefined, stretch: 'fixed', units: 'shaded relief' }
          : categorical && style ? { kind: 'categorical', collection: loc.collection, datetime: date || undefined, stretch: 'fixed', classes: style.classes }
          : { kind: 'continuous', sensor: entry.id, collection: loc.collection, sceneId: item.id, datetime: date || undefined, bands: [key], expression: tf.expr(key) ?? undefined, rescale: rescale ? [rescale] : undefined, stretch: profile.height ? 'fixed' : 'p2-p98', colormap, units: unit },
      }
    }
    if (!isPc || (tf.expr('b1') && !IDENT.test(key))) {
      for (const it of used.slice(0, 3)) signedFor.set(it.id, await signIfNeeded(it.assets[key].href))
    }
    used.slice(0, 3).forEach((it, i) => layers!.push(mk(it, i)))
    if (opts.hillshade && entry.themes.includes('elevation') && !categorical) {
      used.slice(0, 3).forEach((it, i) => layers!.push(mk(it, i, 'hillshade')))
    }
  }

  const notes: string[] = []
  if (tf.note) notes.push(tf.note)
  if (profile.height) notes.push('Below-ground noise (negative heights) is set to 0 m and the stretch runs from 0 to the 98th percentile. The maximum can include residual airborne noise: p95 is the robust canopy/building height.')
  const project = lead2?.properties?.['3dep:usgs_id']
  if (project) notes.push(`Lidar project \`${project}\`, collected ${fmtDate(lead2?.properties?.start_datetime) || '?'} to ${fmtDate(lead2?.properties?.end_datetime) || '?'}.`)
  if (auto) notes.push(`Variable not specified: read asset \`${key}\`. Other assets: ${others.slice(0, 12).join(', ')}. Pass \`variable\` to choose another.`)
  if (search.relaxed) notes.push(`No item within 45 days of ${opts.date}; the nearest available acquisition is used.`)
  else if (target !== null && date) notes.push(`Closest acquisition to ${opts.date}: ${date}.`)
  if (m.path === 'grid' && used.length > 1) notes.push(`${used.length} neighbouring items of the same acquisition were mosaicked (first valid pixel wins).`)
  if (m.path === 'statistics' && group.length > 1) notes.push(`Only the first of ${group.length} neighbouring items was read on this path; statistics may cover part of the AOI.`)
  if (clarity) notes.push(`Cloud screening: ${clarity.clearPct.toFixed(0)}% of the AOI was clear; statistics use clear pixels only (scenes examined: ${examined}).`)
  if (cov !== null && cov < 90) notes.push(`Only ${cov.toFixed(0)}% of the polygon has valid pixels; the statistics describe that part.`)

  const summary =
    `**${entry.title}** — read over this AOI from ${hostName(loc.root)}.\n\n${body}\n\n` +
    `**Asset:** \`${key}\`${date ? ` · **acquired:** ${date}` : ''} · **item:** \`${lead2?.id}\`\n` +
    `**Licence:** ${entry.license}\n` +
    (notes.length ? `\n${notes.map((n) => `- ${n}`).join('\n')}\n` : '')

  return {
    status: 'ok', summary, stats, summary_data: sd, provenance, coverage,
    ...(layers?.length ? { layer: layers[0], layers: layers.slice(1) } : {}),
  }
}
