import { describe, expect, it } from 'vitest'
import {
  bboxToPolygon,
  buildPointAoi,
  extractBboxFromGeojson,
  getAreaKm2,
  getBbox,
  getCentroid,
  haversineKm,
  lonLatToTile,
  pointInAoi,
} from '../geometry'

describe('bboxToPolygon', () => {
  it('returns a closed rectangle ring for a valid bbox', () => {
    const poly = bboxToPolygon([10, 20, 30, 40])
    expect(poly).toEqual({
      type: 'Polygon',
      coordinates: [[[10, 20], [30, 20], [30, 40], [10, 40], [10, 20]]],
    })
  })

  it('round-trips through getBbox', () => {
    const bbox: [number, number, number, number] = [74.28, 31.5, 74.36, 31.55]
    expect(getBbox(bboxToPolygon(bbox)!)).toEqual(bbox)
  })

  it('normalizes a bbox given with reversed corners', () => {
    expect(bboxToPolygon([30, 40, 10, 20])).toEqual(bboxToPolygon([10, 20, 30, 40]))
  })

  it('returns null for a malformed or degenerate bbox', () => {
    expect(bboxToPolygon([1, 2, 3])).toBeNull()
    expect(bboxToPolygon([])).toBeNull()
    expect(bboxToPolygon([1, 2, NaN, 4])).toBeNull()
    // zero-area bbox — no pixels to clip, so no honest statistic exists
    expect(bboxToPolygon([5, 5, 5, 5])).toBeNull()
  })
})

describe('getBbox', () => {
  it('returns the bbox of a Polygon', () => {
    const geom = {
      type: 'Polygon',
      coordinates: [[[10, 20], [30, 20], [30, 40], [10, 40], [10, 20]]],
    }
    expect(getBbox(geom)).toEqual([10, 20, 30, 40])
  })

  it('returns a degenerate bbox for a Point', () => {
    const geom = { type: 'Point', coordinates: [5, 5] }
    expect(getBbox(geom)).toEqual([5, 5, 5, 5])
  })

  it('falls back to [0,0,1,1] for empty geometry', () => {
    expect(getBbox({ type: 'Polygon', coordinates: [[]] })).toEqual([0, 0, 1, 1])
  })
})

describe('getAreaKm2 (Turf polygon-true)', () => {
  it('is positive and scales with bbox size', () => {
    const small = { type: 'Polygon', coordinates: [[[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1], [0, 0]]] }
    const large = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] }
    const a = getAreaKm2(small)
    const b = getAreaKm2(large)
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(a)
  })

  it('roughly matches 12,000–12,400 km² for a 1° box at the equator', () => {
    const oneDeg = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] }
    const area = getAreaKm2(oneDeg)
    expect(area).toBeGreaterThan(12000)
    expect(area).toBeLessThan(12400)
  })

  it('reports a triangle at roughly HALF of its bbox area', () => {
    // Right triangle filling half of a 1°×1° box at the equator.
    const triangle = {
      type: 'Polygon',
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
    }
    const square = {
      type: 'Polygon',
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
    }
    const triArea = getAreaKm2(triangle)
    const sqArea = getAreaKm2(square)
    const ratio = triArea / sqArea
    expect(ratio).toBeGreaterThan(0.45)
    expect(ratio).toBeLessThan(0.55)
  })
})

describe('getCentroid (Turf polygon-true)', () => {
  it('matches bbox center for a rectangle', () => {
    const geom = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 20], [0, 20], [0, 0]]] }
    expect(getCentroid(geom)).toEqual({ lat: 10, lng: 5 })
  })

  it('does NOT return the bbox center for a non-rectangular polygon', () => {
    // Right triangle: vertices (0,0), (2,0), (0,2). Mean of vertices = (0.667, 0.667).
    // Bbox center = (1, 1). Turf's mean-of-vertices centroid differs.
    const tri = { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [0, 2], [0, 0]]] }
    const c = getCentroid(tri)
    expect(c.lng).toBeLessThan(1)
    expect(c.lat).toBeLessThan(1)
  })
})

describe('pointInAoi', () => {
  const triangle = {
    type: 'Polygon',
    coordinates: [[[0, 0], [10, 0], [0, 10], [0, 0]]],
  }

  it('returns true for a point strictly inside the triangle', () => {
    expect(pointInAoi(2, 2, triangle)).toBe(true)
  })

  it('returns false for a point inside the bbox but outside the triangle', () => {
    // (8, 8) is in the [0,0,10,10] bbox but well outside the lower-left triangle.
    expect(pointInAoi(8, 8, triangle)).toBe(false)
  })

  it('returns false for a point clearly outside the bbox', () => {
    expect(pointInAoi(-1, -1, triangle)).toBe(false)
  })

  it('returns false for non-polygon geometry', () => {
    expect(pointInAoi(0, 0, { type: 'Point', coordinates: [0, 0] })).toBe(false)
    expect(pointInAoi(0, 0, null)).toBe(false)
  })

  it('handles MultiPolygon', () => {
    const mp = {
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
        [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]],
      ],
    }
    expect(pointInAoi(0.5, 0.5, mp)).toBe(true)
    expect(pointInAoi(10.5, 10.5, mp)).toBe(true)
    expect(pointInAoi(5, 5, mp)).toBe(false)
  })
})

describe('buildPointAoi (P4.3 focus circle)', () => {
  it('returns a closed Polygon ring centered on the point', () => {
    const aoi = buildPointAoi(51.5074, -0.1278)
    expect(aoi.type).toBe('Polygon')
    const ring = aoi.coordinates[0]
    // ring is closed (first === last)
    expect(ring[0]).toEqual(ring[ring.length - 1])
    // centroid is the clicked point (within rounding)
    const c = getCentroid(aoi)
    expect(c.lat).toBeCloseTo(51.5074, 3)
    expect(c.lng).toBeCloseTo(-0.1278, 3)
  })

  it('contains its own center and excludes far points', () => {
    const aoi = buildPointAoi(0, 0, 200)
    expect(pointInAoi(0, 0, aoi)).toBe(true)
    // 1 km away is well outside a 200 m circle
    expect(pointInAoi(0.01, 0.01, aoi)).toBe(false)
  })

  it('makes a small area — a 200 m circle is roughly 0.1 km²', () => {
    const area = getAreaKm2(buildPointAoi(0, 0, 200))
    expect(area).toBeGreaterThan(0.08)
    expect(area).toBeLessThan(0.16)
  })

  it('radius scales the area', () => {
    const small = getAreaKm2(buildPointAoi(0, 0, 100))
    const big = getAreaKm2(buildPointAoi(0, 0, 400))
    expect(big).toBeGreaterThan(small * 8) // ~16x for 4x radius
  })
})

describe('haversineKm', () => {
  it('returns 0 for the same point', () => {
    expect(haversineKm(40, -74, 40, -74)).toBe(0)
  })

  it('is approximately 111 km for 1° of latitude at the equator', () => {
    const d = haversineKm(0, 0, 1, 0)
    expect(d).toBeGreaterThan(110)
    expect(d).toBeLessThan(112)
  })

  it('handles known NYC↔LA distance (~3940 km)', () => {
    const d = haversineKm(40.7128, -74.0060, 34.0522, -118.2437)
    expect(d).toBeGreaterThan(3900)
    expect(d).toBeLessThan(4000)
  })
})

describe('lonLatToTile', () => {
  it('returns (0,0) at zoom 0', () => {
    expect(lonLatToTile(0, 0, 0)).toEqual({ x: 0, y: 0 })
  })

  it('clamps to valid range at zoom 1', () => {
    const t = lonLatToTile(180, 85, 1)
    expect(t.x).toBeGreaterThanOrEqual(0)
    expect(t.x).toBeLessThanOrEqual(1)
    expect(t.y).toBeGreaterThanOrEqual(0)
    expect(t.y).toBeLessThanOrEqual(1)
  })
})

describe('extractBboxFromGeojson', () => {
  it('returns null for empty FeatureCollection', () => {
    expect(extractBboxFromGeojson({ type: 'FeatureCollection', features: [] })).toBeNull()
  })

  it('extracts bbox over multiple features', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [10, 20] } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-5, 30] } },
      ],
    }
    expect(extractBboxFromGeojson(fc)).toEqual([-5, 20, 10, 30])
  })

  it('handles LineString geometry', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [10, 5]] } },
      ],
    }
    expect(extractBboxFromGeojson(fc)).toEqual([0, 0, 10, 5])
  })
})

describe('Feature / FeatureCollection input', () => {
  const geom = { type: 'Polygon' as const, coordinates: [[[0, 0], [0.045, 0], [0.045, 0.045], [0, 0.045], [0, 0]]] }
  it('measures a Feature the same as its bare geometry', () => {
    const feature = { type: 'Feature', properties: {}, geometry: geom }
    expect(getAreaKm2(feature)).toBeCloseTo(getAreaKm2(geom), 6)
    expect(getAreaKm2(feature)).toBeLessThan(30)
    expect(getBbox(feature)).toEqual(getBbox(geom))
  })
  it('unwraps a FeatureCollection', () => {
    const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: geom }] }
    expect(getAreaKm2(fc)).toBeCloseTo(getAreaKm2(geom), 6)
  })
})
