/**
 * The SSE contract of `POST /api/investigate`, as types for the UI.
 *
 * Each event is sent as `event: <name>` with a JSON `data:` body carrying the same `type`. The
 * run also sends the events `/api/agent` sends for what its operations produce (`tool_call`,
 * `layer`, `chart`, `zoom_to`, `ledger`), with the same shapes, so the existing map and
 * citation pills render them unchanged. Every run ends with `done`; a failure sends `error`
 * first.
 *
 * Order: [discovery] hypotheses, then per step `step`, [`tool_call`/`layer`/`chart`], `evidence`,
 * `belief`; then `verdict`, `corroboration`, `ledger`, `dossier`, `done`.
 */

import type { FamilyId } from './catalogue'

/** [west, south, east, north] */
export type Bbox = [number, number, number, number]

export type StopReasonName = 'confident' | 'converged' | 'op_budget' | 'time_budget' | 'no_informative_evidence' | 'aborted'

export interface DiscoveryCell {
  id: string
  bbox: Bbox
  area_km2: number
  /** Share of clear pixels whose NDVI changed by more than 0.05; null when the cell could not be scored. */
  score: number | null
  mean_ndvi_delta: number | null
  result_id: string | null
  /** Why a cell has no score. A failed read is not a score of zero. */
  reason?: string
  rank: number | null
}

export interface DiscoveryEvent {
  type: 'discovery'
  measure: string
  window: { start: string; end: string }
  cells: DiscoveryCell[]
  /** Index into `cells` of the cell investigated next; -1 when no cell could be scored. */
  chosen: number
  /** Id of that cell, or null. */
  chosen_cell: string | null
}

export interface HypothesisState {
  id: string
  label: string
  /** The hypothesis family's title (the board groups by it). */
  family: string
  prior: number
}

export interface HypothesesEvent {
  type: 'hypotheses'
  family: FamilyId
  family_title: string
  window: { start: string; end: string }
  window_source: 'request' | 'model' | 'default'
  items: HypothesisState[]
  /** Ids the model proposed that are not in the catalogue. */
  rejected_ids: string[]
  /** Ids whose prior was moved into [0.05, 0.6]. */
  clamped_ids: string[]
  /** True when the model proposed nothing usable and the catalogue's own priors are used. */
  used_default_priors: boolean
  /** Why the defaults or the hint were used instead of the model (e.g. the model call failed). */
  note?: string
  calibration_note: string
}

export interface StepEvent {
  type: 'step'
  /** One numbering for step, evidence and belief of the same operation. */
  n: number
  item_id: string
  title: string
  op: string
  args: Record<string, unknown>
  /** One sentence for display only, written by the model (or a fixed sentence when it is unavailable). It changes no number. */
  why: string
  why_source: 'model' | 'rule'
  /** Expected entropy reduction in bits. */
  voi: number
  cost_s: number
  /** True when the result of an identical earlier run is reused (no new operation). */
  reused: boolean
  considered: Array<{ item_id: string; voi: number; cost_s: number }>
  skipped: Array<{ item_id: string; reason: string }>
}

export interface EvidenceEvent {
  type: 'evidence'
  n: number
  item_id: string
  op: string
  resultId: string
  status: 'ok' | 'flagged' | 'refused' | 'failed'
  /** Numeric measured features by name (empty when nothing was measured or the feature is a category). */
  features: Record<string, number>
  summary: string
  /** False when nothing could be measured: the result did not run, was flagged, or lacked the figure. It did not update belief. */
  measured: boolean
  reason?: string
  feature?: {
    name: string
    value: number | string
    unit: string
    /** The raw stats field it was read from; cite as `[[result_id#field]]`. */
    field: string
    derivation: string
    bin: string
  }
  /** Per-hypothesis likelihood ratio applied. */
  likelihood_ratios?: Record<string, number>
  /** True when the item's cap limited a ratio (vision readings, mapped-building counts). */
  capped?: boolean
  /** For a vision item: the category the model chose from the catalogue's list. */
  vision_category?: string
  caveat?: string
}

export interface BeliefRow {
  id: string
  label: string
  p: number
  /** Change since the previous step. */
  delta: number
}

export interface BeliefEvent {
  type: 'belief'
  n: number
  /** Hypothesis id to probability. */
  posteriors: Record<string, number>
  /** False when this step could not be measured and belief is unchanged. */
  updated: boolean
  posterior: BeliefRow[]
  leading: string
  entropy_bits: number
}

export interface CorroborationSource {
  title: string
  url: string
  publisher: string
  /** YYYY-MM-DD as reported by the search-grounded model; null when it gave none. Not verified. */
  /** YYYY-MM-DD as reported by the search-grounded model; empty when it gave none. Not verified. */
  date: string
  /** False when the date is outside the window or unknown (see days_from_window). */
  inWindow: boolean
  /** Days outside the window (0 when inside); null when the date is unknown. */
  days_from_window: number | null
}

export interface CorroborationEvent {
  type: 'corroboration'
  /** `grounded`: sources found by web search. `no_sources`: search ran, nothing relevant. `failed`: search could not run. */
  status: 'grounded' | 'no_sources' | 'failed'
  /** Context only. Sources never change a posterior. */
  role: 'context'
  query: string
  sources: CorroborationSource[]
  note: string
}

export interface MissingEvidence {
  item_id: string
  title: string
  decides: string
  voi: number
  why_not: string
}

export interface VerdictEvent {
  type: 'verdict'
  /** `hypothesis`: the top posterior reached 0.6. `cannot_determine`: it did not. */
  kind: 'hypothesis' | 'cannot_determine'
  /** Hypothesis id; null for cannot_determine. */
  id: string | null
  /** `n` of the evidence items the verdict rests on (measured ones). */
  decidingEvidence: number[]
  label: string
  posterior: number
  runner_up: { id: string; label: string; p: number } | null
  stop_reason: StopReasonName
  evidence_ops_run: number
  items_measured: number
  items_unmeasured: number
  /** For `cannot_determine`: what would decide it. Present (possibly empty) in both cases. */
  evidence_that_would_decide: MissingEvidence[]
  calibration_note: string
}

export interface DossierEvidenceRow {
  item_id: string
  title: string
  op: string
  result_id: string
  measured: boolean
  value: number | string | null
  field: string | null
  unit: string
  bin: string | null
  reason: string | null
}

export interface DossierEvent {
  type: 'dossier'
  /** Markdown. Every number cites `[[result_id#field]]`. */
  summary: string
  summary_source: 'model' | 'recorded-results'
  /** Sentences removed because they had a number without a valid citation. */
  sentences_dropped: number
  family: FamilyId
  window: { start: string; end: string }
  bbox: Bbox
  final_posterior: BeliefRow[]
  evidence: DossierEvidenceRow[]
  skipped: Array<{ item_id: string; reason: string }>
  limits: string[]
  corroboration: Omit<CorroborationEvent, 'type'>
  /** Tokens the run's model calls used (provider-reported); null when the provider does not report them. */
  tokens?: { calls: number; promptTokens: number; outputTokens: number; thoughtTokens: number; cachedTokens: number } | null
  timings_ms: { total: number; discovery?: number; investigation: number; corroboration: number }
  /** Evidence-ledger run id; empty when the evidence store is unavailable. */
  runId: string
}

export interface ErrorEvent {
  type: 'error'
  /** The contract's field. */
  message: string
  /** The field `/api/agent` uses, so the map page's existing handler also shows it. */
  content: string
}

export interface DoneEvent {
  type: 'done'
}

/** Events shared with `/api/agent` (same shapes; see `src/lib/layer-event.ts` and `loop.ts`). */
export interface SharedEvents {
  tool_call: Record<string, unknown>
  layer: Record<string, unknown>
  chart: { type: 'chart'; chart_id: string; title?: string; spec: unknown; layer_id?: string; result_id: string }
  zoom_to: { type: 'zoom_to'; bbox: Bbox }
  ledger: { type: 'ledger'; run_id: string }
}

export interface InvestigateEvents extends SharedEvents {
  discovery: DiscoveryEvent
  hypotheses: HypothesesEvent
  step: StepEvent
  evidence: EvidenceEvent
  belief: BeliefEvent
  corroboration: CorroborationEvent
  verdict: VerdictEvent
  dossier: DossierEvent
  error: ErrorEvent
  done: DoneEvent
}

export type InvestigateEmit = <K extends keyof InvestigateEvents>(event: K, data: InvestigateEvents[K]) => void
