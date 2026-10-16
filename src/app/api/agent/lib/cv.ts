/** Computer-vision helpers: AOI → slippy-tile grid, tile-image fetch,
 *  pixel→geo for any tile, Roboflow inference, and detection dedupe.
 *
 *  Pure logic where possible; only `fetchTileImage` and `runRoboflowInference`
 *  perform I/O. The tile-grid / pixel-geo / dedupe paths are unit-tested.
 */

import { cachedFetchJson } from './cache'
import { haversineKm, lonLatToTile, pointInAoi } from './geometry'

// ---------------------------------------------------------------------------
// Tile math
// ---------------------------------------------------------------------------

export interface TileSpec {
  x: number
  y: number
  z: number
  bounds: TileBounds
}

export interface TileBounds {
  west: number
  south: number
  east: number
  north: number
}

/** Slippy-map tile (x, y, z) → its geographic bounds. */
export function tileToBounds(x: number, y: number, z: number): TileBounds {
  const n = Math.pow(2, z)
  const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
  const south = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI
  const west = (x / n) * 360 - 180
  const east = ((x + 1) / n) * 360 - 180
  return { west, south, east, north }
}

/** Pixel position inside a (x,y,z) tile → geographic polygon (rectangle around the pixel box).
 *  `tilePx` is the tile's pixel size (256 for Esri/OSM-style tiles). */
export function pixelToGeoPolygon(
  px: number,
  py: number,
  w: number,
  h: number,
  tileX: number,
  tileY: number,
  z: number,
  tilePx: number = 256,
): number[][][] {
  const { west, east, north, south } = tileToBounds(tileX, tileY, z)
  const lonScale = (east - west) / tilePx
  const latScale = (north - south) / tilePx
  const x1 = west + (px - w / 2) * lonScale
  const x2 = west + (px + w / 2) * lonScale
  const y1 = north - (py + h / 2) * latScale
  const y2 = north - (py - h / 2) * latScale
  return [[[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]]
}

/** Pixel position → single geographic point (lon, lat) for the pixel center. */
export function pixelToLonLat(
  px: number,
  py: number,
  tileX: number,
  tileY: number,
  z: number,
  tilePx: number = 256,
): [number, number] {
  const { west, east, north, south } = tileToBounds(tileX, tileY, z)
  const lon = west + (px / tilePx) * (east - west)
  const lat = north - (py / tilePx) * (north - south)
  return [lon, lat]
}

// ---------------------------------------------------------------------------
// AOI → tile grid (polygon-aware)
// ---------------------------------------------------------------------------

export interface AoiTileGridResult {
  /** Tiles to actually fetch + analyze. */
  tiles: TileSpec[]
  /** Total tiles whose extent intersects the polygon (before capping). */
  totalCandidates: number
  /** True if a spatially-distributed sample was taken because `totalCandidates > maxTiles`. */
  sampled: boolean
  z: number
}

interface AoiTileGridOpts {
  /** Hard cap on tiles actually returned. */
  maxTiles?: number
  /** Slippy-map zoom. Defaults to 18 (≈0.6 m/px) for fine objects; 17 for structures. */
  zoom?: number
}

const TILE_PX = 256

/** Build a slippy-tile grid that covers an AOI polygon at a given zoom.
 *
 *  Steps:
 *    1. Convert the AOI bbox to a tile range at `z`.
 *    2. Walk the rectangular range; keep tiles whose extent intersects the polygon
 *       (5-point test + reverse polygon-vertex test — robust for AOIs at any scale
 *       larger than a tile, and correct for small AOIs that fit within one tile).
 *    3. If the kept list exceeds `maxTiles`, return a spatially-distributed sample
 *       (every Nth tile) and flag `sampled: true`. **Never silently drop** — callers
 *       must report the coverage truthfully.
 */
export function buildAoiTileGrid(
  aoi: any,
  bbox: [number, number, number, number],
  opts: AoiTileGridOpts = {},
): AoiTileGridResult {
  const z = opts.zoom ?? 18
  const maxTiles = opts.maxTiles ?? 25
  const [minLng, minLat, maxLng, maxLat] = bbox

  // Clamp the corner-tile range so we never iterate the whole world if bbox is degenerate.
  const tl = lonLatToTile(minLng, maxLat, z)
  const br = lonLatToTile(maxLng, minLat, z)
  const xMin = Math.min(tl.x, br.x)
  const xMax = Math.max(tl.x, br.x)
  const yMin = Math.min(tl.y, br.y)
  const yMax = Math.max(tl.y, br.y)

  // Bound the candidate-tile sweep so a misclick can't blow up.
  // (yMax-yMin+1) * (xMax-xMin+1) is the rectangular count.
  const SWEEP_CAP = 4096

  const polygonCoords: number[][] = collectPolygonCoords(aoi)
  const candidates: TileSpec[] = []

  outer: for (let ty = yMin; ty <= yMax; ty++) {
    for (let tx = xMin; tx <= xMax; tx++) {
      if (candidates.length > SWEEP_CAP) break outer
      const tb = tileToBounds(tx, ty, z)
      if (tileIntersectsAoi(tb, aoi, polygonCoords)) {
        candidates.push({ x: tx, y: ty, z, bounds: tb })
      }
    }
  }

  if (candidates.length === 0) {
    // Degenerate AOI (e.g. point) — fall back to a single tile covering the centroid.
    const cx = (minLng + maxLng) / 2
    const cy = (minLat + maxLat) / 2
    const { x, y } = lonLatToTile(cx, cy, z)
    return {
      tiles: [{ x, y, z, bounds: tileToBounds(x, y, z) }],
      totalCandidates: 1,
      sampled: false,
      z,
    }
  }

  if (candidates.length <= maxTiles) {
    return { tiles: candidates, totalCandidates: candidates.length, sampled: false, z }
  }

  // Spatially-distributed sample: take every Nth candidate so coverage is even.
  const step = candidates.length / maxTiles
  const sample: TileSpec[] = []
  for (let i = 0; i < maxTiles; i++) {
    const idx = Math.floor(i * step)
    sample.push(candidates[idx])
  }
  return { tiles: sample, totalCandidates: candidates.length, sampled: true, z }
}

/** Collect the (lon, lat) vertices of an AOI polygon / multipolygon, flat. */
function collectPolygonCoords(aoi: any): number[][] {
  if (!aoi) return []
  if (aoi.type === 'Polygon') {
    return (aoi.coordinates?.[0] ?? []) as number[][]
  }
  if (aoi.type === 'MultiPolygon') {
    const out: number[][] = []
    for (const poly of (aoi.coordinates ?? []) as number[][][][]) {
      for (const c of poly[0] ?? []) out.push(c)
    }
    return out
  }
  return []
}

/** Tile-vs-polygon intersection test. Robust for both
 *    - AOIs much larger than a tile (any tile corner or center inside polygon),
 *    - AOIs smaller than or comparable to a tile (any polygon vertex inside the tile).
 *  Both directions are needed because a slim/narrow polygon can cross a tile without
 *  containing any tile vertex, and a tile can lie inside an AOI without any AOI vertex
 *  being inside it.
 */
function tileIntersectsAoi(tb: TileBounds, aoi: any, polygonCoords: number[][]): boolean {
  // Quick reject on bbox.
  // (Polygon coords spanning a tile guarantees their bboxes overlap, so the bbox test is safe.)
  // We synthesize the polygon bbox from polygonCoords to avoid recomputing per tile.
  // Caller already restricts the sweep to the polygon bbox, so this is mostly defensive.
  const cx = (tb.west + tb.east) / 2
  const cy = (tb.south + tb.north) / 2
  if (pointInAoi(cx, cy, aoi)) return true
  if (pointInAoi(tb.west, tb.north, aoi)) return true
  if (pointInAoi(tb.east, tb.north, aoi)) return true
  if (pointInAoi(tb.west, tb.south, aoi)) return true
  if (pointInAoi(tb.east, tb.south, aoi)) return true
  for (const [lng, lat] of polygonCoords) {
    if (lng >= tb.west && lng <= tb.east && lat >= tb.south && lat <= tb.north) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Tile-image fetch (cached)
// ---------------------------------------------------------------------------

const ESRI_TILE_BASE =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile'

/** XYZ Esri World Imagery tile URL. (Esri uses {z}/{y}/{x} — note the order.) */
export function esriTileUrl(x: number, y: number, z: number): string {
  return `${ESRI_TILE_BASE}/${z}/${y}/${x}`
}

/** Fetch a satellite tile as bytes. Tiles are immutable, so cache aggressively. */
export async function fetchTileImage(url: string, timeoutMs = 15000): Promise<ArrayBuffer> {
  return cachedFetchJson<ArrayBuffer>(
    `cv-tile:${url}`,
    24 * 60 * 60 * 1000, // 24h — XYZ tiles are immutable at a given z/x/y
    async () => {
      const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
      if (!resp.ok) throw new Error(`tile fetch HTTP ${resp.status}`)
      return await resp.arrayBuffer()
    },
  )
}

// ---------------------------------------------------------------------------
// Curated Roboflow model map
// ---------------------------------------------------------------------------

/** Per-model metadata. */
export interface CvModelInfo {
  /** Default Roboflow `project/version` slug. **Candidate** — operators should
   *  verify each slug resolves and performs on their AOIs, and override via env
   *  (`ROBOFLOW_MODEL_<KEY>`) if needed. */
  defaultSlug: string
  /** Env-var name that overrides the default slug at runtime. */
  envVar: string
  /** Geometry to emit per detection. */
  geom: 'point' | 'polygon'
  /** Honest note rendered alongside the result — captures domain caveats. */
  note?: string
  /** Default min confidence for predictions (0–1). */
  defaultConfidence: number
  /** Centroid-distance dedupe threshold in meters across tile seams. */
  dedupeMeters: number
  /** Recommended slippy-map zoom for inference. */
  zoom: number
}

export const CV_MODEL_MAP: Record<string, CvModelInfo> = {
  // Pre-existing slugs preserved so behavior with an existing key doesn't regress.
  // The session plan explicitly calls these out for operator verification; any 404
  // from the inference call is surfaced verbatim with an actionable "set $envVar" hint.
  solar_panel: {
    defaultSlug: 'solar-panel-detection-2024/2',
    envVar: 'ROBOFLOW_MODEL_SOLAR_PANEL',
    geom: 'point',
    defaultConfidence: 0.35,
    dedupeMeters: 4,
    zoom: 18,
  },
  informal_struct: {
    defaultSlug: 'building-detection-vrqdq/2',
    envVar: 'ROBOFLOW_MODEL_INFORMAL_STRUCT',
    geom: 'polygon',
    defaultConfidence: 0.30,
    dedupeMeters: 8,
    zoom: 17,
  },
  road_damage: {
    defaultSlug: 'road-damage-detection-2024/1',
    envVar: 'ROBOFLOW_MODEL_ROAD_DAMAGE',
    geom: 'polygon',
    note: 'Many public road-damage datasets are trained on street-level imagery; performance over satellite tiles varies. Verify on a known damaged corridor before relying on counts.',
    defaultConfidence: 0.30,
    dedupeMeters: 6,
    zoom: 18,
  },
  manhole: {
    defaultSlug: 'manhole-detection-bb5wy/1',
    envVar: 'ROBOFLOW_MODEL_MANHOLE',
    geom: 'point',
    defaultConfidence: 0.30,
    dedupeMeters: 3,
    zoom: 18,
  },
  water_channel: {
    defaultSlug: 'water-body-detection-2024/1',
    envVar: 'ROBOFLOW_MODEL_WATER_CHANNEL',
    geom: 'polygon',
    defaultConfidence: 0.30,
    dedupeMeters: 10,
    zoom: 17,
  },
  roof_material: {
    defaultSlug: 'building-detection-vrqdq/2',
    envVar: 'ROBOFLOW_MODEL_ROOF_MATERIAL',
    geom: 'polygon',
    note: 'Roof-material classification reuses the building-detection slug; class labels reflect the detector\'s training, not material types.',
    defaultConfidence: 0.30,
    dedupeMeters: 8,
    zoom: 18,
  },
}

/** Resolve a model name to its effective Roboflow slug (env override or default). */
export function resolveModelSlug(modelName: string): string | null {
  const info = CV_MODEL_MAP[modelName]
  if (!info) return null
  const envSlug = process.env[info.envVar]
  return envSlug && envSlug.trim() ? envSlug.trim() : info.defaultSlug
}

// ---------------------------------------------------------------------------
// Provider selection — ONNX vs Roboflow vs none
// ---------------------------------------------------------------------------

/** The three categories that have bundled open-weight ONNX models (P3.8). */
export const ONNX_SUPPORTED_MODELS: ReadonlySet<string> = new Set([
  'solar_panel',
  'informal_struct',
  'road_damage',
])

/**
 * CV backends `run_cv_detector` can actually reach.
 *
 * `hf` was removed 2026-08-16 (ISS-128). It pointed at
 * `api-inference.huggingface.co`, which **no longer resolves at all** — curl
 * exits 6, "could not resolve host", while `huggingface.co` answers 200 — and
 * even before DNS died, `IDEA-Research/grounding-dino-base` and `-tiny` both
 * report `inferenceProviderMapping: {}` (re-verified live 2026-08-16), so HF
 * serverless served neither. It could not succeed by any path.
 *
 * Zero-shot / text-prompt detection lives in `detect_objects` (the Phase 2
 * CV-first pipeline with the key-free local DOTA detector), not here.
 */
export type CvProvider = 'roboflow' | 'onnx' | 'none'

/** Choose which inference provider to use for `model`.
 *
 *  Priority order for `'auto'`:
 *    1. Roboflow — if `ROBOFLOW_API_KEY` is set.
 *    2. ONNX     — if the model has a bundled ONNX variant (three priority categories).
 *    3. HF       — only when `text_prompt` is present (arbitrary prompts).
 *    4. none     — no configured provider; caller surfaces the actionable message.
 */
export function pickCvProvider(
  model: string,
  args: Record<string, any> = {},
  env: Record<string, string | undefined> = process.env as any,
): CvProvider {
  const explicit = String(args.provider || 'auto').toLowerCase()

  if (explicit === 'roboflow') return env.ROBOFLOW_API_KEY ? 'roboflow' : 'none'
  if (explicit === 'onnx') return ONNX_SUPPORTED_MODELS.has(model) ? 'onnx' : 'none'
  // `hf` is no longer a route — see the note above. Asking for it by name gets
  // the same honest "nothing can run this" answer as asking for a missing key.
  if (explicit === 'hf') return 'none'

  // auto
  if (env.ROBOFLOW_API_KEY) return 'roboflow'
  // A `text_prompt` used to select `hf` HERE, above the ONNX check — so on a
  // key-free install the natural zero-shot request was routed to a dead host
  // while a working local detector sat one line below. That is ISS-104's defect
  // (a backend that runs nothing capturing the route) in its third location.
  if (ONNX_SUPPORTED_MODELS.has(model)) return 'onnx'
  return 'none'
}

// ---------------------------------------------------------------------------
// Roboflow inference (single tile)
// ---------------------------------------------------------------------------

export interface RoboflowPrediction {
  class: string
  confidence: number
  x: number
  y: number
  width: number
  height: number
}

export interface InferenceOutcome {
  predictions: RoboflowPrediction[]
  rateLimited?: boolean
  /** Set when the slug 404s — the caller turns this into a model-not-available message. */
  modelMissing?: boolean
  /** Any other inference error message. */
  error?: string
}

/** Single Roboflow `/<slug>` POST. Returns predictions or a structured error.
 *  Per-tile failures are tolerated by the caller — we return `{ predictions: [] }`
 *  with an `error`/`rateLimited`/`modelMissing` flag instead of throwing. */
export async function runRoboflowInference(
  slug: string,
  tileBytes: ArrayBuffer,
  apiKey: string,
  confidenceThreshold: number,
  timeoutMs = 25000,
): Promise<InferenceOutcome> {
  const confidence = Math.round(confidenceThreshold * 100)
  const url = `https://detect.roboflow.com/${slug}?api_key=${apiKey}&confidence=${confidence}&overlap=30&format=json`
  try {
    const base64 = Buffer.from(tileBytes).toString('base64')
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: base64,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (resp.status === 404) {
      return { predictions: [], modelMissing: true, error: `Roboflow model "${slug}" not found (HTTP 404).` }
    }
    if (resp.status === 429) {
      return { predictions: [], rateLimited: true, error: 'Roboflow rate limit hit (HTTP 429).' }
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      return { predictions: [], error: `Roboflow HTTP ${resp.status}: ${body.slice(0, 160)}` }
    }
    const json = await resp.json().catch(() => null) as any
    const predictions = Array.isArray(json?.predictions) ? json.predictions as RoboflowPrediction[] : []
    return { predictions }
  } catch (err: any) {
    return { predictions: [], error: err?.message || 'inference failed' }
  }
}

// ---------------------------------------------------------------------------
// Concurrency-capped runner (no extra dep)
// ---------------------------------------------------------------------------

/** Run `fn(item)` over `items` with at most `limit` in flight at once. Preserves input order in the output array. */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    while (true) {
      const idx = cursor++
      if (idx >= items.length) return
      results[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------------------
// Detection merging + dedupe
// ---------------------------------------------------------------------------

export interface GeoDetection {
  class: string
  confidence: number
  /** Centroid lat/lng — used for dedupe + point emission. */
  centroid: [number, number]
  /** Bounding-box polygon (closed ring). Emitted as Polygon for area features. */
  polygon: number[][][]
  /** Which tile produced this detection. */
  tile: { x: number; y: number; z: number }
}

/** Convert one Roboflow tile-pixel prediction into a georeferenced detection. */
export function predictionToDetection(
  pred: RoboflowPrediction,
  tile: TileSpec,
  tilePx: number = TILE_PX,
): GeoDetection {
  const polygon = pixelToGeoPolygon(pred.x, pred.y, pred.width, pred.height, tile.x, tile.y, tile.z, tilePx)
  const centroid = pixelToLonLat(pred.x, pred.y, tile.x, tile.y, tile.z, tilePx)
  return {
    class: pred.class,
    confidence: pred.confidence,
    centroid,
    polygon,
    tile: { x: tile.x, y: tile.y, z: tile.z },
  }
}

/** Centroid-distance dedupe across tile seams. Two detections collapse when:
 *    - they share a class (case-insensitive), AND
 *    - their centroid Haversine distance < `thresholdMeters`.
 *  The higher-confidence detection wins. Stable to input order.
 */
export function dedupeDetections<
  T extends { class: string; confidence: number; centroid: [number, number] },
>(
  detections: T[],
  thresholdMeters: number,
): T[] {
  const thresholdKm = thresholdMeters / 1000
  // Sort by confidence DESC so the higher-confidence detection is the survivor.
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence)
  const kept: T[] = []
  for (const d of sorted) {
    const cls = d.class.toLowerCase()
    let dup = false
    for (const k of kept) {
      if (k.class.toLowerCase() !== cls) continue
      const dKm = haversineKm(d.centroid[1], d.centroid[0], k.centroid[1], k.centroid[0])
      if (dKm < thresholdKm) {
        dup = true
        break
      }
    }
    if (!dup) kept.push(d)
  }
  return kept
}

// ---------------------------------------------------------------------------
// Coverage estimation (honest fraction-of-AOI labeling)
// ---------------------------------------------------------------------------

/** Approximate AOI area covered by `tiles` at zoom `z` — meters² per tile is roughly
 *  constant within a tile's small lat band, so this is a useful coverage proxy without
 *  per-tile Turf-area calls. */
export function approxTileCoverageKm2(tiles: TileSpec[]): number {
  let total = 0
  for (const t of tiles) {
    const widthDeg = t.bounds.east - t.bounds.west
    const heightDeg = t.bounds.north - t.bounds.south
    const midLat = (t.bounds.north + t.bounds.south) / 2
    const kmW = widthDeg * 111 * Math.cos((midLat * Math.PI) / 180)
    const kmH = heightDeg * 111
    total += Math.abs(kmW * kmH)
  }
  return total
}
