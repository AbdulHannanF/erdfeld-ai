/** Pure-math tests for the `analyze_raster` operations (lib/analysis/operations.ts).
 *
 *  Everything here is offline and deterministic — synthetic fields whose correct
 *  answer is known analytically. Every assertion is written so that the WRONG
 *  implementation fails: an anisotropic field must produce different variograms
 *  along different azimuths (an omnidirectional implementation that ignores
 *  `directionDeg` fails), a perfectly correlated pair must give r = 1 exactly,
 *  a uniform field must give texture 0.
 */

import { describe, it, expect } from 'vitest'
import {
  computeStats,
  computeHistogram,
  computeVariogram,
  fitVariogramModel,
  computeTransect,
  computeCorrelation,
  computeTexture,
  computeClusters,
  computeChange,
  gridSamples,
  makeGrid,
  type AnalysisGrid,
} from '../operations'

// ---------------------------------------------------------------------------
// Grid builders
// ---------------------------------------------------------------------------

/** Build a grid from a value function of (col, row). Row 0 = north. */
function grid(
  width: number,
  height: number,
  f: (col: number, row: number) => number,
  opts: { cellM?: number; validAt?: (col: number, row: number) => boolean } = {},
): AnalysisGrid {
  const cellM = opts.cellM ?? 10
  const values = new Float64Array(width * height)
  const valid = new Uint8Array(width * height)
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const i = r * width + c
      values[i] = f(c, r)
      valid[i] = opts.validAt ? (opts.validAt(c, r) ? 1 : 0) : 1
    }
  }
  // A bbox consistent with cellM at the equator, so cellXm/cellYm round-trip.
  const dLng = (width * cellM) / 111_320
  const dLat = (height * cellM) / 110_540
  return makeGrid(values, valid, width, height, [0, 0, dLng, dLat])
}

describe('makeGrid — metric cell size from the bbox', () => {
  it('derives cellXm/cellYm from the bbox and grid shape', () => {
    const g = grid(20, 20, () => 1, { cellM: 10 })
    expect(g.cellXm).toBeCloseTo(10, 1)
    expect(g.cellYm).toBeCloseTo(10, 1)
  })
})

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

describe('computeStats', () => {
  it('computes moments and percentiles over valid pixels only', () => {
    // Values 1..100 laid out row-major; pixels > 100 marked invalid.
    const g = grid(10, 20, (c, r) => r * 10 + c + 1, {
      validAt: (c, r) => r * 10 + c + 1 <= 100,
    })
    const s = computeStats(g)!
    expect(s.count).toBe(100)
    expect(s.mean).toBeCloseTo(50.5, 6)
    expect(s.median).toBeCloseTo(50.5, 6)
    expect(s.min).toBe(1)
    expect(s.max).toBe(100)
    // Population std of 1..100 = sqrt((n^2-1)/12) = sqrt(833.25)
    expect(s.std).toBeCloseTo(Math.sqrt(833.25), 6)
    expect(s.p05).toBeCloseTo(5.95, 1)
    expect(s.p95).toBeCloseTo(95.05, 1)
  })

  it('returns null when no pixel is valid — never a number from nothing', () => {
    const g = grid(4, 4, () => 5, { validAt: () => false })
    expect(computeStats(g)).toBeNull()
  })

  it('excludes non-finite values even where the mask says valid', () => {
    const g = grid(4, 4, (c) => (c === 0 ? NaN : 2))
    const s = computeStats(g)!
    expect(s.count).toBe(12)
    expect(s.mean).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// histogram
// ---------------------------------------------------------------------------

describe('computeHistogram', () => {
  it('bins valid pixels into the requested number of equal-width bins', () => {
    // 40 pixels: 10 at 0.1, 10 at 0.3, 10 at 0.5, 10 at 0.7
    const vals = [0.1, 0.3, 0.5, 0.7]
    const g = grid(4, 10, (c) => vals[c])
    const h = computeHistogram(g, { bins: 4, range: [0, 0.8] })!
    expect(h.bins).toHaveLength(4)
    expect(h.bins.map((b) => b.value)).toEqual([10, 10, 10, 10])
    expect(h.count).toBe(40)
  })

  it('puts the maximum value in the last bin, not past the end', () => {
    const g = grid(2, 2, (c, r) => (c === 1 && r === 1 ? 1 : 0))
    const h = computeHistogram(g, { bins: 2, range: [0, 1] })!
    expect(h.bins[1].value).toBe(1)
    expect(h.count).toBe(4)
  })

  it('derives the range from the data when none is given', () => {
    const g = grid(4, 4, (c) => c)
    const h = computeHistogram(g, { bins: 4 })!
    expect(h.min).toBe(0)
    expect(h.max).toBe(3)
    expect(h.bins.reduce((a, b) => a + b.value, 0)).toBe(16)
  })
})

// ---------------------------------------------------------------------------
// variogram — the directional case is the Phase 2.5 gate
// ---------------------------------------------------------------------------

describe('computeVariogram', () => {
  /** A field striped E–W: value depends only on the row (north–south position).
   *  Along an east–west lag the value never changes → γ ≈ 0.
   *  Along a north–south lag it changes linearly → γ grows with lag. */
  const striped = () => grid(40, 40, (_c, r) => r, { cellM: 10 })

  it('is anisotropic when the field is: E–W γ ≈ 0, N–S γ large', () => {
    const g = striped()
    const { samples } = gridSamples(g, 4000)

    // A 1° tolerance admits only pairs exactly on the axis, so the expected
    // answers are exact: E–W pairs share a row (γ = 0), N–S pairs differ by
    // Δrow (γ = Δrow²/2). An implementation ignoring `directionDeg` fails both.
    const ew = computeVariogram(samples, { lagM: 40, maxLagM: 160, directionDeg: 90, toleranceDeg: 1 })
    const ns = computeVariogram(samples, { lagM: 40, maxLagM: 160, directionDeg: 0, toleranceDeg: 1 })

    expect(ew.bins.length).toBeGreaterThanOrEqual(3)
    expect(ns.bins.length).toBeGreaterThanOrEqual(3)
    for (const b of ew.bins) expect(b.semivariance).toBeLessThan(1e-9)
    // N–S: γ(h) = h²/2 in row units; at ~120 m lag (12 rows) that is ~72.
    const far = ns.bins[ns.bins.length - 1]
    expect(far.semivariance).toBeGreaterThan(10)
    expect(far.semivariance).toBeGreaterThan(ew.bins[ew.bins.length - 1].semivariance * 1000)
  })

  it('honours the requested lag width in metres', () => {
    const g = striped()
    const { samples } = gridSamples(g, 3000)
    const v = computeVariogram(samples, { lagM: 40, maxLagM: 200 })
    expect(v.lagWidthM).toBe(40)
    // Bin centres at 20, 60, 100, 140, 180 m.
    expect(v.bins.map((b) => b.lag_m)).toEqual([20, 60, 100, 140, 180])
  })

  it('omnidirectional (direction null) mixes both axes — between the two', () => {
    const g = striped()
    const { samples } = gridSamples(g, 4000)
    const omni = computeVariogram(samples, { lagM: 40, maxLagM: 160, directionDeg: null })
    const ns = computeVariogram(samples, { lagM: 40, maxLagM: 160, directionDeg: 0, toleranceDeg: 15 })
    const last = omni.bins[omni.bins.length - 1].semivariance
    expect(last).toBeGreaterThan(0)
    expect(last).toBeLessThan(ns.bins[ns.bins.length - 1].semivariance)
  })

  it('treats a direction and its reciprocal as the same lag axis', () => {
    const g = striped()
    const { samples } = gridSamples(g, 2000)
    const a = computeVariogram(samples, { lagM: 40, maxLagM: 160, directionDeg: 45, toleranceDeg: 20 })
    const b = computeVariogram(samples, { lagM: 40, maxLagM: 160, directionDeg: 225, toleranceDeg: 20 })
    expect(b.bins.map((x) => x.pairs)).toEqual(a.bins.map((x) => x.pairs))
  })

  it('reports no bins rather than guessing when there are too few samples', () => {
    const g = grid(4, 4, () => 1)
    const { samples } = gridSamples(g, 100)
    const v = computeVariogram(samples, { lagM: 10, maxLagM: 40 })
    expect(v.bins).toHaveLength(0)
    expect(v.tooFewSamples).toBe(true)
  })
})

describe('fitVariogramModel', () => {
  /** Bins generated from a known spherical model — the fit must recover it. */
  function sphericalBins(nugget: number, sill: number, range: number) {
    const bins: Array<{ lag_m: number; semivariance: number; pairs: number }> = []
    for (let h = 10; h <= 300; h += 10) {
      const r = Math.min(h / range, 1)
      const g = nugget + (sill - nugget) * (1.5 * r - 0.5 * r * r * r)
      bins.push({ lag_m: h, semivariance: g, pairs: 1000 })
    }
    return bins
  }

  it('recovers the parameters of a synthetic spherical variogram', () => {
    const fit = fitVariogramModel(sphericalBins(0.02, 0.5, 150), 'spherical')!
    expect(fit.model).toBe('spherical')
    expect(fit.nugget).toBeCloseTo(0.02, 2)
    expect(fit.sill).toBeCloseTo(0.5, 2)
    expect(fit.range_m).toBeGreaterThan(135)
    expect(fit.range_m).toBeLessThan(165)
    expect(fit.rmse).toBeLessThan(0.01)
  })

  it('auto picks the model with the lowest RMSE and reports which', () => {
    const fit = fitVariogramModel(sphericalBins(0.02, 0.5, 150), 'auto')!
    expect(fit.model).toBe('spherical')
    expect(fit.rmse).toBeLessThan(0.01)
  })

  it('fits an exponential shape better with the exponential model', () => {
    const bins: Array<{ lag_m: number; semivariance: number; pairs: number }> = []
    for (let h = 10; h <= 300; h += 10) {
      bins.push({ lag_m: h, semivariance: 0.05 + 0.4 * (1 - Math.exp(-3 * h / 120)), pairs: 500 })
    }
    const exp = fitVariogramModel(bins, 'exponential')!
    const sph = fitVariogramModel(bins, 'spherical')!
    expect(exp.rmse).toBeLessThan(sph.rmse)
    expect(fitVariogramModel(bins, 'auto')!.model).toBe('exponential')
  })

  it('never reports a negative nugget or sill', () => {
    const bins = [
      { lag_m: 10, semivariance: 0.5, pairs: 10 },
      { lag_m: 20, semivariance: 0.3, pairs: 10 },
      { lag_m: 30, semivariance: 0.1, pairs: 10 },
      { lag_m: 40, semivariance: 0.05, pairs: 10 },
    ]
    const fit = fitVariogramModel(bins, 'spherical')!
    expect(fit.nugget).toBeGreaterThanOrEqual(0)
    expect(fit.sill).toBeGreaterThanOrEqual(0)
  })

  it('returns null with too few bins to constrain a model', () => {
    expect(fitVariogramModel([{ lag_m: 10, semivariance: 1, pairs: 5 }], 'spherical')).toBeNull()
  })

  // DEFECT 1 (2026-08-17): `analyze_raster({operation:"variogram", max_lag_m:2000})`
  // reported a fitted range of 2301 m — larger than the 2000 m window it was
  // fitted over. The search domain for the range parameter used to run up to
  // 1.5x the largest sampled lag, so a field that never plateaued within the
  // window could push the least-squares optimum past it. A range is not
  // identifiable beyond the largest lag you actually paired pixels at, so the
  // fix bounds the search AT the sampled window and flags (rather than hides)
  // the case where the optimum lands on that boundary.
  describe('the range cannot exceed the sampled window', () => {
    it('never reports a range beyond the largest sampled lag, even for a field that never plateaus', () => {
      // Semivariance rising in a straight, unplateaued line all the way to the
      // edge of the window — the exact shape that used to be extrapolated past
      // max_lag_m.
      const bins: Array<{ lag_m: number; semivariance: number; pairs: number }> = []
      for (let h = 100; h <= 2000; h += 100) {
        bins.push({ lag_m: h, semivariance: 0.001 * h, pairs: 200 })
      }
      const fit = fitVariogramModel(bins, 'spherical')!
      expect(fit.range_m).toBeLessThanOrEqual(bins[bins.length - 1].lag_m)
      // The optimiser wanted to keep climbing past the window — that must be
      // flagged, not silently reported as a resolved measurement.
      expect(fit.rangeAtWindowLimit).toBe(true)
    })

    it('does not flag a range that genuinely plateaus well inside the window', () => {
      const fit = fitVariogramModel(sphericalBins(0.02, 0.5, 150), 'spherical')!
      expect(fit.range_m).toBeLessThan(300) // well inside the 10..300 m sampled window
      expect(fit.rangeAtWindowLimit).toBe(false)
    })

    it('bounds every candidate model under "auto" to the sampled window', () => {
      const bins: Array<{ lag_m: number; semivariance: number; pairs: number }> = []
      for (let h = 100; h <= 2000; h += 100) {
        bins.push({ lag_m: h, semivariance: 0.001 * h, pairs: 200 })
      }
      const fit = fitVariogramModel(bins, 'auto')!
      expect(fit.range_m).toBeLessThanOrEqual(bins[bins.length - 1].lag_m)
    })
  })
})

// ---------------------------------------------------------------------------
// transect
// ---------------------------------------------------------------------------

describe('computeTransect', () => {
  it('profiles a west→east line across a west→east ramp', () => {
    const g = grid(20, 20, (c) => c, { cellM: 10 })
    const [minLng, minLat, maxLng, maxLat] = g.bbox
    const midLat = (minLat + maxLat) / 2
    const t = computeTransect(g, [[minLng, midLat], [maxLng, midLat]], 21)
    expect(t.points.length).toBeGreaterThan(15)
    expect(t.points[0].value).toBeLessThan(t.points[t.points.length - 1].value)
    // Monotonic non-decreasing along the ramp.
    for (let i = 1; i < t.points.length; i++) {
      expect(t.points[i].value).toBeGreaterThanOrEqual(t.points[i - 1].value)
    }
    expect(t.length_m).toBeCloseTo(200, -1)
  })

  it('reads a north→south line as decreasing when the field increases southward', () => {
    // Row 0 = north; value grows with row, so going south the value grows.
    const g = grid(20, 20, (_c, r) => r, { cellM: 10 })
    const [minLng, minLat, maxLng, maxLat] = g.bbox
    const midLng = (minLng + maxLng) / 2
    const t = computeTransect(g, [[midLng, maxLat], [midLng, minLat]], 21)
    expect(t.points[0].value).toBeLessThan(t.points[t.points.length - 1].value)
  })

  it('skips samples that fall on invalid pixels and says how many', () => {
    const g = grid(20, 20, (c) => c, { validAt: (c) => c < 10 })
    const [minLng, minLat, maxLng, maxLat] = g.bbox
    const midLat = (minLat + maxLat) / 2
    const t = computeTransect(g, [[minLng, midLat], [maxLng, midLat]], 21)
    expect(t.skipped).toBeGreaterThan(5)
    expect(t.points.every((p) => p.value < 10)).toBe(true)
  })

  it('follows a multi-vertex line and accumulates distance across segments', () => {
    const g = grid(20, 20, (c) => c, { cellM: 10 })
    const [minLng, minLat, maxLng, maxLat] = g.bbox
    const t = computeTransect(
      g,
      [[minLng, minLat], [maxLng, minLat], [maxLng, maxLat]],
      41,
    )
    expect(t.length_m).toBeGreaterThan(350)
    expect(t.points[t.points.length - 1].distance_m).toBeGreaterThan(300)
  })
})

// ---------------------------------------------------------------------------
// correlate
// ---------------------------------------------------------------------------

describe('computeCorrelation', () => {
  it('returns r = 1 and the true slope for a perfect linear relation', () => {
    const a = grid(10, 10, (c, r) => r * 10 + c)
    const b = grid(10, 10, (c, r) => 2 * (r * 10 + c) + 3)
    const out = computeCorrelation(a, b)!
    expect(out.pearson).toBeCloseTo(1, 10)
    expect(out.slope).toBeCloseTo(2, 8)
    expect(out.intercept).toBeCloseTo(3, 6)
    expect(out.n).toBe(100)
  })

  it('returns r = −1 for a perfect inverse relation', () => {
    const a = grid(10, 10, (c, r) => r * 10 + c)
    const b = grid(10, 10, (c, r) => -(r * 10 + c))
    expect(computeCorrelation(a, b)!.pearson).toBeCloseTo(-1, 10)
  })

  it('uses only pixels valid in BOTH grids', () => {
    const a = grid(10, 10, (c, r) => r * 10 + c, { validAt: (c) => c < 5 })
    const b = grid(10, 10, (c, r) => r * 10 + c, { validAt: (_c, r) => r < 5 })
    expect(computeCorrelation(a, b)!.n).toBe(25)
  })

  it('gives near-zero r for an independent pair', () => {
    const a = grid(20, 20, (c) => c % 2)
    const b = grid(20, 20, (_c, r) => (r < 10 ? 0 : 1))
    expect(Math.abs(computeCorrelation(a, b)!.pearson)).toBeLessThan(1e-9)
  })

  it('refuses mismatched grid shapes rather than comparing unaligned pixels', () => {
    const a = grid(10, 10, () => 1)
    const b = grid(8, 10, () => 1)
    expect(() => computeCorrelation(a, b)).toThrow(/shape/i)
  })

  it('ranks monotone-but-nonlinear data at Spearman 1', () => {
    const a = grid(10, 10, (c, r) => r * 10 + c)
    const b = grid(10, 10, (c, r) => Math.exp((r * 10 + c) / 40))
    const out = computeCorrelation(a, b)!
    expect(out.spearman).toBeCloseTo(1, 6)
    expect(out.pearson).toBeLessThan(0.99)
  })
})

// ---------------------------------------------------------------------------
// texture
// ---------------------------------------------------------------------------

describe('computeTexture', () => {
  it('is exactly zero on a uniform field', () => {
    const g = grid(20, 20, () => 0.42)
    const t = computeTexture(g, { window: 3, metric: 'stddev' })!
    expect(t.stats.mean).toBeCloseTo(0, 12)
    expect(t.stats.max).toBeCloseTo(0, 12)
  })

  it('is high on a checkerboard and higher than on a smooth ramp', () => {
    const checker = grid(20, 20, (c, r) => ((c + r) % 2 === 0 ? 0 : 1))
    const ramp = grid(20, 20, (c) => c / 20)
    const tc = computeTexture(checker, { window: 3, metric: 'stddev' })!
    const tr = computeTexture(ramp, { window: 3, metric: 'stddev' })!
    expect(tc.stats.mean).toBeGreaterThan(0.4)
    expect(tc.stats.mean).toBeGreaterThan(tr.stats.mean * 5)
  })

  it('range metric equals max−min inside the window', () => {
    const g = grid(9, 9, (c) => c)
    const t = computeTexture(g, { window: 3, metric: 'range' })!
    // Interior windows span 3 consecutive columns → range 2.
    expect(t.stats.median).toBeCloseTo(2, 6)
  })

  it('skips windows with too few valid neighbours instead of inventing a value', () => {
    const g = grid(10, 10, (c) => c, { validAt: (c, r) => c === 0 && r === 0 })
    expect(computeTexture(g, { window: 3, metric: 'stddev' })).toBeNull()
  })

  it('rejects an even window size', () => {
    const g = grid(10, 10, () => 1)
    expect(() => computeTexture(g, { window: 4, metric: 'stddev' })).toThrow(/odd/i)
  })
})

// ---------------------------------------------------------------------------
// cluster
// ---------------------------------------------------------------------------

describe('computeClusters', () => {
  it('separates two well-separated value groups', () => {
    const g = grid(20, 20, (_c, r) => (r < 10 ? 0.1 : 0.9))
    const out = computeClusters([g], 2)!
    expect(out.sizes.reduce((a, b) => a + b, 0)).toBe(400)
    expect(out.sizes.sort((a, b) => a - b)).toEqual([200, 200])
    const centers = out.centroids.map((c) => c[0]).sort((a, b) => a - b)
    expect(centers[0]).toBeCloseTo(0.1, 6)
    expect(centers[1]).toBeCloseTo(0.9, 6)
  })

  it('is deterministic — identical input gives identical assignments', () => {
    const g = grid(20, 20, (c, r) => Math.sin(c) + Math.cos(r))
    const a = computeClusters([g], 3)!
    const b = computeClusters([g], 3)!
    expect(Array.from(a.assignments)).toEqual(Array.from(b.assignments))
    expect(a.centroids).toEqual(b.centroids)
  })

  it('clusters on two bands jointly', () => {
    const x = grid(20, 20, (c) => (c < 10 ? 0 : 1))
    const y = grid(20, 20, (_c, r) => (r < 10 ? 0 : 1))
    const out = computeClusters([x, y], 4)!
    expect(out.sizes.sort((a, b) => a - b)).toEqual([100, 100, 100, 100])
  })

  it('returns fewer clusters than asked rather than empty ones, and says so', () => {
    const g = grid(10, 10, () => 0.5)
    const out = computeClusters([g], 4)!
    expect(out.centroids.length).toBeLessThan(4)
    expect(out.sizes.reduce((a, b) => a + b, 0)).toBe(100)
  })

  it('returns null when no pixel is valid in every band', () => {
    const a = grid(10, 10, () => 1, { validAt: (c) => c < 5 })
    const b = grid(10, 10, () => 1, { validAt: (c) => c >= 5 })
    expect(computeClusters([a, b], 2)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// change
// ---------------------------------------------------------------------------

describe('computeChange', () => {
  it('reports the per-pixel delta and the fraction that moved', () => {
    const before = grid(10, 10, () => 0.5)
    const after = grid(10, 10, (_c, r) => (r < 5 ? 0.5 : 0.2))
    const out = computeChange(before, after, { threshold: 0.05 })!
    expect(out.stats.mean).toBeCloseTo(-0.15, 6)
    expect(out.decreasedPct).toBeCloseTo(50, 6)
    expect(out.increasedPct).toBeCloseTo(0, 6)
    expect(out.unchangedPct).toBeCloseTo(50, 6)
  })

  it('uses only pixels clear in BOTH dates', () => {
    const before = grid(10, 10, () => 0.5, { validAt: (c) => c < 6 })
    const after = grid(10, 10, () => 0.8, { validAt: (c) => c >= 2 })
    const out = computeChange(before, after)!
    expect(out.stats.count).toBe(40)
    expect(out.stats.mean).toBeCloseTo(0.3, 6)
  })

  it('returns null when the dates share no clear pixel', () => {
    const before = grid(10, 10, () => 0.5, { validAt: (c) => c < 5 })
    const after = grid(10, 10, () => 0.8, { validAt: (c) => c >= 5 })
    expect(computeChange(before, after)).toBeNull()
  })

  it('can restrict the change to ground that had the property before, and says how much that is', () => {
    // 100 pixels: the left 40 columns-worth were vegetated (0.5) and dropped to 0.1; the rest were built (0.0) and did not move.
    const before = grid(10, 10, (c) => (c < 4 ? 0.5 : 0.0))
    const after = grid(10, 10, (c) => (c < 4 ? 0.1 : 0.0))
    const whole = computeChange(before, after, { threshold: 0.1 })!
    const burnable = computeChange(before, after, { threshold: 0.1, baselineMin: 0.15 })!
    expect(whole.stats.mean).toBeCloseTo(-0.16, 6)
    expect(burnable.stats.mean).toBeCloseTo(-0.4, 6)
    expect(burnable.stats.count).toBe(40)
    expect(burnable.clearBoth).toBe(100)
    expect(burnable.decreasedPct).toBeCloseTo(100, 6)
  })

  it('refuses a restricted change that rests on too few pixels, and says why', () => {
    const before = grid(10, 10, (c, r) => (c === 0 && r < 5 ? 0.5 : 0.0))
    const after = grid(10, 10, () => 0.0)
    expect(() => computeChange(before, after, { baselineMin: 0.15 })).toThrow(/only 5 of 100 pixels.*fewer than 30/)
    expect(() => computeChange(grid(10, 10, () => 0.0), after, { baselineMin: 0.15 })).toThrow(/none of the 100 pixels/)
  })
})

// ---------------------------------------------------------------------------
// gridSamples
// ---------------------------------------------------------------------------

describe('gridSamples', () => {
  it('places samples in metric coordinates with north up', () => {
    const g = grid(3, 3, (c, r) => r * 3 + c, { cellM: 10 })
    const { samples, validCount } = gridSamples(g, 100)
    expect(validCount).toBe(9)
    // Value 0 is at col 0, row 0 (north-west) → x 0, y (height-1)*cell = 20.
    const nw = samples.find((s) => s.v === 0)!
    expect(nw.x).toBeCloseTo(0, 6)
    expect(nw.y).toBeCloseTo(20, 0)
  })

  it('thins deterministically above the sample cap', () => {
    const g = grid(50, 50, (c, r) => c + r)
    const a = gridSamples(g, 300)
    const b = gridSamples(g, 300)
    expect(a.samples.length).toBe(300)
    expect(a.validCount).toBe(2500)
    expect(a.samples.map((s) => s.v)).toEqual(b.samples.map((s) => s.v))
  })
})
