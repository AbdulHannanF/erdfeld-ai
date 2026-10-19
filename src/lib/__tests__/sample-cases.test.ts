import { describe, expect, it } from 'vitest'
import { SAMPLE_CASES, sampleCaseToAOI, serverCanAnswer } from '../sample-cases'

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

describe('serverCanAnswer', () => {
  const reply = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch
  it('is true when the default provider holds a server key', async () => {
    expect(await serverCanAnswer(reply({ default_provider: 'gemini', providers: [{ id: 'openai', server_key: false }, { id: 'gemini', server_key: true }] }))).toBe(true)
  })
  it('is false when the default provider has no server key', async () => {
    expect(await serverCanAnswer(reply({ default_provider: 'gemini', providers: [{ id: 'gemini', server_key: false }] }))).toBe(false)
  })
  it('is false on an HTTP error or a network failure', async () => {
    expect(await serverCanAnswer(reply({}, false))).toBe(false)
    expect(await serverCanAnswer((async () => { throw new Error('offline') }) as unknown as typeof fetch)).toBe(false)
  })
})
