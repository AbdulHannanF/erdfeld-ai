/** Client-safe shapes and helpers for batch input (Q-28): the rows of a batch, their summary and
 *  the colours the map and table share. */

import { CATEGORICAL_PALETTE } from '@/lib/categorical-palette'
import type { CaseVerdict } from '@/lib/case-view'

export interface BatchProgress { total: number; queued: number; running: number; done: number; failed: number }

export type RowStatus = 'queued' | 'running' | 'done' | 'failed'

export interface BatchRow {
  idx: number
  name: string
  status: RowStatus
  attempts: number
  /** Why the job failed or is waiting for a retry; null otherwise. */
  error: string | null
  geometry: GeoJSON.Geometry
  /** Present once the case exists. */
  case_id: string | null
  verdict: CaseVerdict | null
  confidence: number | null
  kind: string | null
  reason: string | null
  recipe: string | null
  run_id: string | null
  params: Record<string, string | number> | null
}

export interface BatchView {
  id: string
  label: string | null
  created_at: string
  claim_type: string
  recipe_title: string | null
  state: 'active' | 'finished'
  progress: BatchProgress
  rows: BatchRow[]
}

/** Verdict colours on the map and in the table: data colours from the categorical palette (never the
 *  brand teal), and Cannot determine a neutral grey so an abstention never looks like a finding. */
export const VERDICT_COLOR: Record<CaseVerdict, string> = {
  supported: CATEGORICAL_PALETTE[0],
  contradicted: CATEGORICAL_PALETTE[1],
  cannot_determine: '#8C9399',
}
/** A plot with no verdict yet (queued, running) or none at all (the job failed). */
export const PENDING_COLOR = '#5B6368'

export interface BatchCounts {
  supported: number
  contradicted: number
  cannot_determine: number
  /** Cannot determine by abstention kind. */
  by_kind: Record<string, number>
  pending: number
  failed: number
}

/** The summary the batch view and the tests share. */
export function summarize(rows: BatchRow[]): BatchCounts {
  const c: BatchCounts = { supported: 0, contradicted: 0, cannot_determine: 0, by_kind: {}, pending: 0, failed: 0 }
  for (const r of rows) {
    if (r.verdict) {
      c[r.verdict]++
      if (r.verdict === 'cannot_determine') c.by_kind[r.kind ?? 'unspecified'] = (c.by_kind[r.kind ?? 'unspecified'] ?? 0) + 1
    } else if (r.status === 'failed') c.failed++
    else c.pending++
  }
  return c
}
