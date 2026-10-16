/**
 * The belief engine: pure functions over posteriors, the catalogue's predictions and a measured
 * outcome. The model never computes a number here; it only proposes which catalogue hypotheses
 * apply and how plausible each looks beforehand (`proposePriors` bounds that).
 *
 * Update. A measured value falls in one bin of the item's scale. Hypothesis h predicted that bin
 * with probability P(bin | h), so its likelihood ratio is P(bin | h) / P(bin | not h), where the
 * "not h" side is the other hypotheses weighted by the current posterior. Adding ln(ratio) to
 * ln-odds(h) and renormalising is exactly Bayes' rule over the hypothesis set. Items may cap the
 * ratio (a vision reading to 0.5-2, a mapped-building count to 0.67-1.5); a capped update is no
 * longer exact, which is the point: it limits how far a weak instrument can move belief.
 */

import { MIN_PROB, type EvidenceItem, type Hypothesis } from './catalogue'

export type Posterior = Record<string, number>

export const PRIOR_MIN = 0.05
export const PRIOR_MAX = 0.6
/** Keeps ln-odds finite when a posterior reaches 0 or 1. */
const EPS = 1e-9

export const logit = (p: number) => Math.log(Math.max(p, EPS) / Math.max(1 - p, EPS))
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))

/** Shannon entropy in bits. */
export function entropy(p: Posterior): number {
  let h = 0
  for (const v of Object.values(p)) if (v > 0) h -= v * Math.log2(v)
  return h
}

export function normalise(p: Posterior): Posterior {
  const sum = Object.values(p).reduce((s, v) => s + v, 0)
  if (!(sum > 0)) throw new Error('cannot normalise: the weights sum to zero')
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v / sum]))
}

export function top(p: Posterior): { id: string; p: number } {
  let best = { id: '', p: -1 }
  for (const [id, v] of Object.entries(p)) if (v > best.p) best = { id, p: v }
  return best
}

// ---------------------------------------------------------------------------
// Priors
// ---------------------------------------------------------------------------

export interface ProposedHypothesis { id: string; prior: number }

export interface PriorResult {
  priors: Posterior
  /** Ids the model named that are not in the family's catalogue (rejected, never run). */
  rejected: string[]
  /** Ids whose prior was moved into [PRIOR_MIN, PRIOR_MAX]. */
  clamped: string[]
  /** True when fewer than two usable hypotheses were proposed and the catalogue defaults were used. */
  usedDefaults: boolean
}

/** Validate a model's proposal against the family: unknown ids rejected, priors clamped to
 *  [0.05, 0.6] and normalised. With fewer than two usable hypotheses, the family's own defaults. */
export function proposePriors(proposed: ProposedHypothesis[], hypotheses: Hypothesis[]): PriorResult {
  const known = new Map(hypotheses.map((h) => [h.id, h]))
  const rejected: string[] = []
  const clamped: string[] = []
  const raw: Posterior = {}
  for (const p of proposed) {
    if (!known.has(p.id)) { rejected.push(p.id); continue }
    if (p.id in raw) continue
    const prior = Number.isFinite(p.prior) ? p.prior : known.get(p.id)!.defaultPrior
    const c = Math.min(PRIOR_MAX, Math.max(PRIOR_MIN, prior))
    if (c !== prior) clamped.push(p.id)
    raw[p.id] = c
  }
  if (Object.keys(raw).length < 2) {
    return { priors: normalise(Object.fromEntries(hypotheses.map((h) => [h.id, h.defaultPrior]))), rejected, clamped: [], usedDefaults: true }
  }
  return { priors: normalise(raw), rejected, clamped, usedDefaults: false }
}

// ---------------------------------------------------------------------------
// Likelihoods and updates
// ---------------------------------------------------------------------------

/** P(bin | h) for every hypothesis still in play. */
function binProbability(h: Hypothesis, item: EvidenceItem, bin: number): number {
  const p = h.predicts[item.id]?.p[bin]
  return typeof p === 'number' ? Math.max(p, MIN_PROB) : 1 / Math.max(1, Object.keys(h.predicts).length)
}

/** P(outcome = bin) under the current posterior. */
export function predictiveProbability(posterior: Posterior, hypotheses: Hypothesis[], item: EvidenceItem, bin: number): number {
  return hypotheses.reduce((s, h) => s + (posterior[h.id] ?? 0) * binProbability(h, item, bin), 0)
}

/** The likelihood ratio of each hypothesis for an observed bin, after the item's cap. */
export function likelihoodRatios(posterior: Posterior, hypotheses: Hypothesis[], item: EvidenceItem, bin: number): { ratios: Record<string, number>; capped: boolean } {
  const ratios: Record<string, number> = {}
  let capped = false
  for (const h of hypotheses) {
    const pi = Math.min(1 - EPS, Math.max(EPS, posterior[h.id] ?? 0))
    const against = hypotheses.reduce((s, k) => (k.id === h.id ? s : s + (posterior[k.id] ?? 0) * binProbability(k, item, bin)), 0) / (1 - pi)
    let lr = binProbability(h, item, bin) / Math.max(against, EPS)
    if (item.lrCap) {
      const c = Math.min(item.lrCap[1], Math.max(item.lrCap[0], lr))
      if (c !== lr) capped = true
      lr = c
    }
    ratios[h.id] = lr
  }
  return { ratios, capped }
}

/** Add ln(ratio) to each hypothesis's ln-odds, then renormalise the set to 1. */
export function applyRatios(posterior: Posterior, ratios: Record<string, number>): Posterior {
  const next: Posterior = {}
  for (const [id, p] of Object.entries(posterior)) next[id] = sigmoid(logit(p) + Math.log(ratios[id] ?? 1))
  return normalise(next)
}

export interface BeliefUpdate {
  posterior: Posterior
  ratios: Record<string, number>
  capped: boolean
}

export function updateBeliefs(posterior: Posterior, hypotheses: Hypothesis[], item: EvidenceItem, bin: number): BeliefUpdate {
  const { ratios, capped } = likelihoodRatios(posterior, hypotheses, item, bin)
  return { posterior: applyRatios(posterior, ratios), ratios, capped }
}

/** Posterior entropy after observing `bin`, weighted by how likely each bin is: the expected
 *  entropy of running an item. */
export function expectedEntropyAfter(posterior: Posterior, hypotheses: Hypothesis[], item: EvidenceItem, nBins: number): number {
  let expected = 0
  for (let bin = 0; bin < nBins; bin++) {
    const pBin = predictiveProbability(posterior, hypotheses, item, bin)
    if (pBin <= 0) continue
    expected += pBin * entropy(updateBeliefs(posterior, hypotheses, item, bin).posterior)
  }
  return expected
}
