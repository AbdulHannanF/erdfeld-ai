/** Client-side shapes and helpers for the case view (the JSON `GET /api/cases/:id` returns). */

export type CaseVerdict = 'supported' | 'contradicted' | 'cannot_determine'

export interface CaseTimelineEntry {
  step: number
  op: string
  version: string
  status: string
  date: string | null
  result_id: string | null
  stats: Record<string, number | string>
  summary: string | null
}

export interface CaseViewData {
  id: string
  claim_type: string
  claim: string
  recipe: string
  verdict: CaseVerdict
  confidence: number | null
  decision: { rule: string; reason: string; kind?: string; inputs: Record<string, number | string | null> }
  params: Record<string, string | number>
  geometry: GeoJSON.Geometry
  run_id: string | null
  created_at: string
  timeline: CaseTimelineEntry[]
  explain: Array<{ text: string; cites: string[] }>
  bundle_url: string | null
}

export const VERDICT_LABEL: Record<CaseVerdict, string> = {
  supported: 'Supported',
  contradicted: 'Contradicted',
  cannot_determine: 'Cannot determine',
}

/** Theme-following text and fill classes per verdict (semantic tokens only). */
export const VERDICT_CLASS: Record<CaseVerdict, string> = {
  supported: 'border-leaf-500/50 bg-leaf-500/15 text-leaf-text',
  contradicted: 'border-destructive/50 bg-destructive/10 text-destructive',
  cannot_determine: 'border-aqua-500/40 bg-aqua-500/10 text-aqua-text',
}

export const ABSTAIN_LABEL: Record<string, string> = {
  fetch_failed: 'A data source could not be read',
  data_unavailable: 'No usable data for this plot and date',
  insufficient_quality: 'Too little clear or covering data',
  out_of_scope: 'Outside what the sensor can resolve',
  inconclusive: 'Signal neither for nor against',
}
