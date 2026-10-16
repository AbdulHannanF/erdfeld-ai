import { describe, expect, it } from 'vitest'
import { SAMPLE_CASES, sampleCaseToAOI } from '../sample-cases'

describe('sample cases', () => {
  it('has exactly three cases with unique ids and a question each', () => {
    expect(SAMPLE_CASES).toHaveLength(3)
    expect(new Set(SAMPLE_CASES.map((c) => c.id)).size).toBe(3)
    for (const c of SAMPLE_CASES) expect(c.question.trim().length).toBeGreaterThan(10)
  })

  it('every bbox is a valid, small [w,s,e,n] box', () => {
    for (const c of SAMPLE_CASES) {
      const [w, s, e, n] = c.bbox
      expect(w).toBeLessThan(e)
      expect(s).toBeLessThan(n)
      expect(e - w).toBeLessThan(0.5)
      expect(n - s).toBeLessThan(0.5)
    }
  })

  it('builds a closed rectangle AOI centred on the box', () => {
    const aoi = sampleCaseToAOI(SAMPLE_CASES[0])
    const ring = (aoi.geometry as GeoJSON.Polygon).coordinates[0]
    expect(aoi.type).toBe('Rectangle')
    expect(ring).toHaveLength(5)
    expect(ring[0]).toEqual(ring[4])
    expect(aoi.center?.lng).toBeCloseTo(74.48, 6)
    expect(aoi.center?.lat).toBeCloseTo(31.015, 6)
  })
})
