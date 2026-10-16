/**
 * The events `POST /api/investigate` streams, as the InvestigationBoard consumes them.
 *
 * PROVISIONAL CONTRACT. The backend is being written in parallel; this file is the one place the
 * board's assumptions live, so adjusting the contract means editing this file and
 * `components/investigate/state.ts`, nothing else.
 *
 * Wire format: server-sent events, `event: <type>` plus `data: <json>`, as `/api/agent` does. The
 * payload may repeat `type` or leave it out; the event name wins. Assumptions the backend should
 * confirm:
 *   - `discovery.chosen` is an index into `discovery.cells`.
 *   - `step.n`, `evidence.n` and `belief.n` share one numbering: `n` ties an evidence item and the
 *     belief update it caused to the step that was chosen. `step.voi` is the expected value of
 *     information of that step (larger = more expected to separate the hypotheses).
 *   - `belief.posteriors` maps hypothesis id to probability, summing to about 1.
 *   - `verdict.decidingEvidence` lists the `n` of the evidence items the verdict rests on.
 *   - `corroboration.sources[].inWindow` says the article's date falls in the event window.
 *   - `dossier.runId` is an evidence-ledger run id (`/api/ledger/:runId/...`).
 * A request body of `{ aoi, question? }` (the AOI as GeoJSON geometry) is assumed.
 */

import type { GeoResultStatus } from '@/lib/geo-result'

export type Bbox = [number, number, number, number]

/** The server's own event types (src/app/api/agent/investigator/events.ts) are the source of truth.
 *  The board reads a subset of them, so each type here is that server type narrowed to the fields
 *  the board uses, with the rest optional (a recorded fixture does not carry them). */
import type {
  CorroborationSource as ServerSource,
  DiscoveryCell as ServerCell,
  EvidenceEvent,
  HypothesisState,
  StepEvent,
} from '@/app/api/agent/investigator/events'

export interface DiscoveryCell extends Partial<Pick<ServerCell, 'id' | 'area_km2' | 'rank' | 'reason' | 'mean_ndvi_delta'>> {
  bbox: Bbox
  /** Share of changed clear pixels; null when the cell could not be read. Never drawn as 0. */
  score: number | null
}

export type Hypothesis = HypothesisState

/** A corroborating source. `date` is '' when the source gave no date; `inWindow` is then false. */
export type CorroborationSource = Pick<ServerSource, 'title' | 'url' | 'publisher' | 'date' | 'inWindow'>

/** Events the run shares with /api/agent: the existing handler applies them to the map and charts. */
export const AGENT_PASSTHROUGH = ['tool_call', 'layer', 'chart', 'zoom_to', 'ledger', 'thinking'] as const

export type InvestigationEvent =
  | { type: 'discovery'; cells: DiscoveryCell[]; /** index into cells; -1 when none could be scored */ chosen: number }
  | { type: 'hypotheses'; items: Hypothesis[] }
  | ({ type: 'step'; n: number; op: string; why: string; voi: number } & Partial<Pick<StepEvent, 'title'>>)
  | ({ type: 'evidence'; n: number; resultId: string; summary: string; features: Record<string, number>; status: GeoResultStatus | EvidenceEvent['status'] } & Partial<Pick<EvidenceEvent, 'measured' | 'reason' | 'feature' | 'caveat'>>)
  | { type: 'belief'; n: number; posteriors: Record<string, number> }
  | { type: 'corroboration'; sources: CorroborationSource[]; note: string; status?: 'grounded' | 'no_sources' | 'failed' }
  | { type: 'verdict'; kind: 'hypothesis' | 'cannot_determine'; id?: string | null; label: string; posterior: number; decidingEvidence?: number[] }
  | { type: 'dossier'; summary: string; runId: string }
  | { type: 'error'; message: string; content?: string }

export type InvestigationEventType = InvestigationEvent['type']

export const INVESTIGATION_EVENT_TYPES: readonly InvestigationEventType[] = [
  'discovery', 'hypotheses', 'step', 'evidence', 'belief', 'corroboration', 'verdict', 'dossier', 'error',
]

/** Parse one SSE block into an event, or null when it is not a well-formed event of this contract.
 *  The checks are structural only: enough that the reducer never reads a missing field. */
export function parseInvestigationEvent(name: string, data: string): InvestigationEvent | null {
  let raw: unknown
  try {
    raw = JSON.parse(data)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const type = (INVESTIGATION_EVENT_TYPES as readonly string[]).includes(name) ? name : (raw as { type?: string }).type
  if (!type || !(INVESTIGATION_EVENT_TYPES as readonly string[]).includes(type)) return null
  const e = { ...(raw as Record<string, unknown>), type } as Record<string, unknown>
  const isArr = Array.isArray
  const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  const isStr = (v: unknown) => typeof v === 'string'
  const isRec = (v: unknown) => !!v && typeof v === 'object' && !isArr(v)
  switch (type) {
    case 'discovery': return isArr(e.cells) && isNum(e.chosen) ? (e as unknown as InvestigationEvent) : null
    case 'hypotheses': return isArr(e.items) ? (e as unknown as InvestigationEvent) : null
    case 'step': return isNum(e.n) && isStr(e.op) ? (e as unknown as InvestigationEvent) : null
    case 'evidence': return isNum(e.n) && isStr(e.resultId) && isRec(e.features) ? (e as unknown as InvestigationEvent) : null
    case 'belief': return isNum(e.n) && isRec(e.posteriors) ? (e as unknown as InvestigationEvent) : null
    case 'corroboration': return isArr(e.sources) ? (e as unknown as InvestigationEvent) : null
    case 'verdict': return isStr(e.kind) && isStr(e.label) && isNum(e.posterior) ? (e as unknown as InvestigationEvent) : null
    case 'dossier': return isStr(e.runId) ? (e as unknown as InvestigationEvent) : null
    case 'error': return isStr(e.message) ? (e as unknown as InvestigationEvent) : null
    default: return null
  }
}
