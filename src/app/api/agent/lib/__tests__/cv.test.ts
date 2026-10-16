import { describe, expect, it } from 'vitest'
import {
  approxTileCoverageKm2,
  buildAoiTileGrid,
  CV_MODEL_MAP,
  dedupeDetections,
  esriTileUrl,
  pixelToGeoPolygon,
  pixelToLonLat,
  predictionToDetection,
  resolveModelSlug,
  runWithConcurrency,
  tileToBounds,
  type GeoDetection,
} from '../cv'

// ---------------------------------------------------------------------------
// tileToBounds + pixelToGeoPolygon
// ---------------------------------------------------------------------------

describe('tileToBounds', () => {
  it('returns the full world bbox at z0', () => {
    const b = tileToBounds(0, 0, 0)
    expect(b.west).toBeCloseTo(-180, 6)
    expect(b.east).toBeCloseTo(180, 6)
    expect(b.north).toBeGreaterThan(85) // ~85.05 Web Mercator limit
    expect(b.south).toBeLessThan(-85)
  })

  it('halves the longitude range each zoom level', () => {
    const z3 = tileToBounds(0, 0, 3)
    const widthDeg = z3.east - z3.west
    expect(widthDeg).toBeCloseTo(360 / 8, 6) // 8 tiles wide at z=3
  })

  it('is contiguous across neighboring tiles', () => {
    const left = tileToBounds(123, 200, 12)
    const right = tileToBounds(124, 200, 12)
    expect(right.west).toBeCloseTo(left.east, 9)
  })
})

describe('pixelToGeoPolygon', () => {
  it('returns a closed ring with 5 vertices', () => {
    const ring = pixelToGeoPolygon(128, 128, 10, 10, 0, 0, 1)
    expect(ring[0]).toHaveLength(5)
    expect(ring[0][0]).toEqual(ring[0][4]) // closed
  })

  it('is centered inside the tile bounds', () => {
    const z = 17
    const tx = 38600
    const ty = 49800
    const b = tileToBounds(tx, ty, z)
    const ring = pixelToGeoPolygon(128, 128, 20, 20, tx, ty, z)
    const lngs = ring[0].map((p) => p[0])
    const lats = ring[0].map((p) => p[1])
    const cx = (Math.min(...lngs) + Math.max(...lngs)) / 2
    const cy = (Math.min(...lats) + Math.max(...lats)) / 2
    expect(cx).toBeGreaterThan(b.west)
    expect(cx).toBeLessThan(b.east)
    expect(cy).toBeGreaterThan(b.south)
    expect(cy).toBeLessThan(b.north)
  })

  it('shrinks with the bounding box at higher zoom', () => {
    const z3 = pixelToGeoPolygon(128, 128, 20, 20, 0, 0, 3)
    const z10 = pixelToGeoPolygon(128, 128, 20, 20, 0, 0, 10)
    const widthZ3 = z3[0][1][0] - z3[0][0][0]
    const widthZ10 = z10[0][1][0] - z10[0][0][0]
    expect(widthZ10).toBeLessThan(widthZ3)
  })
})

describe('pixelToLonLat', () => {
  it('returns the tile-NW corner for pixel (0,0)', () => {
    const [lon, lat] = pixelToLonLat(0, 0, 5, 5, 10)
    const b = tileToBounds(5, 5, 10)
    expect(lon).toBeCloseTo(b.west, 6)
    expect(lat).toBeCloseTo(b.north, 6)
  })

  it('returns the tile-SE corner for pixel (256,256)', () => {
    const [lon, lat] = pixelToLonLat(256, 256, 5, 5, 10)
    const b = tileToBounds(5, 5, 10)
    expect(lon).toBeCloseTo(b.east, 6)
    expect(lat).toBeCloseTo(b.south, 6)
  })
})

// ---------------------------------------------------------------------------
// buildAoiTileGrid
// ---------------------------------------------------------------------------

describe('buildAoiTileGrid', () => {
  const square = (w: number, s: number, e: number, n: number) => ({
    type: 'Polygon',
    coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
  })

  it('returns at least one tile for a tiny AOI at high zoom', () => {
    const aoi = square(-122.4195, 37.7745, -122.419, 37.775)
    const r = buildAoiTileGrid(aoi, [-122.4195, 37.7745, -122.419, 37.775], { zoom: 18, maxTiles: 25 })
    expect(r.tiles.length).toBeGreaterThan(0)
    expect(r.sampled).toBe(false)
  })

  it('returns more tiles for a larger AOI at the same zoom', () => {
    const small = square(-122.42, 37.77, -122.418, 37.772)
    const big = square(-122.43, 37.76, -122.41, 37.78)
    const rSmall = buildAoiTileGrid(small, [-122.42, 37.77, -122.418, 37.772], { zoom: 17, maxTiles: 200 })
    const rBig = buildAoiTileGrid(big, [-122.43, 37.76, -122.41, 37.78], { zoom: 17, maxTiles: 200 })
    expect(rBig.tiles.length).toBeGreaterThan(rSmall.tiles.length)
  })

  it('caps tile count at maxTiles and flags `sampled: true`', () => {
    const huge = square(-122.5, 37.7, -122.3, 37.85) // ~17 km × 17 km
    const r = buildAoiTileGrid(huge, [-122.5, 37.7, -122.3, 37.85], { zoom: 18, maxTiles: 25 })
    expect(r.tiles.length).toBeLessThanOrEqual(25)
    expect(r.sampled).toBe(true)
    expect(r.totalCandidates).toBeGreaterThan(25)
  })

  it('filters tiles outside a triangular polygon', () => {
    // Right triangle: NW half of a 0.01°×0.01° square at the equator.
    const triangle = {
      type: 'Polygon',
      coordinates: [[[0, 0], [0.01, 0.01], [0, 0.01], [0, 0]]],
    }
    const squareAoi = square(0, 0, 0.01, 0.01)
    const rTri = buildAoiTileGrid(triangle, [0, 0, 0.01, 0.01], { zoom: 18, maxTiles: 200 })
    const rSquare = buildAoiTileGrid(squareAoi, [0, 0, 0.01, 0.01], { zoom: 18, maxTiles: 200 })
    expect(rTri.tiles.length).toBeLessThan(rSquare.tiles.length)
  })

  it('always returns at least one tile for a degenerate AOI', () => {
    // Zero-area bbox (point).
    const point = { type: 'Polygon', coordinates: [[[0, 0], [0, 0], [0, 0], [0, 0]]] }
    const r = buildAoiTileGrid(point, [0, 0, 0, 0], { zoom: 18, maxTiles: 25 })
    expect(r.tiles.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// dedupeDetections
// ---------------------------------------------------------------------------

describe('dedupeDetections', () => {
  const mk = (cls: string, lng: number, lat: number, conf: number): GeoDetection => ({
    class: cls,
    confidence: conf,
    centroid: [lng, lat],
    polygon: [[[lng, lat], [lng, lat], [lng, lat], [lng, lat], [lng, lat]]],
    tile: { x: 0, y: 0, z: 18 },
  })

  it('keeps a single detection when no duplicates exist', () => {
    const out = dedupeDetections([mk('solar_panel', 0, 0, 0.9)], 5)
    expect(out).toHaveLength(1)
  })

  it('merges two near-coincident detections of the same class', () => {
    // ~1.1 meters apart at the equator (1e-5 ° ≈ 1.11 m).
    const a = mk('solar_panel', 0, 0, 0.6)
    const b = mk('solar_panel', 1e-5, 0, 0.9)
    const out = dedupeDetections([a, b], 5)
    expect(out).toHaveLength(1)
    expect(out[0].confidence).toBeCloseTo(0.9, 6) // higher-confidence survives
  })

  it('does NOT merge detections of different classes', () => {
    const a = mk('solar_panel', 0, 0, 0.9)
    const b = mk('manhole', 1e-5, 0, 0.9)
    const out = dedupeDetections([a, b], 5)
    expect(out).toHaveLength(2)
  })

  it('does NOT merge detections farther apart than the threshold', () => {
    // ~111 meters apart (1e-3 ° at the equator).
    const a = mk('solar_panel', 0, 0, 0.9)
    const b = mk('solar_panel', 1e-3, 0, 0.9)
    const out = dedupeDetections([a, b], 5)
    expect(out).toHaveLength(2)
  })

  it('is class-name case-insensitive', () => {
    const a = mk('Solar_Panel', 0, 0, 0.6)
    const b = mk('solar_panel', 1e-5, 0, 0.9)
    const out = dedupeDetections([a, b], 5)
    expect(out).toHaveLength(1)
  })

  it('preserves order-independence (higher-conf wins regardless of input order)', () => {
    const a = mk('solar_panel', 0, 0, 0.9)
    const b = mk('solar_panel', 1e-5, 0, 0.6)
    expect(dedupeDetections([a, b], 5)[0].confidence).toBeCloseTo(0.9, 6)
    expect(dedupeDetections([b, a], 5)[0].confidence).toBeCloseTo(0.9, 6)
  })
})

// ---------------------------------------------------------------------------
// predictionToDetection
// ---------------------------------------------------------------------------

describe('predictionToDetection', () => {
  it('places the centroid inside the tile bounds', () => {
    const tile = { x: 38600, y: 49800, z: 17, bounds: tileToBounds(38600, 49800, 17) }
    const d = predictionToDetection({ class: 'solar_panel', confidence: 0.9, x: 128, y: 128, width: 10, height: 10 }, tile)
    expect(d.centroid[0]).toBeGreaterThan(tile.bounds.west)
    expect(d.centroid[0]).toBeLessThan(tile.bounds.east)
    expect(d.centroid[1]).toBeGreaterThan(tile.bounds.south)
    expect(d.centroid[1]).toBeLessThan(tile.bounds.north)
  })
})

// ---------------------------------------------------------------------------
// runWithConcurrency
// ---------------------------------------------------------------------------

describe('runWithConcurrency', () => {
  it('runs all items, preserves order', async () => {
    const items = [1, 2, 3, 4, 5]
    const out = await runWithConcurrency(items, 2, async (n) => n * 10)
    expect(out).toEqual([10, 20, 30, 40, 50])
  })

  it('enforces the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 10 }, (_, i) => i)
    await runWithConcurrency(items, 3, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
    })
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('handles an empty input list', async () => {
    const out = await runWithConcurrency<number, number>([], 4, async (n) => n)
    expect(out).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Model map / slug resolution
// ---------------------------------------------------------------------------

describe('CV_MODEL_MAP + resolveModelSlug', () => {
  it('exposes all six expected models', () => {
    for (const m of ['solar_panel', 'informal_struct', 'road_damage', 'manhole', 'water_channel', 'roof_material']) {
      expect(CV_MODEL_MAP[m]).toBeDefined()
    }
  })

  it('returns the default slug when no env override is set', () => {
    delete process.env.ROBOFLOW_MODEL_SOLAR_PANEL
    expect(resolveModelSlug('solar_panel')).toBe(CV_MODEL_MAP.solar_panel.defaultSlug)
  })

  it('honors the env override', () => {
    process.env.ROBOFLOW_MODEL_SOLAR_PANEL = 'my/own-model/3'
    expect(resolveModelSlug('solar_panel')).toBe('my/own-model/3')
    delete process.env.ROBOFLOW_MODEL_SOLAR_PANEL
  })

  it('returns null for an unknown model', () => {
    expect(resolveModelSlug('nonexistent')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Esri URL
// ---------------------------------------------------------------------------

describe('esriTileUrl', () => {
  it('uses Esri tile order {z}/{y}/{x}', () => {
    const url = esriTileUrl(123, 456, 17)
    expect(url.endsWith('/17/456/123')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// approxTileCoverageKm2
// ---------------------------------------------------------------------------

describe('approxTileCoverageKm2', () => {
  it('returns 0 for an empty tile list', () => {
    expect(approxTileCoverageKm2([])).toBe(0)
  })

  it('is positive for any non-degenerate tile', () => {
    const tile = { x: 38600, y: 49800, z: 17, bounds: tileToBounds(38600, 49800, 17) }
    expect(approxTileCoverageKm2([tile])).toBeGreaterThan(0)
  })

  it('scales linearly with tile count', () => {
    const tile = { x: 38600, y: 49800, z: 17, bounds: tileToBounds(38600, 49800, 17) }
    const one = approxTileCoverageKm2([tile])
    const four = approxTileCoverageKm2([tile, tile, tile, tile])
    expect(four / one).toBeCloseTo(4, 6)
  })
})
