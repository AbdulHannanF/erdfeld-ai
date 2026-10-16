/** ESA WorldCover 2021 helpers: class labels, ClassesPalette, categorical stats parser, PC STAC fetch. */

import type { RasterDescriptor } from '@/lib/raster-style'
import { PC_DATA } from './analysis/sensors'
import { cachedFetchJson } from './cache'
import { chooseMaxSize } from './digitize/scene-grid'
import { bboxToPolygon } from './geometry'
import { getLogger } from './logger'
import { toGeometry } from './pixels'
import { searchPCStac, signPCAsset } from './stac'
import { TITILER_BASE } from './titiler'
import type { ClassesPalette } from './types'

const log = getLogger('lib/worldcover')

/** ESA WorldCover 2021 class definitions (official colors from ESA product guide). */
export const WORLDCOVER_LABELS: Record<number, { name: string; color: string }> = {
  10:  { name: 'Tree Cover',          color: '#006400' },
  20:  { name: 'Shrubland',           color: '#ffbb22' },
  30:  { name: 'Grassland',           color: '#ffff4c' },
  40:  { name: 'Cropland',            color: '#f096ff' },
  50:  { name: 'Built-up',            color: '#fa0000' },
  60:  { name: 'Bare / Sparse Veg',   color: '#b4b4b4' },
  70:  { name: 'Snow / Ice',          color: '#f0f0f0' },
  80:  { name: 'Permanent Water',     color: '#0064c8' },
  90:  { name: 'Herbaceous Wetland',  color: '#0096a0' },
  95:  { name: 'Mangroves',           color: '#00cf75' },
  100: { name: 'Moss / Lichen',       color: '#fae6a0' },
}

/** ClassesPalette for LayerLegend — mirrors WORLDCOVER_LABELS. */
export const WORLDCOVER_PALETTE: ClassesPalette = {
  kind: 'classes',
  label: 'ESA WorldCover 2021',
  classes: Object.entries(WORLDCOVER_LABELS).map(([, { name, color }]) => ({
    color,
    label: name,
  })),
}

export interface WorldCoverStats {
  /** % of in-AOI pixels classified as Built-up (class 50). */
  builtUpPct: number
  /** % of in-AOI pixels classified as Tree Cover (class 10). */
  treeCoverPct: number
  /** % of in-AOI pixels classified as Cropland (class 40). */
  croplandPct: number
  /** % Grassland + Shrubland (classes 30 + 20). */
  grasslandPct: number
  /** % Permanent Water + Herbaceous Wetland (classes 80 + 90). */
  waterPct: number
  /** Label of the most common class by pixel count. */
  dominantClass: string
  /** Total valid pixel count. */
  totalPixels: number
  /** Every class that occurs, largest first (shares of the counted pixels). */
  classes: WorldCoverClassShare[]
  year: 2021
}

/** Pull the b1 statistics block out of either titiler envelope: GET returns
 *  `{b1: …}`, POST (feature cutline) returns a GeoJSON Feature. */
function b1Block(statsJson: any): any | null {
  return (
    statsJson?.properties?.statistics?.b1 ??
    statsJson?.features?.[0]?.properties?.statistics?.b1 ??
    statsJson?.b1 ??
    null
  )
}

/** Class → pixel-count map from a titiler `categorical=true` histogram.
 *
 *  titiler.xyz does **not** return a `categories` key (verified live 2026-08-10);
 *  categorical stats arrive as `histogram: [[counts…], [values…]]` where the
 *  second array holds the actual class values, one per count. Some builds /
 *  continuous requests return `counts + 1` bin edges instead — then the lower
 *  edge names the class. */
function countsFromHistogram(hist: any): Record<number, number> | null {
  if (!Array.isArray(hist) || hist.length < 2) return null
  const [counts, edges] = hist
  if (!Array.isArray(counts) || !Array.isArray(edges) || counts.length === 0) return null
  if (edges.length !== counts.length && edges.length !== counts.length + 1) return null

  const out: Record<number, number> = {}
  for (let i = 0; i < counts.length; i++) {
    const cls = Math.round(Number(edges[i]))
    const n = Number(counts[i])
    if (!Number.isFinite(cls) || !Number.isFinite(n)) continue
    out[cls] = (out[cls] ?? 0) + n
  }
  return Object.keys(out).length ? out : null
}

/** Parse a titiler /cog/statistics response (categorical=true) into WorldCoverStats.
 *  Accepts both titiler envelopes and both categorical encodings: an explicit
 *  `categories` map (keys may be "10" or "10.0"), or the `histogram` pair that
 *  titiler.xyz actually returns. */
export function parseWorldCoverStats(statsJson: any): WorldCoverStats | null {
  const b1 = b1Block(statsJson)
  if (!b1 || typeof b1 !== 'object') return null

  const cats = b1.categories as Record<string, number> | undefined
  let counts: Record<number, number> | null = null

  if (cats && typeof cats === 'object' && Object.keys(cats).length > 0) {
    // Normalize float keys ("10.0" → 10) and accumulate counts
    counts = {}
    for (const [k, v] of Object.entries(cats)) {
      const key = Math.round(parseFloat(k))
      if (!isNaN(key) && typeof v === 'number') {
        counts[key] = (counts[key] ?? 0) + v
      }
    }
  } else {
    counts = countsFromHistogram(b1.histogram)
  }
  if (!counts) return null

  const totalPixels = Object.values(counts).reduce((a, b) => a + b, 0)
  if (totalPixels === 0) return null

  const pct = (cls: number) =>
    Math.round(((counts[cls] ?? 0) / totalPixels) * 1000) / 10 // 1 decimal place

  const builtUpPct  = pct(50)
  const treeCoverPct = pct(10)
  const croplandPct  = pct(40)
  const grasslandPct = pct(30) + pct(20)  // Grassland + Shrubland
  const waterPct     = pct(80) + pct(90)  // Permanent Water + Herbaceous Wetland

  const [dominantVal] = Object.entries(counts).sort(([, a], [, b]) => b - a)[0]
  const dominantClass = WORLDCOVER_LABELS[Math.round(parseFloat(dominantVal))]?.name ?? 'Unknown'

  const { shares } = classSharesFromCounts(new Map(Object.entries(counts).map(([k, v]) => [Math.round(Number(k)), v])))
  return { builtUpPct, treeCoverPct, croplandPct, grasslandPct, waterPct, dominantClass, totalPixels, classes: shares, year: 2021 }
}

/** Build a URL-encoded JSON colormap string for titiler tile requests.
 *  Maps each WorldCover pixel value to an RGBA tuple. */
export function buildWorldCoverColormap(): string {
  const cm: Record<string, [number, number, number, number]> = {}
  for (const [v, { color }] of Object.entries(WORLDCOVER_LABELS)) {
    const r = parseInt(color.slice(1, 3), 16)
    const g = parseInt(color.slice(3, 5), 16)
    const b = parseInt(color.slice(5, 7), 16)
    cm[v] = [r, g, b, 220]
  }
  return encodeURIComponent(JSON.stringify(cm))
}

/** Fetch ESA WorldCover 2021 categorical stats + tile URL for an AOI.
 *
 *  ISS-102: this used to GET `/cog/statistics?bbox=…`, which titiler **ignores** —
 *  it returned statistics for the whole COG, and a WorldCover COG is a 3°×3°
 *  (~330 km) tile. Measured live 2026-08-10 on an AOI inside Lahore:
 *
 *    GET  (bbox → whole tile) : majority **Cropland**,  built-up  3.8%
 *    POST (AOI polygon)       : majority **Built-up**,  built-up 82.9%
 *
 *  Pass `aoiPolygon` to clip to the drawn shape; without one the bbox is sent as
 *  a rectangle cutline (still correct, just coarser). `clip` reports which.
 *
 *  Uses Planetary Computer STAC (free, no key) + SAS signing + titiler.xyz.
 *  Returns null on any failure — caller should fall back gracefully. */
export async function fetchWorldCoverData(bbox: number[], aoiPolygon?: any): Promise<{
  stats: WorldCoverStats
  tileUrl: string
  unsignedHref: string
  clip: 'polygon' | 'bbox'
} | null> {
  const [minLng, minLat, maxLng, maxLat] = bbox

  const drawn = toGeometry(aoiPolygon)
  const geom = drawn ?? bboxToPolygon(bbox)
  if (!geom) {
    log.warn({ bbox }, 'no usable geometry for WorldCover statistics')
    return null
  }
  const clip: 'polygon' | 'bbox' = drawn ? 'polygon' : 'bbox'

  // 1. Find a WorldCover 2021 item covering the bbox
  let item: any = null
  try {
    const data = await searchPCStac([minLng, minLat, maxLng, maxLat], 'esa-worldcover', 8)
    item = pickWorldCover2021(data.features ?? [])[0] ?? null
  } catch (err: any) {
    log.warn({ err: err.message }, 'PC STAC query failed')
    return null
  }
  if (!item) return null

  const unsignedHref: string | undefined =
    item?.assets?.map?.href ?? item?.assets?.data?.href ?? undefined
  if (!unsignedHref) return null

  // 2. Sign the asset URL (~1 h SAS token, same pattern as JRC GSW)
  let signedUrl: string
  try {
    signedUrl = await signPCAsset(unsignedHref)
  } catch (err: any) {
    log.warn({ err: err.message }, 'SAS signing failed')
    return null
  }

  // 3. Categorical pixel stats from titiler, POSTed as a cutline so the counts are
  //    actually about the AOI (cached by unsigned URL to survive SAS rotation).
  let statsJson: any = null
  try {
    const statsParams = new URLSearchParams({
      url: signedUrl,
      categorical: 'true',
      bidx: '1',
      max_size: '512',
    })
    const geomKey = `${clip}:${JSON.stringify(geom).length}:${JSON.stringify((geom.coordinates || []).slice(0, 1)).slice(0, 80)}`
    statsJson = await cachedFetchJson(
      `worldcover-stats:${unsignedHref}:${geomKey}`,
      55 * 60 * 1000,  // 55 min — just under the 1h SAS token lifetime
      async () => {
        const res = await fetch(`${TITILER_BASE}/cog/statistics?${statsParams}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'Feature', properties: {}, geometry: geom }),
          signal: AbortSignal.timeout(30000),
        })
        if (!res.ok) throw new Error(`titiler stats HTTP ${res.status}`)
        return res.json()
      },
    )
  } catch (err: any) {
    log.warn({ err: err.message }, 'titiler stats failed')
    return null
  }

  const stats = parseWorldCoverStats(statsJson)
  if (!stats) return null

  // 4. Build tile URL (signed URL baked in; expires ~1h — labeled honestly in summary)
  const colormap = buildWorldCoverColormap()
  // The TileMatrixSet segment is REQUIRED — titiler.xyz answers the older
  // `/cog/tiles/{z}/{x}/{y}` form with 404, so this layer was created, counted
  // and legended while never drawing a single tile (41 × 404 in the 2026-08-17
  // sweep). Every other tile-URL builder in the codebase already carries it.
  const tileUrl = `${TITILER_BASE}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${encodeURIComponent(signedUrl)}&bidx=1&colormap=${colormap}`

  return { stats, tileUrl, unsignedHref, clip }
}

// ---------------------------------------------------------------------------
// Per-class land cover over the AOI polygon (classify_land_cover)
// ---------------------------------------------------------------------------

/** The 2021 (v200) product among the STAC items that touch an AOI. PC also serves the 2020 (v100)
 *  product for the same tiles; the labels and the legend here are the 2021 ones, so a 2020 item is
 *  never mixed in. An item whose id carries no year at all (a mocked or custom catalogue) is kept. */
export function pickWorldCover2021(features: any[]): any[] {
  const has = (f: any, re: RegExp) => re.test(String(f?.id ?? ''))
  const dated = features.filter((f) => has(f, /(19|20)\d{2}/))
  if (dated.length === 0) return features
  return features.filter((f) => has(f, /2021/))
}

/** XYZ template served by the Planetary Computer data API for one WorldCover item, painted with the
 *  official class colours. Unlike a signed COG URL it never expires. */
export function worldCoverItemTileUrl(itemId: string): string {
  const colormap: Record<string, [number, number, number, number]> = {}
  for (const [v, { color }] of Object.entries(WORLDCOVER_LABELS)) {
    colormap[v] = [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16), 255]
  }
  const p = new URLSearchParams({ collection: 'esa-worldcover', item: itemId, assets: 'map', colormap: JSON.stringify(colormap), nodata: '0' })
  return `${PC_DATA}/item/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${p}`
}

export interface WorldCoverClassShare {
  value: number
  label: string
  color: string
  /** Share of classified AOI pixels, percent (one decimal). */
  pct: number
  pixels: number
}

/** Class shares from class counts: only classes that occur, largest first. Unknown class values
 *  (not in the 11-class legend) are not counted as classified. */
export function classSharesFromCounts(counts: ReadonlyMap<number, number>): { shares: WorldCoverClassShare[]; classified: number } {
  let classified = 0
  for (const [v, n] of counts) if (WORLDCOVER_LABELS[v] && n > 0) classified += n
  if (classified === 0) return { shares: [], classified: 0 }
  const shares = [...counts.entries()]
    .filter(([v, n]) => WORLDCOVER_LABELS[v] && n > 0)
    .map(([v, n]) => ({
      value: v,
      label: WORLDCOVER_LABELS[v].name,
      color: WORLDCOVER_LABELS[v].color,
      pct: Math.round((n / classified) * 1000) / 10,
      pixels: n,
    }))
    .sort((a, b) => b.pixels - a.pixels)
  return { shares, classified }
}

export interface WorldCoverCover {
  shares: WorldCoverClassShare[]
  classifiedPixels: number
  /** Classified pixels over the pixels the polygon should hold at this grid, 0..100. */
  coveragePct: number
  /** Side of the square one sampled pixel represents (m): 10 unless the AOI is large. */
  gsdM: number
  /** One entry per WorldCover tile that holds classified pixels over the AOI. */
  tiles: Array<{ itemId: string; tileUrl: string }>
}

export type WorldCoverOutcome =
  | { ok: true; cover: WorldCoverCover }
  | { ok: false; reason: 'no_polygon' | 'no_data' | 'fetch_failed'; message: string }

/** Per-class fractions of ESA WorldCover 2021 inside the AOI polygon, from titiler's categorical statistics
 *  over a polygon cutline (class codes are counted, never blended).
 *  Every 2021 tile touching the AOI is read and merged. A fetch failure and an AOI with no
 *  classified pixel (open sea) are different outcomes and are reported as such. */
export async function fetchWorldCoverClasses(aoi: any, bbox: number[], areaKm2: number): Promise<WorldCoverOutcome> {
  const geom = toGeometry(aoi)
  const sizing = geom ? chooseMaxSize(geom, 10, 1000) : null
  if (!geom || !sizing) return { ok: false, reason: 'no_polygon', message: 'A polygon AOI is required (draw a polygon, rectangle, or circle).' }

  let items: any[]
  try {
    const found = await searchPCStac(bbox, 'esa-worldcover', 8)
    items = pickWorldCover2021(found.features ?? [])
  } catch (err: any) {
    return { ok: false, reason: 'fetch_failed', message: `The Planetary Computer catalogue could not be searched (${err?.message ?? 'unknown error'}).` }
  }
  if (items.length === 0) return { ok: false, reason: 'no_data', message: 'ESA WorldCover 2021 has no tile over this AOI.' }

  // The `map` asset is a palette COG: a pixel read (`feature.npy`) comes back as RGBA with the colour
  // already applied, and the class codes are gone. titiler's categorical statistics histogram the
  // raw codes, clipped to the polygon (a cutline), so counts are taken from there. Tiles do not
  // overlap, so the counts of the tiles an AOI touches add up.
  const counts = new Map<number, number>()
  const read: Array<{ itemId: string; classified: number }> = []
  /** Pixels of the sampled grid that fall inside the polygon, as titiler counts them (valid + masked). */
  let polygonPx = 0
  let lastErr = ''
  let answered = 0
  for (const item of items) {
    const href: string | undefined = item?.assets?.map?.href ?? item?.assets?.data?.href
    if (!href) { lastErr = `tile ${item?.id} has no map asset`; continue }
    try {
      const signed = await signPCAsset(href)
      const qs = new URLSearchParams({ url: signed, categorical: 'true', bidx: '1', max_size: String(sizing.maxSize) })
      const geomKey = `${JSON.stringify(geom).length}:${JSON.stringify((geom.coordinates || []).slice(0, 1)).slice(0, 80)}`
      const json = await cachedFetchJson(`worldcover-classes:${href.split('?')[0]}:${sizing.maxSize}:${geomKey}`, 55 * 60 * 1000, async () => {
        const res = await fetch(`${TITILER_BASE}/cog/statistics?${qs}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'Feature', properties: {}, geometry: geom }),
          signal: AbortSignal.timeout(45_000),
        })
        if (!res.ok) throw new Error(`titiler cog/statistics HTTP ${res.status}`)
        return res.json()
      })
      const b1 = b1Block(json)
      const tileCounts = countsFromHistogram(b1?.histogram)
      const inPolygon = Number(b1?.valid_pixels) + Number(b1?.masked_pixels ?? 0)
      if (Number.isFinite(inPolygon)) polygonPx = Math.max(polygonPx, inPolygon)
      answered++
      let classified = 0
      for (const [v, n] of Object.entries(tileCounts ?? {})) {
        const cls = Math.round(Number(v))
        if (!WORLDCOVER_LABELS[cls] || !(n > 0)) continue
        counts.set(cls, (counts.get(cls) ?? 0) + n)
        classified += n
      }
      read.push({ itemId: String(item.id), classified })
    } catch (err: any) {
      lastErr = err?.message ?? 'read failed'
      log.warn({ item: item?.id, err: lastErr }, 'worldcover class statistics failed')
    }
  }
  if (answered === 0) return { ok: false, reason: 'fetch_failed', message: `titiler could not read the WorldCover classes (${lastErr || 'unknown error'}). The public titiler.xyz instance is rate-limited, so retry shortly.` }

  const { shares, classified } = classSharesFromCounts(counts)
  if (classified === 0) return { ok: false, reason: 'no_data', message: 'WorldCover holds no classified pixel inside this polygon (for example open sea, which the product leaves unclassified).' }

  // Coverage and the sampled pixel size come from titiler's own count of the polygon's grid pixels;
  // without it (an unexpected response) they fall back to the planned grid.
  const expected = polygonPx > 0 ? polygonPx : Math.max(1, (areaKm2 * 1e6) / (sizing.gsdM * sizing.gsdM))
  const gsdM = Math.sqrt((areaKm2 * 1e6) / expected)
  return {
    ok: true,
    cover: {
      shares,
      classifiedPixels: classified,
      coveragePct: Math.min(100, (classified / expected) * 100),
      gsdM,
      tiles: read.filter((r) => r.classified > 0).map((r) => ({ itemId: r.itemId, tileUrl: worldCoverItemTileUrl(r.itemId) })),
    },
  }
}

/** Categorical raster descriptor for a WorldCover layer: the classes that occur, with their share. */
export function worldCoverDescriptor(shares: WorldCoverClassShare[], itemId?: string): RasterDescriptor {
  return {
    kind: 'categorical',
    sensor: 'esa-worldcover',
    collection: 'esa-worldcover',
    sceneId: itemId,
    datetime: '2021',
    classes: shares.map((s) => ({ value: s.value, label: `${s.label} ${s.pct}%`, color: s.color })),
    stretch: 'fixed',
  }
}

/** Descriptor listing every official class (a layer whose AOI shares were not computed per class). */
export function worldCoverLegendDescriptor(itemId?: string): RasterDescriptor {
  return {
    kind: 'categorical',
    sensor: 'esa-worldcover',
    collection: 'esa-worldcover',
    sceneId: itemId,
    datetime: '2021',
    classes: Object.entries(WORLDCOVER_LABELS).map(([v, { name, color }]) => ({ value: Number(v), label: name, color })),
    stretch: 'fixed',
  }
}
