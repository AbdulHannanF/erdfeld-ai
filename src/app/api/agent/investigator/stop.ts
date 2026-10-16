/** Stopping rule and verdict. Pure; every threshold is a named constant. */

import { top, type Posterior } from './belief'

export const STOP_CONFIDENT = 0.85
export const STOP_FLAT_RANGE = 0.03
export const MAX_EVIDENCE_OPS = 6
export const VERDICT_MIN = 0.6
export const DEFAULT_TIME_BUDGET_MS = 180_000

export type StopReason = 'confident' | 'converged' | 'op_budget' | 'time_budget' | 'no_informative_evidence' | 'aborted'

export interface StopInput {
  posterior: Posterior
  /** The leading hypothesis after the priors and after each step that actually measured something. */
  history: Array<{ id: string; p: number }>
  /** Evidence items actually measured. With none, belief is still the model's priors and nothing may be concluded from it. */
  measured: number
  /** Of those, items that observed the event window (see `observesWindow`). Archive baselines, pre-window scenes and
   *  quality checks move belief but cannot confirm that something happened in the window. */
  windowMeasured: number
  opsRun: number
  elapsedMs: number
  budgetMs: number
  /** The best value of information among items still runnable, in bits (0 when none). */
  bestVoi: number
  minVoi: number
  aborted?: boolean
}

/** Why to stop now, or null to go on. Checked in this order. */
export function shouldStop(i: StopInput): StopReason | null {
  if (i.aborted) return 'aborted'
  if (i.windowMeasured > 0 && top(i.posterior).p >= STOP_CONFIDENT) return 'confident'
  // A step that measured nothing leaves belief unchanged; it must not look like convergence,
  // so the history holds measuring steps only.
  const last3 = i.history.slice(-3)
  if (last3.length === 3 && last3.every((h) => h.id === last3[0].id)) {
    const ps = last3.map((h) => h.p)
    if (Math.max(...ps) - Math.min(...ps) < STOP_FLAT_RANGE) return 'converged'
  }
  if (i.opsRun >= MAX_EVIDENCE_OPS) return 'op_budget'
  if (i.elapsedMs >= i.budgetMs) return 'time_budget'
  if (i.bestVoi < i.minVoi) return 'no_informative_evidence'
  return null
}

export function timeBudgetMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.INVESTIGATOR_TIME_BUDGET_MS)
  return Number.isFinite(n) && n >= 5_000 ? n : DEFAULT_TIME_BUDGET_MS
}

export type Verdict =
  | { kind: 'hypothesis'; id: string; posterior: number }
  | { kind: 'cannot_determine'; leading: { id: string; posterior: number } }

/** The top hypothesis when its posterior reaches 0.6, otherwise "Cannot determine". Priors alone never decide, and
 *  neither does evidence that never looked at the window: with no measurement from inside it the answer is "Cannot determine". */
export function decide(posterior: Posterior, windowMeasured: number): Verdict {
  const t = top(posterior)
  return windowMeasured > 0 && t.p >= VERDICT_MIN ? { kind: 'hypothesis', id: t.id, posterior: t.p } : { kind: 'cannot_determine', leading: { id: t.id, posterior: t.p } }
}
