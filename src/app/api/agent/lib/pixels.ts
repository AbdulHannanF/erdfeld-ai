/** Polygon-clipped per-pixel raster access via titiler `/stac/feature.npy`.
 *
 *  This is the ONLY sanctioned way to get statistics for an AOI. It exists because
 *  the alternatives are wrong:
 *
 *    - titiler GET `/cog/statistics?bbox=…` **silently ignores `bbox`** and returns
 *      whole-COG statistics (verified 2026-08-09: identical mean 3414.405 and
 *      identical count 1 048 576 for the AOI bbox and for a bbox 400 km away).
 *      Any "bbox mean" from that endpoint is a ~110 × 110 km scene average.
 *    - POST `/cog/statistics` with a feature *is* correctly clipped, but returns
 *      only aggregate moments — no per-pixel access, so no cloud masking and no
 *      way to compute the mean of a per-pixel index (see `meanOfIndex` below).
 *
 *  `/stac/feature.npy` returns the real per-pixel values clipped to the drawn
 *  polygon as a raw NumPy array, shape `(bands, H, W)`, where the LAST band is the
 *  validity mask (0 = nodata / outside the polygon). Verified live against
 *  titiler.xyz. Everything downstream is pure math on those values.
 */

import { cachedFetchJson, fetchWithRetry } from './cache'
import { getLogger } from './logger'
import { TITILER_BASE } from './titiler'
import { parseNpy } from './npy'

const log = getLogger('agent/pixels')

/** A polygon-clipped pixel grid. `values` is band 0; `mask` is the validity band
 *  (0 = outside polygon / nodata). Both are length `width * height`, row 0 = north. */
export interface PixelGrid {
  values: Float64Array
  mask: Float64Array
  width: number
  height: number
  /** Number of bands titiler returned, including the trailing mask band. */
  bands: number
  /** All bands, flat, band-major — for callers needing more than band 0. */
  raw: Float64Array
}

export interface FeatureGridRequest {
  /** Canonical STAC item href (titiler `/stac/*` requires the item URL, not an asset href). */
  itemHref: string
  /** Asset KEY names on the item (e.g. `['nir','red']` or `['scl']`) — not hrefs. */
  assets: string[]
  /** Optional band expression using positional `b1`, `b2`, … matching `assets` order. */
  expression?: string
  /** AOI geometry (Polygon or MultiPolygon). */
  geom: any
  /**
   * Longest-edge pixel budget. 96 → ≤9 216 px, fast and ample for AOI statistics.
   * Raise only when a caller genuinely needs finer structure; cost is quadratic.
   */
  maxSize?: number
  /** Cache namespace so different callers don't collide on identical URLs. */
  cacheTag?: string
}

/** Extract a Polygon/MultiPolygon geometry from an AOI, Feature, or raw geometry. */
export function toGeometry(aoi: any): any | null {
  const geom = aoi?.type === 'Feature' ? aoi.geometry : aoi?.geometry ? aoi.geometry : aoi
  if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) return null
  return geom
}

/**
 * Fetch a polygon-clipped pixel grid from titiler.
 *
 * Throws with an honest, user-surfaceable message on failure — callers must
 * degrade explicitly rather than substituting a bbox or scene-wide number.
 */
export async function fetchFeatureGrid(req: FeatureGridRequest): Promise<PixelGrid> {
  const { itemHref, assets, expression, geom, maxSize = 96, cacheTag = 'grid' } = req
  if (!assets.length) throw new Error('fetchFeatureGrid: no assets requested')

  const qs = new URLSearchParams({ url: itemHref, max_size: String(maxSize) })
  if (expression) qs.set('expression', expression)
  for (const a of assets) qs.append('assets', a)
  const url = `${TITILER_BASE}/stac/feature.npy?${qs}`

  const feature = { type: 'Feature', properties: {}, geometry: geom }
  // Geometry participates in the cache key — same URL + different polygon is a
  // different read. Length + first-ring prefix keeps the key bounded.
  const geomKey = `${JSON.stringify(geom).length}:${JSON.stringify((geom.coordinates || []).slice(0, 1)).slice(0, 80)}`

  const b64 = await cachedFetchJson(
    `${cacheTag}-npy:${url}:${geomKey}`,
    { source: 'titiler' },
    async () => {
      const res = await fetchWithRetry(
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(feature) },
        { timeoutMs: 45_000 },
      )
      if (!res.ok) throw new Error(`titiler feature.npy HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer()).toString('base64')
    },
  )

  const parsed = parseNpy(Buffer.from(b64, 'base64'))
  const [bands, height, width] =
    parsed.shape.length === 3 ? parsed.shape : [1, parsed.shape[0], parsed.shape[1]]
  const px = height * width
  if (px === 0) throw new Error('titiler returned an empty pixel grid for this polygon')

  return {
    values: parsed.data.subarray(0, px) as Float64Array,
    // titiler appends the validity mask as the final band.
    mask: (bands >= 2
      ? parsed.data.subarray((bands - 1) * px, bands * px)
      : new Float64Array(px).fill(255)) as Float64Array,
    width,
    height,
    bands,
    raw: parsed.data,
  }
}

export interface CogGridRequest {
  /** A single COG URL, already signed if the source requires it (PC SAS). */
  cogUrl: string
  /** AOI geometry (Polygon or MultiPolygon). */
  geom: any
  /** Longest-edge pixel budget; see `FeatureGridRequest.maxSize`. */
  maxSize?: number
  /** Cache namespace so different callers don't collide on identical URLs. */
  cacheTag?: string
  /** Extra titiler query params (e.g. `{ nodata: '0' }`). */
  params?: Record<string, string>
}

/**
 * Polygon-clipped pixel grid for a **single COG** via titiler `/cog/feature.npy`.
 *
 * The `/stac/*` variant needs a STAC item URL whose assets titiler can fetch
 * anonymously — true for Element84's Sentinel-2, false for Planetary Computer,
 * whose blobs require a SAS token. For those, sign the asset href and read it
 * directly here. Verified live 2026-08-10 against a PC-signed Landsat
 * `lwir11` COG: shape `(2, 96, 96)` uint16, band 0 = data, band 1 = mask.
 *
 * Throws with an honest, user-surfaceable message on failure.
 */
export async function fetchCogFeatureGrid(req: CogGridRequest): Promise<PixelGrid> {
  const { cogUrl, geom, maxSize = 96, cacheTag = 'coggrid', params } = req

  const qs = new URLSearchParams({ url: cogUrl, max_size: String(maxSize), ...(params ?? {}) })
  const url = `${TITILER_BASE}/cog/feature.npy?${qs}`

  const feature = { type: 'Feature', properties: {}, geometry: geom }
  const geomKey = `${JSON.stringify(geom).length}:${JSON.stringify((geom.coordinates || []).slice(0, 1)).slice(0, 80)}`
  // A PC SAS token rotates hourly; keying on it would defeat the cache, so the
  // key uses the path only (the token is an access credential, not an identity).
  const urlKey = cogUrl.split('?')[0]

  const b64 = await cachedFetchJson(
    `${cacheTag}-cognpy:${urlKey}:${JSON.stringify(params ?? {})}:${maxSize}:${geomKey}`,
    { source: 'titiler' },
    async () => {
      const res = await fetchWithRetry(
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(feature) },
        { timeoutMs: 45_000 },
      )
      if (!res.ok) throw new Error(`titiler cog/feature.npy HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer()).toString('base64')
    },
  )

  const parsed = parseNpy(Buffer.from(b64, 'base64'))
  const [bands, height, width] =
    parsed.shape.length === 3 ? parsed.shape : [1, parsed.shape[0], parsed.shape[1]]
  const px = height * width
  if (px === 0) throw new Error('titiler returned an empty pixel grid for this polygon')

  return {
    values: parsed.data.subarray(0, px) as Float64Array,
    mask: (bands >= 2
      ? parsed.data.subarray((bands - 1) * px, bands * px)
      : new Float64Array(px).fill(255)) as Float64Array,
    width,
    height,
    bands,
    raw: parsed.data,
  }
}

/** Summary statistics over the pixels selected by `keep`. */
export interface GridStats {
  mean: number
  median: number
  std: number
  min: number
  max: number
  /** 2nd and 98th percentile (linear interpolation): a data-driven display stretch. */
  p2: number
  p98: number
  /** Pixels that passed `keep` and were finite. */
  count: number
  /** Pixels inside the polygon (mask > 0), regardless of `keep`. */
  insidePolygon: number
}

/** Linear-interpolated quantile (0..1) of an ascending-sorted array. */
function quantileSorted(sorted: number[], q: number): number {
  const pos = q * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/**
 * Compute statistics over grid pixels, optionally filtered by a per-pixel predicate.
 *
 * Returns `null` when no pixel qualifies — callers MUST surface that honestly
 * rather than reporting a number derived from nothing.
 */
export function gridStats(
  grid: PixelGrid,
  keep?: (index: number) => boolean,
): GridStats | null {
  const kept: number[] = []
  let insidePolygon = 0
  const px = grid.width * grid.height

  for (let i = 0; i < px; i++) {
    if (!grid.mask[i]) continue
    insidePolygon++
    if (keep && !keep(i)) continue
    const v = grid.values[i]
    if (!Number.isFinite(v)) continue
    kept.push(v)
  }

  if (kept.length === 0) return null

  kept.sort((a, b) => a - b)
  const count = kept.length
  const sum = kept.reduce((a, b) => a + b, 0)
  const mean = sum / count
  const variance = kept.reduce((a, v) => a + (v - mean) * (v - mean), 0) / count
  const median =
    count % 2 === 1
      ? kept[(count - 1) / 2]
      : (kept[count / 2 - 1] + kept[count / 2]) / 2

  return {
    mean,
    median,
    std: Math.sqrt(variance),
    min: kept[0],
    max: kept[count - 1],
    p2: quantileSorted(kept, 0.02),
    p98: quantileSorted(kept, 0.98),
    count,
    insidePolygon,
  }
}

/**
 * True mean of a per-pixel index.
 *
 * Deliberately distinct from the retired `getNDVIMeanFromScene`, which computed
 * the index **of the band means** — `(mean(NIR) − mean(RED)) / (mean(NIR) + mean(RED))`.
 * By Jensen's inequality that is not the mean of the per-pixel index, and it also
 * makes per-pixel cloud masking impossible. Always prefer this.
 */
export function meanOfIndex(grid: PixelGrid, keep?: (index: number) => boolean): number | null {
  return gridStats(grid, keep)?.mean ?? null
}

export { log as pixelsLog }
