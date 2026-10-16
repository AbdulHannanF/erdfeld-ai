import { describe, expect, it } from 'vitest'
import { ndviBucketsFromHistogram } from '../titiler'

// ---------------------------------------------------------------------------
// ndviBucketsFromHistogram — pure function that converts a titiler histogram
// (counts + bin-edges arrays) into 5 NDVI class percentages.
// ---------------------------------------------------------------------------

/** Build a synthetic flat histogram over the range [lo, hi] with `bins` bins.
 *  All counts equal 1 so every bin has the same weight. */
function flatHistogram(bins: number, lo = -1, hi = 1): [number[], number[]] {
  const edges: number[] = []
  const step = (hi - lo) / bins
  for (let i = 0; i <= bins; i++) edges.push(lo + i * step)
  const counts = new Array(bins).fill(1)
  return [counts, edges]
}

/** Build a histogram with all mass in [peakLo, peakHi] and zeros elsewhere. */
function peakedHistogram(bins: number, peakLo: number, peakHi: number, lo = -1, hi = 1): [number[], number[]] {
  const edges: number[] = []
  const step = (hi - lo) / bins
  for (let i = 0; i <= bins; i++) edges.push(lo + i * step)
  const counts = edges.slice(0, -1).map((edge) => {
    const mid = edge + step / 2
    return mid >= peakLo && mid < peakHi ? 10 : 0
  })
  return [counts, edges]
}

describe('ndviBucketsFromHistogram', () => {
  it('always sums to exactly 100', () => {
    const [c, e] = flatHistogram(50)
    const b = ndviBucketsFromHistogram(c, e)
    const total = b.water + b.bare + b.sparse + b.moderate + b.dense
    expect(total).toBe(100)
  })

  it('returns all-dense for a histogram that peaks in dense range (>0.5)', () => {
    const [c, e] = peakedHistogram(50, 0.55, 0.85)
    const b = ndviBucketsFromHistogram(c, e)
    expect(b.dense).toBeGreaterThan(80)
    expect(b.water).toBe(0)
    expect(b.bare).toBe(0)
  })

  it('returns mostly water for a histogram that peaks in the negative range', () => {
    const [c, e] = peakedHistogram(50, -0.8, -0.1)
    const b = ndviBucketsFromHistogram(c, e)
    expect(b.water).toBeGreaterThan(70)
    expect(b.dense).toBe(0)
  })

  it('produces different distributions for dense vs. urban AOIs', () => {
    const [cDense, eDense] = peakedHistogram(50, 0.5, 0.9)
    const [cUrban, eUrban] = peakedHistogram(50, 0.0, 0.15)
    const dense = ndviBucketsFromHistogram(cDense, eDense)
    const urban = ndviBucketsFromHistogram(cUrban, eUrban)
    expect(dense.dense).toBeGreaterThan(urban.dense)
    expect(urban.bare).toBeGreaterThan(dense.bare)
  })

  it('returns all-dense for empty counts (graceful default)', () => {
    const b = ndviBucketsFromHistogram([], [])
    expect(b.dense).toBe(100)
    expect(b.water + b.bare + b.sparse + b.moderate + b.dense).toBe(100)
  })

  it('returns all-dense for all-zero counts', () => {
    const [, e] = flatHistogram(10)
    const c = new Array(10).fill(0)
    const b = ndviBucketsFromHistogram(c, e)
    expect(b.dense).toBe(100)
    expect(b.water + b.bare + b.sparse + b.moderate + b.dense).toBe(100)
  })

  it('handles a single bin spanning the entire range', () => {
    const counts = [100]
    const edges = [-1, 1]
    const b = ndviBucketsFromHistogram(counts, edges)
    // bin center is 0, which falls in the "bare" class [0, 0.15)
    expect(b.bare).toBe(100)
    expect(b.water + b.bare + b.sparse + b.moderate + b.dense).toBe(100)
  })

  it('flat 50-bin histogram: no class exceeds 50%', () => {
    const [c, e] = flatHistogram(50)
    const b = ndviBucketsFromHistogram(c, e)
    for (const v of Object.values(b)) {
      expect(v).toBeLessThanOrEqual(55)  // allow small rounding flex
    }
  })

  it('sparse vegetation AOI: sparse+moderate dominates over dense', () => {
    const [c, e] = peakedHistogram(50, 0.15, 0.45)
    const b = ndviBucketsFromHistogram(c, e)
    expect(b.sparse + b.moderate).toBeGreaterThan(b.dense)
  })

  it('rounding correction guarantees exactly 100', () => {
    // Use a histogram where rounding drift is likely (prime-count bins)
    const bins = 47
    const edges: number[] = []
    const step = 2 / bins
    for (let i = 0; i <= bins; i++) edges.push(-1 + i * step)
    const counts = Array.from({ length: bins }, (_, i) => i + 1)  // ascending ramp
    const b = ndviBucketsFromHistogram(counts, edges)
    expect(b.water + b.bare + b.sparse + b.moderate + b.dense).toBe(100)
  })
})
