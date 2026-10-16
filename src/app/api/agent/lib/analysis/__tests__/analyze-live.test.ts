/**
 * LIVE `analyze_raster` verification (opt-in: ANALYZE_LIVE=1).
 *
 * Hits AWS Earth Search + titiler.xyz for real Sentinel-2 pixels. NOT part of
 * the default suite.
 *
 *   ANALYZE_LIVE=1 npx vitest run analyze-live
 *
 * The Phase 2.5 gate is here: "give me a directional variogram of NDWI at 40 m
 * lags" must actually work — the requested lag width must come back as 40, the
 * requested azimuth must come back as the azimuth, and two perpendicular
 * azimuths over real ground must NOT produce the same curve (an implementation
 * that silently ignores `direction_deg` passes every other check).
 *
 * Assertions are written so a wrong answer fails. "It returned something" is
 * never enough — see ISS-122.
 */

import { describe, it, expect } from 'vitest'
import { executeTool } from '../../../tools'

const LIVE = !!process.env.ANALYZE_LIVE
const suite = LIVE ? describe : describe.skip

/** Irrigated Nile floodplain beside desert at Luxor, Egypt — ~4 x 4.4 km.
 *  Chosen because it is reliably CLOUD-FREE (so the gate cannot be satisfied by
 *  an honest refusal) and strongly anisotropic: field strips run with the river,
 *  desert runs across it. Anisotropy is the property the gate exists to prove. */
const AOI = {
  type: 'Polygon',
  coordinates: [[[32.62, 25.68], [32.66, 25.68], [32.66, 25.72], [32.62, 25.72], [32.62, 25.68]]],
}

/** The Phase 0 audit AOI — Lahore, 16.9 km². Used only for the cloud-refusal case. */
const LAHORE = {
  type: 'Polygon',
  coordinates: [[[74.30, 31.50], [74.36, 31.50], [74.36, 31.56], [74.30, 31.56], [74.30, 31.50]]],
}

const sd = (r: any) => (r.stats ?? {}) as Record<string, any>
const degraded = (r: any) => String(r.summary).startsWith('Real data unavailable')

/** A degraded live result is acceptable (upstream can be down or clouded) but it
 *  must be EXPLICIT — never an empty success carrying numbers. */
function assertHonestDegrade(r: any, what: string) {
  console.warn(`live ${what} degraded:`, String(r.summary).slice(0, 260))
  expect(r.stats).toBeUndefined()
  expect(r.layers).toHaveLength(0)
}

suite('LIVE analyze_raster — real cloud-masked Sentinel-2 pixels', () => {
  it('GATE: a directional NDWI variogram at 40 m lags returns what was asked for', async () => {
    const r = await executeTool('analyze_raster', AOI, {
      operation: 'variogram',
      index: 'NDWI',
      lag_m: 40,
      max_lag_m: 800,
      direction_deg: 45,
      tolerance_deg: 20,
    })
    // No degrade escape: this AOI is chosen to be clear, so a refusal here IS a
    // failure. An assertion that accepts both outcomes cannot prove the gate.
    expect(degraded(r)).toBe(false)

    const d = sd(r)
    console.log('directional NDWI variogram:', {
      lag_width_m: d.lag_width_m, direction_deg: d.direction_deg, tolerance_deg: d.tolerance_deg,
      bins: d.lag_bins, pairs: d.pairs, model: d.model, range_m: d.range_m,
      nugget: d.nugget, sill: d.sill, pixel_size_m: d.pixel_size_m, scene: d.scene_date,
    })

    // The parameters the user asked for are the parameters that were used.
    expect(d.lag_width_m).toBe(40)
    expect(d.direction_deg).toBe(45)
    expect(d.tolerance_deg).toBe(20)
    expect(d.index).toBe('NDWI')

    // Bin centres must sit at (b + 0.5) × 40 m — 20, 60, 100, …
    const bins = d.semivariogram as Array<{ label: string; value: number }>
    expect(Array.isArray(bins)).toBe(true)
    expect(bins.length).toBeGreaterThanOrEqual(4)
    for (const b of bins) expect((Number(b.label) - 20) % 40).toBe(0)
    for (const b of bins) expect(b.value).toBeGreaterThanOrEqual(0)
    expect(Number(d.pairs)).toBeGreaterThan(1000)

    // A fitted model must be physically ordered: 0 ≤ nugget ≤ sill.
    if (d.model) {
      expect(d.nugget).toBeGreaterThanOrEqual(0)
      expect(d.sill).toBeGreaterThanOrEqual(d.nugget)
      expect(d.range_m).toBeGreaterThan(0)
    }
    expect(r.summary).toMatch(/45° axis/)
  }, 180_000)

  it('GATE: perpendicular azimuths give DIFFERENT curves on real ground', async () => {
    const [ns, ew] = await Promise.all([
      executeTool('analyze_raster', AOI, {
        operation: 'variogram', index: 'NDVI', lag_m: 40, max_lag_m: 800,
        direction_deg: 0, tolerance_deg: 20,
      }),
      executeTool('analyze_raster', AOI, {
        operation: 'variogram', index: 'NDVI', lag_m: 40, max_lag_m: 800,
        direction_deg: 90, tolerance_deg: 20,
      }),
    ])
    expect(degraded(ns)).toBe(false)
    expect(degraded(ew)).toBe(false)

    const a = sd(ns).semivariogram as Array<{ label: string; value: number }>
    const b = sd(ew).semivariogram as Array<{ label: string; value: number }>
    console.log('N–S γ:', a.slice(0, 6).map((x) => x.value))
    console.log('E–W γ:', b.slice(0, 6).map((x) => x.value))
    console.log('ranges:', sd(ns).range_m, 'vs', sd(ew).range_m)

    // The two directions may drop different sparse low-lag bins (a narrow cone
    // holds fewer pairs at short lags), so compare on the lags they share. On
    // those, the curves must DIFFER — if `direction_deg` were ignored they
    // would be identical value for value.
    const byLag = new Map(b.map((x) => [x.label, x.value]))
    const shared = a.filter((x) => byLag.has(x.label))
    expect(shared.length).toBeGreaterThanOrEqual(6)
    expect(shared.map((x) => x.value)).not.toEqual(shared.map((x) => byLag.get(x.label)))
    // And they must differ substantially, not in the last decimal.
    const maxRelDiff = Math.max(
      ...shared.map((x) => Math.abs(x.value - byLag.get(x.label)!) / Math.max(1e-9, x.value)),
    )
    console.log('max relative γ difference between azimuths:', maxRelDiff.toFixed(3))
    expect(maxRelDiff).toBeGreaterThan(0.05)
    // Both must still be real variograms, not noise.
    expect(Number(sd(ns).pairs)).toBeGreaterThan(1000)
    expect(Number(sd(ew).pairs)).toBeGreaterThan(1000)
  }, 180_000)

  it('refuses a lag finer than the pixel it would need, and names the pixel size', async () => {
    const r = await executeTool('analyze_raster', AOI, {
      operation: 'variogram', index: 'NDVI', lag_m: 2, max_size: 64,
    })
    console.log('sub-pixel lag refusal:', String(r.summary).slice(0, 220))
    expect(degraded(r)).toBe(true)
    expect(r.summary).toMatch(/finer than/)
    expect(r.summary).toMatch(/10 m/)   // Sentinel-2's own floor is stated
    expect(r.stats).toBeUndefined()
  }, 120_000)

  it('stats report cloud-masked ground, not the −0.072 cloud-top artefact', async () => {
    const r = await executeTool('analyze_raster', AOI, { operation: 'stats', index: 'NDVI' })
    if (degraded(r)) return assertHonestDegrade(r, 'stats')
    const d = sd(r)
    console.log('NDVI stats:', {
      mean: d.mean, median: d.median, std: d.std, p05: d.p05, p95: d.p95,
      clear_pct: d.clear_pct, clear_pixels: d.clear_pixels, in_polygon: d.in_polygon_pixels,
      pixel_size_m: d.pixel_size_m, scene: d.scene_date,
    })
    expect(Number(d.clear_pct)).toBeGreaterThanOrEqual(40)
    expect(Number(d.clear_pixels)).toBeGreaterThan(1000)
    expect(Number(d.mean)).toBeGreaterThan(-0.05)   // the ISS-101 artefact was −0.072
    expect(Number(d.mean)).toBeLessThan(1)
    expect(Number(d.p05)).toBeLessThanOrEqual(Number(d.median))
    expect(Number(d.median)).toBeLessThanOrEqual(Number(d.p95))
    // At the default max_size the read must be far finer than the 96-px stats path.
    expect(Number(d.pixel_size_m)).toBeLessThan(40)
  }, 180_000)

  it('the histogram totals the same clear pixels the stats used', async () => {
    const [s, h] = await Promise.all([
      executeTool('analyze_raster', AOI, { operation: 'stats', index: 'NDVI' }),
      executeTool('analyze_raster', AOI, { operation: 'histogram', index: 'NDVI', bins: 12 }),
    ])
    if (degraded(s) || degraded(h)) return assertHonestDegrade(degraded(s) ? s : h, 'histogram')
    const dist = sd(h).distribution as Array<{ label: string; value: number }>
    const total = dist.reduce((a, b) => a + b.value, 0)
    console.log('histogram bins:', dist.length, 'total px:', total, 'stats count:', sd(s).clear_pixels)
    expect(dist.length).toBe(12)
    expect(total).toBe(Number(sd(h).count))
    expect(Number(sd(h).count)).toBe(Number(sd(s).clear_pixels))
  }, 180_000)

  it('NDVI and NDBI are negatively correlated where irrigated fields meet desert', async () => {
    const r = await executeTool('analyze_raster', AOI, {
      operation: 'correlate', index: 'NDVI', index2: 'NDBI',
    })
    if (degraded(r)) return assertHonestDegrade(r, 'correlate')
    const d = sd(r)
    console.log('NDVI vs NDBI:', {
      r: d.pearson_r, rho: d.spearman_rho, slope: d.slope, n: d.pixels, scene: d.scene_date,
    })
    // Vegetation index vs built-up index: physically these must oppose.
    expect(Number(d.pearson_r)).toBeLessThan(-0.3)
    expect(Number(d.pearson_r)).toBeGreaterThanOrEqual(-1)
    expect(Number(d.pixels)).toBeGreaterThan(1000)
    expect(Number(d.slope)).toBeLessThan(0)
  }, 240_000)

  it('a transect across the AOI returns a real profile with gaps left as gaps', async () => {
    const r = await executeTool('analyze_raster', AOI, {
      operation: 'transect', index: 'NDVI',
      line: [[32.625, 25.685], [32.655, 25.715]],
      samples: 60,
    })
    if (degraded(r)) return assertHonestDegrade(r, 'transect')
    const d = sd(r)
    const profile = d.profile as Array<{ label: string; value: number }>
    console.log('transect:', { length_m: d.length_m, samples: d.samples, skipped: d.skipped })
    expect(Number(d.length_m)).toBeGreaterThan(4000)
    expect(Number(d.length_m)).toBeLessThan(6000)
    expect(profile.length).toBeGreaterThan(20)
    expect(Number(d.samples) + Number(d.skipped)).toBe(60)
    // Distances must ascend along the line.
    for (let i = 1; i < profile.length; i++) {
      expect(Number(profile[i].label)).toBeGreaterThan(Number(profile[i - 1].label))
    }
  }, 180_000)

  it('texture returns a rendered layer and a scale in metres', async () => {
    const r = await executeTool('analyze_raster', AOI, {
      operation: 'texture', index: 'NDVI', window: 5, metric: 'stddev',
    })
    if (degraded(r)) return assertHonestDegrade(r, 'texture')
    const d = sd(r)
    console.log('texture:', { mean: d.mean, p95: d.p95, window_m: d.window_m, windows: d.windows })
    expect(Number(d.window_px)).toBe(5)
    expect(Number(d.window_m)).toBeGreaterThan(0)
    expect(Number(d.mean)).toBeGreaterThan(0)
    expect(r.layers[0]?.imageBase64?.length ?? 0).toBeGreaterThan(500)
    expect(r.layers[0]?.bounds).toBeDefined()
  }, 180_000)

  it('cluster zones partition exactly the clear pixels', async () => {
    const r = await executeTool('analyze_raster', AOI, {
      operation: 'cluster', indices: ['NDVI', 'NDBI'], k: 4,
    })
    if (degraded(r)) return assertHonestDegrade(r, 'cluster')
    const d = sd(r)
    const zones = d.zone_sizes as Array<{ label: string; value: number }>
    const total = zones.reduce((a, b) => a + b.value, 0)
    console.log('zones:', zones, 'k returned:', d.k_returned, 'px:', d.pixels)
    expect(Number(d.k_returned)).toBeGreaterThanOrEqual(2)
    expect(Number(d.k_returned)).toBeLessThanOrEqual(4)
    expect(zones.length).toBe(Number(d.k_returned))
    expect(total).toBeGreaterThan(99.4)
    expect(total).toBeLessThan(100.6)
    expect(r.layers[0]?.imageBase64?.length ?? 0).toBeGreaterThan(500)
  }, 300_000)

  it('refuses over a clouded AOI instead of reporting cloud-top structure', async () => {
    // Lahore in monsoon season. The point is the SHAPE of the answer: an
    // analysis is not attempted on a polygon whose every candidate scene is
    // clouded, and the refusal names how the scenes were scored.
    const r = await executeTool('analyze_raster', LAHORE, {
      operation: 'variogram', index: 'NDVI', lag_m: 40,
    })
    console.log('clouded AOI:', String(r.summary).slice(0, 200))
    if (!degraded(r)) {
      // The AOI cleared — then it must be a real result, not a hollow one.
      expect(Number(sd(r).pairs)).toBeGreaterThan(1000)
      return
    }
    expect(r.summary).toMatch(/cloud/i)
    expect(r.summary).toMatch(/polygon/i)
    expect(r.stats).toBeUndefined()
  }, 180_000)

  it('an unsupported index is refused by name rather than silently substituted', async () => {
    const r = await executeTool('analyze_raster', AOI, { operation: 'stats', index: 'NDXX' })
    expect(degraded(r)).toBe(true)
    expect(r.summary).toContain('NDXX')
    expect(r.stats).toBeUndefined()
  }, 60_000)
})
