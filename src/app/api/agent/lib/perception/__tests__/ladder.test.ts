/** ③ Detector ladder (spec §3.4).
 *
 *  > Tried in order; the first tier that returns a confident result wins, and the
 *  > report always states which tier answered.
 *
 *  The orchestration invariants under test are the honesty ones:
 *   - a tier that FAILS is never recorded as a tier that found nothing;
 *   - a skipped tier always says why;
 *   - the report names the tier that answered;
 *   - descending the ladder after a genuine empty result is allowed, but the
 *     empty result is still reported.
 */

import { describe, expect, it } from 'vitest'
import { runDetectorLadder, type LadderContext, type TierRunner } from '../ladder'

const CTX: LadderContext = {
  profile: {
    raw: 'every car', target: 'car', footprintM: [4.5, 2], minPxNeeded: 20,
    task: 'detect', source: 'curated', confidence: 'high',
  },
  plan: {
    ok: true, zoom: 20, mpp: 0.113, objectPx: 39.8, probes: [],
    source: { id: 'esri-world-imagery', name: 'Esri World Imagery', urlTemplate: 'https://x/{z}/{y}/{x}', minZoom: 1, maxZoom: 23, bestResolutionM: 0.3, attribution: '', licence: '' },
  },
  aoi: { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] },
  bbox: [0, 0, 0.01, 0.01],
  areaKm2: 1.2,
}

const detection = (cls: string) => ({
  class: cls, confidence: 0.8, centroid: [0.005, 0.005] as [number, number],
  polygon: [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]],
  tier: 'A' as const, model: 'fake',
})

function runner(over: Partial<TierRunner> & Pick<TierRunner, 'tier' | 'name'>): TierRunner {
  return {
    gate: () => null,
    run: async () => ({ detections: [], note: 'nothing found' }),
    ...over,
  } as TierRunner
}

describe('runDetectorLadder', () => {
  it('stops at the first tier that answers and names it', async () => {
    let bRan = false
    const report = await runDetectorLadder(CTX, [
      runner({ tier: 'A', name: 'curated', run: async () => ({ detections: [detection('car')], note: 'ok' }) }),
      runner({ tier: 'B', name: 'open-vocab', run: async () => { bRan = true; return { detections: [], note: '' } } }),
    ])
    expect(report.tierUsed).toBe('A')
    expect(report.detections).toHaveLength(1)
    expect(bRan).toBe(false)
  })

  it('records a SKIPPED tier with its reason and moves on', async () => {
    const report = await runDetectorLadder(CTX, [
      runner({ tier: 'A', name: 'curated', gate: () => 'no curated model covers "car"' }),
      runner({ tier: 'B', name: 'open-vocab', run: async () => ({ detections: [detection('car')], note: 'ok' }) }),
    ])
    expect(report.tierUsed).toBe('B')
    const a = report.outcomes.find((o) => o.tier === 'A')!
    expect(a.status).toBe('skipped')
    expect(a.note).toContain('no curated model')
  })

  it('distinguishes a FAILED tier from an empty one — the whole point', async () => {
    const report = await runDetectorLadder(CTX, [
      runner({ tier: 'A', name: 'curated', run: async () => ({ error: 'provider returned HTTP 503' }) }),
      runner({ tier: 'B', name: 'open-vocab', run: async () => ({ detections: [], note: 'no masks cleared the margin' }) }),
    ])
    const a = report.outcomes.find((o) => o.tier === 'A')!
    const b = report.outcomes.find((o) => o.tier === 'B')!
    expect(a.status).toBe('failed')
    expect(a.note).toContain('503')
    expect(b.status).toBe('empty')
    // No tier answered, and that is NOT the same as "there are zero cars".
    expect(report.tierUsed).toBeNull()
    expect(report.anyTierFailed).toBe(true)
  })

  it('reports a genuine zero as a zero when every tier ran cleanly', async () => {
    const report = await runDetectorLadder(CTX, [
      runner({ tier: 'A', name: 'curated', run: async () => ({ detections: [], note: 'model ran, found none' }) }),
      runner({ tier: 'B', name: 'open-vocab', run: async () => ({ detections: [], note: 'no masks cleared the margin' }) }),
    ])
    expect(report.tierUsed).toBeNull()
    expect(report.anyTierFailed).toBe(false)
    expect(report.detections).toHaveLength(0)
    expect(report.outcomes.every((o) => o.status === 'empty')).toBe(true)
  })

  it('survives a runner that throws, and calls that a failure', async () => {
    const report = await runDetectorLadder(CTX, [
      runner({ tier: 'A', name: 'curated', run: async () => { throw new Error('boom') } }),
    ])
    expect(report.outcomes[0].status).toBe('failed')
    expect(report.outcomes[0].note).toMatch(/boom/)
    expect(report.anyTierFailed).toBe(true)
  })

  it('records every tier it considered, in ladder order', async () => {
    const report = await runDetectorLadder(CTX, [
      runner({ tier: 'A', name: 'curated', gate: () => 'no weights' }),
      runner({ tier: 'B', name: 'open-vocab', gate: () => 'object too small' }),
      runner({ tier: 'C', name: 'indirect', run: async () => ({ detections: [], note: 'shadow geometry needs a detection first' }) }),
    ])
    expect(report.outcomes.map((o) => o.tier)).toEqual(['A', 'B', 'C'])
  })

  it('tags every detection with the tier that produced it', async () => {
    const report = await runDetectorLadder(CTX, [
      runner({
        tier: 'B', name: 'open-vocab',
        run: async () => ({ detections: [{ ...detection('car'), tier: 'A' as any }], note: 'ok' }),
      }),
    ])
    // The runner mislabelled it; the ladder is the authority on which tier ran.
    expect(report.detections[0].tier).toBe('B')
  })
})
