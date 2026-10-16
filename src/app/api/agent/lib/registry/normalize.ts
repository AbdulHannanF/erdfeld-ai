/** Mapping from raw catalog records to `DatasetEntry`.
 *
 *  Pure functions only (no network) so the harvester stays thin and every mapping
 *  rule is unit-testable. Each mapper returns null for a record that cannot be
 *  represented honestly (no title, no spatial extent); the caller counts those.
 */

import type {
  AccessKind, AuthKind, DatasetAccess, DatasetEntry, DatasetVariable, Theme,
} from './types'
import { GLOBAL_BBOX } from './types'
import { assignThemes } from './themes'
import { DEFAULT_NOTES } from './sources'

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Strip markdown / HTML and truncate on a word boundary. */
export function cleanText(input: unknown, max = 400): string {
  let s = String(input ?? '')
  s = s.replace(/<[^>]+>/g, ' ')
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  s = s.replace(/https?:\/\/\S+/g, ' ')
  s = s.replace(/[#*_`>|]+/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '')}…`
}

function uniqueStrings(xs: unknown[], cap: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const x of xs) {
    const s = String(x ?? '').trim()
    const k = s.toLowerCase()
    if (!s || seen.has(k)) continue
    seen.add(k)
    out.push(s)
    if (out.length >= cap) break
  }
  return out
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const ARCSEC_M = 30.87
const DEG_M = 111_320

interface ResMatch { m: number }

/** All resolution-like quantities found in `text`, in metres. */
function resolutionMatches(text: string): ResMatch[] {
  const t = text.toLowerCase().replace(/[_]+/g, ' ')
  const out: ResMatch[] = []
  const push = (v: number, factor: number) => {
    const m = v * factor
    if (Number.isFinite(m) && m >= 0.02 && m <= 120_000) out.push({ m })
  }
  let re = /(?<![\w.])(\d+(?:\.\d+)?)\s?-?\s?(km|kilomet(?:er|re)s?)(?![a-z0-9²³])/g
  for (let x; (x = re.exec(t));) push(Number(x[1]), 1000)
  re = /(?<![\w.])(\d+(?:\.\d+)?)\s?-?\s?(m|met(?:er|re)s?)(?![a-z0-9²³/^])/g
  for (let x; (x = re.exec(t));) push(Number(x[1]), 1)
  re = /(?<![\w.])(\d+(?:\.\d+)?)\s?-?\s?(cm|centimet(?:er|re)s?)(?![a-z0-9²³])/g
  for (let x; (x = re.exec(t));) push(Number(x[1]), 0.01)
  re = /(?<![\w.])(1\/\d+|\d+(?:\.\d+)?)\s?-?\s?(?:arc[\s-]?)?(?:seconds?|secs?|arcsec)(?![a-z])/g
  for (let x; (x = re.exec(t));) {
    const v = x[1].includes('/') ? Number(x[1].split('/')[0]) / Number(x[1].split('/')[1]) : Number(x[1])
    push(v, ARCSEC_M)
  }
  re = /(?<![\w.])(1\/\d+|\d*\.?\d+)\s?-?\s?(?:°|degrees?|deg)(?![a-z])/g
  for (let x; (x = re.exec(t));) {
    const v = x[1].includes('/') ? Number(x[1].split('/')[0]) / Number(x[1].split('/')[1]) : Number(x[1])
    if (v > 0 && v <= 5) push(v, DEG_M)
  }
  // Copernicus DEM style ids: glo-30 / glo-90 are metres.
  re = /\bglo[\s-]?(30|90)\b/g
  for (let x; (x = re.exec(t));) push(Number(x[1]), 1)
  return out
}

/** Finest resolution mentioned in a short, deliberate string (title / id / keywords). */
export function parseResolutionFromTitle(text: string): number | null {
  const ms = resolutionMatches(text)
  if (!ms.length) return null
  return round(Math.min(...ms.map((x) => x.m)))
}

/**
 * Description is prose: only accept quantities sitting next to a resolution
 * cue, so "a 5 m accuracy" or "500 km swath" does not become the pixel size.
 */
export function parseResolutionFromDescription(text: string): number | null {
  const cue = /(resolution|pixel|grid(?:ded)?|spatial sampling|gsd|cell size|spacing|at a scale)/i
  const sentences = String(text ?? '').slice(0, 1500).split(/(?<=[.;])\s+/)
  const found: number[] = []
  for (const sentence of sentences) {
    if (!cue.test(sentence)) continue
    // Trim to a window around the cue so a distant number is not captured.
    const idx = sentence.search(cue)
    const win = sentence.slice(Math.max(0, idx - 60), idx + 90)
    for (const m of resolutionMatches(win)) found.push(m.m)
  }
  return found.length ? round(Math.min(...found)) : null
}

function round(m: number): number {
  return m >= 10 ? Math.round(m) : Math.round(m * 100) / 100
}

function numberish(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Best-effort resolution for a STAC-shaped collection. */
export function stacResolution(col: any): number | null {
  const gsds: number[] = []
  const take = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(take)
    else {
      // Sub-2 cm "gsd" values are unit slips (degrees, or 0), not ground sample distances in metres.
      const n = numberish(v)
      if (n && n >= 0.02) gsds.push(n)
    }
  }
  take(col?.gsd)
  take(col?.summaries?.gsd)
  for (const b of col?.summaries?.['eo:bands'] ?? []) take(b?.gsd)
  for (const ia of Object.values<any>(col?.item_assets ?? {})) {
    for (const b of ia?.['eo:bands'] ?? []) take(b?.gsd)
    for (const b of ia?.['raster:bands'] ?? []) take(b?.spatial_resolution)
  }
  for (const b of col?.summaries?.['raster:bands'] ?? []) take(b?.spatial_resolution)
  if (gsds.length) return round(Math.min(...gsds))

  const title = `${col?.id ?? ''} ${col?.title ?? ''} ${(col?.keywords ?? []).join(' ')}`
  return parseResolutionFromTitle(title) ?? parseResolutionFromDescription(col?.description ?? '')
}

// ---------------------------------------------------------------------------
// Extents, license, variables
// ---------------------------------------------------------------------------

/** Longitude span in degrees; a box with minLon > maxLon crosses the antimeridian (STAC convention). */
export function lonSpan(b: readonly [number, number, number, number]): number {
  return b[2] >= b[0] ? b[2] - b[0] : b[2] - b[0] + 360
}

export function isGlobalBbox(b: [number, number, number, number]): boolean {
  return lonSpan(b) >= 350 && b[3] - b[1] >= 110
}

/** First (overall) bbox of a STAC extent as a 2D lon/lat box; null if absent/invalid. */
export function extentBbox(extent: any): [number, number, number, number] | null {
  const b = extent?.spatial?.bbox?.[0]
  if (!Array.isArray(b) || b.length < 4) return null
  const n = b.map(Number)
  const box: [number, number, number, number] = b.length >= 6
    ? [n[0], n[1], n[3], n[4]]
    : [n[0], n[1], n[2], n[3]]
  if (!box.every(Number.isFinite)) return null
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
  // Longitudes may legitimately be reversed (antimeridian crossing); latitudes may not.
  const [south, north] = box[1] <= box[3] ? [box[1], box[3]] : [box[3], box[1]]
  return [clamp(box[0], -180, 180), clamp(south, -90, 90), clamp(box[2], -180, 180), clamp(north, -90, 90)]
}

export function extentTemporal(extent: any): { start: string | null; end: string | null } {
  const iv = extent?.temporal?.interval?.[0]
  const f = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 10) : null)
  return { start: f(iv?.[0]), end: f(iv?.[1]) }
}

export function normalizeLicense(raw: unknown): string {
  const s = String(raw ?? '').trim()
  if (!s || /^(not[- ]?provided|unknown|other|n\/a|none)$/i.test(s)) return 'various'
  if (s.length > 40) return 'various'
  return s
}

/** Variables / bands with units where declared (STAC eo/raster/datacube, Earth Engine). */
export function stacVariables(col: any, cap = 24): DatasetVariable[] {
  const out: DatasetVariable[] = []
  const seen = new Set<string>()
  const add = (name: unknown, unit: unknown) => {
    const n = String(name ?? '').trim()
    if (!n || seen.has(n.toLowerCase()) || out.length >= cap) return
    seen.add(n.toLowerCase())
    const u = String(unit ?? '').trim()
    out.push(u && u.length <= 24 ? { name: n, unit: u } : { name: n })
  }
  for (const b of col?.summaries?.['eo:bands'] ?? []) add(b?.name, b?.['gee:units'] ?? b?.unit ?? b?.units)
  for (const [k, v] of Object.entries<any>(col?.['cube:variables'] ?? {})) add(k, v?.unit)
  for (const b of col?.summaries?.['raster:bands'] ?? []) add(b?.name, b?.unit)
  for (const [k, ia] of Object.entries<any>(col?.item_assets ?? {})) {
    const role = ia?.roles
    if (Array.isArray(role) && (role.includes('thumbnail') || role.includes('overview') || role.includes('metadata'))) continue
    const rb = ia?.['raster:bands']?.[0]
    const eb = ia?.['eo:bands']?.[0]
    add(eb?.name ?? k, rb?.unit ?? eb?.unit)
  }
  return out
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export function stacAccessKind(col: any): AccessKind {
  const types: string[] = []
  for (const ia of Object.values<any>(col?.item_assets ?? {})) if (ia?.type) types.push(String(ia.type).toLowerCase())
  for (const a of Object.values<any>(col?.assets ?? {})) {
    if (a?.type && !(a.roles ?? []).some((r: string) => ['thumbnail', 'metadata', 'overview'].includes(r))) {
      types.push(String(a.type).toLowerCase())
    }
  }
  const has = (re: RegExp) => types.some((t) => re.test(t))
  if (has(/geotiff/) || has(/cog/)) return 'stac-cog'
  if (has(/zarr/)) return 'stac-zarr'
  return 'stac-other'
}

// ---------------------------------------------------------------------------
// Entry assembly
// ---------------------------------------------------------------------------

interface Parts {
  source: string
  localId: string
  title: string
  description: unknown
  descriptionMax?: number
  providers?: unknown[]
  keywords?: unknown[]
  categories?: string[]
  bbox: [number, number, number, number]
  temporal: { start: string | null; end: string | null }
  resolution_m: number | null
  license: unknown
  access: DatasetAccess
  variables?: DatasetVariable[]
  forceThemes?: Theme[]
  extraThemeText?: string
  keywordCap?: number
  providerCap?: number
  curated?: boolean
}

export function buildEntry(p: Parts): DatasetEntry {
  const description = cleanText(p.description, p.descriptionMax ?? 400)
  const keywords = uniqueStrings((p.keywords ?? []).map((k) => String(k).toLowerCase()), p.keywordCap ?? 14)
  const themes = assignThemes({
    id: p.localId,
    title: p.title,
    keywords,
    description: `${description} ${p.extraThemeText ?? ''}`,
    categories: p.categories,
  })
  for (const t of p.forceThemes ?? []) if (!themes.includes(t)) themes.unshift(t)
  return {
    id: `${p.source}:${p.localId}`,
    title: cleanText(p.title, 160),
    description,
    source: p.source,
    providers: uniqueStrings(p.providers ?? [], p.providerCap ?? 5),
    themes: themes.slice(0, 6),
    variables: p.variables ?? [],
    spatial: { bbox: p.bbox, global: isGlobalBbox(p.bbox) },
    temporal: p.temporal,
    resolution_m: p.resolution_m,
    license: normalizeLicense(p.license),
    access: p.access,
    keywords,
    ...(p.curated ? { curated: true } : {}),
  }
}

export interface StacSourceInfo {
  source: string
  /** Root URL of the STAC API this collection came from. */
  root: string
  auth: AuthKind | null
  notes?: string
}

/** Any STAC collection (Planetary Computer, Earth Search, LandsatLook, CDSE, ...). */
export function stacCollectionToEntry(col: any, info: StacSourceInfo): DatasetEntry | null {
  const id = String(col?.id ?? '').trim()
  const title = cleanText(col?.title || id, 160)
  const bbox = extentBbox(col?.extent)
  if (!id || !title || !bbox) return null
  const kind = stacAccessKind(col)
  const sarExt = JSON.stringify(col?.stac_extensions ?? []).includes('/sar/') || !!col?.summaries?.['sar:polarizations']
  return buildEntry({
    source: info.source,
    localId: id,
    title,
    description: col?.description,
    providers: (col?.providers ?? []).map((p: any) => p?.name),
    keywords: col?.keywords,
    bbox,
    temporal: extentTemporal(col?.extent),
    resolution_m: stacResolution(col),
    license: col?.license,
    variables: stacVariables(col),
    forceThemes: sarExt ? ['sar'] : undefined,
    access: {
      kind,
      url: `${info.root.replace(/\/+$/, '')}/collections/${encodeURIComponent(id)}`,
      requires_auth: info.auth,
      notes: info.notes ?? DEFAULT_NOTES[info.source] ?? '',
    },
  })
}

// --- NASA CMR-STAC ----------------------------------------------------------

const CMR_NOISE = new Set(['earth science', 'not provided', 'none', 'not applicable', 'earth science services', 'completed', 'in work'])

export function cmrCollectionToEntry(col: any, provider: string, root: string): DatasetEntry | null {
  const id = String(col?.id ?? '').trim()
  const title = cleanText(col?.title || '', 160)
  const bbox = extentBbox(col?.extent)
  if (!id || !title || !bbox) return null
  const gcmd = (col?.keywords ?? []).map((k: any) => String(k)).filter((k: string) => !CMR_NOISE.has(k.toLowerCase()))
  const platforms = (col?.summaries?.platform ?? []).filter((p: any) => !/not provided/i.test(String(p)))
  const instruments = (col?.summaries?.instruments ?? []).filter((p: any) => !/not provided/i.test(String(p)))
  const licenseRaw = String(col?.license ?? '')
  const license = /^(not-provided|proprietary|other)?$/i.test(licenseRaw) ? 'various' : licenseRaw
  return buildEntry({
    source: 'cmr',
    localId: `${provider}/${id}`,
    title,
    description: col?.description,
    descriptionMax: 160,
    providers: (col?.providers ?? []).map((p: any) => p?.name).filter((n: any) => n && n !== 'NASA EOSDIS'),
    providerCap: 2,
    keywordCap: 7,
    keywords: [...platforms, ...instruments, ...gcmd.slice().reverse()],
    categories: gcmd,
    bbox,
    temporal: extentTemporal(col?.extent),
    resolution_m: stacResolution(col),
    license,
    access: {
      kind: 'stac-other',
      url: `${root.replace(/\/+$/, '')}/${provider}/collections/${encodeURIComponent(id)}`,
      requires_auth: 'earthdata',
      notes: DEFAULT_NOTES.cmr,
    },
  })
}

// --- Google Earth Engine static STAC ---------------------------------------

export function geeCollectionToEntry(col: any): DatasetEntry | null {
  const id = String(col?.id ?? '').trim()
  const title = cleanText(col?.title || id, 160)
  const bbox = extentBbox(col?.extent)
  if (!id || !bbox) return null
  if (/deprecated/i.test(String(col?.['gee:status'] ?? ''))) return null
  const type = String(col?.['gee:type'] ?? 'image')
  const ctor = type === 'image_collection' ? 'ee.ImageCollection' : type === 'table' || type === 'table_collection' ? 'ee.FeatureCollection' : 'ee.Image'
  return buildEntry({
    source: 'gee',
    localId: id,
    title,
    description: col?.description,
    providers: (col?.providers ?? []).filter((p: any) => !(p?.roles ?? []).includes('host') || (p?.roles ?? []).length > 1).map((p: any) => p?.name),
    keywords: col?.keywords,
    categories: [...(col?.['gee:categories'] ?? []), ...(col?.keywords ?? [])].map(String),
    bbox,
    temporal: extentTemporal(col?.extent),
    resolution_m: stacResolution(col),
    license: col?.license,
    variables: stacVariables(col),
    access: {
      kind: 'earthengine',
      url: `https://developers.google.com/earth-engine/datasets/catalog/${id.replace(/\//g, '_')}`,
      requires_auth: 'earthengine',
      notes: `${ctor}('${id}'); needs an Earth Engine account/service account. ${col?.['gee:terms_of_use'] ? 'Has dataset-specific terms of use.' : ''}`.trim(),
    },
  })
}

// --- OpenTopography ---------------------------------------------------------

function geometryBbox(geojson: any): [number, number, number, number] | null {
  let minX = 180, minY = 90, maxX = -180, maxY = -90
  let seen = false
  const walk = (c: any) => {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      // Some surveys publish projected (metre) coordinates here; those are not lon/lat, so skip them.
      if (!(Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90)) return
      seen = true
      minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0])
      minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1])
    } else if (Array.isArray(c)) c.forEach(walk)
  }
  for (const f of geojson?.features ?? []) walk(f?.geometry?.coordinates)
  return seen ? [minX, minY, maxX, maxY] : null
}

export function openTopographyToEntry(ds: any, format: 'PointCloud' | 'Raster'): DatasetEntry | null {
  const d = ds?.Dataset ?? ds
  const oid = String(d?.identifier?.value ?? '').trim()
  const title = cleanText(d?.name, 160)
  const bbox = geometryBbox(d?.spatialCoverage?.geo?.geojson)
  if (!oid || !title || !bbox) return null
  const [a, b] = String(d?.temporalCoverage ?? '').split('/').map((s: string) => s.trim().slice(0, 10))
  const isPc = format === 'PointCloud'
  const keywords = String(d?.keywords ?? '').split(/[,;]/).map((s: string) => s.trim()).filter(Boolean)
  const res = isPc ? null : parseResolutionFromTitle(`${d?.name ?? ''} ${keywords.join(' ')}`) ?? parseResolutionFromDescription(d?.description ?? '')
  return buildEntry({
    source: 'opentopography',
    localId: oid,
    title,
    description: d?.description || `${isPc ? 'Lidar point cloud' : 'Raster elevation'} survey distributed by OpenTopography.`,
    descriptionMax: 140,
    keywordCap: 8,
    providers: ['OpenTopography'],
    keywords: [...keywords, isPc ? 'lidar' : 'dem'],
    bbox,
    temporal: { start: a || null, end: b || a || null },
    resolution_m: res,
    license: 'various',
    forceThemes: isPc ? ['lidar'] : ['elevation'],
    access: {
      kind: 'rest',
      url: `https://portal.opentopography.org/${isPc ? 'lidarDataset' : 'rasterDataset'}?opentopoID=${encodeURIComponent(oid)}`,
      requires_auth: 'opentopography',
      notes: DEFAULT_NOTES.opentopography,
    },
  })
}

// --- Global Forest Watch data API ------------------------------------------

export function gfwDatasetToEntry(row: any): DatasetEntry | null {
  const id = String(row?.dataset ?? '').trim()
  const m = row?.metadata ?? {}
  const title = cleanText(m.title || id.replace(/_/g, ' '), 160)
  if (!id || !m.title) return null
  const resolution = numberish(m.spatial_resolution) ?? parseResolutionFromTitle(`${m.resolution_description ?? ''} ${m.subtitle ?? ''}`)
  const lic = String(m.license ?? '')
  const yrs = `${m.subtitle ?? ''} ${m.title ?? ''}`.match(/\b(19|20)\d{2}\b/g)?.map(Number).sort() ?? []
  return buildEntry({
    source: 'gfw',
    localId: id,
    title,
    description: [m.overview, m.function, m.subtitle].filter(Boolean).join(' '),
    providers: [m.source ? String(m.source).slice(0, 60) : 'World Resources Institute / Global Forest Watch'],
    keywords: [...(m.tags ?? []), 'global forest watch'],
    bbox: GLOBAL_BBOX,
    temporal: yrs.length ? { start: `${yrs[0]}-01-01`, end: yrs.length > 1 ? `${yrs[yrs.length - 1]}-12-31` : `${yrs[0]}-12-31` } : { start: null, end: null },
    resolution_m: resolution,
    license: /^(tbd|)$/i.test(lic) ? 'various' : lic,
    access: {
      kind: 'rest',
      url: `https://data-api.globalforestwatch.org/dataset/${encodeURIComponent(id)}`,
      requires_auth: 'api-key',
      notes: DEFAULT_NOTES.gfw,
    },
  })
}

// --- openEO collections -----------------------------------------------------

export function openEoCollectionToEntry(col: any, root: string, source = 'openeo-cdse'): DatasetEntry | null {
  const id = String(col?.id ?? '').trim()
  const bbox = extentBbox(col?.extent)
  if (!id || !bbox) return null
  const dims = col?.['cube:dimensions'] ?? {}
  const bandDim = Object.values<any>(dims).find((d) => d?.type === 'bands')
  const variables: DatasetVariable[] = (bandDim?.values ?? []).slice(0, 24).map((n: any) => ({ name: String(n) }))
  return buildEntry({
    source,
    localId: id,
    title: col?.title || id,
    description: col?.description,
    providers: (col?.providers ?? []).map((p: any) => p?.name),
    keywords: col?.keywords,
    bbox,
    temporal: extentTemporal(col?.extent),
    resolution_m: stacResolution(col),
    license: col?.license,
    variables,
    access: {
      kind: 'openeo',
      url: `${root.replace(/\/+$/, '')}/collections/${encodeURIComponent(id)}`,
      requires_auth: 'copernicus',
      notes: DEFAULT_NOTES['openeo-cdse'],
    },
  })
}
