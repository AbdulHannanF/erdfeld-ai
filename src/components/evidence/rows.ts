import type { LedgerExport } from '@/app/api/agent/engine/ledger'
import type { CitableToolResult } from '@/lib/citations'
import type { ToolCallStatus } from '@/store/useStore'

/**
 * One row of the Evidence tab per result of a run. The authoritative source is the evidence ledger
 * (`GET /api/ledger/:runId`): it names every operation, the data items it read and its status.
 * When the ledger is not available (a run that was never saved, a stub) the rows are rebuilt from
 * what this session holds, and say so. Nothing is filled in that neither source recorded.
 */

export type RowStatus = 'ok' | 'flagged' | 'refused' | 'failed' | 'skipped' | 'unknown'

export interface EvidenceRow {
  /** The content-hash id (`r_` + 16 hex); null for a step that produced no result. */
  resultId: string | null
  /** Position in the run. */
  n: number
  op: string
  version?: string
  /** Where the data came from: datasets or catalogues, as named by the operation. */
  sources: string[]
  /** The data items read: scene ids, dataset ids, release tags. */
  items: string[]
  /** Dates of those items and of the result, `YYYY-MM-DD`, oldest first. */
  dates: string[]
  cloudPct?: number
  clearPct?: number
  confidence?: 'high' | 'medium' | 'low'
  status: RowStatus
  /** Why the status is not ok, when a check or an error said. */
  note?: string
  /** Served from the result cache: nothing was recomputed for this request. */
  cached?: boolean
  ms?: number
  method?: string
  /** The citable figures of the result. */
  figures: Array<{ key: string; value: string }>
  /** True when the row came from the ledger rather than this session's memory. */
  fromLedger: boolean
}

const DATE_IN_ID = /(?:^|[^0-9])((?:19|20)\d{2})[-_]?(0[1-9]|1[0-2])[-_]?(0[1-9]|[12]\d|3[01])(?:[^0-9]|$)/

/** The calendar date inside a scene id (`S2B_MSIL2A_20260108T052229_...`, `2026-01-08`), or null. */
export function dateInItem(id: string): string | null {
  const m = DATE_IN_ID.exec(id)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

function figuresOf(stats: Record<string, unknown> | null | undefined): EvidenceRow['figures'] {
  const out: EvidenceRow['figures'] = []
  for (const [key, v] of Object.entries(stats ?? {})) {
    if (typeof v === 'number') out.push({ key, value: Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000) })
    else if (typeof v === 'string') out.push({ key, value: v })
    // array figures are charts, not row facts
  }
  return out
}

/** Cloud and clear percentages, when a result's own figures carry them under an obvious name. */
function skyOf(stats: Record<string, unknown> | null | undefined): Pick<EvidenceRow, 'cloudPct' | 'clearPct'> {
  const out: Pick<EvidenceRow, 'cloudPct' | 'clearPct'> = {}
  for (const [key, v] of Object.entries(stats ?? {})) {
    if (typeof v !== 'number') continue
    const k = key.toLowerCase()
    if (out.clearPct === undefined && /(^|_)(aoi_)?clear(_|$)/.test(k) && /pct|percent|%/.test(k)) out.clearPct = v
    else if (out.cloudPct === undefined && /(^|_)cloud(_|$)/.test(k) && /pct|percent|cover|%/.test(k)) out.cloudPct = v
  }
  return out
}

function datesOf(items: string[], date?: string): string[] {
  const set = new Set<string>()
  if (date) set.add(date.slice(0, 10))
  for (const id of items) {
    const d = dateInItem(id)
    if (d) set.add(d)
  }
  return [...set].sort()
}

function statusOfCall(tc: ToolCallStatus | undefined): { status: RowStatus; note?: string } {
  if (!tc) return { status: 'unknown' }
  const failing = tc.verdict?.checks.filter((c) => c.status !== 'pass').map((c) => c.message).join(' ')
  if (tc.status === 'error') return { status: tc.verdict?.status === 'refused' ? 'refused' : 'failed', note: failing || tc.errorText }
  if (tc.verdict?.status === 'flagged') return { status: 'flagged', note: failing }
  if (tc.verdict?.status === 'failed') return { status: 'failed', note: failing }
  return { status: 'ok' }
}

export function buildEvidenceRows(
  ledger: LedgerExport | null,
  toolResults: Record<string, CitableToolResult>,
  toolCalls: ToolCallStatus[],
): EvidenceRow[] {
  if (ledger) {
    return ledger.nodes.map((node) => {
      const prov = node.provenance
      const items = prov?.items ?? []
      const call = toolCalls.find((t) => t.resultId && t.resultId === node.resultId)
      const failing = call ? statusOfCall(call) : null
      return {
        resultId: node.resultId,
        n: node.idx + 1,
        op: node.op,
        version: node.version || undefined,
        sources: prov?.sources ?? [],
        items,
        dates: datesOf(items, prov?.date),
        ...skyOf(node.stats as Record<string, unknown> | null),
        confidence: node.resultId ? toolResults[node.resultId]?.confidence : undefined,
        status: node.status === 'ok' || node.status === 'flagged' || node.status === 'refused' || node.status === 'failed' || node.status === 'skipped' ? node.status : 'unknown',
        note: failing?.note,
        cached: node.cached || undefined,
        ms: node.ms || undefined,
        method: prov?.method,
        figures: figuresOf(node.stats as Record<string, unknown> | null),
        fromLedger: true,
      }
    })
  }

  // No ledger: the results this session holds, in the order their steps ran.
  const rows: EvidenceRow[] = []
  const seen = new Set<string>()
  toolCalls.forEach((tc) => {
    const r = tc.resultId ? toolResults[tc.resultId] : undefined
    if (tc.resultId) seen.add(tc.resultId)
    const { status, note } = statusOfCall(tc)
    rows.push({
      resultId: tc.resultId ?? null,
      n: rows.length + 1,
      op: r?.tool ?? tc.toolName,
      sources: r?.provenance?.source ? [r.provenance.source] : [],
      items: [],
      dates: datesOf([], r?.provenance?.date),
      ...skyOf(r?.summaryData),
      confidence: r?.confidence,
      status,
      note,
      ms: tc.durationMs,
      method: r?.provenance?.method,
      figures: figuresOf(r?.summaryData),
      fromLedger: false,
    })
  })
  for (const r of Object.values(toolResults)) {
    if (seen.has(r.resultId)) continue
    rows.push({
      resultId: r.resultId,
      n: rows.length + 1,
      op: r.tool,
      sources: r.provenance?.source ? [r.provenance.source] : [],
      items: [],
      dates: datesOf([], r.provenance?.date),
      ...skyOf(r.summaryData),
      confidence: r.confidence,
      status: 'unknown',
      method: r.provenance?.method,
      figures: figuresOf(r.summaryData),
      fromLedger: false,
    })
  }
  return rows
}
