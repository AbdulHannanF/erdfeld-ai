import { describe, it, expect } from 'vitest'
import {
  CHANGE, FALLBACK_THRESHOLD_DB, WATER_DB_MAX, WATER_DB_MIN, chooseWaterThreshold, classifyChange, cleanMask, linearToDb,
  medianFilter3, otsu, dbHistogram, waterFraction, waterMask,
} from '../sar'
import { MIN_COVERAGE_PCT, pickPair, groupScenes, nearestLike, platformName, type S1Scene, type SeriesPoint } from '../scenes'

/** Deterministic PRNG (mulberry32) so synthetic noise is reproducible. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r())
}

/** A W x H dB grid: columns < waterCols are water N(wMu, wSd), the rest land N(lMu, lSd). */
function scene(W: number, H: number, waterCols: number, o: { wMu?: number; wSd?: number; lMu?: number; lSd?: number; seed?: number } = {}) {
  const { wMu = -22, wSd = 1.2, lMu = -10, lSd = 1.5, seed = 1 } = o
  const r = rng(seed)
  const db = new Float32Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) db[y * W + x] = x < waterCols ? wMu + wSd * gauss(r) : lMu + lSd * gauss(r)
  return db
}

describe('linearToDb', () => {
  it('converts linear power to dB and refuses nodata', () => {
    const grid = { values: Float64Array.from([0.01, 0.1, 1, 0, -5, 0.5]), mask: Float64Array.from([255, 255, 255, 255, 255, 0]), width: 6, height: 1 }
    const db = linearToDb(grid)
    expect(db[0]).toBeCloseTo(-20, 5)
    expect(db[1]).toBeCloseTo(-10, 5)
    expect(db[2]).toBeCloseTo(0, 5)
    expect(Number.isNaN(db[3])).toBe(true) // zero is nodata, never -inf
    expect(Number.isNaN(db[4])).toBe(true)
    expect(Number.isNaN(db[5])).toBe(true) // outside the polygon
  })
})

describe('medianFilter3', () => {
  it('removes speckle outliers, keeps a clean edge, ignores NaN neighbours', () => {
    const W = 8, H = 8
    const src = new Float32Array(W * H).fill(-10)
    for (let y = 0; y < H; y++) for (let x = 0; x < 3; x++) src[y * W + x] = -22 // water on the left
    src[4 * W + 6] = -25 // dark speckle on land
    src[2 * W + 1] = -5 // bright speckle in water
    const out = medianFilter3(src, W, H)
    expect(out[4 * W + 6]).toBe(-10)
    expect(out[2 * W + 1]).toBe(-22)
    expect(out[4 * W + 0]).toBe(-22)
    expect(out[4 * W + 5]).toBe(-10)
    src[0] = NaN
    expect(Number.isNaN(medianFilter3(src, W, H)[0])).toBe(true)
  })
})

describe('Otsu water threshold', () => {
  it('picks a threshold inside the plausible range between two dB populations', () => {
    const db = scene(80, 60, 28) // 35% water at -22 dB, land at -10 dB, with noise
    const t = chooseWaterThreshold([medianFilter3(db, 80, 60)])
    expect(t.method).toBe('otsu')
    expect(t.thresholdDb).toBeGreaterThanOrEqual(WATER_DB_MIN)
    expect(t.thresholdDb).toBeLessThanOrEqual(WATER_DB_MAX)
    expect(t.thresholdDb).toBeGreaterThan(-20)
    expect(t.thresholdDb).toBeLessThan(-13.9)
    expect(t.separability!).toBeGreaterThan(0.8)
    expect(t.darkSharePct!).toBeGreaterThan(30)
    expect(t.darkSharePct!).toBeLessThan(40)
    // and it classifies the synthetic scene almost perfectly
    const wm = waterMask(db, t.thresholdDb)
    let wrong = 0
    for (let y = 0; y < 60; y++) for (let x = 0; x < 80; x++) if (wm[y * 80 + x] !== (x < 28 ? 1 : 0)) wrong++
    expect(wrong / 4800).toBeLessThan(0.01)
  })

  it('takes the middle of an empty gap between the modes', () => {
    const h = dbHistogram([Float32Array.from([-22, -22, -22, -10, -10, -10, -10])])
    const o = otsu(h.counts)!
    expect(o.threshold).toBeGreaterThan(-21)
    expect(o.threshold).toBeLessThan(-11)
    expect(Math.abs(o.threshold - -16)).toBeLessThan(1.5)
  })

  it('clamps an Otsu split that falls outside the water range (land-dominated AOI with a minor water mode)', () => {
    // 3% water at -21 dB, the rest two land populations (-10 and -3 dB): the dominant split is land vs land, near -6.5 dB
    const r = rng(3)
    const g = new Float32Array(100 * 60)
    for (let i = 0; i < g.length; i++) {
      const u = r()
      g[i] = u < 0.03 ? -21 + 1.2 * gauss(r) : u < 0.52 ? -10 + 0.8 * gauss(r) : -3 + 0.8 * gauss(r)
    }
    const t = chooseWaterThreshold([g])
    expect(t.otsuDb).toBeGreaterThan(-9)
    expect(t.otsuDb).toBeLessThan(-4)
    expect(t.method).toBe('otsu-clamped')
    expect(t.thresholdDb).toBe(WATER_DB_MAX)
    expect(t.note).toMatch(/clamped/)
  })

  it('falls back to -18 dB and says so when Otsu separability is weak', () => {
    // heavy-tailed: a land mode plus a broad smear of outliers from -30 to +5 dB, no distinct water mode
    const r = rng(9)
    const g = new Float32Array(100 * 60)
    for (let i = 0; i < g.length; i++) g[i] = r() < 0.7 ? -9 + 1.2 * gauss(r) : -30 + 35 * r()
    const t = chooseWaterThreshold([g], undefined, 0.8) // a stricter bar, as for a high-stakes run
    expect(t.separability!).toBeLessThan(0.8)
    expect(t.method).toBe('fallback')
    expect(t.thresholdDb).toBe(FALLBACK_THRESHOLD_DB)
    expect(t.note).toMatch(/weakly bimodal/)
    expect(t.note).toMatch(/-18/)
    // the default bar accepts the same data (clamped or not, never the fallback): the bar is a parameter
    expect(chooseWaterThreshold([g]).method).not.toBe('fallback')
  })

  it('falls back when the AOI has no dark water mode at all, and on an empty histogram', () => {
    const land = scene(60, 60, 0, { lMu: -9, lSd: 1.5, seed: 4 }) // pure land, one mode
    const t = chooseWaterThreshold([land])
    expect(t.otsuDb!).toBeGreaterThan(-12) // Otsu just halves the land mode
    expect(t.method).toBe('fallback')
    expect(t.thresholdDb).toBe(-18)
    expect(t.note).toMatch(/no water mode/)
    const empty = chooseWaterThreshold([new Float32Array(10).fill(NaN)])
    expect(empty.method).toBe('fallback')
    expect(empty.pixels).toBe(0)
  })
})

describe('masks and change classes', () => {
  it('cleanMask drops isolated pixels, fills pinholes, keeps solid blocks', () => {
    const W = 12, H = 12
    const m = new Uint8Array(W * H)
    for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) m[y * W + x] = 1 // 6x6 block
    m[4 * W + 4] = 0 // pinhole
    m[9 * W + 9] = 1 // lone pixel
    const out = cleanMask(m, W, H)
    expect(out[9 * W + 9]).toBe(0)
    expect(out[4 * W + 4]).toBe(1)
    let n = 0
    for (const v of out) n += v
    expect(n).toBe(36)
  })

  it('flood = after AND NOT before; permanent = both; receded = before only; gaps are neither', () => {
    //            idx: 0  1  2  3  4
    const before = Uint8Array.from([0, 1, 1, 0, 1])
    const after = Uint8Array.from([1, 1, 0, 0, 1])
    const valid = Uint8Array.from([1, 1, 1, 1, 0])
    const c = classifyChange(before, after, valid)
    expect([...c]).toEqual([CHANGE.FLOOD, CHANGE.PERMANENT, CHANGE.RECEDED, CHANGE.NONE, CHANGE.NONE])
  })

  it('waterFraction counts only observed pixels', () => {
    const db = Float32Array.from([-20, -20, -5, NaN])
    expect(waterFraction(waterMask(db, -18), db)).toBeCloseTo(2 / 3, 10)
    expect(waterFraction(new Uint8Array(1), new Float32Array([NaN]))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Scene grouping and before/after choice
// ---------------------------------------------------------------------------

function item(date: string, rel: number, orbit: 'ascending' | 'descending', id = `${date}-${rel}`) {
  return {
    id, bbox: [0, 0, 1, 1],
    properties: { datetime: `${date}T01:00:00Z`, 'sat:relative_orbit': rel, 'sat:orbit_state': orbit, platform: 'sentinel-1a' },
    assets: { vv: { href: `https://x/${id}/vv.tiff` } },
  }
}
function point(date: string, rel: number, orbit: 'ascending' | 'descending', pct: number, coverage = 100): SeriesPoint {
  const [s] = groupScenes([item(date, rel, orbit)])
  return { scene: s, fraction: pct / 100, coveragePct: coverage }
}

describe('scene grouping', () => {
  it('merges slices of one pass and keeps passes apart, oldest first', () => {
    const scenes = groupScenes([item('2025-08-28', 107, 'descending', 'b'), item('2025-08-28', 107, 'descending', 'a'), item('2025-08-27', 100, 'ascending')])
    expect(scenes.map((s) => s.key)).toEqual(['100/2025-08-27', '107/2025-08-28'])
    expect(scenes[1].items).toHaveLength(2)
    expect(scenes[1].orbit).toBe('descending')
  })
  it('names the platform', () => expect(platformName('sentinel-1a')).toBe('Sentinel-1A'))
  it('explicit dates prefer the like orbit over a closer scene of another geometry', () => {
    const ss = groupScenes([item('2025-08-01', 100, 'ascending'), item('2025-08-03', 34, 'descending')])
    const after = groupScenes([item('2025-09-04', 100, 'ascending')])[0]
    expect(nearestLike(ss, '2025-08-02', after)!.relativeOrbit).toBe(100)
    expect(nearestLike(ss, '2025-08-02')!.relativeOrbit).toBe(100) // tie -> the earlier
  })
})

describe('pickPair (window mode)', () => {
  const series = [
    point('2025-06-16', 100, 'ascending', 3.5),
    point('2025-06-17', 107, 'descending', 2.8),
    point('2025-07-10', 100, 'ascending', 4.4),
    point('2025-07-11', 107, 'descending', 3.0),
    point('2025-08-03', 100, 'ascending', 3.8),
    point('2025-08-15', 100, 'ascending', 3.0),
    point('2025-08-27', 100, 'ascending', 9.0),
    point('2025-08-28', 107, 'descending', 12.0), // peak
    point('2025-09-08', 100, 'ascending', 5.0),
  ]
  it('takes the peak as after and the nearest earlier dry scene on the same orbit as before', () => {
    const p = pickPair(series)
    if ('error' in p) throw new Error(p.error)
    expect(p.after.scene.key).toBe('107/2025-08-28')
    // earlier orbit-107 scenes: 06-17 (2.8%) and 07-11 (3.0%); both are dry, the nearest is 07-11
    expect(p.before.scene.key).toBe('107/2025-07-11')
    expect(p.match).toBe('orbit')
    expect(p.how).toMatch(/peak-water scene/)
    expect(p.how).toMatch(/same relative orbit 107/)
  })
  it('does not call a wet scene "dry"', () => {
    const s = [
      point('2025-07-01', 100, 'ascending', 2.0),
      point('2025-07-13', 100, 'ascending', 7.0), // wet (monsoon already rising), not in the lowest quarter
      point('2025-07-25', 100, 'ascending', 10.0),
    ]
    const p = pickPair(s)
    if ('error' in p) throw new Error(p.error)
    expect(p.before.scene.date).toBe('2025-07-01')
  })
  it('falls back to the same flight direction, then to any geometry, and reports which', () => {
    const dir = pickPair([point('2025-07-01', 34, 'descending', 2), point('2025-08-01', 107, 'descending', 9)])
    if ('error' in dir) throw new Error(dir.error)
    expect(dir.match).toBe('direction')
    const any = pickPair([point('2025-07-01', 100, 'ascending', 2), point('2025-08-01', 107, 'descending', 9)])
    if ('error' in any) throw new Error(any.error)
    expect(any.match).toBe('any')
    expect(any.how).toMatch(/any geometry/)
  })
  it('ignores scenes that barely cover the AOI and errors when nothing earlier exists', () => {
    const partial = pickPair([point('2025-07-01', 100, 'ascending', 1, MIN_COVERAGE_PCT - 1), point('2025-08-01', 100, 'ascending', 9)])
    expect(partial).toHaveProperty('error')
    expect(pickPair([])).toHaveProperty('error')
  })
  it('honours a forced after date', () => {
    const p = pickPair(series, { after: '2025-08-15' })
    if ('error' in p) throw new Error(p.error)
    expect(p.after.scene.key).toBe('100/2025-08-15')
    expect(p.before.scene.date < '2025-08-15').toBe(true)
  })
})
