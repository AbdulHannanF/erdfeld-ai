/** Native-resolution mosaics for detector input.
 *
 *  Detectors take a fixed square input (640, 1024, …). Feeding them a single
 *  256 px slippy tile means the runtime upscales it 4×, and feeding them an
 *  upscaled small mosaic is worse: measured 2026-08-10, the DOTA-trained
 *  detector produced misplaced boxes from a 512 px mosaic stretched to 1024, and
 *  correct aircraft (7/7 verified by cropping what it pointed at) from a 1024 px
 *  mosaic built from 16 native tiles.
 *
 *  So: build the mosaic at the model's own input size out of whole tiles, and
 *  never resample. This module owns that arithmetic plus the georeferencing that
 *  turns a mosaic pixel back into a coordinate.
 *
 *  Georeferencing runs through **global Web-Mercator pixel space** rather than
 *  interpolating across the mosaic's own bounds. Latitude is non-linear in
 *  Mercator, so a lerp from the mosaic's north edge to its south edge drifts —
 *  by tens of centimetres over a 1024 px mosaic at z19, which is a car's width.
 */

import { lonLatToTile, pointInAoi } from '../geometry'
import { tileToBounds, type TileBounds } from '../cv'

const TILE_PX = 256

/** One mosaic: a square block of `tilesPerSide²` tiles at a single zoom. */
export interface MosaicSpec {
  /** North-west tile of the block. */
  tileX: number
  tileY: number
  z: number
  tilesPerSide: number
  /** `tilesPerSide * 256`. */
  sizePx: number
}

/** How many 256 px tiles per side fit inside a model's input size. */
export function tilesPerSideFor(inputSizePx: number): number {
  return Math.max(1, Math.floor(inputSizePx / TILE_PX))
}

/** Mosaic pixel → (lon, lat), exactly, via global Mercator pixel coordinates. */
export function mosaicPixelToLonLat(px: number, py: number, spec: MosaicSpec): [number, number] {
  const worldPx = TILE_PX * 2 ** spec.z
  const gx = spec.tileX * TILE_PX + px
  const gy = spec.tileY * TILE_PX + py
  const lon = (gx / worldPx) * 360 - 180
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / worldPx))) * 180) / Math.PI
  return [lon, lat]
}

/** Mosaic-pixel box (centre + size) → closed GeoJSON ring. */
export function mosaicPixelToGeoPolygon(
  cx: number,
  cy: number,
  w: number,
  h: number,
  spec: MosaicSpec,
): number[][][] {
  const [west, north] = mosaicPixelToLonLat(cx - w / 2, cy - h / 2, spec)
  const [east, south] = mosaicPixelToLonLat(cx + w / 2, cy + h / 2, spec)
  return [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
}

/** Geographic bounds of a whole mosaic. */
export function mosaicBounds(spec: MosaicSpec): TileBounds {
  const nw = tileToBounds(spec.tileX, spec.tileY, spec.z)
  const se = tileToBounds(spec.tileX + spec.tilesPerSide - 1, spec.tileY + spec.tilesPerSide - 1, spec.z)
  return { west: nw.west, north: nw.north, east: se.east, south: se.south }
}

export interface MosaicGridResult {
  mosaics: MosaicSpec[]
  /** Blocks intersecting the AOI before any cap was applied. */
  totalCandidates: number
  /** True when a spatially-distributed subset was taken. */
  sampled: boolean
  z: number
}

export interface MosaicGridOptions {
  zoom: number
  /** Model input size; the block is sized to hold whole tiles up to this. */
  sizePx: number
  maxMosaics?: number
}

/**
 * Cover an AOI with tile-aligned mosaic blocks.
 *
 * Blocks are snapped to a multiple of `tilesPerSide` so neighbours tile the plane
 * exactly: no overlap (which would double-count detections the seam dedupe then
 * has to undo) and no gap (which would silently miss objects).
 */
export function buildAoiMosaicGrid(
  aoi: any,
  bbox: [number, number, number, number],
  opts: MosaicGridOptions,
): MosaicGridResult {
  const z = opts.zoom
  const n = tilesPerSideFor(opts.sizePx)
  const maxMosaics = opts.maxMosaics ?? 12
  const [minLng, minLat, maxLng, maxLat] = bbox

  const tl = lonLatToTile(minLng, maxLat, z)
  const br = lonLatToTile(maxLng, minLat, z)

  // Snap to the block lattice so blocks never overlap.
  const bx0 = Math.floor(Math.min(tl.x, br.x) / n)
  const bx1 = Math.floor(Math.max(tl.x, br.x) / n)
  const by0 = Math.floor(Math.min(tl.y, br.y) / n)
  const by1 = Math.floor(Math.max(tl.y, br.y) / n)

  const SWEEP_CAP = 4096
  const candidates: MosaicSpec[] = []
  outer: for (let by = by0; by <= by1; by++) {
    for (let bx = bx0; bx <= bx1; bx++) {
      if (candidates.length >= SWEEP_CAP) break outer
      const spec: MosaicSpec = { tileX: bx * n, tileY: by * n, z, tilesPerSide: n, sizePx: n * TILE_PX }
      if (blockIntersectsAoi(spec, aoi)) candidates.push(spec)
    }
  }

  if (candidates.length === 0) {
    // Degenerate AOI (a point, or a polygon smaller than floating-point noise):
    // fall back to the single block holding the centroid rather than returning
    // nothing, which a caller would read as "no imagery".
    const { x, y } = lonLatToTile((minLng + maxLng) / 2, (minLat + maxLat) / 2, z)
    const spec: MosaicSpec = {
      tileX: Math.floor(x / n) * n,
      tileY: Math.floor(y / n) * n,
      z,
      tilesPerSide: n,
      sizePx: n * TILE_PX,
    }
    return { mosaics: [spec], totalCandidates: 1, sampled: false, z }
  }

  if (candidates.length <= maxMosaics) {
    return { mosaics: candidates, totalCandidates: candidates.length, sampled: false, z }
  }

  // Spatially-distributed subset — evenly spread, and flagged, never silent.
  const step = candidates.length / maxMosaics
  const sample: MosaicSpec[] = []
  for (let i = 0; i < maxMosaics; i++) sample.push(candidates[Math.floor(i * step)])
  return { mosaics: sample, totalCandidates: candidates.length, sampled: true, z }
}

function blockIntersectsAoi(spec: MosaicSpec, aoi: any): boolean {
  const b = mosaicBounds(spec)
  if (pointInAoi((b.west + b.east) / 2, (b.south + b.north) / 2, aoi)) return true
  if (pointInAoi(b.west, b.north, aoi)) return true
  if (pointInAoi(b.east, b.north, aoi)) return true
  if (pointInAoi(b.west, b.south, aoi)) return true
  if (pointInAoi(b.east, b.south, aoi)) return true
  for (const [lng, lat] of collectPolygonCoords(aoi)) {
    if (lng >= b.west && lng <= b.east && lat >= b.south && lat <= b.north) return true
  }
  return false
}

function collectPolygonCoords(aoi: any): number[][] {
  if (!aoi) return []
  if (aoi.type === 'Polygon') return (aoi.coordinates?.[0] ?? []) as number[][]
  if (aoi.type === 'MultiPolygon') {
    const out: number[][] = []
    for (const poly of (aoi.coordinates ?? []) as number[][][][]) for (const c of poly[0] ?? []) out.push(c)
    return out
  }
  return []
}

// ---------------------------------------------------------------------------
// Fetch + compose
// ---------------------------------------------------------------------------

/** Fetch every tile of a mosaic and compose it, at native resolution. */
export async function composeMosaic(
  spec: MosaicSpec,
  urlFor: (x: number, y: number, z: number) => string,
  fetchTile: (url: string) => Promise<ArrayBuffer>,
  isPlaceholder: (bytes: Buffer) => boolean,
): Promise<{ image: Buffer; placeholderTiles: number; fetched: number } | { error: string }> {
  const sharp = (await import('sharp')).default
  const parts: Array<{ input: Buffer; left: number; top: number }> = []
  let placeholderTiles = 0
  let failures = 0
  let firstError = ''

  for (let dy = 0; dy < spec.tilesPerSide; dy++) {
    for (let dx = 0; dx < spec.tilesPerSide; dx++) {
      const url = urlFor(spec.tileX + dx, spec.tileY + dy, spec.z)
      try {
        const buf = Buffer.from(await fetchTile(url))
        if (isPlaceholder(buf)) { placeholderTiles++; continue }
        parts.push({ input: buf, left: dx * TILE_PX, top: dy * TILE_PX })
      } catch (err: any) {
        failures++
        if (!firstError) firstError = err?.message ?? 'tile fetch failed'
      }
    }
  }

  const total = spec.tilesPerSide * spec.tilesPerSide
  if (parts.length === 0) {
    return {
      error: failures
        ? `all ${total} tiles failed to fetch (first error: ${firstError})`
        : `all ${total} tiles were the provider's blank placeholder — no imagery here at z${spec.z}`,
    }
  }

  const image = await sharp({
    create: { width: spec.sizePx, height: spec.sizePx, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite(parts)
    .jpeg({ quality: 95 })
    .toBuffer()

  return { image, placeholderTiles, fetched: parts.length }
}
