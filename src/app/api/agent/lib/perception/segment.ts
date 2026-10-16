/** Promptable segmentation that returns the actual outline (ISS-110).
 *
 *  `segment_feature` advertised *"delineates the exact boundary"* and returned
 *  the mask's **bounding rectangle** — five coordinates. The mask data was never
 *  the problem: SAM2 returns real polygon rings (measured 2026-08-10, up to 346
 *  vertices per ring), and the old path scanned them down to a bbox.
 *
 *  This module keeps the ring. The pieces are separated so each is testable
 *  without a network: pick the real ring out of SAM2's noise, thin it if it is
 *  absurdly dense, project it, and decide honestly whether the result is actually
 *  an outline or just a box.
 */

import { getLogger } from '../logger'
import { IMAGERY_REGISTRY, isPlaceholderTile, metersPerPixel, type ImagerySource } from './imagery-plan'
import { mosaicPixelToLonLat, type MosaicSpec } from './mosaic'

const log = getLogger('agent/perception-segment')

/** Shoelace area of a pixel ring. */
function ringArea(ring: number[][]): number {
  if (!Array.isArray(ring) || ring.length < 3) return 0
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % ring.length]
    a += x1 * y2 - x2 * y1
  }
  return Math.abs(a / 2)
}

/**
 * Is this ring just a rectangle?
 *
 * The ISS-110 regression guard. A ring of 4 (or 5, closed) distinct corners that
 * takes only two x values and two y values is a bounding box, not an outline.
 * Anything else — including a rotated quadrilateral — is a real shape.
 */
export function ringIsRectangular(ring: number[][]): boolean {
  if (!Array.isArray(ring) || ring.length < 4) return false
  const pts = ring.length >= 5 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring.slice(0, -1)
    : ring
  if (pts.length !== 4) return false
  const xs = new Set(pts.map((p) => p[0]))
  const ys = new Set(pts.map((p) => p[1]))
  return xs.size === 2 && ys.size === 2
}

/**
 * Pick the ring that is actually an object.
 *
 * SAM2 mixes real contours with 1- and 2-point noise — one measured prediction
 * carried 169 of them. Largest real area wins; when nothing qualifies the answer
 * is null, because an invented outline on a real coordinate is worse than no
 * answer.
 */
export function bestRing(rings: number[][][]): number[][] | null {
  let best: number[][] | null = null
  let bestArea = 0
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 4) continue
    const a = ringArea(ring)
    if (a > bestArea) { bestArea = a; best = ring }
  }
  return bestArea > 0 ? best : null
}

/** Evenly thin a dense ring, keeping its first vertex and its shape. */
export function decimateRing(ring: number[][], maxVertices: number): number[][] {
  if (ring.length <= maxVertices) return ring
  const step = ring.length / maxVertices
  const out: number[][] = []
  for (let i = 0; i < maxVertices; i++) out.push(ring[Math.floor(i * step)])
  return out
}

/** Project a pixel ring into a closed GeoJSON ring. */
export function ringToGeoRing(ring: number[][], spec: MosaicSpec): number[][] {
  const geo = ring.map(([x, y]) => {
    const [lon, lat] = mosaicPixelToLonLat(x, y, spec)
    return [lon, lat]
  })
  const first = geo[0]
  const last = geo[geo.length - 1]
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) geo.push([first[0], first[1]])
  return geo
}

// ---------------------------------------------------------------------------
// Imagery ceiling probe
// ---------------------------------------------------------------------------

export type ProbeResult = Buffer | Uint8Array | { placeholder: true }

export interface CeilingOptions {
  lat: number
  lon: number
  fetchTile: (url: string, zoom: number) => Promise<ProbeResult>
  source?: ImagerySource
  /** Highest zoom worth trying. */
  maxZoom?: number
  /** Lowest zoom worth accepting. */
  minZoom?: number
}

export type CeilingResult =
  | { ok: true; zoom: number; mpp: number; source: ImagerySource }
  | { ok: false; reason: string }

/**
 * Find the finest zoom that actually carries imagery here.
 *
 * Segmentation has no target size to plan against — the user clicked a thing and
 * wants its outline — so instead of asking "what resolves a 4.5 m object?" this
 * asks "what is the best available?" and walks down from the top. A fetch that
 * throws is a provider failure, never "this place has no imagery".
 */
export async function probeImageryCeiling(opts: CeilingOptions): Promise<CeilingResult> {
  const source = opts.source ?? IMAGERY_REGISTRY[0]
  const maxZoom = Math.min(opts.maxZoom ?? 21, source.maxZoom)
  const minZoom = Math.max(opts.minZoom ?? 16, source.minZoom)

  for (let z = maxZoom; z >= minZoom; z--) {
    let result: ProbeResult
    try {
      result = await opts.fetchTile(tileUrl(source, z, opts.lat, opts.lon), z)
    } catch (err: any) {
      return {
        ok: false,
        reason:
          `Could not reach ${source.name} to check imagery here: ${err?.message ?? 'unreachable'}. ` +
          `This is a provider failure, not a statement about what imagery exists.`,
      }
    }
    const isBytes = Buffer.isBuffer(result) || result instanceof Uint8Array
    if (isBytes && !isPlaceholderTile(result as any)) {
      return { ok: true, zoom: z, mpp: metersPerPixel(opts.lat, z), source }
    }
  }

  return {
    ok: false,
    reason:
      `${source.name} returns its blank placeholder tile at every zoom from ${maxZoom} down to ` +
      `${minZoom} at this location — there is no imagery here to segment.`,
  }
}

function tileUrl(source: ImagerySource, z: number, lat: number, lon: number): string {
  const n = 2 ** z
  const x = Math.floor(((lon + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  return source.urlTemplate.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
}

// ---------------------------------------------------------------------------
// Point → outline
// ---------------------------------------------------------------------------

/** Ground extent a segmentation frame should cover, in metres. */
export const SEGMENT_FRAME_M = 150

/** Never go coarser than this, whatever the frame arithmetic says. */
const MIN_SEGMENT_ZOOM = 16

/**
 * Pick the zoom to segment at.
 *
 * The finest available imagery is *not* automatically the right choice: the block
 * has a fixed pixel size, so a finer zoom frames less ground. Measured
 * 2026-08-10 — at Schiphol's z21 ceiling a 1024 px block spans only ~47 m, and a
 * 40 m aircraft prompted there produced an outline that filled 96 % of its own
 * bounding box, i.e. the frame was cropping the object rather than containing it.
 *
 * So: start at the ceiling and back off until the frame covers `desiredExtentM`.
 */
export function chooseSegmentationZoom(
  ceilingZoom: number,
  lat: number,
  tilesPerSide: number,
  desiredExtentM: number = SEGMENT_FRAME_M,
): number {
  const sizePx = tilesPerSide * 256
  for (let z = ceilingZoom; z > MIN_SEGMENT_ZOOM; z--) {
    if (sizePx * metersPerPixel(lat, z) >= desiredExtentM) return z
  }
  return Math.min(ceilingZoom, MIN_SEGMENT_ZOOM)
}

/** Mosaic block containing a coordinate, at the given zoom and block size. */
export function mosaicForPoint(lat: number, lon: number, zoom: number, tilesPerSide: number): MosaicSpec {
  const n = 2 ** zoom
  const tx = Math.floor(((lon + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const ty = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  // Centre the block on the clicked tile so the feature is not cut by an edge.
  const half = Math.floor(tilesPerSide / 2)
  return {
    tileX: tx - half,
    tileY: ty - half,
    z: zoom,
    tilesPerSide,
    sizePx: tilesPerSide * 256,
  }
}

/** Where a coordinate falls inside a mosaic, in mosaic pixels. */
export function lonLatToMosaicPixel(lat: number, lon: number, spec: MosaicSpec): [number, number] {
  const worldPx = 256 * 2 ** spec.z
  const gx = ((lon + 180) / 360) * worldPx
  const s = Math.sin((lat * Math.PI) / 180)
  const gy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldPx
  return [gx - spec.tileX * 256, gy - spec.tileY * 256]
}

/** Maximum vertices kept in an emitted outline. */
export const MAX_OUTLINE_VERTICES = 400

export interface OutlineResult {
  /** Closed geographic ring. */
  geoRing: number[][]
  /** Vertices before decimation. */
  rawVertices: number
  confidence: number
  spec: MosaicSpec
  rectangular: boolean
}

/** Turn SAM2's rings for one prompt into a projected, thinned outline. */
export function ringsToOutline(
  rings: number[][][],
  confidence: number,
  spec: MosaicSpec,
): OutlineResult | null {
  const ring = bestRing(rings)
  if (!ring) return null
  const thinned = decimateRing(ring, MAX_OUTLINE_VERTICES)
  const geoRing = ringToGeoRing(thinned, spec)
  log.info({ rawVertices: ring.length, kept: thinned.length }, 'segmented outline')
  return {
    geoRing,
    rawVertices: ring.length,
    confidence,
    spec,
    rectangular: ringIsRectangular(geoRing),
  }
}
