import { describe, it, expect } from 'vitest'
import { buildPolygonIndex, buildingsInFlood, floodedRoadLength, footprintCentroid, pointInPolygon, ringCentroid } from '../impact'

const square = (x: number, y: number, s: number) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]
const rev = (r: number[][]) => [...r].reverse()

describe('point in polygon', () => {
  const donut = [square(0, 0, 10), rev(square(4, 4, 2))]
  it('respects holes', () => {
    expect(pointInPolygon(donut, 1, 1)).toBe(true)
    expect(pointInPolygon(donut, 5, 5)).toBe(false) // in the hole
    expect(pointInPolygon(donut, 11, 5)).toBe(false)
  })
})

describe('footprint centroid', () => {
  it('is the area-weighted centroid, not the bbox centre of an L', () => {
    // L-shape: 2x2 square plus a 2x1 arm; centroid is left of the bbox centre
    const L = [[0, 0], [2, 0], [2, 1], [4, 1], [4, 2], [0, 2], [0, 0]]
    const c = ringCentroid(L)
    expect(c[0]).toBeCloseTo(10 / 6, 6) // (4*1 + 2*3) / 6
    expect(c[1]).toBeCloseTo(7 / 6, 6) // (4*1 + 2*1.5) / 6; the bbox centre would be (2, 1)
    expect(footprintCentroid({ type: 'Polygon', coordinates: [square(10, 10, 2)] })).toEqual([11, 11])
    expect(footprintCentroid({ type: 'MultiPolygon', coordinates: [[square(0, 0, 1)], [square(10, 10, 4)]] })).toEqual([12, 12]) // largest part
    // a ~10 m footprint at real-world lon/lat: the centroid must stay within a metre of the true centre
    const tiny = footprintCentroid({ type: 'Polygon', coordinates: [square(74.00585, 31.00415, 0.0001)] })!
    expect(Math.abs(tiny[0] - 74.0059)).toBeLessThan(1e-8)
    expect(Math.abs(tiny[1] - 31.0042)).toBeLessThan(1e-8)
    expect(footprintCentroid({ type: 'LineString', coordinates: [] })).toBeNull()
  })
})

describe('buildings in flood polygons', () => {
  // Flood A: a donut (hole at 4..6); flood B: a separate square at 20..24
  const polys = [[square(0, 0, 10), rev(square(4, 4, 2))], [square(20, 20, 4)]]
  const index = buildPolygonIndex(polys)
  const b = (id: string, x: number, y: number, s = 0.5) => ({ id, geometry: { type: 'Polygon', coordinates: [square(x, y, s)] } })

  it('counts exactly the footprints whose centroid is inside', () => {
    const rows = [
      b('in-A-1', 1, 1), b('in-A-2', 8, 8), b('in-A-3', 0.1, 9),
      b('in-hole', 4.7, 4.7), // centroid (4.95, 4.95) inside the hole
      b('in-B', 21, 21),
      b('outside', 15, 15), b('far', 100, 100),
      b('straddle-edge', 9.9, 5, 0.5), // centroid x = 10.15 > 10: outside although the footprint overlaps
    ]
    const hit = buildingsInFlood(rows, index)
    expect(hit.map((h) => h.id).sort()).toEqual(['in-A-1', 'in-A-2', 'in-A-3', 'in-B'])
    expect(hit.find((h) => h.id === 'in-B')!.polygon).toBe(1)
    expect(buildingsInFlood(rows, buildPolygonIndex([])).length).toBe(0)
  })

  it('stays correct with many polygons (grid index)', () => {
    const many = Array.from({ length: 400 }, (_, i) => [square((i % 20) * 3, Math.floor(i / 20) * 3, 2)])
    const idx = buildPolygonIndex(many)
    let hits = 0
    for (let i = 0; i < 400; i++) if (idx.find((i % 20) * 3 + 1, Math.floor(i / 20) * 3 + 1) === i) hits++
    expect(hits).toBe(400)
    expect(idx.find(2.5, 2.5)).toBe(-1) // the 1-unit street between squares
  })
})

describe('flooded road length', () => {
  it('measures the part of a road inside the flood, to ~step accuracy', () => {
    const lat = 31
    const kx = 111_320 * Math.cos((lat * Math.PI) / 180)
    // flood: lon 74.000..74.002 (about 190 m wide); road runs W-E from 73.999 to 74.004 (about 477 m)
    const idx = buildPolygonIndex([[[[74, 30.99], [74.002, 30.99], [74.002, 31.01], [74, 31.01], [74, 30.99]]]])
    const r = floodedRoadLength([{ geometry: { type: 'LineString', coordinates: [[73.999, lat], [74.004, lat]] } }, { geometry: { type: 'LineString', coordinates: [[74.1, lat], [74.2, lat]] } }], idx, 5)
    const expected = (0.002 * kx) / 1000
    expect(r.floodedKm).toBeGreaterThan(expected - 0.01)
    expect(r.floodedKm).toBeLessThan(expected + 0.01)
    expect(r.segmentsTouched).toBe(1)
    expect(r.segmentsRead).toBe(2)
    expect(r.totalKm).toBeGreaterThan(r.floodedKm)
  })
})
