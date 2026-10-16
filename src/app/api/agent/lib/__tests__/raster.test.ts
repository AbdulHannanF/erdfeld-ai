import { describe, expect, it } from 'vitest'
import { bilinearInterp, elevToRgb, ndviToRgb, sarToRgb, seededNoise } from '../raster'

describe('ndviToRgb', () => {
  it('maps very low NDVI (<0) to blue (water)', () => {
    expect(ndviToRgb(-0.5)).toEqual([0, 0, 255])
  })

  it('maps high NDVI (≥0.7) to dark green', () => {
    expect(ndviToRgb(0.9)).toEqual([0, 100, 0])
  })

  it('maps moderate NDVI (0.4) to yellow-green', () => {
    expect(ndviToRgb(0.4)).toEqual([154, 205, 50])
  })

  it('returns a 3-tuple for any input', () => {
    const rgb = ndviToRgb(0)
    expect(rgb).toHaveLength(3)
  })
})

describe('elevToRgb', () => {
  it('returns the lowest stop for t=0', () => {
    expect(elevToRgb(0)).toEqual([49, 54, 149])
  })

  it('returns the highest stop for t=1', () => {
    expect(elevToRgb(1)).toEqual([165, 0, 38])
  })

  it('clamps inputs below 0', () => {
    expect(elevToRgb(-1)).toEqual([49, 54, 149])
  })

  it('clamps inputs above 1', () => {
    expect(elevToRgb(2)).toEqual([165, 0, 38])
  })

  it('interpolates between stops', () => {
    const mid = elevToRgb(0.5)
    expect(mid).toEqual([254, 224, 144])
  })
})

describe('sarToRgb', () => {
  it('maps near-zero backscatter to dark navy (water/flood)', () => {
    expect(sarToRgb(0.01)).toEqual([10, 10, 50])
  })

  it('maps high backscatter to near-white (urban double-bounce)', () => {
    expect(sarToRgb(0.9)).toEqual([225, 220, 205])
  })
})

describe('bilinearInterp', () => {
  it('preserves grid corner values (with row flip — output row 0 = north)', () => {
    const grid = [
      [0, 1],   // south row in source
      [10, 11], // north row in source
    ]
    const out = bilinearInterp(grid, 2, 2, 2, 2)
    // PNG row 0 = north → top-left = north-west corner of source = grid[1][0]
    expect(out[0][0]).toBeCloseTo(10)
    expect(out[0][1]).toBeCloseTo(11)
    expect(out[1][0]).toBeCloseTo(0)
    expect(out[1][1]).toBeCloseTo(1)
  })

  it('produces output of the requested dimensions', () => {
    const grid = [[0, 1], [2, 3]]
    const out = bilinearInterp(grid, 2, 2, 5, 7)
    expect(out).toHaveLength(5)
    expect(out[0]).toHaveLength(7)
  })
})

describe('seededNoise', () => {
  it('is deterministic for the same seed', () => {
    const a = seededNoise(42, 10)
    const b = seededNoise(42, 10)
    expect(a).toEqual(b)
  })

  it('produces different sequences for different seeds', () => {
    const a = seededNoise(1, 10)
    const b = seededNoise(2, 10)
    expect(a).not.toEqual(b)
  })

  it('returns the requested count of samples', () => {
    expect(seededNoise(7, 25)).toHaveLength(25)
  })

  it('produces values in [0,1)', () => {
    for (const v of seededNoise(99, 100)) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})
