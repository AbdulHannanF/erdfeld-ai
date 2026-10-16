import { describe, it, expect } from 'vitest'
import { delineateFromStack } from '../delineate'
import { classifyProfile, findPeaks } from '../phenology'
import { makeGeoref } from '../../vectorize'
import { DATES, RECTS, makeStack, pip, rectCentre, truthArea } from './synthetic'

describe('classifyProfile', () => {
  const dates = ['2025-01-10', '2025-03-01', '2025-04-20', '2025-06-10', '2025-08-01', '2025-09-20', '2025-11-10']
  it('finds seasonal peaks with prominence and handles gaps', () => {
    expect(findPeaks([0.2, 0.7, 0.3, 0.2, 0.6, 0.2])).toEqual([1, 4])
    expect(findPeaks([0.2, 0.25, 0.3, 0.25])).toEqual([]) // below the minimum height
    const withGap = [0.2, 0.7, NaN, 0.2, 0.2, 0.2, 0.2]
    expect(classifyProfile(dates, withGap, 25).cls).toBe('winter_crop')
  })
  it('labels hemispheres by local season', () => {
    const summerPeak = [0.2, 0.2, 0.2, 0.3, 0.75, 0.3, 0.2] // Aug
    expect(classifyProfile(dates, summerPeak, 25).cls).toBe('summer_crop')
    expect(classifyProfile(dates, summerPeak, -25).cls).toBe('winter_crop')
    expect(classifyProfile(dates, summerPeak, 25).label).toContain('kharif')
    expect(classifyProfile(dates, summerPeak, -25).label).not.toContain('kharif')
  })
  it('separates non-field, perennial, fallow and unknown', () => {
    expect(classifyProfile(dates, dates.map(() => 0.12), 10).cls).toBe('non_field')
    expect(classifyProfile(dates, dates.map(() => 0.72), 10).cls).toBe('perennial')
    expect(classifyProfile(dates, dates.map(() => 0.36), 10).cls).toBe('fallow_sparse')
    expect(classifyProfile(dates, [NaN, 0.5, NaN, NaN, NaN, 0.4, NaN], 10).cls).toBe('unknown')
  })
})

describe('delineateFromStack — synthetic season (6 touching fields + bare strip)', () => {
  const size = 120
  const stack = makeStack({ size })
  const t0 = performance.now()
  const res = delineateFromStack(stack, { minFieldAreaM2: 2000, lat: 25 })
  const ms = performance.now() - t0
  const geo = makeGeoref(stack.bbox, size, size)

  it('recovers six field polygons plus one non-field region', () => {
    expect(res.fieldCount).toBe(6)
    expect(res.nonFieldCount).toBe(1)
    expect(res.features.length).toBe(7)
  })

  it('matches each truth rectangle: class right, area within 10%', () => {
    const report: string[] = []
    for (const q of RECTS) {
      const c = rectCentre(q, size)
      const [lon, lat] = geo.toLonLat(c.x, c.y)
      const f = res.features.find((feat: any) => pip(feat, lon, lat))
      expect(f, `no polygon at centre of ${q.cls}`).toBeTruthy()
      const truthM2 = truthArea(q, size) * geo.pixelAreaM2
      const err = Math.abs(f.properties.area_m2 - truthM2) / truthM2
      report.push(`${q.cls}: ${(err * 100).toFixed(1)}%`)
      expect(f.properties.class, q.cls).toBe(q.cls)
      expect(err, `${q.cls} area error`).toBeLessThan(0.03)
    }
    // Printed so the accuracy numbers can be quoted.
    console.log('synthetic area errors ->', report.join(', '), `| ${ms.toFixed(0)} ms`)
  })

  it('attaches profile, seasons and a 0-1 confidence to every polygon', () => {
    for (const f of res.features) {
      const p = f.properties
      expect(p.profile_dates).toEqual(DATES)
      expect(p.profile_values).toHaveLength(DATES.length)
      expect(p.confidence).toBeGreaterThan(0)
      expect(p.confidence).toBeLessThanOrEqual(1)
      expect(typeof p.name).toBe('string')
    }
    const dbl = res.features.find((f: any) => f.properties.class === 'double_crop')
    expect(dbl.properties.growing_seasons).toBe(2)
  })

  it('emits valid closed polygons with CCW shells', () => {
    for (const f of res.features) {
      for (const [i, ring] of f.geometry.coordinates.entries()) {
        expect(ring[0]).toEqual(ring[ring.length - 1])
        let s = 0
        for (let k = 0; k < ring.length - 1; k++) s += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1]
        if (i === 0) expect(s).toBeGreaterThan(0)
      }
    }
  })
})

describe('built-up vs. fallow (NDBI)', () => {
  const dates = ['2025-01-10', '2025-03-01', '2025-04-20', '2025-06-10', '2025-08-01', '2025-09-20', '2025-11-10']
  it('classifies a flat low-NDVI, high-NDBI profile as non-field, a negative-NDBI one as fallow', () => {
    const ndvi = [0.32, 0.36, 0.34, 0.31, 0.38, 0.33, 0.35]
    expect(classifyProfile(dates, ndvi, 25, dates.map(() => 0.14)).cls).toBe('non_field')
    expect(classifyProfile(dates, ndvi, 25, dates.map(() => -0.08)).cls).toBe('fallow_sparse')
    expect(classifyProfile(dates, ndvi, 25).cls).toBe('fallow_sparse') // no NDBI supplied
  })
  it('keeps a seasonal crop a crop even when its bare-soil dates have positive NDBI', () => {
    const crop = [0.2, 0.7, 0.3, 0.2, 0.2, 0.2, 0.2]
    expect(classifyProfile(dates, crop, 25, [0.1, -0.3, 0.05, 0.1, 0.1, 0.1, 0.1]).cls).toBe('winter_crop')
  })
  it('calls open water (NDVI < 0 throughout) non-field', () => {
    expect(classifyProfile(dates, dates.map(() => -0.2), 25, dates.map(() => -0.3)).cls).toBe('non_field')
  })

  const size = 120
  const rects = RECTS.map((q) => (q.cls === 'perennial' ? { ...q, cls: 'built_up' as const } : q))
  const res = delineateFromStack(makeStack({ size, rects }), { minFieldAreaM2: 2000, lat: 25 })
  const geo = makeGeoref(makeStack({ size, rects }).bbox, size, size)
  const classAt = (cls: string) => {
    const q = rects.find((r) => r.cls === cls)!
    const c = rectCentre(q, size)
    const [lon, lat] = geo.toLonLat(c.x, c.y)
    return res.features.find((f: any) => pip(f, lon, lat))?.properties.class
  }
  it('segments a built-up block as non-field and a fallow block as fallow', () => {
    expect(classAt('built_up')).toBe('non_field')
    expect(classAt('fallow_sparse')).toBe('fallow_sparse')
    expect(classAt('winter_crop')).toBe('winter_crop')
  })
})

describe('delineateFromStack — robustness', () => {
  it('does not shatter fields under heavier noise and more cloud gaps', () => {
    const stack = makeStack({ size: 120, noise: 0.05, gapRate: 0.2, seed: 11 })
    const res = delineateFromStack(stack, { minFieldAreaM2: 2000, lat: 25 })
    expect(res.fieldCount).toBeGreaterThanOrEqual(5)
    expect(res.fieldCount).toBeLessThanOrEqual(8)
  })

  it('merges sub-minimum regions instead of emitting slivers', () => {
    const stack = makeStack({ size: 120 })
    const res = delineateFromStack(stack, { minFieldAreaM2: 20_000, lat: 25 }) // 2 ha minimum
    for (const f of res.features) expect(f.properties.area_m2).toBeGreaterThanOrEqual(20_000 - 1)
  })
})

describe('performance', () => {
  it('segments + vectorizes a 600x600 grid x 6 dates in under ~2 s', () => {
    const stack = makeStack({ size: 600, dates: DATES.filter((_, i) => i % 4 !== 3).slice(0, 6), seed: 3 })
    const t0 = performance.now()
    const res = delineateFromStack(stack, { minFieldAreaM2: 2000, lat: 25 })
    const ms = performance.now() - t0
    console.log(`600x600x6 delineate: ${ms.toFixed(0)} ms, ${res.features.length} polygons`)
    expect(res.fieldCount).toBeGreaterThanOrEqual(5)
    expect(ms).toBeLessThan(2500)
  })
})
