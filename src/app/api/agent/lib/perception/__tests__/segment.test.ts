/** ISS-110 — `segment_feature` promised "the exact boundary" and returned the
 *  mask's bounding rectangle (5 coordinates).
 *
 *  The fix is not cosmetic: SAM2 already returns real polygon rings (measured
 *  2026-08-10 — 196 batched point prompts, rings up to 346 vertices), and the old
 *  code threw them away by scanning the mask to a bbox. These tests pin the
 *  property that distinguishes a real outline from a rectangle, because "returns
 *  a polygon" is true of both.
 */

import { describe, expect, it } from 'vitest'
import {
  bestRing,
  decimateRing,
  probeImageryCeiling,
  ringToGeoRing,
  ringIsRectangular,
} from '../segment'
import type { MosaicSpec } from '../mosaic'

const SPEC: MosaicSpec = { tileX: 370380, tileY: 213732, z: 19, tilesPerSide: 4, sizePx: 1024 }

/** A ring shaped like a blob, not a box. */
const BLOB = [
  [100, 100], [140, 96], [180, 112], [196, 150], [188, 190],
  [150, 210], [112, 202], [92, 168], [94, 130],
]
const RECT = [[100, 100], [200, 100], [200, 200], [100, 200]]

describe('ringIsRectangular — the property ISS-110 got wrong', () => {
  it('recognises a 4-corner axis-aligned box as a rectangle', () => {
    expect(ringIsRectangular(RECT)).toBe(true)
  })

  it('recognises a closed 5-point box as a rectangle', () => {
    expect(ringIsRectangular([...RECT, [100, 100]])).toBe(true)
  })

  it('does NOT call a real mask outline rectangular', () => {
    expect(ringIsRectangular(BLOB)).toBe(false)
  })

  it('does not call a rotated quadrilateral a rectangle just for having 4 points', () => {
    expect(ringIsRectangular([[100, 150], [150, 100], [200, 150], [150, 200]])).toBe(false)
  })
})

describe('bestRing', () => {
  it('picks the largest-area ring, not the first', () => {
    const small = [[0, 0], [10, 0], [10, 10], [0, 10]]
    expect(bestRing([small, BLOB])).toEqual(BLOB)
  })

  it('drops degenerate contours — SAM2 returns many 1- and 2-point rings', () => {
    expect(bestRing([[[5, 5]], [[5, 5], [6, 6]], BLOB])).toEqual(BLOB)
  })

  it('returns null when every ring is noise, rather than inventing geometry', () => {
    expect(bestRing([[[5, 5]], [[5, 5], [6, 6]]])).toBeNull()
  })

  it('returns null for an empty list', () => {
    expect(bestRing([])).toBeNull()
  })
})

describe('decimateRing', () => {
  it('leaves a small ring untouched', () => {
    expect(decimateRing(BLOB, 500)).toEqual(BLOB)
  })

  it('thins a dense ring while keeping its shape and endpoints', () => {
    const dense = Array.from({ length: 900 }, (_, i) => {
      const t = (i / 900) * Math.PI * 2
      return [512 + 100 * Math.cos(t), 512 + 100 * Math.sin(t)]
    })
    const out = decimateRing(dense, 200)
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out.length).toBeGreaterThan(50)
    expect(out[0]).toEqual(dense[0])
    // Still a circle of radius ~100, not a collapsed line.
    const rs = out.map(([x, y]) => Math.hypot(x - 512, y - 512))
    expect(Math.min(...rs)).toBeGreaterThan(95)
    expect(Math.max(...rs)).toBeLessThan(105)
  })
})

describe('ringToGeoRing', () => {
  it('produces a closed geographic ring with the same vertex count plus closure', () => {
    const geo = ringToGeoRing(BLOB, SPEC)
    expect(geo).toHaveLength(BLOB.length + 1)
    expect(geo[0]).toEqual(geo[geo.length - 1])
  })

  it('keeps the outline non-rectangular after projection — the whole point', () => {
    const geo = ringToGeoRing(BLOB, SPEC)
    expect(ringIsRectangular(geo)).toBe(false)
  })

  it('lands the geometry at the mosaic’s real coordinates', () => {
    const geo = ringToGeoRing(BLOB, SPEC)
    for (const [lon, lat] of geo) {
      expect(lon).toBeGreaterThan(74.2)
      expect(lon).toBeLessThan(74.4)
      expect(lat).toBeGreaterThan(31.4)
      expect(lat).toBeLessThan(31.6)
    }
  })

  it('encloses less area than its own bounding box — a mask is not its bbox', () => {
    const geo = ringToGeoRing(BLOB, SPEC)
    const lons = geo.map((c) => c[0])
    const lats = geo.map((c) => c[1])
    const bboxArea = (Math.max(...lons) - Math.min(...lons)) * (Math.max(...lats) - Math.min(...lats))
    let a = 0
    for (let i = 0; i < geo.length - 1; i++) a += geo[i][0] * geo[i + 1][1] - geo[i + 1][0] * geo[i][1]
    expect(Math.abs(a / 2)).toBeLessThan(bboxArea * 0.95)
  })
})

describe('probeImageryCeiling', () => {
  const real = () => Buffer.alloc(19022)
  const placeholder = { placeholder: true as const }

  it('finds the finest zoom that still carries real imagery', async () => {
    const r = await probeImageryCeiling({
      lat: 31.52, lon: 74.32,
      fetchTile: async (_u, z) => (z <= 19 ? real() : placeholder),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.zoom).toBe(19)
    expect(r.mpp).toBeCloseTo(0.2545, 3)
  })

  it('finds a deeper ceiling where the provider has one', async () => {
    const r = await probeImageryCeiling({
      lat: 52.3676, lon: 4.9041,
      fetchTile: async (_u, z) => (z <= 21 ? real() : placeholder),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.zoom).toBe(21)
  })

  it('reports a fetch failure as a failure, not as "no imagery here"', async () => {
    const r = await probeImageryCeiling({
      lat: 0, lon: 0,
      fetchTile: async () => { throw new Error('ECONNRESET') },
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/ECONNRESET/)
    expect(r.reason).not.toMatch(/no imagery/i)
  })

  it('reports honestly when the location has no imagery at all', async () => {
    const r = await probeImageryCeiling({
      lat: 0, lon: 0,
      fetchTile: async () => placeholder,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/no imagery|placeholder/i)
  })
})

describe('chooseSegmentationZoom — the frame must contain the feature', () => {
  it('backs off from the ceiling when the finest zoom frames too little ground', async () => {
    const { chooseSegmentationZoom } = await import('../segment')
    // Schiphol, ceiling z21 (0.046 m/px): a 1024 px block spans only ~47 m, which
    // cannot contain a 40 m aircraft. z19 spans ~186 m.
    const z = chooseSegmentationZoom(21, 52.3086, 4, 150)
    expect(z).toBeLessThan(21)
    expect(z).toBe(19)
  })

  it('never exceeds the ceiling, even when a finer zoom would be ideal', async () => {
    const { chooseSegmentationZoom } = await import('../segment')
    expect(chooseSegmentationZoom(18, 52.3086, 4, 150)).toBeLessThanOrEqual(18)
  })

  it('stays at the ceiling when the ceiling already frames enough ground', async () => {
    const { chooseSegmentationZoom } = await import('../segment')
    // z19 over Lahore: 1024 px × 0.2545 = 260 m, comfortably over 150 m.
    expect(chooseSegmentationZoom(19, 31.52, 4, 150)).toBe(19)
  })

  it('does not drop below a floor that would make the imagery useless', async () => {
    const { chooseSegmentationZoom } = await import('../segment')
    expect(chooseSegmentationZoom(21, 52.3086, 4, 100_000)).toBeGreaterThanOrEqual(16)
  })
})
