import { describe, expect, it } from 'vitest'
import {
  haversineM,
  ringAreaM2,
  polygonCentroid,
} from '../geo-ops'

// A ~0.01° square near the equator (closed ring).
const square: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [0.01, 0],
      [0.01, 0.01],
      [0, 0.01],
      [0, 0],
    ],
  ],
}

describe('haversineM', () => {
  it('is zero for identical points', () => {
    expect(haversineM(10, 20, 10, 20)).toBe(0)
  })

  it('matches the known ~111 km per degree of latitude', () => {
    const d = haversineM(0, 0, 0, 1)
    // One degree of latitude ≈ 111.19 km
    expect(d).toBeGreaterThan(111_000)
    expect(d).toBeLessThan(111_400)
  })
})

describe('ringAreaM2', () => {
  it('computes ~1.23 km² for a 0.01° equatorial square', () => {
    const area = ringAreaM2(square.coordinates[0])
    // 0.01° ≈ 1.113 km on a side → ~1.23 km²
    expect(area / 1e6).toBeGreaterThan(1.1)
    expect(area / 1e6).toBeLessThan(1.35)
  })
})

describe('polygonCentroid', () => {
  it('averages the ring vertices', () => {
    // 5 vertices incl. the closing duplicate at [0,0] → pulled toward origin
    const c = polygonCentroid(square)
    expect(c.lng).toBeCloseTo(0.004, 6)
    expect(c.lat).toBeCloseTo(0.004, 6)
  })
})
