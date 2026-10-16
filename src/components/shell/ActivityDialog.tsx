'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { FileCheck2, History, Loader2, MessageSquare, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Callout, WbDialog } from '@/components/shell/WbDialog'
import { BTN } from '@/components/shell/ui'
import { downloadBundle, fetchLedger, openSummary } from '@/components/evidence/ledger-actions'
import { fetchRuns, type RunSummary } from '@/lib/lists-client'
import { readRuns } from '@/lib/run-log'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import type { LedgerExport } from '@/app/api/agent/engine/ledger'

const noSubscribe = () => () => {}

/** One ledger run: what was asked, when, which operations ran, and the evidence exports. A run the
 *  server listed already carries its operations; a run remembered by this browser (the fallback
 *  when the server has no database) has its ledger read on demand, and a run it no longer holds is
 *  said to be missing. */
function RunRow({ run }: { run: { id: string; query: string | null; at: number; operations?: string[] } }) {
  const fromServer = run.operations !== undefined
  const [state, setState] = useState<{ ledger?: LedgerExport; error?: string } | null>(null)
  useEffect(() => {
    if (fromServer) return
    const ctl = new AbortController()
    fetchLedger(run.id, ctl.signal).then((r) => {
      if (!ctl.signal.aborted) setState('ledger' in r ? { ledger: r.ledger } : { error: r.error })
    })
    return () => ctl.abort()
  }, [run.id, fromServer])
  const ops = run.operations ?? state?.ledger?.nodes.map((n) => n.op.replace(/_/g, ' ')) ?? []
  return (
    <li className="grid gap-1 rounded-md border border-border bg-sunk p-2.5" data-testid="activity-run">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-[0.8125rem] font-medium leading-snug text-foreground">{run.query || state?.ledger?.query || 'Run without a question'}</p>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{formatDistanceToNow(run.at, { addSuffix: true })}</span>
      </div>
      <p className="font-mono text-xs text-muted-foreground">{run.id}</p>
      {!fromServer && !state && <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" aria-hidden />Reading the ledger</p>}
      {state?.error && <p className="text-xs text-warning">{state.error}</p>}
      {ops.length > 0 && <p className="text-xs text-muted-foreground">{ops.length} operation{ops.length === 1 ? '' : 's'}: {[...new Set(ops.map((o) => o.replace(/_/g, ' ')))].join(', ')}</p>}
      {(fromServer || state?.ledger) && (
        <div className="mt-0.5 flex flex-wrap gap-1.5">
          <button type="button" className={BTN} onClick={() => void downloadBundle(run.id)}><ShieldCheck className="size-3.5" aria-hidden />Signed bundle</button>
          <button type="button" className={BTN} onClick={() => void openSummary(run.id)}><FileCheck2 className="size-3.5" aria-hidden />PDF summary</button>
        </div>
      )}
    </li>
  )
}

/** The evidence-ledger runs of this owner, newest first, read from `GET /api/ledger`. Only when
 *  the server reports no database (or cannot be reached) does it fall back to the runs this
 *  browser remembers, and it says so. */
function LedgerRuns() {
  const [rows, setRows] = useState<RunSummary[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [source, setSource] = useState<'loading' | 'server' | 'local'>('loading')
  const [more, setMore] = useState(false)
  useEffect(() => {
    const ctl = new AbortController()
    fetchRuns(undefined, 15, ctl.signal).then((r) => {
      if (ctl.signal.aborted) return
      if (r.ok) {
        setRows(r.items)
        setNext(r.nextCursor)
        setSource('server')
      } else {
        setSource('local')
      }
    })
    return () => ctl.abort()
  }, [])
  const loadMore = async () => {
    if (!next) return
    setMore(true)
    const r = await fetchRuns(next)
    setMore(false)
    if (r.ok) {
      setRows((prev) => [...prev, ...r.items])
      setNext(r.nextCursor)
    }
  }
  const local = source === 'local' ? readRuns() : []
  const empty = source === 'server' ? rows.length === 0 : local.length === 0

  return (
    <section className="grid gap-1.5" aria-label="Ledger runs">
      <p className="font-mono text-xs uppercase tracking-[0.09em] text-muted-foreground">Evidence ledger runs</p>
      {source === 'loading' ? (
        <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" aria-hidden />Reading the ledger</p>
      ) : empty ? (
        <Callout icon={<History />}>No runs yet. Every question that runs operations is written to the evidence ledger, with its sources and a content-hash id per result.</Callout>
      ) : (
        <>
          {source === 'local' && <p className="text-xs text-warning">The server ledger could not be read, so these are the runs this browser remembers.</p>}
          <ul className="grid gap-2">
            {source === 'server'
              ? rows.map((r) => <RunRow key={r.id} run={{ id: r.id, query: r.query, at: Date.parse(r.createdAt), operations: r.operations }} />)
              : local.slice(0, 15).map((r) => <RunRow key={r.id} run={r} />)}
          </ul>
          {next && <button type="button" className={BTN} onClick={() => void loadMore()} disabled={more}>{more ? 'Loading' : 'Show older runs'}</button>}
        </>
      )}
    </section>
  )
}

/** The two lists behind Activity history: conversations saved in this browser and the evidence
 *  ledger runs. Shared by the dialog and the dock's History tab. */
export function ActivityLists({ onOpened }: { onOpened?: () => void }) {
  const setInspectorTab = useUi((s) => s.setInspectorTab)
  const chatHistory = useStore((s) => s.chatHistory)
  const loadFromHistory = useStore((s) => s.loadFromHistory)
  const mounted = useSyncExternalStore(noSubscribe, () => true, () => false)
  if (!mounted) return null

  return (
    <>
      <section className="grid gap-1.5" aria-label="Conversations">
        <p className="font-mono text-xs uppercase tracking-[0.09em] text-muted-foreground">Conversations in this browser</p>
        {chatHistory.length === 0 ? (
          <Callout icon={<MessageSquare />}>No earlier conversations. Each finished question is saved here, and you can reopen it.</Callout>
        ) : (
          <ul className="grid gap-1">
            {chatHistory.slice(0, 20).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="flex w-full items-baseline justify-between gap-3 rounded-md border border-border bg-sunk px-2.5 py-2 text-left text-[0.8125rem] text-foreground hover:bg-hover"
                  onClick={() => {
                    loadFromHistory(c.id)
                    setInspectorTab('assistant')
                    onOpened?.()
                    toast.success('Conversation reopened')
                  }}
                >
                  <span className="min-w-0 truncate">{c.query}</span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{formatDistanceToNow(c.timestamp, { addSuffix: true })}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <LedgerRuns />
    </>
  )
}

/** Activity history: the questions asked in this browser (reopen one) and the evidence-ledger runs
 *  behind them. Both are remembered locally; the ledger itself is on the server. */
export default function ActivityDialog() {
  const open = useUi((s) => s.dialog) === 'activity'
  const closeDialog = useUi((s) => s.closeDialog)

  return (
    <WbDialog
      open={open}
      onClose={closeDialog}
      wide
      testId="activity-dialog"
      kicker="ACTIVITY"
      title="Activity history"
      description="Earlier conversations and the evidence-ledger runs behind them."
      foot={<button type="button" className={BTN} onClick={closeDialog}>Close</button>}
    >
      {open && <ActivityLists onOpened={closeDialog} />}
    </WbDialog>
  )
}
