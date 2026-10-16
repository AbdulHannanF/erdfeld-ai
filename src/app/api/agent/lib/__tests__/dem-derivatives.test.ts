import { describe, it, expect } from 'vitest'
import {
  computeSlope,
  computeAspect,
  computeContours,
  slopeDistribution,
  aspectClass,
  COMPASS_LABELS,
  stitchSegments,
} from '../dem-derivatives'

// ---------------------------------------------------------------------------
// computeSlope — Horn (1981)
// ---------------------------------------------------------------------------

describe('computeSlope', () => {
  const CELL = 100 // 100 m cell size for clean arithmetic

  it('flat terrain → slope 0%', () => {
    const flat = Array.from({ length: 5 }, () => Array(5).fill(500))
    const s = computeSlope(flat, CELL, CELL)
    expect(s.min).toBeCloseTo(0, 5)
    expect(s.max).toBeCloseTo(0, 5)
  })

  it('planar east-facing slope at 10° → slope ≈ 17.63%', () => {
    // z[r][c] = c * 100 * tan(10°) — elevation increases going east
    const tan10 = Math.tan(10 * Math.PI / 180)
    const grid = Array.from({ length: 5 }, () =>
      Array.from({ length: 5 }, (_, c) => c * CELL * tan10),
    )
    const s = computeSlope(grid, CELL, CELL)
    // Interior cell should be exactly tan(10°) * 100
    expect(s.values[2][2]).toBeCloseTo(tan10 * 100, 1)
    expect(s.min).toBeGreaterThanOrEqual(0)
    expect(s.max).toBeCloseTo(tan10 * 100, 1)
  })

  it('planar north-facing slope at 10° → slope ≈ 17.63%', () => {
    const tan10 = Math.tan(10 * Math.PI / 180)
    // Row 0 = north (highest); elevation decreases going south (increasing r)
    const grid = Array.from({ length: 5 }, (_, r) =>
      Array.from({ length: 5 }, () => (4 - r) * CELL * tan10),
    )
    const s = computeSlope(grid, CELL, CELL)
    expect(s.values[2][2]).toBeCloseTo(tan10 * 100, 1)
  })

  it('slope increases with steeper angle', () => {
    const makePlane = (angleDeg: number) =>
      Array.from({ length: 5 }, () =>
        Array.from({ length: 5 }, (_, c) => c * CELL * Math.tan(angleDeg * Math.PI / 180)),
      )
    const s5  = computeSlope(makePlane(5),  CELL, CELL).values[2][2]
    const s20 = computeSlope(makePlane(20), CELL, CELL).values[2][2]
    const s45 = computeSlope(makePlane(45), CELL, CELL).values[2][2]
    expect(s5).toBeLessThan(s20)
    expect(s20).toBeLessThan(s45)
    expect(s45).toBeCloseTo(100, 1) // tan(45°) = 1 → 100%
  })

  it('45° diagonal slope → slope = √2 * 100 ≈ 141%', () => {
    // z increases equally in x and y direction
    const grid = Array.from({ length: 5 }, (_, r) =>
      Array.from({ length: 5 }, (_, c) => (c + (4 - r)) * CELL),
    )
    const s = computeSlope(grid, CELL, CELL)
    expect(s.values[2][2]).toBeCloseTo(Math.sqrt(2) * 100, 0)
  })

  it('returns DerivativeGrid with correct dimensions', () => {
    const grid = Array.from({ length: 7 }, (_, r) =>
      Array.from({ length: 9 }, (_, c) => r * 10 + c * 5),
    )
    const s = computeSlope(grid, CELL, CELL)
    expect(s.rows).toBe(7)
    expect(s.cols).toBe(9)
    expect(s.values).toHaveLength(7)
    expect(s.values[0]).toHaveLength(9)
  })

  it('min <= max in all cases', () => {
    const random = Array.from({ length: 6 }, () =>
      Array.from({ length: 6 }, () => Math.random() * 1000),
    )
    const s = computeSlope(random, CELL, CELL)
    expect(s.min).toBeLessThanOrEqual(s.max)
  })

  it('non-square grid works correctly', () => {
    const grid = Array.from({ length: 3 }, () => [0, 10, 20, 30]) // 3 rows, 4 cols
    const s = computeSlope(grid, 10, 10)
    expect(s.rows).toBe(3)
    expect(s.cols).toBe(4)
    expect(s.min).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// computeAspect — Horn (1981)
// ---------------------------------------------------------------------------

describe('computeAspect', () => {
  const CELL = 100

  it('east-facing slope → aspect ≈ 90°', () => {
    const tan10 = Math.tan(10 * Math.PI / 180)
    const grid = Array.from({ length: 5 }, () =>
      Array.from({ length: 5 }, (_, c) => c * CELL * tan10),
    )
    const a = computeAspect(grid, CELL, CELL)
    expect(a.values[2][2]).toBeCloseTo(90, 0)
  })

  it('west-facing slope → aspect ≈ 270°', () => {
    const tan10 = Math.tan(10 * Math.PI / 180)
    const grid = Array.from({ length: 5 }, () =>
      Array.from({ length: 5 }, (_, c) => (4 - c) * CELL * tan10),
    )
    const a = computeAspect(grid, CELL, CELL)
    expect(a.values[2][2]).toBeCloseTo(270, 0)
  })

  it('north-facing slope → aspect ≈ 0°', () => {
    const tan10 = Math.tan(10 * Math.PI / 180)
    // Row 0 = north (high elevation); decreases going south
    const grid = Array.from({ length: 5 }, (_, r) =>
      Array.from({ length: 5 }, () => (4 - r) * CELL * tan10),
    )
    const a = computeAspect(grid, CELL, CELL)
    // atan2(0, positive) = 0° → may also manifest as 360° at floating-point edges
    const v = a.values[2][2]
    expect(v < 1 || v > 359).toBe(true)
  })

  it('south-facing slope → aspect ≈ 180°', () => {
    const tan10 = Math.tan(10 * Math.PI / 180)
    // Elevation increases going south (increasing row index)
    const grid = Array.from({ length: 5 }, (_, r) =>
      Array.from({ length: 5 }, () => r * CELL * tan10),
    )
    const a = computeAspect(grid, CELL, CELL)
    expect(a.values[2][2]).toBeCloseTo(180, 0)
  })

  it('NE-facing slope → aspect ≈ 45°', () => {
    // Elevation increases equally going east and north
    // Row 0 = north (high), so "north-facing" means row increases → elevation decreases
    // NE-facing: elevation increases both going east (col+) and north (row-)
    const grid = Array.from({ length: 5 }, (_, r) =>
      Array.from({ length: 5 }, (_, c) => (c + (4 - r)) * CELL),
    )
    const a = computeAspect(grid, CELL, CELL)
    expect(a.values[2][2]).toBeCloseTo(45, 0)
  })

  it('all aspect values in [0, 360)', () => {
    const grid = Array.from({ length: 6 }, (_, r) =>
      Array.from({ length: 6 }, (_, c) => Math.sin(r) * 100 + Math.cos(c) * 80),
    )
    const a = computeAspect(grid, CELL, CELL)
    for (const row of a.values) {
      for (const v of row) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThan(360)
      }
    }
  })

  it('returns correct dimensions', () => {
    const grid = Array.from({ length: 4 }, () => Array(6).fill(100))
    const a = computeAspect(grid, CELL, CELL)
    expect(a.rows).toBe(4)
    expect(a.cols).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// computeContours — marching squares
// ---------------------------------------------------------------------------

describe('computeContours', () => {
  const BOUNDS: [number, number, number, number] = [0, 0, 4, 4]

  it('flat terrain → no contours emitted', () => {
    const flat = Array.from({ length: 5 }, () => Array(5).fill(100))
    const r = computeContours(flat, 10, BOUNDS)
    expect(r.levels).toHaveLength(0)
    expect(r.featureCollection.features).toHaveLength(0)
    expect(r.totalSegments).toBe(0)
  })

  it('east ramp: correct contour levels emitted', () => {
    // z[r][c] = c * 25 → 0, 25, 50, 75, 100 m
    const ramp = Array.from({ length: 4 }, () => [0, 25, 50, 75, 100])
    const r = computeContours(ramp, 25, BOUNDS)
    expect(r.levels).toContain(25)
    expect(r.levels).toContain(50)
    expect(r.levels).toContain(75)
    expect(r.levels).toContain(100)
  })

  it('interval larger than relief → no contours emitted', () => {
    const small = Array.from({ length: 4 }, () => [100, 102, 104, 106])
    const r = computeContours(small, 50, BOUNDS)
    expect(r.levels).toHaveLength(0)
  })

  it('contour level is set in feature properties', () => {
    const ramp = Array.from({ length: 4 }, () => [0, 30, 60, 90, 120])
    const r = computeContours(ramp, 30, BOUNDS)
    for (const feature of r.featureCollection.features) {
      expect(typeof feature.properties.elevation).toBe('number')
      expect(r.levels).toContain(feature.properties.elevation)
    }
  })

  it('contour coordinates are valid lat/lng pairs', () => {
    const ramp = Array.from({ length: 4 }, () => [0, 50, 100, 150, 200])
    const bounds: [number, number, number, number] = [10, 40, 11, 41]
    const r = computeContours(ramp, 50, bounds)
    for (const feat of r.featureCollection.features) {
      for (const seg of feat.geometry.coordinates) {
        for (const [lng, lat] of seg) {
          expect(lng).toBeGreaterThanOrEqual(10)
          expect(lng).toBeLessThanOrEqual(11)
          expect(lat).toBeGreaterThanOrEqual(40)
          expect(lat).toBeLessThanOrEqual(41)
        }
      }
    }
  })

  it('more segments with smaller interval', () => {
    const grid = Array.from({ length: 5 }, (_, r) =>
      Array.from({ length: 5 }, (_, c) => (r + c) * 10),
    )
    const rCoarse = computeContours(grid, 20, BOUNDS)
    const rFine   = computeContours(grid, 10, BOUNDS)
    expect(rFine.totalSegments).toBeGreaterThanOrEqual(rCoarse.totalSegments)
  })

  it('minElev and maxElev reported correctly', () => {
    const grid = [[100, 200], [300, 400]]
    const r = computeContours(grid, 50, BOUNDS)
    expect(r.minElev).toBe(100)
    expect(r.maxElev).toBe(400)
  })

  it('GeoJSON output is a valid FeatureCollection with MultiLineString geometry', () => {
    const grid = Array.from({ length: 5 }, () => [0, 25, 50, 75, 100])
    const r = computeContours(grid, 25, BOUNDS)
    expect(r.featureCollection.type).toBe('FeatureCollection')
    expect(Array.isArray(r.featureCollection.features)).toBe(true)
    for (const feat of r.featureCollection.features) {
      expect(feat.type).toBe('Feature')
      expect(feat.geometry.type).toBe('MultiLineString')
      expect(Array.isArray(feat.geometry.coordinates)).toBe(true)
    }
  })

  it('small 2×2 grid (1 cell) → can generate segments', () => {
    // Case 1 (bl above): tl=1, tr=2, br=4, bl=10, level=5
    // left crosses: bl(10)→tl(1) at t=(5-10)/(1-10)=5/9 ≈ 0.56
    // bottom crosses: br(4)→bl(10) at t=(5-4)/(10-4)=1/6 ≈ 0.17
    const grid = [[1, 2], [10, 4]]
    const bounds: [number, number, number, number] = [0, 0, 1, 1]
    const r = computeContours(grid, 5, bounds)
    const feat = r.featureCollection.features.find(f => f.properties.elevation === 5)
    expect(feat).toBeDefined()
    expect(feat!.geometry.coordinates.length).toBeGreaterThan(0)
  })

  it('handles saddle case 5 (tr+bl above): two segments', () => {
    // case 5: tl=1, tr=10, br=2, bl=10, level=5
    const grid = [[1, 10], [10, 2]]
    const bounds: [number, number, number, number] = [0, 0, 1, 1]
    const r = computeContours(grid, 5, bounds)
    const feat = r.featureCollection.features.find(f => f.properties.elevation === 5)
    expect(feat).toBeDefined()
    // Saddle case 5 emits 2 segments
    expect(feat!.geometry.coordinates.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// slopeDistribution
// ---------------------------------------------------------------------------

describe('slopeDistribution', () => {
  it('all flat', () => {
    const d = slopeDistribution([0, 1, 2, 3, 4])
    expect(d.flat).toBe(100)
    expect(d.gentle).toBe(0)
  })

  it('all very steep', () => {
    const d = slopeDistribution([70, 80, 90])
    expect(d.verysteep).toBe(100)
  })

  it('mixed distribution', () => {
    const d = slopeDistribution([2, 8, 20, 45, 70])
    expect(d.flat).toBe(20)      // 1/5
    expect(d.gentle).toBe(20)   // 1/5
    expect(d.moderate).toBe(20) // 1/5
    expect(d.steep).toBe(20)    // 1/5
    expect(d.verysteep).toBe(20)// 1/5
  })

  it('totals roughly 100%', () => {
    const pcts = [3, 7, 18, 45, 65, 0, 12, 25]
    const d = slopeDistribution(pcts)
    const total = d.flat + d.gentle + d.moderate + d.steep + d.verysteep
    // Due to Math.round, total may be off by a few points
    expect(total).toBeGreaterThanOrEqual(95)
    expect(total).toBeLessThanOrEqual(105)
  })
})

// ---------------------------------------------------------------------------
// aspectClass and COMPASS_LABELS
// ---------------------------------------------------------------------------

describe('aspectClass', () => {
  it('0° → class 0 (N)', () => expect(aspectClass(0)).toBe(0))
  it('90° → class 2 (E)', () => expect(aspectClass(90)).toBe(2))
  it('180° → class 4 (S)', () => expect(aspectClass(180)).toBe(4))
  it('270° → class 6 (W)', () => expect(aspectClass(270)).toBe(6))
  it('45° → class 1 (NE)', () => expect(aspectClass(45)).toBe(1))
  it('360° = 0° → class 0 (N)', () => expect(aspectClass(360)).toBe(0))
  it('negative angles wrap correctly', () => expect(aspectClass(-90)).toBe(6)) // -90 → 270 → W
})

describe('COMPASS_LABELS', () => {
  it('has 8 labels', () => expect(COMPASS_LABELS).toHaveLength(8))
  it('correct order', () => {
    expect(COMPASS_LABELS[0]).toBe('N')
    expect(COMPASS_LABELS[2]).toBe('E')
    expect(COMPASS_LABELS[4]).toBe('S')
    expect(COMPASS_LABELS[6]).toBe('W')
  })
})

describe('stitchSegments — contour fragments become continuous lines', () => {
  it('joins a chain of shared endpoints into one polyline', () => {
    const segs: [number, number][][] = [
      [[0, 0], [1, 1]],
      [[1, 1], [2, 2]],
      [[2, 2], [3, 3]],
    ]
    const lines = stitchSegments(segs)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toEqual([[0, 0], [1, 1], [2, 2], [3, 3]])
  })

  it('joins segments handed over in arbitrary order and orientation', () => {
    // Marching squares emits per cell, so a ring arrives shuffled and with
    // inconsistent winding. Both must still chain.
    const segs: [number, number][][] = [
      [[2, 2], [1, 1]],
      [[3, 3], [2, 2]],
      [[0, 0], [1, 1]],
    ]
    const lines = stitchSegments(segs)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveLength(4)
  })

  it('closes a ring instead of looping forever', () => {
    const segs: [number, number][][] = [
      [[0, 0], [1, 0]],
      [[1, 0], [1, 1]],
      [[1, 1], [0, 1]],
      [[0, 1], [0, 0]],
    ]
    const lines = stitchSegments(segs)
    expect(lines).toHaveLength(1)
    // 4 edges + the repeated closing vertex.
    expect(lines[0]).toHaveLength(5)
    expect(lines[0][0]).toEqual(lines[0][lines[0].length - 1])
  })

  it('keeps genuinely separate contours separate', () => {
    const segs: [number, number][][] = [
      [[0, 0], [1, 1]],
      [[10, 10], [11, 11]],
    ]
    expect(stitchSegments(segs)).toHaveLength(2)
  })

  it('collapses a dense grid of crossings into a handful of lines', () => {
    // The reported defect: a 10x10 grid produced 261 two-point fragments. A
    // straight contour across a 10x10 grid crosses 9 cells, so the honest answer
    // is ONE line, not nine segments.
    const segs: [number, number][][] = []
    for (let c = 0; c < 9; c++) segs.push([[c, 0.5], [c + 1, 0.5]])
    const lines = stitchSegments(segs)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveLength(10)
  })

  it('returns nothing for no input', () => {
    expect(stitchSegments([])).toEqual([])
  })
})

describe('computeContours reports lines, not raw crossings', () => {
  it('joins its own output', () => {
    // A pure west-to-east ramp: every level is one straight line spanning the grid.
    const grid = Array.from({ length: 10 }, () =>
      Array.from({ length: 10 }, (_, c) => c * 10),
    )
    const res = computeContours(grid, 20, [0, 0, 1, 1])
    expect(res.levels.length).toBeGreaterThan(0)
    // One continuous line per level, well below the crossing count.
    expect(res.totalLines).toBe(res.levels.length)
    expect(res.totalSegments).toBeGreaterThan(res.totalLines)
    for (const f of res.featureCollection.features) {
      expect(f.geometry.coordinates).toHaveLength(1)
      expect(f.geometry.coordinates[0].length).toBeGreaterThan(2)
    }
  })
})
