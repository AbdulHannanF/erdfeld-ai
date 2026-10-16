'use client'

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, FileCheck2, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { buildEvidenceRows, type EvidenceRow } from '@/components/evidence/rows'
import { FigureGrid, ResultIdChip, StatusBadge } from '@/components/evidence/EvidencePieces'
import { downloadBundle, fetchLedger, openSummary, rerunLedger, type RerunReport } from '@/components/evidence/ledger-actions'
import { shortDate } from '@/components/map/scenes'
import { Button } from '@/components/ui/button'
import { prefersReducedMotion } from '@/components/map/layers'
import type { LedgerExport } from '@/app/api/agent/engine/ledger'
import { cn } from '@/lib/utils'

const SCENES_SHOWN = 3

const pct = (v: number) => `${Math.round(v * 10) / 10}%`

const Row = memo(function Row({ row, focused, field, rerun }: { row: EvidenceRow; focused: boolean; field?: string; rerun?: RerunReport['nodes'][number] }) {
  const ref = useRef<HTMLLIElement>(null)
  const [open, setOpen] = useState(false)
  const [allScenes, setAllScenes] = useState(false)
  const showFigures = open || (focused && !!field)

  // A clicked citation lands here: bring the row into view and move keyboard focus to it.
  useEffect(() => {
    if (!focused) return
    const el = ref.current
    el?.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    el?.focus({ preventScroll: true })
  }, [focused])

  const scenes = allScenes ? row.items : row.items.slice(0, SCENES_SHOWN)
  const sky = [row.clearPct != null ? `${pct(row.clearPct)} clear` : null, row.cloudPct != null ? `${pct(row.cloudPct)} cloud` : null].filter(Boolean).join(' · ')

  return (
    <li
      ref={ref}
      id={row.resultId ? `ev-${row.resultId}` : undefined}
      tabIndex={-1}
      data-testid="evidence-row"
      data-focused={focused || undefined}
      className={cn('rounded-lg border bg-card p-3 outline-none transition-shadow', focused ? 'border-ring ring-2 ring-ring/40' : 'border-border')}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums text-muted-foreground" aria-hidden>{row.n}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 break-words text-[0.8125rem] font-medium leading-snug text-foreground">
              {row.op.replace(/_/g, ' ')}
              {row.version && <span className="font-normal text-muted-foreground">@{row.version}</span>}
            </p>
            <StatusBadge status={row.status} />
          </div>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
            {row.sources.length > 0 ? row.sources.join(' · ') : 'Source not recorded'}
            {row.cached && ' · reused from cache'}
          </p>
        </div>
      </div>

      {row.note && <p className="mt-2 rounded bg-warning/10 px-2 py-1.5 text-xs leading-snug text-foreground">{row.note}</p>}

      <dl className="mt-2.5 grid grid-cols-[4rem_1fr] gap-x-3 gap-y-1.5 text-xs">
        {row.items.length > 0 && (
          <>
            <dt className="pt-0.5 text-muted-foreground">Scenes</dt>
            <dd className="min-w-0 space-y-0.5">
              {scenes.map((id) => <div key={id} className="truncate tabular-nums text-foreground" title={id}>{id}</div>)}
              {row.items.length > SCENES_SHOWN && (
                <button type="button" onClick={() => setAllScenes((v) => !v)} className="text-brand-text underline-offset-2 hover:underline">
                  {allScenes ? 'Show fewer' : `Show all ${row.items.length}`}
                </button>
              )}
            </dd>
          </>
        )}
        {row.dates.length > 0 && (
          <>
            <dt className="text-muted-foreground">Dates</dt>
            <dd className="tabular-nums text-foreground">{row.dates.length > 4 ? `${shortDate(row.dates[0])} to ${shortDate(row.dates[row.dates.length - 1])} (${row.dates.length})` : row.dates.map((d) => shortDate(d)).join(', ')}</dd>
          </>
        )}
        {sky && (
          <>
            <dt className="text-muted-foreground">Sky</dt>
            <dd className="tabular-nums text-foreground">{sky}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Confidence</dt>
        <dd className="capitalize text-foreground">{row.confidence ?? <span className="normal-case text-muted-foreground">not stated</span>}</dd>
        {row.method && (
          <>
            <dt className="text-muted-foreground">Method</dt>
            <dd className="text-foreground">{row.method}</dd>
          </>
        )}
        <dt className="pt-0.5 text-muted-foreground">Result id</dt>
        <dd className="min-w-0">{row.resultId ? <ResultIdChip id={row.resultId} /> : <span className="text-muted-foreground">none: no result was produced</span>}</dd>
        {rerun && (
          <>
            <dt className="text-muted-foreground">Re-run</dt>
            <dd className={cn('text-foreground', rerun.outcome !== 'reproduced' && 'text-warning')}>
              {rerun.outcome === 'reproduced' ? 'Reproduced: same id, same figures' : rerun.outcome === 'changed' ? `Changed. ${rerun.reason ?? ''}` : `Not run. ${rerun.reason ?? ''}`}
            </dd>
          </>
        )}
      </dl>

      {row.figures.length > 0 && (
        <div className="mt-2.5 border-t border-border pt-2">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={showFigures} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight className={cn('size-3.5 transition-transform', showFigures && 'rotate-90')} aria-hidden />
            Figures ({row.figures.length})
          </button>
          {showFigures && <FigureGrid className="mt-1.5" entries={row.figures.map((f) => [f.key, f.value])} mark={focused ? field : undefined} />}
        </div>
      )}
    </li>
  )
})

/** Every result of the run, as recorded: the operation, where its data came from, which scenes and
 *  dates, how clear they were, how far to trust it and whether its checks passed, with the
 *  content-hash id that a citation and the signed bundle both refer to. */
export default function EvidenceTab() {
  const toolResults = useStore((s) => s.toolResults)
  const toolCalls = useStore((s) => s.toolCalls)
  const ledgerRunIds = useStore((s) => s.ledgerRunIds)
  const isLoading = useStore((s) => s.isLoading)
  const focus = useUi((s) => s.evidenceFocus)

  const [runIndex, setRunIndex] = useState<number | null>(null)
  const runId = ledgerRunIds.length ? ledgerRunIds[Math.min(runIndex ?? ledgerRunIds.length - 1, ledgerRunIds.length - 1)] : undefined
  const [loaded, setLoaded] = useState<{ runId: string; ledger?: LedgerExport; error?: string } | null>(null)
  const [report, setReport] = useState<{ runId: string; value?: RerunReport; error?: string } | null>(null)
  const [rerunning, setRerunning] = useState(false)

  useEffect(() => {
    if (!runId) return
    const ctl = new AbortController()
    fetchLedger(runId, ctl.signal).then((r) => {
      if (ctl.signal.aborted) return
      setLoaded('ledger' in r ? { runId, ledger: r.ledger } : { runId, error: r.error })
    })
    return () => ctl.abort()
  }, [runId])

  const ledger = loaded?.runId === runId ? loaded?.ledger ?? null : null
  const ledgerError = loaded?.runId === runId ? loaded?.error : undefined
  const loadingLedger = !!runId && loaded?.runId !== runId
  const rows = useMemo(() => buildEvidenceRows(ledger, toolResults, toolCalls), [ledger, toolResults, toolCalls])
  const rerunBy = new Map((report?.runId === runId ? report?.value?.nodes ?? [] : []).map((n) => [n.originalResultId, n]))

  const doRerun = async () => {
    if (!runId) return
    setRerunning(true)
    const r = await rerunLedger(runId)
    setReport('error' in r ? { runId, error: r.error } : { runId, value: r })
    setRerunning(false)
  }

  if (rows.length === 0) {
    return (
      <div className="py-10 text-center" data-testid="evidence-empty">
        <p className="font-heading text-[0.9375rem] font-medium text-foreground">{isLoading ? 'Collecting evidence' : 'No evidence yet'}</p>
        <p className="mx-auto mt-1 max-w-[34ch] text-[0.8125rem] leading-relaxed text-muted-foreground">
          Every operation that runs is listed here with its source, scenes, dates, checks and result id.
        </p>
      </div>
    )
  }

  return (
    <div className="grid gap-3" data-testid="evidence-tab">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.8125rem] text-foreground">
          <span className="font-medium tabular-nums">{rows.length}</span> {rows.length === 1 ? 'result' : 'results'}
          <span className="text-muted-foreground">{ledger ? ' · from the evidence ledger' : ' · from this session, not yet in the ledger'}</span>
        </p>
        {ledgerRunIds.length > 1 && (
          <select
            aria-label="Run"
            value={ledgerRunIds.indexOf(runId ?? '')}
            onChange={(e) => setRunIndex(Number(e.target.value))}
            className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground"
          >
            {ledgerRunIds.map((id, i) => <option key={id} value={i}>Run {i + 1}{i === ledgerRunIds.length - 1 ? ' (latest)' : ''}</option>)}
          </select>
        )}
      </div>

      {runId ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void downloadBundle(runId)}><ShieldCheck aria-hidden />Signed bundle</Button>
          <Button size="sm" variant="outline" onClick={() => void openSummary(runId)}><FileCheck2 aria-hidden />PDF summary</Button>
          <Button size="sm" variant="outline" onClick={doRerun} disabled={rerunning}>
            {rerunning ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}Re-run
          </Button>
        </div>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">The signed bundle, PDF summary and re-run appear once the run is saved to the ledger.</p>
      )}

      {loadingLedger && <p className="inline-flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" aria-hidden />Reading the ledger</p>}
      {ledgerError && <p className="text-xs text-warning" role="status">{ledgerError}</p>}
      {report && report.runId === runId && (
        <p className={cn('rounded-lg border px-3 py-2 text-xs leading-relaxed', report.error ? 'border-danger/30 bg-danger/10 text-foreground' : report.value?.reproduced ? 'border-success/30 bg-success/10 text-foreground' : 'border-warning/30 bg-warning/10 text-foreground')} role="status">
          {report.error ?? (report.value?.reproduced ? 'Re-run reproduced every result with the same ids and figures.' : `Re-run: ${report.value?.nodes.filter((n) => n.outcome !== 'reproduced').length} of ${report.value?.nodes.length} results did not reproduce. The reason is on each row.`)}
        </p>
      )}

      <ol className="grid gap-2.5">
        {rows.map((row) => (
          <Row
            key={`${row.n}-${row.resultId ?? row.op}`}
            row={row}
            focused={!!focus && row.resultId === focus.resultId}
            field={focus?.resultId === row.resultId ? focus.field : undefined}
            rerun={row.resultId ? rerunBy.get(row.resultId) : undefined}
          />
        ))}
      </ol>
    </div>
  )
}
