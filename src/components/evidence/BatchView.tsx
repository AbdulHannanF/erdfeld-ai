'use client'

import { BrandMark } from '@/components/shell/BrandMark'
import { ArrowLeft, Download, Loader2 } from 'lucide-react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'

import { PENDING_COLOR, VERDICT_COLOR, summarize, type BatchView as BatchData } from '@/lib/case-batch'
import { ABSTAIN_LABEL, VERDICT_LABEL, type CaseVerdict } from '@/lib/case-view'
import { followJobEvents } from '@/lib/job-events'
import { getOwnerToken } from '@/lib/projects'

const BatchMap = dynamic(() => import('@/components/evidence/BatchMap'), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-card" />,
})

const VERDICTS: CaseVerdict[] = ['supported', 'contradicted', 'cannot_determine']
const STATUS_LABEL = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed' } as const

const Dot = ({ color }: { color: string }) => <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-border" style={{ background: color }} />

/** A batch of claims (Q-28): progress while the queue works through the plots, then the verdict
 *  table, the summary and the map. Progress follows the job SSE stream; the rows are re-read from
 *  the batch endpoint as events arrive. */
export default function BatchView({ id }: { id: string }) {
  const [data, setData] = useState<BatchData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const headers = useCallback(() => ({ 'x-owner-token': getOwnerToken() }), [])

  const load = useCallback(async (): Promise<BatchData | null> => {
    const res = await fetch(`/api/cases/batch/${encodeURIComponent(id)}`, { headers: headers() })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error(res.status === 403 ? 'This batch belongs to another owner.' : res.status === 404 ? 'No such batch.' : body?.error ?? `HTTP ${res.status}`)
    }
    const v = (await res.json()) as BatchData
    setData(v)
    return v
  }, [id, headers])

  useEffect(() => {
    const ctl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const refreshSoon = () => { if (!timer) timer = setTimeout(() => { timer = undefined; load().catch(() => {}) }, 800) }
    ;(async () => {
      try {
        let view = await load()
        let last = 0
        while (view && view.state === 'active' && !ctl.signal.aborted) {
          try {
            const r = await followJobEvents(id, headers(), (e) => {
              const p = e.data?.progress
              if (p) setData((d) => (d ? { ...d, progress: p } : d))
              refreshSoon()
            }, ctl.signal, last)
            last = r.last
            if (!r.done) await new Promise((res) => setTimeout(res, 1000))
          } catch {
            if (ctl.signal.aborted) return
            await new Promise((r) => setTimeout(r, 3000))
          }
          view = await load()
        }
      } catch (e) {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : 'The batch could not be loaded.')
      }
    })()
    return () => { ctl.abort(); if (timer) clearTimeout(timer) }
  }, [id, load, headers])

  const rowEls = useRef(new Map<number, HTMLTableRowElement>())
  useEffect(() => { if (selected != null) rowEls.current.get(selected)?.scrollIntoView({ block: 'nearest' }) }, [selected])

  const download = async (kind: 'csv' | 'geojson' | 'bundles', fallbackName: string) => {
    setBusy(kind)
    try {
      const url = kind === 'bundles' ? `/api/cases/batch/${id}/bundles` : `/api/cases/batch/${id}/export?format=${kind}`
      const res = await fetch(url, { headers: headers() })
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`)
      const href = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = href
      a.download = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName
      a.click()
      URL.revokeObjectURL(href)
    } catch (e) {
      setError(e instanceof Error ? `Download failed: ${e.message}` : 'Download failed.')
    } finally {
      setBusy(null)
    }
  }

  const shell = (children: React.ReactNode) => (
    <div className="h-screen overflow-y-auto bg-background text-foreground" data-testid="batch-page">
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-border bg-background/95 px-4 py-3">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-brand-text hover:underline"><ArrowLeft className="h-4 w-4" aria-hidden /> Back to the map</Link>
        <BrandMark height={32} className="ml-auto" />
      </header>
      {children}
    </div>
  )

  if (!data) {
    return shell(error
      ? <p className="mx-auto max-w-2xl p-6 text-destructive" role="alert" data-testid="batch-error">{error}</p>
      : <p className="flex items-center gap-2 p-6 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading the batch...</p>)
  }

  const { progress, rows } = data
  const finished = progress.done + progress.failed
  const pct = progress.total ? Math.round((finished / progress.total) * 100) : 0
  const counts = summarize(rows)
  const kinds = Object.entries(counts.by_kind).sort((a, b) => b[1] - a[1])

  return shell(
    <main className="mx-auto grid max-w-[93.75rem] grid-cols-[minmax(0,1fr)] gap-6 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:p-6">
      <aside className="min-w-0 lg:order-2">
        <div className="space-y-3 lg:sticky lg:top-20">
          <div className="h-[20rem] overflow-hidden rounded-lg border border-border lg:h-[calc(100vh-14rem)] lg:min-h-[22.5rem]">
            <BatchMap rows={rows} selected={selected} onSelect={setSelected} />
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Map legend" data-testid="batch-legend">
            {VERDICTS.map((v) => <li key={v} className="inline-flex items-center gap-1.5"><Dot color={VERDICT_COLOR[v]} />{VERDICT_LABEL[v]}</li>)}
            <li className="inline-flex items-center gap-1.5"><Dot color={PENDING_COLOR} />Not decided yet</li>
          </ul>
        </div>
      </aside>

      <div className="min-w-0 space-y-6 lg:order-1">
        <section aria-labelledby="batch-title">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Batch of claims</p>
          <h1 id="batch-title" className="mt-1 font-heading text-2xl font-medium leading-snug" data-testid="batch-title">{data.label ?? data.recipe_title ?? data.claim_type}</h1>
          <p className="mt-1 text-xs text-muted-foreground">Recipe <code>{data.claim_type}</code> · {progress.total} plots · {new Date(data.created_at).toISOString().slice(0, 10)}</p>

          <div className="mt-4" data-testid="batch-progress">
            <div className="flex items-baseline justify-between text-sm">
              <span>{data.state === 'active' ? <span className="inline-flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />Checking plots</span> : 'Finished'}</span>
              <span className="tabular-nums text-muted-foreground" data-testid="batch-progress-text">{finished} of {progress.total} plots{progress.failed ? `, ${progress.failed} failed` : ''}</span>
            </div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-label="Plots finished" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={finished}>
              <div className="h-full bg-brand-500 transition-[width] duration-300" style={{ width: `${pct}%` }} />
            </div>
          </div>

          <dl className="mt-4 grid grid-cols-3 gap-2" data-testid="batch-summary">
            {VERDICTS.map((v) => (
              <div key={v} className="rounded-lg border border-border bg-card p-3">
                <dt className="flex items-center gap-1.5 text-xs text-muted-foreground"><Dot color={VERDICT_COLOR[v]} />{VERDICT_LABEL[v]}</dt>
                <dd className="mt-1 font-heading text-2xl tabular-nums" data-testid={`count-${v}`}>{counts[v]}</dd>
              </div>
            ))}
          </dl>
          {kinds.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground" data-testid="batch-kinds">
              Cannot determine, by reason: {kinds.map(([k, n]) => `${ABSTAIN_LABEL[k] ?? k} (${n})`).join('; ')}.
            </p>
          )}
          {(counts.pending > 0 || counts.failed > 0) && (
            <p className="mt-1 text-xs text-muted-foreground">
              {counts.pending > 0 && <>{counts.pending} not decided yet. </>}
              {counts.failed > 0 && <span className="text-destructive">{counts.failed} could not be run (an error, not a verdict).</span>}
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {([['csv', 'Export CSV', 'claims.csv'], ['geojson', 'Export GeoJSON', 'claims.geojson'], ['bundles', 'Signed bundles (zip)', 'bundles.zip']] as const).map(([kind, label, name]) => (
              <button key={kind} onClick={() => download(kind, name)} disabled={busy !== null || (kind === 'bundles' && counts.supported + counts.contradicted + counts.cannot_determine === 0)} data-testid={`export-${kind}`}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                {busy === kind ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}{label}
              </button>
            ))}
          </div>
          {error && <p className="mt-3 text-sm text-destructive" role="alert" data-testid="batch-error">{error}</p>}
        </section>

        <section aria-labelledby="batch-table">
          <h2 id="batch-table" className="font-heading text-lg font-medium">Verdicts</h2>
          <div className="mt-3 overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[34rem] text-left text-sm" data-testid="batch-table">
              <thead className="bg-card text-xs text-muted-foreground">
                <tr><th className="px-3 py-2 font-medium">Plot</th><th className="px-3 py-2 font-medium">Verdict</th><th className="px-3 py-2 font-medium">Confidence</th><th className="px-3 py-2 font-medium">Cannot determine because</th><th className="px-3 py-2 font-medium"><span className="sr-only">Case</span></th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.idx} ref={(n) => { if (n) rowEls.current.set(r.idx, n); else rowEls.current.delete(r.idx) }} onClick={() => setSelected(r.idx)} data-testid="batch-row" data-verdict={r.verdict ?? r.status}
                    className={`cursor-pointer border-t border-border align-top ${selected === r.idx ? 'bg-secondary' : 'hover:bg-card'}`}>
                    <td className="px-3 py-2 font-medium">{r.name}</td>
                    <td className="px-3 py-2">
                      {r.verdict
                        ? <span className="inline-flex items-center gap-2"><Dot color={VERDICT_COLOR[r.verdict]} />{VERDICT_LABEL[r.verdict]}</span>
                        : r.status === 'failed'
                          ? <span className="text-destructive" title={r.error ?? undefined}>Error</span>
                          : <span className="inline-flex items-center gap-2 text-muted-foreground"><Dot color={PENDING_COLOR} />{STATUS_LABEL[r.status]}{r.error ? ' (retrying)' : ''}</span>}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{r.confidence != null ? `${Math.round(r.confidence * 100)}%` : ''}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{r.verdict === 'cannot_determine' ? (r.kind ? ABSTAIN_LABEL[r.kind] ?? r.kind : '') : r.status === 'failed' ? r.error : ''}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">{r.case_id && <Link href={`/cases/${r.case_id}`} onClick={(e) => e.stopPropagation()} className="text-brand-text hover:underline" aria-label={`Open the case for ${r.name}`}>Open</Link>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>,
  )
}
