/**
 * Evidence selection by value of information.
 *
 * For each item not yet run, the value of information is the expected entropy reduction (bits)
 * under the catalogue's per-hypothesis predicted outcome distribution: how much running it is
 * expected to sharpen the posterior. Items are ranked by that value per unit of cost, after the
 * conditions that make an item pointless or impossible have removed it. Nothing here is written
 * by a model, so "radar rather than optical because the sky is cloudy" is not a prompt: an
 * optical item is removed when an optical result has reported cloud, and the radar item is what
 * remains with value.
 */

import { binCount, type EvidenceItem, type Family, type Hypothesis } from './catalogue'
import { entropy, expectedEntropyAfter, type Posterior } from './belief'

/** An item must be expected to remove at least this much entropy to be worth running. */
export const MIN_VOI_BITS = 0.01
/** Seconds added to every item's cost so a free item does not get an infinite score. */
export const COST_FLOOR_S = 10

export interface OpInfo {
  available: boolean
  earliest?: string
  maxAreaKm2?: number
  typicalSeconds: number
}

export interface Facts {
  /** An optical result reported too much cloud, so more optical items cannot help. */
  opticalBlocked: boolean
  opticalBlockedReason?: string
}

export interface Situation {
  window: { start: string; end: string }
  areaKm2: number
  now: number
  facts: Facts
  opInfo: (op: string) => OpInfo
}

export type Applicability = { runnable: true } | { runnable: false; reason: string }

const DAY_MS = 86_400_000
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY_MS

/** Can this item be run in this situation? Conditions only; value is judged separately. */
export function applicability(item: EvidenceItem, sit: Situation): Applicability {
  const op = sit.opInfo(item.op)
  if (!op.available) return { runnable: false, reason: `${item.op} is not available in this deployment` }
  if (op.earliest && sit.window.start < op.earliest) return { runnable: false, reason: `${item.op} has no data before ${op.earliest}, and the window starts ${sit.window.start}` }
  if (op.maxAreaKm2 !== undefined && sit.areaKm2 > op.maxAreaKm2) return { runnable: false, reason: `${item.op} is limited to ${op.maxAreaKm2} km2 and the area is ${sit.areaKm2.toFixed(0)} km2` }
  if (item.minWindowDays !== undefined && days(sit.window.start, sit.window.end) < item.minWindowDays) return { runnable: false, reason: `needs a window of at least ${item.minWindowDays} days` }
  if (item.liveWithinDays !== undefined) {
    const age = (sit.now - Date.parse(sit.window.end)) / DAY_MS
    if (age > item.liveWithinDays) return { runnable: false, reason: `${item.op} is a near-real-time source covering only the last ${item.liveWithinDays} days, and the window ended ${Math.round(age)} days ago` }
  }
  if (item.sensor === 'optical' && sit.facts.opticalBlocked) return { runnable: false, reason: `optical imagery is cloud-limited here (${sit.facts.opticalBlockedReason ?? 'an optical result reported cloud'})` }
  return { runnable: true }
}

/** Expected entropy reduction in bits from running the item. */
export function valueOfInformation(posterior: Posterior, hypotheses: Hypothesis[], item: EvidenceItem): number {
  return Math.max(0, entropy(posterior) - expectedEntropyAfter(posterior, hypotheses, item, binCount(item.scale)))
}

export interface Candidate {
  item: EvidenceItem
  voi: number
  costS: number
  score: number
}

export interface Selection {
  chosen: Candidate | null
  /** Every runnable item with positive value, best first. */
  candidates: Candidate[]
  skipped: Array<{ item_id: string; reason: string }>
}

/**
 * `done` holds the ids of items already read. `runKeyOf` identifies a distinct execution so an
 * item that reads a result already in hand costs nothing; `executed` is the set of those keys.
 */
export function selectNext(
  family: Family,
  posterior: Posterior,
  done: Set<string>,
  executed: Set<string>,
  runKeyOf: (item: EvidenceItem) => string,
  sit: Situation,
): Selection {
  const hypotheses = family.hypotheses.filter((h) => h.id in posterior)
  const candidates: Candidate[] = []
  const skipped: Selection['skipped'] = []
  for (const item of family.items) {
    if (done.has(item.id)) continue
    const ok = applicability(item, sit)
    if (!ok.runnable) { skipped.push({ item_id: item.id, reason: ok.reason }); continue }
    const voi = valueOfInformation(posterior, hypotheses, item)
    if (voi < MIN_VOI_BITS) continue
    const costS = executed.has(runKeyOf(item)) ? 0 : sit.opInfo(item.op).typicalSeconds
    candidates.push({ item, voi, costS, score: voi / (costS + COST_FLOOR_S) })
  }
  candidates.sort((a, b) => b.score - a.score)
  return { chosen: candidates[0] ?? null, candidates, skipped }
}

export interface Missing {
  item_id: string
  title: string
  decides: string
  voi: number
  /** Why it was not obtained: skipped by a condition, could not be measured, or never reached. */
  why_not: string
}

/** The evidence that would decide the question: the items with the most value left at the final
 *  posterior, whether or not they could be run here. */
export function whatWouldDecide(family: Family, posterior: Posterior, whyNot: (item: EvidenceItem) => string | null, limit = 3): Missing[] {
  const hypotheses = family.hypotheses.filter((h) => h.id in posterior)
  const out: Missing[] = []
  for (const item of family.items) {
    const why = whyNot(item)
    if (why === null) continue
    const voi = valueOfInformation(posterior, hypotheses, item)
    if (voi >= MIN_VOI_BITS) out.push({ item_id: item.id, title: item.title, decides: item.decides, voi, why_not: why })
  }
  return out.sort((a, b) => b.voi - a.voi).slice(0, limit)
}
