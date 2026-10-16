import { describe, expect, it } from 'vitest'

import {
  PRIOR_MAX, PRIOR_MIN, applyRatios, entropy, expectedEntropyAfter, likelihoodRatios, normalise, predictiveProbability, proposePriors, top, updateBeliefs,
} from '../belief'
import { binCount, getFamily } from '../catalogue'

const water = getFamily('water')!
const item = (id: string) => water.items.find((i) => i.id === id)!
const uniform = Object.fromEntries(water.hypotheses.map((h) => [h.id, 0.25]))
const sum = (p: Record<string, number>) => Object.values(p).reduce((s, v) => s + v, 0)

describe('priors', () => {
  it('rejects unknown ids, clamps to [0.05, 0.6] and normalises', () => {
    const r = proposePriors([
      { id: 'water_flood_event', prior: 0.95 },
      { id: 'water_permanent', prior: 0.001 },
      { id: 'water_seasonal_inundation', prior: 0.3 },
      { id: 'made_up', prior: 0.5 },
    ], water.hypotheses)
    expect(r.rejected).toEqual(['made_up'])
    expect(r.clamped.sort()).toEqual(['water_flood_event', 'water_permanent'])
    expect(r.usedDefaults).toBe(false)
    expect(Object.keys(r.priors).sort()).toEqual(['water_flood_event', 'water_permanent', 'water_seasonal_inundation'])
    expect(sum(r.priors)).toBeCloseTo(1, 12)
    // raw 0.6 / 0.05 / 0.3 normalised by 0.95
    expect(r.priors.water_flood_event).toBeCloseTo(0.6 / 0.95, 12)
    expect(r.priors.water_permanent).toBeCloseTo(0.05 / 0.95, 12)
    expect(PRIOR_MIN).toBe(0.05)
    expect(PRIOR_MAX).toBe(0.6)
  })

  it('takes a non-finite prior as the catalogue default and ignores a repeated id', () => {
    const r = proposePriors([
      { id: 'water_flood_event', prior: Number.NaN },
      { id: 'water_flood_event', prior: 0.5 },
      { id: 'water_permanent', prior: 0.2 },
    ], water.hypotheses)
    expect(r.priors.water_flood_event / r.priors.water_permanent).toBeCloseTo(0.4 / 0.2, 9)
  })

  it('falls back to the catalogue defaults when fewer than two ids survive', () => {
    const r = proposePriors([{ id: 'nope', prior: 0.5 }, { id: 'water_flood_event', prior: 0.5 }], water.hypotheses)
    expect(r.usedDefaults).toBe(true)
    expect(r.rejected).toEqual(['nope'])
    expect(r.priors.water_flood_event).toBeCloseTo(0.4, 12)
    expect(sum(r.priors)).toBeCloseTo(1, 12)
  })
})

describe('updates in log-odds', () => {
  it('equals Bayes\' rule over the hypothesis set', () => {
    const it1 = item('sar_new_water')
    const bin = 3
    const { posterior } = updateBeliefs(uniform, water.hypotheses, it1, bin)
    const direct = normalise(Object.fromEntries(water.hypotheses.map((h) => [h.id, 0.25 * h.predicts.sar_new_water.p[bin]])))
    for (const h of water.hypotheses) expect(posterior[h.id]).toBeCloseTo(direct[h.id], 9)
    expect(sum(posterior)).toBeCloseTo(1, 12)
  })

  it('moves belief toward the hypothesis that predicted the outcome and away from the one that ruled it out', () => {
    const { posterior, ratios } = updateBeliefs(uniform, water.hypotheses, item('sar_new_water'), 3)
    expect(top(posterior).id).toBe('water_flood_event')
    expect(ratios.water_flood_event).toBeGreaterThan(1)
    expect(ratios.water_permanent).toBeLessThan(1)
    expect(posterior.water_permanent).toBeLessThan(0.25)
  })

  it('reports the likelihood ratio as P(bin | h) / P(bin | not h)', () => {
    const { ratios } = likelihoodRatios(uniform, water.hypotheses, item('sar_new_water'), 3)
    const h = water.hypotheses.find((x) => x.id === 'water_flood_event')!
    const others = water.hypotheses.filter((x) => x !== h)
    const against = others.reduce((s, k) => s + (0.25 / 0.75) * k.predicts.sar_new_water.p[3], 0)
    expect(ratios.water_flood_event).toBeCloseTo(h.predicts.sar_new_water.p[3] / against, 9)
  })

  it('applies a ratio of 1 as no change', () => {
    const p = applyRatios({ a: 0.7, b: 0.3 }, { a: 1, b: 1 })
    expect(p.a).toBeCloseTo(0.7, 12)
  })

  it('caps a vision reading to a likelihood ratio between 0.5 and 2', () => {
    const vision = item('water_vision')
    // 'no_visible_water' is strongly predicted by the artefact hypothesis, so the uncapped ratio is large
    const uncapped = likelihoodRatios(uniform, water.hypotheses, { ...vision, lrCap: undefined }, 3)
    expect(Math.max(...Object.values(uncapped.ratios))).toBeGreaterThan(2)
    const capped = likelihoodRatios(uniform, water.hypotheses, vision, 3)
    expect(capped.capped).toBe(true)
    for (const r of Object.values(capped.ratios)) {
      expect(r).toBeGreaterThanOrEqual(0.5)
      expect(r).toBeLessThanOrEqual(2)
    }
    // a capped reading moves belief less than the same reading uncapped
    const a = updateBeliefs(uniform, water.hypotheses, vision, 3).posterior
    const b = updateBeliefs(uniform, water.hypotheses, { ...vision, lrCap: undefined }, 3).posterior
    expect(top(a).p).toBeLessThan(top(b).p)
  })

  it('keeps the mapped-building item within 0.67 to 1.5', () => {
    const s = getFamily('structures')!
    const osm = s.items.find((i) => i.op === 'query_osm')!
    const start = Object.fromEntries(s.hypotheses.map((h) => [h.id, 1 / s.hypotheses.length]))
    for (let bin = 0; bin < binCount(osm.scale); bin++) {
      for (const r of Object.values(likelihoodRatios(start, s.hypotheses, osm, bin).ratios)) {
        expect(r).toBeGreaterThanOrEqual(0.67 - 1e-9)
        expect(r).toBeLessThanOrEqual(1.5 + 1e-9)
      }
    }
  })

  it('stays finite when a posterior is near certainty', () => {
    const p = updateBeliefs({ a: 1 - 1e-12, b: 1e-12 }, water.hypotheses.slice(0, 2).map((h, i) => ({ ...h, id: i === 0 ? 'a' : 'b' })), item('sar_new_water'), 0).posterior
    expect(Number.isFinite(p.a) && Number.isFinite(p.b)).toBe(true)
    expect(sum(p)).toBeCloseTo(1, 9)
  })
})

describe('entropy', () => {
  it('is 2 bits for four equal hypotheses and 0 for certainty', () => {
    expect(entropy(uniform)).toBeCloseTo(2, 12)
    expect(entropy({ a: 1, b: 0 })).toBe(0)
  })
  it('predictive probabilities over the bins sum to 1', () => {
    for (const it2 of water.items) {
      let s = 0
      for (let b = 0; b < binCount(it2.scale); b++) s += predictiveProbability(uniform, water.hypotheses, it2, b)
      expect(s).toBeCloseTo(1, 9)
    }
  })
  it('never increases in expectation (a measurement cannot be expected to add uncertainty)', () => {
    for (const f of [water, getFamily('fire')!, getFamily('structures')!, getFamily('vegetation_loss')!]) {
      const p = Object.fromEntries(f.hypotheses.map((h) => [h.id, h.defaultPrior]))
      for (const it2 of f.items) {
        if (it2.lrCap) continue // a capped update is not exact Bayes
        expect(expectedEntropyAfter(p, f.hypotheses, it2, binCount(it2.scale))).toBeLessThanOrEqual(entropy(p) + 1e-9)
      }
    }
  })
})
