/** Native-resolution mosaics.
 *
 *  Measured 2026-08-10: the DOTA-trained detector returns correct aircraft and
 *  vehicles when fed a mosaic built at its own input size (16 tiles → 1024 px, no
 *  resampling), and misplaced boxes when fed a 512 px mosaic upscaled to 1024.
 *  Georeferencing therefore has to work in *global* pixel space, not by lerping
 *  across a mosaic — Mercator latitude is non-linear and a naive lerp drifts.
 */

import { describe, expect, it } from 'vitest'
import { tileToBounds } from '../../cv'
import {
  buildAoiMosaicGrid,
  mosaicPixelToLonLat,
  mosaicPixelToGeoPolygon,
  tilesPerSideFor,
} from '../mosaic'

const LAHORE_AOI = {
  type: 'Polygon',
  coordinates: [[[74.30, 31.51], [74.34, 31.51], [74.34, 31.53], [74.30, 31.53], [74.30, 31.51]]],
}
const LAHORE_BBOX: [number, number, number, number] = [74.30, 31.51, 74.34, 31.53]

describe('tilesPerSideFor', () => {
  it('maps a model input size to whole 256 px tiles', () => {
    expect(tilesPerSideFor(1024)).toBe(4)
    expect(tilesPerSideFor(640)).toBe(2)   // 2×256=512 ≤ 640 < 3×256
    expect(tilesPerSideFor(256)).toBe(1)
  })

  it('never returns zero, even for a tiny input size', () => {
    expect(tilesPerSideFor(64)).toBe(1)
  })
})

describe('mosaicPixelToLonLat', () => {
  const spec = { tileX: 370380, tileY: 213732, z: 19, tilesPerSide: 4, sizePx: 1024 }

  it('maps the mosaic origin to the north-west corner of its first tile', () => {
    const b = tileToBounds(spec.tileX, spec.tileY, spec.z)
    const [lon, lat] = mosaicPixelToLonLat(0, 0, spec)
    expect(lon).toBeCloseTo(b.west, 10)
    expect(lat).toBeCloseTo(b.north, 10)
  })

  it('maps the far corner to the south-east corner of the last tile', () => {
    const b = tileToBounds(spec.tileX + 3, spec.tileY + 3, spec.z)
    const [lon, lat] = mosaicPixelToLonLat(spec.sizePx, spec.sizePx, spec)
    expect(lon).toBeCloseTo(b.east, 10)
    expect(lat).toBeCloseTo(b.south, 10)
  })

  it('agrees with per-tile bounds at an interior tile seam — no Mercator drift', () => {
    // Pixel 512 is exactly the boundary between the 2nd and 3rd tile row/col.
    const seam = tileToBounds(spec.tileX + 2, spec.tileY + 2, spec.z)
    const [lon, lat] = mosaicPixelToLonLat(512, 512, spec)
    expect(lon).toBeCloseTo(seam.west, 10)
    expect(lat).toBeCloseTo(seam.north, 10)
  })

  it('is monotonic: x east, y south', () => {
    const [lon0, lat0] = mosaicPixelToLonLat(100, 100, spec)
    const [lon1, lat1] = mosaicPixelToLonLat(200, 200, spec)
    expect(lon1).toBeGreaterThan(lon0)
    expect(lat1).toBeLessThan(lat0)
  })
})

describe('mosaicPixelToGeoPolygon', () => {
  const spec = { tileX: 370380, tileY: 213732, z: 19, tilesPerSide: 4, sizePx: 1024 }

  it('produces a closed ring whose corners bracket the box', () => {
    const ring = mosaicPixelToGeoPolygon(512, 512, 40, 20, spec)[0]
    expect(ring).toHaveLength(5)
    expect(ring[0]).toEqual(ring[4])
    const lons = ring.map((c) => c[0])
    const lats = ring.map((c) => c[1])
    const [cLon, cLat] = mosaicPixelToLonLat(512, 512, spec)
    expect(Math.min(...lons)).toBeLessThan(cLon)
    expect(Math.max(...lons)).toBeGreaterThan(cLon)
    expect(Math.min(...lats)).toBeLessThan(cLat)
    expect(Math.max(...lats)).toBeGreaterThan(cLat)
  })

  it('gives a box whose ground width matches the requested pixel width', () => {
    const widthPx = 40
    const ring = mosaicPixelToGeoPolygon(512, 512, widthPx, 20, spec)[0]
    const lons = ring.map((c) => c[0])
    const spanDeg = Math.max(...lons) - Math.min(...lons)
    const midLat = ring[0][1]
    const spanM = spanDeg * 111320 * Math.cos((midLat * Math.PI) / 180)
    // 40 px at z19 over Lahore ≈ 40 × 0.2545 m
    expect(spanM).toBeGreaterThan(9)
    expect(spanM).toBeLessThan(11)
  })
})

describe('buildAoiMosaicGrid', () => {
  it('covers the AOI with mosaics aligned to whole tiles', () => {
    const grid = buildAoiMosaicGrid(LAHORE_AOI, LAHORE_BBOX, { zoom: 18, sizePx: 1024, maxMosaics: 32 })
    expect(grid.mosaics.length).toBeGreaterThan(0)
    for (const m of grid.mosaics) {
      expect(m.tilesPerSide).toBe(4)
      expect(m.sizePx).toBe(1024)
      expect(m.tileX % 4).toBe(0)   // aligned so neighbouring mosaics never overlap
      expect(m.tileY % 4).toBe(0)
    }
  })

  it('produces non-overlapping mosaics', () => {
    const grid = buildAoiMosaicGrid(LAHORE_AOI, LAHORE_BBOX, { zoom: 18, sizePx: 1024, maxMosaics: 32 })
    const keys = grid.mosaics.map((m) => `${m.tileX}/${m.tileY}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('reports sampling honestly instead of silently truncating', () => {
    const big = buildAoiMosaicGrid(LAHORE_AOI, LAHORE_BBOX, { zoom: 20, sizePx: 1024, maxMosaics: 4 })
    expect(big.sampled).toBe(true)
    expect(big.mosaics.length).toBe(4)
    expect(big.totalCandidates).toBeGreaterThan(4)
  })

  it('does not flag sampling when everything fits', () => {
    const small = buildAoiMosaicGrid(LAHORE_AOI, LAHORE_BBOX, { zoom: 16, sizePx: 1024, maxMosaics: 64 })
    expect(small.sampled).toBe(false)
    expect(small.mosaics.length).toBe(small.totalCandidates)
  })

  it('always returns at least one mosaic for a degenerate AOI', () => {
    const pt: [number, number, number, number] = [74.32, 31.52, 74.32, 31.52]
    const grid = buildAoiMosaicGrid(
      { type: 'Polygon', coordinates: [[[74.32, 31.52], [74.32, 31.52], [74.32, 31.52], [74.32, 31.52]]] },
      pt, { zoom: 19, sizePx: 1024, maxMosaics: 8 },
    )
    expect(grid.mosaics.length).toBe(1)
  })
})
