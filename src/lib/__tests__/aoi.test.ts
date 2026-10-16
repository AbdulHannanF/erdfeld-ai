import { describe, expect, it } from 'vitest'
import { aoiSignature } from '../aoi'

const SQUARE_A = {
  type: 'Polygon',
  coordinates: [[[-0.13, 51.50], [-0.12, 51.50], [-0.12, 51.51], [-0.13, 51.51], [-0.13, 51.50]]],
}

// A genuinely different area (the manifest must NOT carry over to it).
const SQUARE_B = {
  type: 'Polygon',
  coordinates: [[[2.34, 48.85], [2.35, 48.85], [2.35, 48.86], [2.34, 48.86], [2.34, 48.85]]],
}

describe('aoiSignature', () => {
  it('returns a non-empty stable signature for a geometry', () => {
    const sig = aoiSignature(SQUARE_A)
    expect(sig).toBeTruthy()
    expect(sig).toBe(aoiSignature(SQUARE_A))
  })

  it('accepts an AOI object wrapping the geometry (uses .geometry)', () => {
    expect(aoiSignature({ type: 'Feature', geometry: SQUARE_A })).toBe(aoiSignature(SQUARE_A))
  })

  it('produces DIFFERENT signatures for different areas — manifest clears on AOI change', () => {
    expect(aoiSignature(SQUARE_A)).not.toBe(aoiSignature(SQUARE_B))
  })

  it('is stable under sub-meter float jitter (rounds to 5 dp)', () => {
    const jittered = {
      type: 'Polygon',
      coordinates: [[
        [-0.130000001, 51.500000004], [-0.12, 51.50], [-0.12, 51.51], [-0.13, 51.51], [-0.130000001, 51.500000004],
      ]],
    }
    expect(aoiSignature(jittered)).toBe(aoiSignature(SQUARE_A))
  })

  it('changes when a vertex moves more than the rounding tolerance', () => {
    const moved = {
      type: 'Polygon',
      coordinates: [[[-0.13, 51.50], [-0.11, 51.50], [-0.11, 51.51], [-0.13, 51.51], [-0.13, 51.50]]],
    }
    expect(aoiSignature(moved)).not.toBe(aoiSignature(SQUARE_A))
  })

  it('returns empty string for null / malformed input (no crash)', () => {
    expect(aoiSignature(null)).toBe('')
    expect(aoiSignature(undefined)).toBe('')
    expect(aoiSignature({})).toBe('')
    expect(aoiSignature({ type: 'Polygon' })).toBe('')
  })
})
