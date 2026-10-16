/** Tier B (open vocabulary) and Tier C (indirect evidence).
 *
 *  Tier B is SAM2 masks labelled by CLIP. It is the general engine — unlimited
 *  vocabulary, viewpoint-agnostic because SAM2 segments shapes rather than
 *  learned classes. But it was MEASURED on 2026-08-10 and it is not a free lunch:
 *
 *    - a 14×14 point grid over a 512 px Lahore mosaic produced 83 candidate masks
 *      after footprint filtering; CLIP labelled 19 of them "car" and, on
 *      inspection, they were rooftops and bare ground while the actual cars had
 *      no mask at all;
 *    - on twelve HAND-PICKED crops (7 verified cars, 5 verified non-cars) the
 *      car-vs-distractor margin was ~0.02 on a 0.25–0.35 scale: separable at a
 *      24 px crop and at a 96 px crop, NOT separable at 48 px.
 *
 *  So CLIP carries real but weak signal that collapses when the object is small.
 *  Tier B therefore carries a resolution gate of its own and a margin floor, and
 *  the tests below pin both — a Tier B that answers everything would be the
 *  ISS-107 failure again: a fallback that fires on every request looks exactly
 *  like a feature that works.
 */

import { describe, expect, it } from 'vitest'
import { TIER_B_MIN_PX, cosineSimilarity, l2Normalize, pickBestLabel, ringToBox, makeTierBRunner } from '../tier-b'
import { makeTierCRunner, shadowLengthM, solarPosition } from '../tier-c'
import type { LadderContext } from '../ladder'

function ctxWith(over: Partial<LadderContext> = {}): LadderContext {
  return {
    profile: {
      raw: 'every car', target: 'car', footprintM: [4.5, 2], minPxNeeded: 20,
      task: 'detect', source: 'curated', confidence: 'high',
    },
    plan: { ok: true, zoom: 20, mpp: 0.113, objectPx: 39.8, probes: [] },
    aoi: { type: 'Polygon', coordinates: [[[-73.99, 40.75], [-73.98, 40.75], [-73.98, 40.76], [-73.99, 40.76], [-73.99, 40.75]]] },
    bbox: [-73.99, 40.75, -73.98, 40.76],
    areaKm2: 1,
    ...over,
  }
}

describe('vector helpers', () => {
  it('normalises to unit length', () => {
    const v = l2Normalize([3, 4])
    expect(Math.hypot(...v)).toBeCloseTo(1, 10)
    expect(v).toEqual([0.6, 0.8])
  })

  it('computes cosine similarity, and is 1 for identical directions', () => {
    expect(cosineSimilarity(l2Normalize([1, 2, 3]), l2Normalize([2, 4, 6]))).toBeCloseTo(1, 10)
    expect(cosineSimilarity(l2Normalize([1, 0]), l2Normalize([0, 1]))).toBeCloseTo(0, 10)
  })
})

describe('ringToBox', () => {
  it('bounds a polygon ring', () => {
    expect(ringToBox([[10, 20], [30, 20], [30, 50], [10, 50]])).toEqual({ x0: 10, y0: 20, x1: 30, y1: 50, w: 20, h: 30 })
  })

  it('rejects a degenerate contour rather than treating it as an object', () => {
    // SAM2 really does return 1- and 2-point "rings" — 169 of them in one
    // measured prediction. They are noise, not tiny objects.
    expect(ringToBox([[10, 20]])).toBeNull()
    expect(ringToBox([[10, 20], [11, 21]])).toBeNull()
  })
})

describe('pickBestLabel — the margin is the whole safeguard', () => {
  const phrases = ['car', 'rooftop', 'tree', 'bare ground']

  it('accepts a crop that beats every distractor by more than the floor', () => {
    const r = pickBestLabel([0.31, 0.24, 0.22, 0.25], phrases, 0.02)
    expect(r.accepted).toBe(true)
    expect(r.label).toBe('car')
    expect(r.margin).toBeCloseTo(0.06, 6)
  })

  it('REJECTS a crop whose margin is inside the measured noise band', () => {
    // The margins actually observed on real SAM2 masks were ~0.003–0.02.
    const r = pickBestLabel([0.2782, 0.2761, 0.2743, 0.2755], phrases, 0.02)
    expect(r.accepted).toBe(false)
    expect(r.margin).toBeLessThan(0.02)
  })

  it('rejects when a distractor wins outright', () => {
    const r = pickBestLabel([0.24, 0.31, 0.22, 0.25], phrases, 0.02)
    expect(r.accepted).toBe(false)
    expect(r.label).toBe('rooftop')
  })
})

describe('Tier B gating', () => {
  const deps = {
    segment: async () => [],
    embedImage: async () => [0, 1],
    embedTexts: async () => [[0, 1]],
    fetchTile: async () => new ArrayBuffer(10),
    available: () => null as string | null,
  }

  it('runs when the object is large enough for CLIP to have signal', () => {
    const gate = makeTierBRunner(deps).gate(ctxWith({
      plan: { ok: true, zoom: 20, mpp: 0.05, objectPx: 90, probes: [] },
    }))
    expect(gate).toBeNull()
  })

  it('skips small objects, citing the measurement rather than a guess', () => {
    const gate = makeTierBRunner(deps).gate(ctxWith())   // car at 39.8 px
    expect(gate).toBeTruthy()
    expect(gate).toContain(String(TIER_B_MIN_PX))
    expect(gate).toMatch(/measured|2026-08-10/i)
  })

  it('skips with an actionable message when no segmentation backend is configured', () => {
    const gate = makeTierBRunner({ ...deps, available: () => 'ROBOFLOW_API_KEY is not set' })
      .gate(ctxWith({ plan: { ok: true, zoom: 20, mpp: 0.05, objectPx: 90, probes: [] } }))
    expect(gate).toContain('ROBOFLOW_API_KEY')
  })

  it('skips when there is no imagery plan at all', () => {
    expect(makeTierBRunner(deps).gate(ctxWith({ plan: { ok: false, probes: [], reason: 'x' } }))).toBeTruthy()
  })
})

describe('solarPosition', () => {
  // NOAA reference: Greenwich, 2026-06-21 12:00 UTC — near local solar noon at
  // the summer solstice, so elevation ≈ 90 − 51.48 + 23.44 ≈ 62°.
  it('puts the midsummer London sun high and due south', () => {
    const p = solarPosition(new Date('2026-06-21T12:00:00Z'), 51.4778, -0.0015)
    expect(p.elevationDeg).toBeGreaterThan(58)
    expect(p.elevationDeg).toBeLessThan(66)
    expect(p.azimuthDeg).toBeGreaterThan(150)
    expect(p.azimuthDeg).toBeLessThan(210)
  })

  it('puts the midwinter London sun low', () => {
    const p = solarPosition(new Date('2026-12-21T12:00:00Z'), 51.4778, -0.0015)
    expect(p.elevationDeg).toBeGreaterThan(10)
    expect(p.elevationDeg).toBeLessThan(20)
  })

  it('reports the sun below the horizon at local midnight', () => {
    expect(solarPosition(new Date('2026-06-21T00:00:00Z'), 51.4778, -0.0015).elevationDeg).toBeLessThan(0)
  })
})

describe('shadowLengthM', () => {
  it('is the object height at 45°', () => {
    expect(shadowLengthM(10, 45)).toBeCloseTo(10, 6)
  })

  it('grows as the sun drops', () => {
    expect(shadowLengthM(10, 20)!).toBeGreaterThan(shadowLengthM(10, 60)!)
  })

  it('is null when the sun is at or below the horizon — no shadow to measure', () => {
    expect(shadowLengthM(10, 0)).toBeNull()
    expect(shadowLengthM(10, -5)).toBeNull()
  })
})

describe('Tier C', () => {
  it('never fabricates detections — it reports evidence and what would resolve it', async () => {
    const out = await makeTierCRunner({ now: new Date('2026-06-21T11:00:00Z') }).run(ctxWith({
      profile: { raw: 'utility pole', target: 'utility pole', footprintM: [0.3, 0.3], minPxNeeded: 20, task: 'detect', source: 'curated', confidence: 'high' },
      plan: { ok: false, probes: [], reason: 'ceiling reached', ceilingMpp: 0.2545 },
    }))
    expect('error' in out).toBe(false)
    if ('error' in out) return
    expect(out.detections).toHaveLength(0)
    expect(out.note).toMatch(/shadow/i)
  })

  it('states the shadow a target of known height would cast', async () => {
    const out = await makeTierCRunner({ now: new Date('2026-06-21T11:00:00Z') }).run(ctxWith({
      profile: { raw: 'utility pole', target: 'utility pole', footprintM: [0.3, 0.3], minPxNeeded: 20, task: 'detect', source: 'curated', confidence: 'high' },
      plan: { ok: false, probes: [], reason: 'x', ceilingMpp: 0.2545 },
    }))
    if ('error' in out) return
    // 11:00 UTC is 07:00 local in New York. A pole is ~9 m tall; at that low sun its shadow is many metres, which
    // is the point — the shadow is resolvable where the object is not.
    expect(out.note).toMatch(/\d+(\.\d+)?\s*m/)
  })
})
