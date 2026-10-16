import type {
  Bbox,
  CorroborationSource,
  DiscoveryCell,
  Hypothesis,
  InvestigationEvent,
} from '@/lib/investigation-events'
import type { GeoResultStatus } from '@/lib/geo-result'

/**
 * What the board shows, built by folding the event stream. Pure: the same events always give the
 * same state, which is what makes the recorded-fixture preview a faithful test of the live board.
 */

type EvidenceFields = Extract<InvestigationEvent, { type: 'evidence' }>

export interface StepEntry {
  n: number
  op: string
  /** The catalogue's name for the check ("Long-term water occurrence (JRC, 1984-2021)"). */
  title?: string
  why: string
  voi: number
  evidence?: {
    resultId: string
    summary: string
    features: Record<string, number>
    status: GeoResultStatus
    /** The structured reading, when the check measured something. */
    measured?: EvidenceFields['measured']
    reason?: EvidenceFields['reason']
    feature?: EvidenceFields['feature']
  }
}

export interface BeliefPoint {
  n: number
  posteriors: Record<string, number>
}

export interface InvestigationState {
  status: 'idle' | 'running' | 'done' | 'error'
  discovery?: { cells: DiscoveryCell[]; chosen: number }
  hypotheses: Hypothesis[]
  steps: StepEntry[]
  /** One point per belief update, in order. */
  beliefs: BeliefPoint[]
  corroboration?: { sources: CorroborationSource[]; note: string }
  verdict?: Extract<InvestigationEvent, { type: 'verdict' }>
  dossier?: { summary: string; runId: string }
  error?: string
}

export const INITIAL_INVESTIGATION: InvestigationState = {
  status: 'idle',
  hypotheses: [],
  steps: [],
  beliefs: [],
}

/** A hypothesis counts as ruled out once its probability falls below this. */
export const RULED_OUT_BELOW = 0.05

export function reduceInvestigation(state: InvestigationState, e: InvestigationEvent): InvestigationState {
  switch (e.type) {
    case 'discovery':
      return { ...state, status: 'running', discovery: { cells: e.cells, chosen: e.chosen } }
    case 'hypotheses':
      return { ...state, status: 'running', hypotheses: e.items }
    case 'step': {
      const rest = state.steps.filter((s) => s.n !== e.n)
      return { ...state, status: 'running', steps: [...rest, { n: e.n, op: e.op, title: e.title, why: e.why, voi: e.voi }].sort((a, b) => a.n - b.n) }
    }
    case 'evidence': {
      const evidence = { resultId: e.resultId, summary: e.summary, features: e.features, status: e.status, measured: e.measured, reason: e.reason, feature: e.feature }
      const has = state.steps.some((s) => s.n === e.n)
      // Evidence can arrive without its step event (a dropped event): keep it rather than lose it.
      const steps = has
        ? state.steps.map((s) => (s.n === e.n ? { ...s, evidence } : s))
        : [...state.steps, { n: e.n, op: 'unknown step', why: '', voi: 0, evidence }].sort((a, b) => a.n - b.n)
      return { ...state, status: 'running', steps }
    }
    case 'belief':
      return { ...state, status: 'running', beliefs: [...state.beliefs.filter((b) => b.n !== e.n), { n: e.n, posteriors: e.posteriors }].sort((a, b) => a.n - b.n) }
    case 'corroboration':
      return { ...state, corroboration: { sources: e.sources, note: e.note } }
    case 'verdict':
      return { ...state, verdict: e }
    case 'dossier':
      return { ...state, status: 'done', dossier: { summary: e.summary, runId: e.runId } }
    case 'error':
      return { ...state, status: 'error', error: e.message }
  }
}

export function foldEvents(events: InvestigationEvent[]): InvestigationState {
  return events.reduce(reduceInvestigation, INITIAL_INVESTIGATION)
}

/** Probability per hypothesis now: the latest belief update, or the priors before the first. */
export function currentBelief(state: InvestigationState): Record<string, number> {
  const last = state.beliefs[state.beliefs.length - 1]
  if (last) return last.posteriors
  return Object.fromEntries(state.hypotheses.map((h) => [h.id, h.prior]))
}

export interface RuledOut {
  hypothesis: Hypothesis
  probability: number
  /** The update that took it furthest down, and what that evidence was; both from the stream. */
  fromProbability: number
  step?: StepEntry
}

/** Hypotheses now below the threshold, each with the single update that cost it the most.
 *  The reason is read off the recorded updates, not written by the board. */
export function ruledOut(state: InvestigationState): RuledOut[] {
  const now = currentBelief(state)
  const out: RuledOut[] = []
  for (const h of state.hypotheses) {
    const p = now[h.id] ?? 0
    if (p >= RULED_OUT_BELOW) continue
    let prev = h.prior
    let worst = { drop: 0, from: h.prior, n: -1 }
    for (const b of state.beliefs) {
      const q = b.posteriors[h.id] ?? prev
      if (prev - q > worst.drop) worst = { drop: prev - q, from: prev, n: b.n }
      prev = q
    }
    out.push({ hypothesis: h, probability: p, fromProbability: worst.from, step: state.steps.find((s) => s.n === worst.n) })
  }
  return out.sort((a, b) => a.probability - b.probability)
}

/** Hypotheses still in play, most probable first. */
export function leading(state: InvestigationState): Array<{ hypothesis: Hypothesis; probability: number }> {
  const now = currentBelief(state)
  return state.hypotheses
    .map((hypothesis) => ({ hypothesis, probability: now[hypothesis.id] ?? 0 }))
    .filter((r) => r.probability >= RULED_OUT_BELOW)
    .sort((a, b) => b.probability - a.probability)
}

export function chosenCell(state: InvestigationState): Bbox | null {
  const d = state.discovery
  return d ? d.cells[d.chosen]?.bbox ?? null : null
}

const pct = (p: number) => `${Math.round(p * 100)}%`
const lowerFirst = (t: string) => (t.length > 1 && t[1] === t[1].toLowerCase() ? t[0].toLowerCase() + t.slice(1) : t)

/** What a check is called: the catalogue title, else the operation's name. */
export function checkName(step: Pick<StepEntry, 'op' | 'title'>): string {
  return step.title?.trim() || step.op.replace(/_/g, ' ')
}

function fmtReading(f: NonNullable<NonNullable<StepEntry['evidence']>['feature']>): string {
  const v = typeof f.value === 'number' ? Number(f.value.toPrecision(3)).toLocaleString('en-US') : String(f.value)
  return f.unit && f.unit !== 'category' ? `${v} ${f.unit}` : v
}

/** One plain line for what a check found, built from the event's structured fields (the measured
 *  feature, its status and reason), never by reading the result's prose. The raw summary and the
 *  dataset line stay behind the "Details" disclosure. Empty before the result arrives. */
export function checkFinding(step: StepEntry): string {
  const ev = step.evidence
  if (!ev) return ''
  if (ev.feature) return `Measured ${fmtReading(ev.feature)}${ev.feature.bin ? ` (${ev.feature.bin})` : ''}.`
  if (ev.status === 'refused' || ev.status === 'failed') return `Could not be measured${ev.reason ? `: ${ev.reason}` : '.'}`
  if (ev.status === 'flagged') return `Result flagged, not used${ev.reason ? `: ${ev.reason}` : '.'}`
  if (ev.measured === false) return `Nothing measured${ev.reason ? `: ${ev.reason}` : '.'}`
  return 'Result recorded.'
}

/** The reason line for a ruled-out hypothesis: the check that cost it most, what that check read,
 *  and the belief before and after, all from the recorded events. */
export function ruledOutReason(r: RuledOut): string {
  if (!r.step) return `Never rose above ${pct(Math.max(r.hypothesis.prior, r.probability))}.`
  const f = r.step.evidence?.feature
  return `Ruled out after ${lowerFirst(checkName(r.step))}${f ? `: read ${fmtReading(f)}` : ''} (${pct(r.fromProbability)} \u2192 ${pct(r.probability)}).`
}
