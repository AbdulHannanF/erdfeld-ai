'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import { CircleAlert, CircleCheck, ExternalLink, Loader2, Trash2 } from 'lucide-react'
import { ResultIdChip } from '@/components/evidence/EvidencePieces'
import { BTN } from '@/components/shell/ui'
import { fetchBatches, type BatchSummary } from '@/lib/lists-client'
import { useJobs, type TrackedBatch } from '@/store/useJobs'
import { cn } from '@/lib/utils'

const STATE: Record<TrackedBatch['state'], { text: string; cls: string }> = {
  active: { text: 'RUNNING', cls: 'border-[#8e704533] bg-[#b0833b12] text-warning' },
  finished: { text: 'FINISHED', cls: 'border-[#3d8d6755] bg-[#3d8d6712] text-[var(--success)]' },
  missing: { text: 'NOT ON SERVER', cls: 'border-border bg-secondary text-muted-foreground' },
  error: { text: 'ERROR', cls: 'border-danger/40 bg-danger/10 text-danger' },
}

/** The caller's batches (tool runs, catalog reads, band math, claim batches), newest first, read from
 *  `GET /api/jobs` and refreshed while any is running. The batches this browser queued add what the
 *  list does not carry: each job's error and result id (read from `GET /api/jobs/:id` by the
 *  JobRunner) and where a claim report opens. Only when the server reports no database does the tab
 *  fall back to the batches this browser remembers. */
export default function JobsTab() {
  const local = useJobs((s) => s.batches)
  const remove = useJobs((s) => s.remove)
  const clearFinished = useJobs((s) => s.clearFinished)
  const [server, setServer] = useState<BatchSummary[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const anyActive = server?.some((b) => b.state === 'active') ?? false
  const localKey = local.map((b) => `${b.id}:${b.state}`).join()

  useEffect(() => {
    const ctl = new AbortController()
    fetchBatches(undefined, 30, ctl.signal).then((r) => {
      if (ctl.signal.aborted) return
      if (r.ok) {
        setServer(r.items)
        setNext(r.nextCursor)
      } else {
        setServer(null)
      }
    })
    return () => ctl.abort()
  }, [tick, localKey])
  useEffect(() => {
    if (!anyActive) return
    const t = window.setInterval(() => setTick((n) => n + 1), 3000)
    return () => window.clearInterval(t)
  }, [anyActive])

  const batches = useMemo<TrackedBatch[]>(() => {
    if (!server) return local
    return server.map((s) => {
      const mine = local.find((b) => b.id === s.id)
      return {
        ...mine,
        id: s.id,
        label: s.label ?? mine?.label ?? 'Batch',
        kind: s.kind,
        op: s.ops[0],
        createdAt: Date.parse(s.createdAt),
        state: s.state,
        progress: s.progress,
      }
    })
  }, [server, local])
  const fromServer = server !== null

  const loadMore = async () => {
    if (!next) return
    const r = await fetchBatches(next)
    if (r.ok) {
      setServer((prev) => [...(prev ?? []), ...r.items])
      setNext(r.nextCursor)
    }
  }

  if (batches.length === 0) {
    return (
      <div className="grid min-h-[4.75rem] place-items-center text-center text-[0.8125rem] text-muted-foreground" data-testid="jobs-empty">
        <div>
          <strong className="mb-1 block text-[0.875rem] font-medium text-foreground">The processing queue is clear</strong>
          A tool run, a catalog read, band math or a claim batch queued from this browser appears here while it runs.
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-1.5" data-testid="jobs-list">
      {!fromServer && batches.some((b) => b.state !== 'active') && (
        <div className="flex justify-end">
          <button type="button" className={cn(BTN, 'h-7 text-xs')} onClick={clearFinished}><Trash2 className="size-3" aria-hidden />Clear finished</button>
        </div>
      )}
      {batches.map((b) => {
        const st = STATE[b.error && b.state === 'active' ? 'error' : b.state]
        const p = b.progress
        const failed = b.jobs?.filter((j) => j.status === 'failed') ?? []
        const doneIds = b.jobs?.filter((j) => j.resultId) ?? []
        return (
          <article key={b.id} className="grid grid-cols-[1.375rem_minmax(0,1fr)_auto] items-start gap-2 rounded-[0.3125rem] border border-border bg-sunk px-2.5 py-2" data-testid="job-row">
            <span className="grid size-[1.375rem] place-items-center rounded border border-border text-muted-foreground" aria-hidden>
              {b.state === 'active' ? <Loader2 className="size-3.5 animate-spin" /> : failed.length ? <CircleAlert className="size-3.5 text-danger" /> : <CircleCheck className="size-3.5 text-[var(--success)]" />}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[0.8125rem] text-foreground" title={b.label}>{b.label}</p>
              <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                {b.kind === 'claims' ? 'claim batch' : b.op ?? 'operation'} · {formatDistanceToNow(b.createdAt, { addSuffix: true })}
                {p && ` · ${p.done}/${p.total} done${p.failed ? `, ${p.failed} failed` : ''}${p.running ? `, ${p.running} running` : ''}${p.queued ? `, ${p.queued} queued` : ''}`}
              </p>
              {failed.map((j) => <p key={j.idx} className="mt-1 text-xs text-danger">{j.error ?? 'The job failed.'}</p>)}
              {b.jobs?.some((j) => j.stalled) && <p className="mt-1 text-xs text-warning" data-testid="job-stalled">The worker running this job has stopped responding. It is being retried; this can take up to a minute.</p>}
              {b.error && <p className="mt-1 text-xs text-warning">{b.error}</p>}
              {doneIds.length > 0 && (
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  Result {doneIds.map((j) => <ResultIdChip key={j.idx} id={j.resultId!} />)}
                  {doneIds.some((j) => j.resultStatus && j.resultStatus !== 'ok') && <span>· status {doneIds.map((j) => j.resultStatus).join(', ')}</span>}
                </p>
              )}
              <div className="mt-1.5 flex gap-1.5">
                {(b.kind === 'claims' || b.href) && (
                  <Link href={b.href ?? `/cases/batch/${b.id}`} className="inline-flex items-center gap-1 text-xs text-brand-text underline-offset-2 hover:underline">Open report <ExternalLink className="size-3" aria-hidden /></Link>
                )}
                {!fromServer && <button type="button" onClick={() => remove(b.id)} className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Remove from list</button>}
              </div>
            </div>
            <span className={cn('rounded border px-1.5 py-0.5 font-mono text-xs', st.cls)}>{st.text}</span>
          </article>
        )
      })}
      {next && <button type="button" className={cn(BTN, 'h-7 justify-self-start text-xs')} onClick={() => void loadMore()}>Show older batches</button>}
    </div>
  )
}
