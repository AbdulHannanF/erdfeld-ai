/** titiler.xyz client — COG/STAC tile + band-stats endpoints. */

import { cachedFetchJson, fetchWithRetry } from './cache'
import { bboxToPolygon, genId } from './geometry'
import { S2_ASSET_KEYS, getStacItemHref, pickAssetKey } from './stac'
import { resolveBandSetReflectance, scaleExpression } from './reflectance'

/** Resolve the TiTiler endpoint, trimming any trailing slash(es). Pure + exported so
 *  the env-driven behavior is unit-testable. */
export function resolveTitilerBase(endpoint?: string): string {
  return (endpoint || 'https://titiler.xyz').replace(/\/+$/, '')
}

/** TiTiler endpoint for COG/STAC raster tiles + per-band statistics.
 *
 *  Defaults to the public `titiler.xyz` instance maintained by DevelopmentSeed — perfect
 *  for development, but it is a **shared, rate-limited community server with no SLA**, and
 *  is the leading cause of NDVI/spectral tiles intermittently failing to render in
 *  production (the "flat-colour fallback" symptom).
 *
 *  For a reliable, fast, version-pinned raster pipeline, run your own TiTiler (see the
 *  `titiler` service in docker-compose.yml) and point `TITILER_ENDPOINT` at it
 *  (e.g. `http://titiler:8000` inside compose, or your own public HTTPS URL). */
export const TITILER_BASE = resolveTitilerBase(process.env.TITILER_ENDPOINT)

/** A titiler `/cog/statistics` b1 block (the fields we read). `count` = valid pixel
 *  count, used as polygon-vs-bbox evidence for the HONESTY-001 verification. */
export interface CogBandStats {
  mean: number
  min?: number
  max?: number
  count?: number
  std?: number
  median?: number
  /** Percentage of the clipped window that carried data. */
  valid_percent?: number
  valid_pixels?: number
  percentile_2?: number
  percentile_98?: number
  /**
   * `[[counts], [binEdges]]` — and for `categorical=true`, `[[counts], [classValues]]`.
   *
   * titiler has always returned this; the interface simply did not admit it, so
   * callers needing class counts had to re-issue the request. Phase 3 discovery
   * reads it for categorical datasets it was not pre-wired for.
   */
  histogram?: number[][]
}

/** Per-band statistics from a single COG clipped to the AOI **bounding box**.
 *
 *  ISS-102: this used to issue GET `/cog/statistics?bbox=…`, which titiler
 *  **silently ignores** — it returns whole-COG statistics. Re-verified live on
 *  2026-08-10 against titiler.xyz with a Sentinel-2 B08 COG: the AOI bbox and a
 *  bbox 400 km away both returned mean 2678.755 and count 1 048 576 (a fixed
 *  1024×1024 read of the entire ~110 × 110 km scene). Any caller of the old path
 *  was quoting a scene average as the AOI value.
 *
 *  It now POSTs the bbox as a rectangle cutline — the same correct mechanism as
 *  `fetchCogPolygonStats`, which is what makes the returned numbers actually
 *  bbox-clipped. Prefer `fetchCogPolygonStats` with the drawn AOI when you have
 *  one; reach for this only when no polygon is available. Returns null (never a
 *  whole-scene number) on a malformed bbox or any titiler failure. */
export async function fetchCogBandStats(
  cogUrl: string,
  bbox: number[],
  extraParams?: Record<string, string>,
): Promise<CogBandStats | null> {
  const rect = bboxToPolygon(bbox)
  if (!rect) return null
  return fetchCogPolygonStats(cogUrl, rect, extraParams)
}

/** Per-band statistics from a single COG clipped to an actual **polygon** (not bbox)
 *  via titiler.xyz POST `/cog/statistics` with a GeoJSON Feature body. Returns the
 *  b1 stats block or null on failure. This is the polygon-true path that closes the
 *  bbox-clip caveat (HONESTY-001) for single-band COGs. Cached 10 minutes. */
export async function fetchCogPolygonStats(
  cogUrl: string,
  aoiPolygon: any,
  extraParams?: Record<string, string>,
): Promise<CogBandStats | null> {
  // Accept a raw geometry, a Feature wrapping it, or an AOI object holding `.geometry`.
  const geom = aoiPolygon?.type === 'Feature' ? aoiPolygon.geometry
    : aoiPolygon?.geometry ? aoiPolygon.geometry
    : aoiPolygon
  if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) return null
  const feature = { type: 'Feature', properties: {}, geometry: geom }
  const qs = new URLSearchParams({ url: cogUrl, ...(extraParams ?? {}) })
  const cacheKey = `cogpolystats:${cogUrl}:${JSON.stringify(extraParams ?? {})}:${JSON.stringify(geom).length}:${JSON.stringify((geom.coordinates || []).slice(0, 1)).slice(0, 80)}`
  try {
    return await cachedFetchJson(cacheKey, 10 * 60 * 1000, async () => {
      const res = await fetch(`${TITILER_BASE}/cog/statistics?${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(feature),
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) throw new Error(`titiler poly-stats HTTP ${res.status}`)
      const json = await res.json()
      const stats = json?.properties?.statistics?.b1
        ?? json?.features?.[0]?.properties?.statistics?.b1
        ?? json?.b1 ?? null
      if (!stats || typeof stats.mean !== 'number') throw new Error('no b1.mean in titiler poly-stats')
      return stats as CogBandStats
    })
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// RETIRED (Phase 0, 2026-08-10): `getNDVIMeanFromScene` and
// `getSpectralIndexMeanFromScene` are deleted. Both computed the index **of the
// band means** — `f(mean(NIR), mean(RED))`, not `mean(f(NIR, RED))` (ISS-112) —
// which is a different statistic by Jensen's inequality AND makes per-pixel
// cloud masking impossible. Both also fell through to the bbox path (ISS-102).
//
// Use `maskedIndexStats` / `maskedIndexMean` from `lib/index-stats.ts`: one
// polygon-clipped `feature.npy` read for the index, one for SCL, masked per
// pixel. It returns null rather than a number it cannot stand behind.
// ---------------------------------------------------------------------------

/** Build a titiler.xyz NDVI tile URL using the /stac/tiles/ endpoint.
 *
 *  Expression uses positional b1/b2 notation (b1 = first assets= param = NIR,
 *  b2 = second = Red). This is universally compatible with titiler v2.x without
 *  needing asset_as_band=true. Asset-name notation (e.g. "nir-red") requires
 *  asset_as_band but the public titiler.xyz instance rejects it (DATA-007).
 *  URL uses .png — not @1x.png — matching the v2 route /{z}/{x}/{y}.{format}. */
export function buildNDVITileUrl(item: any): string | null {
  const itemHref = getStacItemHref(item)
  if (!itemHref) return null
  const nirKey = pickAssetKey(item, S2_ASSET_KEYS.B08)
  const redKey = pickAssetKey(item, S2_ASSET_KEYS.B04)
  if (!nirKey || !redKey) return null
  const params = new URLSearchParams({
    url: itemHref,
    expression: '(b1-b2)/(b1+b2)',  // b1=nir, b2=red (positional, always compatible)
    rescale: '-1,1',
    colormap_name: 'rdylgn',
    return_mask: 'true',
  })
  params.append('assets', nirKey)
  params.append('assets', redKey)
  return `${TITILER_BASE}/stac/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${params}`
}

type SpectralIndexConfig = {
  bandKeys: string[][]
  exprTemplate: string
  colormap: string
  rescale: string
  /** The formula carries constants defined in reflectance units (EVI's +1, SAVI's +0.5), so
   *  every band must be DN -> reflectance scaled before evaluation. Pure ratios are
   *  scale-invariant and skip it. */
  reflectance?: boolean
}

export const SPECTRAL_INDEX_TILE_CONFIG: Record<string, SpectralIndexConfig> = {
  NDVI: { bandKeys: [['nir','B08'], ['red','B04']],          exprTemplate: '(BAND0-BAND1)/(BAND0+BAND1)',              colormap: 'rdylgn',  rescale: '-1,1' },
  NDWI: { bandKeys: [['green','B03'], ['nir','B08']],        exprTemplate: '(BAND0-BAND1)/(BAND0+BAND1)',              colormap: 'blues_r', rescale: '-1,1' },
  NDBI: { bandKeys: [['swir16','B11'], ['nir','B08']],       exprTemplate: '(BAND0-BAND1)/(BAND0+BAND1)',              colormap: 'orrd',    rescale: '-1,1' },
  EVI:  { bandKeys: [['nir','B08'], ['red','B04'], ['blue','B02']], exprTemplate: '2.5*(BAND0-BAND1)/(BAND0+6*BAND1-7.5*BAND2+1)', colormap: 'ylgn', rescale: '-1,1', reflectance: true },
  NBR:  { bandKeys: [['nir','B08'], ['swir22','B12']],       exprTemplate: '(BAND0-BAND1)/(BAND0+BAND1)',              colormap: 'rdylgn',  rescale: '-1,1' },
  SAVI: { bandKeys: [['nir','B08'], ['red','B04']],          exprTemplate: '1.5*(BAND0-BAND1)/(BAND0+BAND1+0.5)',      colormap: 'ylgn',    rescale: '-1,1', reflectance: true },
}

/** Positional titiler expression for an index; reflectance-scaled when the formula needs it. */
function indexExpression(item: any, cfg: SpectralIndexConfig, assetKeys: string[]): string {
  const positional = cfg.exprTemplate.replace(/BAND(\d)/g, (_, i) => `b${Number(i) + 1}`)
  if (!cfg.reflectance) return positional
  return scaleExpression(positional, resolveBandSetReflectance(item, assetKeys, { isSentinel2: true }).transforms)
}

export function buildSpectralIndexTileUrl(item: any, index: string): string | null {
  const cfg = SPECTRAL_INDEX_TILE_CONFIG[index.toUpperCase()]
  if (!cfg) return null
  const itemHref = getStacItemHref(item)
  if (!itemHref) return null
  const resolvedKeys = cfg.bandKeys.map(keys => pickAssetKey(item, keys))
  if (resolvedKeys.some(k => k === null)) return null
  // Use positional b1/b2/... notation — BAND0→b1, BAND1→b2 — no asset_as_band needed.
  const expression = indexExpression(item, cfg, resolvedKeys as string[])
  const params = new URLSearchParams({
    url: itemHref,
    expression,
    rescale: cfg.rescale,
    colormap_name: cfg.colormap,
    return_mask: 'true',
  })
  for (const key of resolvedKeys) params.append('assets', key!)
  return `${TITILER_BASE}/stac/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${params}`
}

// ---------------------------------------------------------------------------
// Server-side polygon cutline (RENDER-004 fix) — the gold standard.
//
// titiler's `/stac/feature.png` and `/cog/feature.png` endpoints render the REAL
// per-pixel data clipped to a POSTed GeoJSON polygon: pixels outside the polygon are
// transparent (alpha=0). Returned as a base64 PNG and rendered by MapPanel as an
// `imageBase64` ImageSource bounded to the polygon bbox — so the analytical raster
// matches the drawn shape exactly (no bbox bleed past a non-rectangular AOI), the same
// guarantee GEE's `.clip(geom)` gives on the GEE path. Verified live against titiler.xyz.
// ---------------------------------------------------------------------------

/** Accept a raw geometry, a Feature, or an AOI object holding `.geometry`; return a
 *  Polygon/MultiPolygon geometry or null. */
function normalizeClipGeom(aoiPolygon: any): any | null {
  const geom = aoiPolygon?.type === 'Feature' ? aoiPolygon.geometry
    : aoiPolygon?.geometry ? aoiPolygon.geometry
    : aoiPolygon
  if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) return null
  return geom
}

/** POST the GeoJSON feature to a titiler `/feature.png` URL and return the clipped
 *  PNG as base64 (cached 10 min). Returns null on any failure so callers fall back to
 *  the XYZ tile path (which still works, just bbox-bound). */
async function postFeatureClipPng(url: string, geom: any): Promise<string | null> {
  const feature = { type: 'Feature', properties: {}, geometry: geom }
  const cacheKey = `featpng:${url}:${JSON.stringify(geom).length}:${JSON.stringify((geom.coordinates || []).slice(0, 1)).slice(0, 80)}`
  try {
    return await cachedFetchJson(cacheKey, { source: 'titiler', ttlMs: 10 * 60 * 1000 }, async () => {
      const res = await fetchWithRetry(
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(feature) },
        { timeoutMs: 30_000 },
      )
      if (!res.ok) throw new Error(`titiler feature HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 200) throw new Error('titiler feature returned a tiny/empty image')
      return buf.toString('base64')
    })
  } catch {
    return null
  }
}

/** Polygon-clipped spectral-index PNG (NDVI/NDWI/NDBI/EVI/NBR/SAVI) for a Sentinel-2
 *  STAC item — real per-pixel data, transparent outside the polygon. */
export async function buildStacIndexClipPng(item: any, index: string, aoiPolygon: any, maxSize = 1024): Promise<string | null> {
  const cfg = SPECTRAL_INDEX_TILE_CONFIG[index.toUpperCase()]
  if (!cfg) return null
  const itemHref = getStacItemHref(item)
  if (!itemHref) return null
  const geom = normalizeClipGeom(aoiPolygon)
  if (!geom) return null
  const resolvedKeys = cfg.bandKeys.map((keys) => pickAssetKey(item, keys))
  if (resolvedKeys.some((k) => k === null)) return null
  const expression = indexExpression(item, cfg, resolvedKeys as string[])
  const params = new URLSearchParams({
    url: itemHref,
    expression,
    rescale: cfg.rescale,
    colormap_name: cfg.colormap,
    max_size: String(maxSize),
  })
  for (const key of resolvedKeys) params.append('assets', key!)
  return postFeatureClipPng(`${TITILER_BASE}/stac/feature.png?${params}`, geom)
}

/** Polygon-clipped TRUE-COLOUR PNG (red/green/blue) for a Sentinel-2 STAC item.
 *
 *  Deliberately NOT cloud-masked: this is what the VLM inspection path looks at
 *  (Phase 2.5, spec §3.6 A), and the whole point is to SEE the cloud that the
 *  SCL numbers say is there. Masking it out first would hide the evidence.
 *
 *  `rescale` is per band; 0–3000 covers L2A surface reflectance for land without
 *  clipping bright cloud tops to a flat white blob. */
export async function buildStacTrueColorClipPng(
  item: any,
  aoiPolygon: any,
  maxSize = 768,
  rescaleMax = 3000,
): Promise<string | null> {
  const itemHref = getStacItemHref(item)
  if (!itemHref) return null
  const geom = normalizeClipGeom(aoiPolygon)
  if (!geom) return null
  const keys = [
    pickAssetKey(item, S2_ASSET_KEYS.B04 ?? ['red', 'B04']),
    pickAssetKey(item, S2_ASSET_KEYS.B03 ?? ['green', 'B03']),
    pickAssetKey(item, S2_ASSET_KEYS.B02 ?? ['blue', 'B02']),
  ]
  if (keys.some((k) => k === null)) return null
  const params = new URLSearchParams({ url: itemHref, max_size: String(maxSize) })
  for (const key of keys) params.append('assets', key!)
  for (let i = 0; i < 3; i++) params.append('rescale', `0,${rescaleMax}`)
  return postFeatureClipPng(`${TITILER_BASE}/stac/feature.png?${params}`, geom)
}

/** NDVI is the NDVI spectral config — convenience wrapper. */
export async function buildNdviClipPng(item: any, aoiPolygon: any, maxSize = 1024): Promise<string | null> {
  return buildStacIndexClipPng(item, 'NDVI', aoiPolygon, maxSize)
}

/** Polygon-clipped PNG for a single-band COG (DEM / thermal / surface-water / worldcover).
 *  `cogUrl` must already be signed if the source requires it (PC SAS). */
export async function fetchCogClipPng(
  cogUrl: string,
  opts: { rescale?: string; colormap?: string; nodata?: string; bidx?: string; algorithm?: string; colormap_raw?: string; expression?: string },
  aoiPolygon: any,
  maxSize = 1024,
): Promise<string | null> {
  const geom = normalizeClipGeom(aoiPolygon)
  if (!geom) return null
  const params = new URLSearchParams({ url: cogUrl, max_size: String(maxSize) })
  if (opts.rescale) params.set('rescale', opts.rescale)
  if (opts.colormap) params.set('colormap_name', opts.colormap)
  if (opts.colormap_raw) params.set('colormap', opts.colormap_raw)
  if (opts.nodata) params.set('nodata', opts.nodata)
  if (opts.bidx) params.set('bidx', opts.bidx)
  if (opts.algorithm) params.set('algorithm', opts.algorithm)
  if (opts.expression) params.set('expression', opts.expression)
  return postFeatureClipPng(`${TITILER_BASE}/cog/feature.png?${params}`, geom)
}

/** titiler.xyz tile URL for a single-band DEM COG (e.g. Copernicus DEM 30m).
 *  `signedHref` must already be SAS-signed (PC asset). Colors with a terrain ramp
 *  rescaled to the AOI's actual [min,max] so the gradient spans the real relief.
 *  Real 30m per-pixel rendering — no point-sampling blur. */
export function buildDemCogTileUrl(signedHref: string, minElev: number, maxElev: number): string {
  const lo = Math.floor(minElev)
  const hi = Math.max(lo + 1, Math.ceil(maxElev))
  const params = new URLSearchParams({
    url: signedHref,
    rescale: `${lo},${hi}`,
    colormap_name: 'terrain',
    return_mask: 'true',
  })
  return `${TITILER_BASE}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${params}`
}

/** titiler.xyz hillshade tile URL for a single-band DEM COG. Produces shaded-relief
 *  terrain (the "3D-looking" grey relief in Google Earth). `signedHref` must be SAS-signed. */
export function buildDemHillshadeTileUrl(signedHref: string): string {
  const params = new URLSearchParams({
    url: signedHref,
    algorithm: 'hillshade',
    // The shading of a pixel needs its neighbours: without a 2 px read buffer every tile's edge rows and columns
    // are computed with missing neighbours and show as a grid of lines at tile boundaries (seen at zoom 15).
    buffer: '2',
    return_mask: 'true',
  })
  return `${TITILER_BASE}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${params}`
}

/** Landsat C2 L2 ST_B10 raw DN -> Kelvin: `ST_K = DN * 0.00341802 + 149.0`. */
export const LST_SCALE = 0.00341802
export const LST_OFFSET = 149.0
/** Raw ST_B10 digital number -> degrees Celsius. */
export const dnToCelsius = (dn: number): number => dn * LST_SCALE + LST_OFFSET - 273.15
/** titiler band math turning the raw ST_B10 DN into degrees Celsius, so a tile, a clipped PNG, the
 *  legend and the statistics all speak one unit (the `rescale` is then in degrees Celsius). */
export const LST_CELSIUS_EXPRESSION = `b1*${LST_SCALE}+${LST_OFFSET}-273.15`

/** Query parameters colouring a PC-signed Landsat ST_B10 COG by surface temperature on
 *  `[minC, maxC]` degrees Celsius. The raw DN is a uint16 of tens of thousands, so a Kelvin range
 *  handed to titiler's `rescale` saturates every pixel to one colour: the scale/offset must be
 *  applied first (band math), and the stretch given in the result's unit. */
export function landsatLstRenderParams(minC: number, maxC: number): { expression: string; rescale: string; colormap: string } {
  return { expression: LST_CELSIUS_EXPRESSION, rescale: `${minC},${maxC}`, colormap: 'plasma' }
}

/** titiler tile URL for a PC-signed Landsat ST_B10 COG, coloured by surface temperature (degrees C). */
export function buildLandsatLstTileUrl(signedHref: string, minC: number, maxC: number): string {
  const r = landsatLstRenderParams(minC, maxC)
  const params = new URLSearchParams({
    url: signedHref,
    expression: r.expression,
    rescale: r.rescale,
    colormap_name: r.colormap,
    nodata: '0',
    return_mask: 'true',
  })
  return `${TITILER_BASE}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${params}`
}

/** Polygon-clipped Landsat surface-temperature PNG on `[minC, maxC]` degrees Celsius. */
export function fetchLandsatLstClipPng(signedHref: string, minC: number, maxC: number, aoiPolygon: any, maxSize = 1024): Promise<string | null> {
  const r = landsatLstRenderParams(minC, maxC)
  return fetchCogClipPng(signedHref, { expression: r.expression, rescale: r.rescale, colormap: r.colormap, nodata: '0' }, aoiPolygon, maxSize)
}

/** NDVI class thresholds — used for bucketing histogram counts. */
const NDVI_THRESHOLDS = [
  { key: 'water',    min: -1.00, max:  0.00 },
  { key: 'bare',     min:  0.00, max:  0.15 },
  { key: 'sparse',   min:  0.15, max:  0.30 },
  { key: 'moderate', min:  0.30, max:  0.50 },
  { key: 'dense',    min:  0.50, max:  1.00 },
] as const

export type NdviBuckets = { water: number; bare: number; sparse: number; moderate: number; dense: number }

/** Pure function — convert a titiler histogram (counts + edges arrays) into
 *  per-class percentages. Sums exactly to 100. Exported for testing. */
export function ndviBucketsFromHistogram(counts: number[], edges: number[]): NdviBuckets {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total === 0) return { water: 0, bare: 0, sparse: 0, moderate: 0, dense: 100 }

  const raw: Record<string, number> = { water: 0, bare: 0, sparse: 0, moderate: 0, dense: 0 }
  for (let i = 0; i < counts.length; i++) {
    const mid = (edges[i] + edges[i + 1]) / 2
    for (const t of NDVI_THRESHOLDS) {
      if (mid >= t.min && mid < t.max) { raw[t.key] += counts[i]; break }
    }
  }

  const pcts: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw)) pcts[k] = Math.round((v / total) * 100)

  // Correct rounding drift to guarantee sum = 100
  const sum = Object.values(pcts).reduce((a, b) => a + b, 0)
  if (sum !== 100) {
    const top = Object.entries(pcts).sort((a, b) => b[1] - a[1])[0][0]
    pcts[top] += 100 - sum
  }

  return { water: pcts.water, bare: pcts.bare, sparse: pcts.sparse, moderate: pcts.moderate, dense: pcts.dense }
}

/** Fetch a per-pixel NDVI histogram from a Sentinel-2 STAC item via titiler
 *  `/stac/statistics` with expression.  Returns `NdviBuckets` (5 class percentages)
 *  or null if the endpoint is unreachable or returns no histogram. Cached 10 min. */
export async function fetchNdviHistogram(item: any, bbox: number[]): Promise<NdviBuckets | null> {
  const itemHref = getStacItemHref(item)
  if (!itemHref) return null
  const nirKey = pickAssetKey(item, S2_ASSET_KEYS.B08)
  const redKey = pickAssetKey(item, S2_ASSET_KEYS.B04)
  if (!nirKey || !redKey) return null

  const expression = `(${nirKey}-${redKey})/(${nirKey}+${redKey})`
  const params = new URLSearchParams({
    url: itemHref,
    expression,
    bbox: bbox.join(','),
    max_size: '512',
    histogram_bins: '50',
    histogram_range: '-1,1',
  })
  params.append('assets', nirKey)
  params.append('assets', redKey)

  const cacheKey = `ndvihist:${params.toString()}`
  try {
    const data = await cachedFetchJson(cacheKey, 10 * 60 * 1000, async () => {
      const res = await fetch(`${TITILER_BASE}/stac/statistics?${params}`, {
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) throw new Error(`titiler stac/statistics HTTP ${res.status}`)
      return res.json()
    })

    // The response key is the expression string; fall back to first key if unknown
    const exprData = (data?.[expression] ?? Object.values(data ?? {})[0]) as any
    if (!exprData?.histogram) return null

    const [counts, edges] = exprData.histogram as [number[], number[]]
    if (!Array.isArray(counts) || !Array.isArray(edges) || counts.length < 2) return null

    return ndviBucketsFromHistogram(counts, edges)
  } catch {
    return null
  }
}

/** Colored fallback feature — used when a tile URL fails to verify. Prefers the
 *  drawn AOI polygon when provided; falls back to a bbox rectangle otherwise. */
export function buildBboxFallbackLayer(
  bbox: number[],
  indexValue: number | null,
  indexLabel: string,
  forceColor?: string,
  aoiPolygon?: any,
): {
  id: string
  name: string
  type: 'geojson'
  geojson: GeoJSON.FeatureCollection
} {
  const v = indexValue ?? 0
  let color = forceColor
  if (!color) {
    color = v > 0.5 ? '#166534'
      : v > 0.3 ? '#4ade80'
      : v > 0.1 ? '#fbbf24'
      : v > 0   ? '#f97316'
      : '#ef4444'
  }
  const sign = v >= 0 ? '+' : ''
  const usePolygon = aoiPolygon
    && (aoiPolygon.type === 'Polygon' || aoiPolygon.type === 'MultiPolygon')
  const geometry = usePolygon
    ? aoiPolygon
    : {
        type: 'Polygon' as const,
        coordinates: [[
          [bbox[0], bbox[1]], [bbox[2], bbox[1]],
          [bbox[2], bbox[3]], [bbox[0], bbox[3]],
          [bbox[0], bbox[1]],
        ]],
      }
  return {
    id: `${indexLabel.toLowerCase()}-fallback-${genId()}`,
    name: `${indexLabel} ${usePolygon ? 'AOI' : 'bbox'} (${sign}${v.toFixed(2)})`,
    type: 'geojson',
    geojson: {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature' as const,
        properties: { [`${indexLabel.toLowerCase()}_mean`]: v, label: `${indexLabel}: ${v.toFixed(3)}`, color, fill: color, illustrative: true },
        geometry,
      }],
    },
  }
}
