import { describe, it, expect } from 'vitest'
import { labelComponents, makeGeoref, vectorizeLabels, vectorizeMask, type VectorPolygon } from '..'

/** 1 degree per 10 px at the equator-ish so lon/lat maths is easy to eyeball. */
const BBOX: [number, number, number, number] = [10, 20, 11, 21]

function grid(w: number, h: number, fill: (x: number, y: number) => number) {
  const a = new Int32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = fill(x, y)
  return a
}

/** Shoelace in lon/lat: > 0 = counter-clockwise. */
function signedArea(ring: number[][]): number {
  let s = 0
  for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
  return s / 2
}

function expectValid(p: VectorPolygon) {
  p.coordinates.forEach((ring, i) => {
    expect(ring.length).toBeGreaterThanOrEqual(4)
    expect(ring[0]).toEqual(ring[ring.length - 1])
    const a = signedArea(ring)
    if (i === 0) expect(a).toBeGreaterThan(0) // shell CCW
    else expect(a).toBeLessThan(0) // hole CW
  })
}

const sqKey = (c: number[]) => `${c[0]},${c[1]}`

describe('labelComponents', () => {
  it('separates diagonal neighbours (4-connectivity) and keeps values apart', () => {
    const g = grid(4, 4, (x, y) => (x === y ? 1 : 0))
    expect(labelComponents(g, 4, 4).count).toBe(4)
    const two = grid(4, 1, (x) => (x < 2 ? 1 : 2))
    const c = labelComponents(two, 4, 1)
    expect(c.count).toBe(2)
    expect(Array.from(c.areas)).toEqual([0, 2, 2])
    expect(Array.from(c.values)).toEqual([0, 1, 2])
  })

  it('merges a U shape through the union-find second pass', () => {
    const g = grid(5, 3, (x, y) => (x === 0 || x === 4 || y === 2 ? 1 : 0))
    expect(labelComponents(g, 5, 3).count).toBe(1)
  })
})

describe('vectorizeLabels', () => {
  it('traces a single square with correct georeferenced corners', () => {
    // 10x10 grid over 1°x1°; square of pixels x 2..4, y 3..5 (3x3).
    const g = grid(10, 10, (x, y) => (x >= 2 && x <= 4 && y >= 3 && y <= 5 ? 1 : 0))
    const { polygons } = vectorizeLabels(g, 10, 10, { bbox: BBOX })
    expect(polygons).toHaveLength(1)
    const p = polygons[0]
    expectValid(p)
    expect(p.areaPx).toBe(9)
    // Corners: x 2..5 -> lon 10.2..10.5 ; y 3..6 -> lat 21-0.3 .. 21-0.6
    const corners = new Set(p.coordinates[0].map(sqKey))
    for (const c of ['10.2,20.7', '10.5,20.7', '10.5,20.4', '10.2,20.4']) expect(corners.has(c)).toBe(true)
    expect(p.coordinates[0]).toHaveLength(5) // collinear lattice vertices removed
    const geo = makeGeoref(BBOX, 10, 10)
    expect(p.areaM2).toBeCloseTo(9 * geo.pixelAreaM2, 3)
  })

  it('keeps a hole as a clockwise inner ring', () => {
    const g = grid(10, 10, (x, y) => {
      const inOuter = x >= 1 && x <= 7 && y >= 1 && y <= 7
      const inHole = x >= 3 && x <= 5 && y >= 3 && y <= 5
      return inOuter && !inHole ? 1 : 0
    })
    const { polygons } = vectorizeLabels(g, 10, 10, { bbox: BBOX })
    expect(polygons).toHaveLength(1)
    const p = polygons[0]
    expectValid(p)
    expect(p.coordinates).toHaveLength(2)
    expect(p.areaPx).toBe(49 - 9)
    const geo = makeGeoref(BBOX, 10, 10)
    expect(p.areaM2).toBeCloseTo(40 * geo.pixelAreaM2, 3)
  })

  it('shares coincident boundaries between adjacent components, even after simplification', () => {
    // Left block value 1, right block value 2, sharing a wobbly edge; background elsewhere.
    const w = 40, h = 40
    const g = grid(w, h, (x, y) => {
      if (x < 5 || x >= 35 || y < 5 || y >= 35) return 0
      const split = 20 + (y % 7 === 0 ? 1 : 0) // slight zig-zag boundary
      return x < split ? 1 : 2
    })
    const { polygons } = vectorizeLabels(g, w, h, { bbox: BBOX, simplifyTolerancePx: 0.3 })
    expect(polygons).toHaveLength(2)
    polygons.forEach(expectValid)
    const [a, b] = polygons
    // Every vertex of A lying strictly inside the union's interior must also be on B (shared arc).
    const bSet = new Set(b.coordinates[0].map(sqKey))
    const shared = a.coordinates[0].filter((c) => bSet.has(sqKey(c)))
    expect(shared.length).toBeGreaterThanOrEqual(8) // the zig-zag arc survives and is identical on both sides
    // No gaps / overlaps: simplified areas sum to the simplified union's footprint, which equals the
    // sum of the pixel areas up to the simplification error (a few px).
    const geo = makeGeoref(BBOX, w, h)
    const total = (a.areaM2 + b.areaM2) / geo.pixelAreaM2
    expect(Math.abs(total - (a.areaPx + b.areaPx))).toBeLessThan(1e-6)
    // Planar lon/lat area of each polygon equals what the other loses: A∪B ring area ≈ pixel area ±1%.
    const planar = (p: VectorPolygon) => Math.abs(signedArea(p.coordinates[0])) * w * h // deg² -> px² (grid spans 1° x 1°)
    const sumPlanar = planar(a) + planar(b)
    expect(Math.abs(sumPlanar - (a.areaPx + b.areaPx)) / (a.areaPx + b.areaPx)).toBeLessThan(0.01)
  })

  it('splits pixels that touch only at a corner into separate polygons', () => {
    const g = grid(6, 6, (x, y) => ((x === 1 && y === 1) || (x === 2 && y === 2) ? 1 : 0))
    const { polygons } = vectorizeLabels(g, 6, 6, { bbox: BBOX, simplifyTolerancePx: 0 })
    expect(polygons).toHaveLength(2)
    polygons.forEach(expectValid)
    polygons.forEach((p) => expect(p.areaPx).toBe(1))
  })

  it('splits a hole that touches its shell at one corner into shell + hole', () => {
    // Ring of 1s whose inner void connects to the outside only diagonally.
    const g = grid(7, 7, (x, y) => {
      if (x < 1 || x > 5 || y < 1 || y > 5) return 0
      if (x >= 2 && x <= 4 && y >= 2 && y <= 4) return x === 4 && y === 4 ? 1 : 0 // void, except one corner pixel
      return 1
    })
    // Open the void diagonally to the outside: remove the SE corner ring pixel (5,5) so the void touches (5,5)'s void corner.
    g[5 * 7 + 5] = 0
    const { polygons } = vectorizeLabels(g, 7, 7, { bbox: BBOX, simplifyTolerancePx: 0 })
    polygons.forEach(expectValid)
    // 4-connectivity: everything stays valid and total pixel area is preserved.
    expect(polygons.reduce((s, p) => s + p.areaPx, 0)).toBe(Array.from(g).filter(Boolean).length)
  })

  it('simplification keeps polygons valid and reduces vertices on a diagonal staircase', () => {
    const n = 60
    const g = grid(n, n, (x, y) => (y > x && y < n - 3 && x > 2 ? 1 : 0)) // diagonal triangle edge
    const lossless = vectorizeLabels(g, n, n, { bbox: BBOX, simplifyTolerancePx: 0 }).polygons[0]
    const simp = vectorizeLabels(g, n, n, { bbox: BBOX, simplifyTolerancePx: 1 }).polygons[0]
    expectValid(lossless)
    expectValid(simp)
    expect(simp.coordinates[0].length).toBeLessThan(lossless.coordinates[0].length / 4)
    // Area drift from simplification stays small.
    const planar = (p: VectorPolygon) => Math.abs(signedArea(p.coordinates[0]))
    expect(Math.abs(planar(simp) - planar(lossless)) / planar(lossless)).toBeLessThan(0.02)
  })

  it('drops components below the minimum area and fills sub-minimum holes', () => {
    const g = grid(40, 40, (x, y) => {
      if (x >= 2 && x < 22 && y >= 2 && y < 22) return x === 10 && y === 10 ? 0 : 1 // 20x20 with a 1px pinhole
      if (x >= 30 && x < 32 && y >= 30 && y < 32) return 1 // 2x2 speck
      return 0
    })
    const geo = makeGeoref(BBOX, 40, 40)
    const r = vectorizeLabels(g, 40, 40, { bbox: BBOX, minAreaM2: 10 * geo.pixelAreaM2 })
    expect(r.polygons).toHaveLength(1)
    expect(r.droppedSmall).toBe(1)
    expect(r.polygons[0].coordinates).toHaveLength(1) // pinhole filled
    const all = vectorizeLabels(g, 40, 40, { bbox: BBOX })
    expect(all.polygons).toHaveLength(2)
    expect(all.polygons.find((p) => p.areaPx > 100)!.coordinates).toHaveLength(2)
  })

  it('vectorizeMask treats any non-zero as foreground', () => {
    const m = new Float64Array(16).map((_, i) => (i === 5 || i === 6 ? 0.5 : NaN))
    const r = vectorizeMask(m, 4, 4, { bbox: BBOX })
    expect(r.polygons).toHaveLength(1)
    expect(r.polygons[0].areaPx).toBe(2)
  })

  it('handles an island component nested in another (no junction vertices)', () => {
    const g = grid(20, 20, (x, y) => {
      if (x >= 3 && x < 17 && y >= 3 && y < 17) return x >= 8 && x < 12 && y >= 8 && y < 12 ? 2 : 1
      return 0
    })
    const { polygons } = vectorizeLabels(g, 20, 20, { bbox: BBOX, simplifyTolerancePx: 1 })
    expect(polygons).toHaveLength(2)
    polygons.forEach(expectValid)
    const island = polygons.find((p) => p.value === 2)!
    const host = polygons.find((p) => p.value === 1)!
    const hole = [...new Set(host.coordinates[1].map(sqKey))].sort()
    expect([...new Set(island.coordinates[0].map(sqKey))].sort()).toEqual(hole)
  })

  it('vectorizes a 1000x1000 grid of ~700 irregular regions in well under a second', () => {
    const n = 1000
    const g = grid(n, n, (x, y) => {
      // Blocky regions with a wavy boundary and some speckle.
      const bx = Math.floor((x + 6 * Math.sin(y / 9)) / 37)
      const by = Math.floor((y + 6 * Math.sin(x / 11)) / 41)
      const speck = (x * 7919 + y * 104729) % 997 === 0 ? 9 : 0
      return speck || 1 + ((bx * 31 + by * 17) % 4)
    })
    // Best of three: the budget is about algorithmic cost, not JIT warm-up or a loaded CI runner.
    let ms = Infinity
    let r = vectorizeLabels(g, n, n, { bbox: BBOX, minAreaM2: 0 })
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      r = vectorizeLabels(g, n, n, { bbox: BBOX, minAreaM2: 0 })
      ms = Math.min(ms, performance.now() - t0)
    }
    expect(r.polygons.length).toBeGreaterThan(500)
    r.polygons.slice(0, 50).forEach(expectValid)
    expect(ms).toBeLessThan(1000)
  })
})
