import { describe, expect, it } from 'vitest'

import { TRANSIENT_FAILURES_BEFORE_FLAG, decideTileFailure } from '../tile-failure'

describe('decideTileFailure', () => {
  it('flags a 4xx at once (bad or expired tile URL)', () => {
    const counts = new Map<string, number>()
    expect(decideTileFailure(counts, 'layer-a', 403)).toBe(true)
    expect(decideTileFailure(counts, 'layer-a', 404)).toBe(true)
  })

  it('flags 5xx and network errors only when a source keeps failing', () => {
    const counts = new Map<string, number>()
    const verdicts = Array.from({ length: TRANSIENT_FAILURES_BEFORE_FLAG }, (_, i) => decideTileFailure(counts, 'layer-a', i === 0 ? 500 : undefined))
    expect(verdicts).toEqual([false, false, true])
  })

  it('counts each source on its own', () => {
    const counts = new Map<string, number>()
    decideTileFailure(counts, 'layer-a', 502)
    decideTileFailure(counts, 'layer-a', 502)
    expect(decideTileFailure(counts, 'layer-b', 502)).toBe(false)
  })
})
