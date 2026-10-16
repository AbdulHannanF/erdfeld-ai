'use client'

import { useEffect, useMemo, useState } from 'react'
import { Download, FileCheck2, Loader2, Info, ShieldCheck } from 'lucide-react'
import { useStore, type ChatMessage } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import CitedMarkdown, { citationRefsIn } from '@/components/answer/CitedMarkdown'
import { StepList } from '@/components/answer/StepList'
import FigureCharts from '@/components/answer/FigureCharts'
import FeatureList from '@/components/answer/FeatureList'
import ExportMenu from '@/components/answer/ExportMenu'
import ShareMenu from '@/components/answer/ShareMenu'
import { AgentErrorNotice, CannotDetermineNotice, CaveatNote, FetchFailedNotice, RefusedNotice } from '@/components/answer/AnswerStates'
import { caveats, citedFigures, keyFigures, runHeadline, summariseRun } from '@/components/answer/derive'
import { downloadBundle } from '@/components/evidence/ledger-actions'
import { useResultDetails } from '@/components/evidence/useResultDetails'
import { Button } from '@/components/ui/button'
import { aoiAreaKm2, formatAreaKm2 } from '@/lib/aoi'
import { cn } from '@/lib/utils'

const NO_PROVIDER_ERROR_MARKER = 'No AI provider is configured'

/** Seconds since `active` became true; a live run can take minutes, so the wait shows its age. */
function useElapsed(active: boolean): number {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    if (!active) return
    const t0 = Date.now()
    const id = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => {
      clearInterval(id)
      setSecs(0)
    }
  }, [active])
  return secs
}

const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** The answer to the latest question: the question, what was run, the answer with its citations,
 *  the figures it rests on with their ranges, what to be careful about, and what to do with it. */
export default function AnswerView({ onRetry }: { onRetry: () => void }) {
  const messages = useStore((s) => s.messages)
  const streaming = useStore((s) => s.streamingContent)
  const isLoading = useStore((s) => s.isLoading)
  const toolCalls = useStore((s) => s.toolCalls)
  const liveResults = useStore((s) => s.toolResults)
  const layers = useStore((s) => s.layers)
  const aoi = useStore((s) => s.aoi)
  const agentError = useStore((s) => s.agentError)
  const lastQuery = useStore((s) => s.lastQuery)
  const ledgerRunIds = useStore((s) => s.ledgerRunIds)
  const setSettingsPanelOpen = useStore((s) => s.setSettingsPanelOpen)
  const showResults = useUi((s) => s.showResults)
  const thinking = useStore((s) => s.thinkingTokens)
  const runNotice = useStore((s) => s.runNotice)
  const elapsed = useElapsed(isLoading)

  const lastUser = messages.map((m) => m.role).lastIndexOf('user')
  const question = lastUser >= 0 ? messages[lastUser] : null
  // Quick layers answer in their own words, outside any question: they are shown apart.
  const isQuick = (m: ChatMessage) => m.id.startsWith('quick-')
  const quick = messages.filter((m) => isQuick(m) && m.content)
  const reply: ChatMessage | undefined = lastUser >= 0 ? messages.slice(lastUser + 1).find((m) => m.role === 'assistant' && !isQuick(m)) : undefined
  const content = isLoading ? streaming : (reply?.content ?? '')
  const results = reply?.toolResults ?? liveResults
  const earlier = useMemo(() => {
    const out: Array<{ q: ChatMessage; a?: ChatMessage }> = []
    const upTo = lastUser >= 0 ? lastUser : messages.length
    for (let i = 0; i < upTo; i++) {
      if (messages[i].role === 'user') out.push({ q: messages[i], a: messages.slice(i + 1).find((m) => m.role === 'assistant' && !isQuick(m) && m.content) })
    }
    return out.reverse()
  }, [messages, lastUser])

  const refs = citationRefsIn(content)
  const runResultIds = [...new Set([...refs.map((r) => r.resultId), ...toolCalls.flatMap((t) => (t.resultId ? [t.resultId] : []))])]
  const details = useResultDetails(isLoading ? [] : runResultIds)
  const figures = citedFigures(refs, results, details)
  const head = isLoading ? null : runHeadline(figures, runResultIds, results)
  const keys = isLoading ? [] : keyFigures(runResultIds, results)
  const note = isLoading ? [] : caveats(runResultIds, results, details)
  const run = summariseRun(toolCalls, liveResults, layers, isLoading)
  const runId = ledgerRunIds[ledgerRunIds.length - 1]
  const km2 = aoiAreaKm2(aoi?.geometry)
  const noProvider = !!agentError?.includes(NO_PROVIDER_ERROR_MARKER)
  const status = isLoading
    ? `Working. ${toolCalls.filter((t) => t.status === 'running').map((t) => t.label || t.toolName).join(', ') || 'Reading the question'}.`
    : reply?.content ? 'The answer is ready.' : ''

  if (!question && quick.length === 0) return null

  const quickNotes = quick.length > 0 && (
    <section aria-label="Quick layer results" className="grid gap-3" data-testid="quick-notes">
      {quick.map((m) => (
        <div key={m.id} className="rounded-lg border border-border bg-muted/40 px-3.5 py-3 text-[0.8125rem]">
          <CitedMarkdown content={m.content} toolResults={liveResults} />
        </div>
      ))}
    </section>
  )

  if (!question) {
    return (
      <div className="grid gap-5" data-testid="answer-view">
        <h2 className="font-heading text-lg font-medium text-foreground">Quick layer</h2>
        <StepList />
        {quickNotes}
        <FeatureList />
      </div>
    )
  }

  return (
    <div className="thread-in grid gap-6" data-testid="answer-view">
      {/* spoken status for assistive technology; the visible steps below carry the same news */}
      <p className="sr-only" role="status" aria-live="polite">{status}</p>

      {agentError && !isLoading && lastQuery && (
        <AgentErrorNotice message={agentError} noProvider={noProvider} onRetry={onRetry} onOpenSettings={() => setSettingsPanelOpen(true)} />
      )}

      <div>
        <h2 className="font-heading text-lg font-medium tracking-[-0.005em] text-foreground">{question.content}</h2>
        <p className="mt-1.5 text-xs text-muted-foreground">
          You · {time(question.timestamp)}
          {aoi && ` · ${aoi.type} area${km2 != null ? `, ${formatAreaKm2(km2)}` : ''}`}
        </p>
        {runNotice && (
          <p className="mt-1 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground" role="status" data-testid="run-notice">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />{runNotice}
          </p>
        )}
      </div>

      <StepList />

      {!isLoading && run.state === 'refused' && <RefusedNotice run={run} />}
      {!isLoading && run.state === 'failed' && <FetchFailedNotice run={run} />}
      {!isLoading && run.state === 'cannot_determine' && <CannotDetermineNotice run={run} />}

      {head && (
        <p className="font-heading text-2xl font-semibold tracking-[-0.015em] text-foreground" data-testid="answer-headline">
          {head.text}
          {head.label && <span className="ml-2 font-medium text-muted-foreground">{head.label}</span>}
          {head.lowConfidence && (
            <span className="ml-2 inline-block rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 align-middle text-xs font-medium text-warning">Low confidence</span>
          )}
        </p>
      )}

      <div aria-live="polite" aria-atomic="false" aria-busy={isLoading} className={cn(isLoading && !content && 'min-h-6')}>
        {isLoading && !content ? (
          <div className="grid gap-1 text-[0.8125rem] text-muted-foreground" data-testid="working">
            <p className="inline-flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" aria-hidden />Working on it<span className="tabular-nums">({elapsed} s)</span></p>
            {thinking.slice(-3).map((t) => <p key={t.id} className="pl-5 text-xs leading-snug" data-testid="status-line">{t.content}</p>)}
            {elapsed > 60 && <p className="pl-5 text-xs">Some analyses take a few minutes. The steps above show what has finished.</p>}
          </div>
        ) : content ? (
          <CitedMarkdown content={content} toolResults={isLoading ? undefined : results} charts={reply?.charts} liveCharts={isLoading} />
        ) : null}
      </div>

      {!isLoading && (keys.length > 0 || figures.length > 1) && (
        <section aria-label="Key figures" className="grid gap-3">
          {/* a field delineation shows what its result recorded; any other run shows the extra cited figures */}
          <dl className="grid grid-flow-col auto-cols-fr border-y border-border" data-testid="key-figures">
            {(keys.length > 0 ? keys.map((k) => ({ id: k.label, label: k.label, value: k.value })) : figures.slice(1, 4).map((f) => ({ id: `${f.resultId}#${f.key}`, label: `${f.label}${f.range ? ` · ${f.range.low} to ${f.range.high}` : ''}`, value: f.value }))).map((f, i) => (
              <div key={f.id} className={cn('grid content-start gap-0.5 py-3', i > 0 && 'border-l border-border pl-3')}>
                <dt className="order-2 text-xs text-muted-foreground">{f.label}</dt>
                <dd className="order-1 font-heading text-lg font-semibold">{f.value}</dd>
              </div>
            ))}
          </dl>
          {keys.length === 0 && figures.length > 4 && (
            <ul className="divide-y divide-border border-b border-border">
              {figures.slice(4).map((f) => (
                <li key={`${f.resultId}#${f.key}`} className="py-2 text-sm leading-snug text-foreground">{f.sentence}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {quickNotes}

      <CaveatNote items={note} />

      {!isLoading && <FigureCharts />}
      {!isLoading && <FeatureList />}

      {!isLoading && reply?.content && (
        <div className="grid gap-2.5">
          <div className="flex flex-wrap gap-2">
            <ExportMenu align="start" side="top">
              <Button size="sm"><Download aria-hidden />Export</Button>
            </ExportMenu>
            {runId && (
              <Button variant="outline" size="sm" onClick={() => void downloadBundle(runId)}><ShieldCheck aria-hidden />Signed bundle</Button>
            )}
            <ShareMenu />
            {runId && (
              <Button variant="ghost" size="sm" onClick={showResults}><FileCheck2 aria-hidden />See evidence</Button>
            )}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {runResultIds.length > 0 ? `${runResultIds.length} ${runResultIds.length === 1 ? 'result' : 'results'} · ` : ''}
            computed {time(reply.timestamp)}
            {runId ? ' · reproducible from the evidence ledger' : ''}
          </p>
        </div>
      )}

      {earlier.length > 0 && (
        <section aria-label="Earlier in this session" className="border-t border-border pt-3">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Earlier in this session</h3>
          <ul className="divide-y divide-border">
            {earlier.map(({ q, a }) => (
              <li key={q.id}>
                <details className="group py-2">
                  <summary className="cursor-pointer list-none text-[0.8125rem] text-foreground marker:hidden [&::-webkit-details-marker]:hidden">
                    <span className="mr-1.5 text-muted-foreground group-open:hidden">+</span>
                    <span className="mr-1.5 hidden text-muted-foreground group-open:inline">−</span>
                    {q.content}
                  </summary>
                  {a ? <div className="mt-2 pl-4"><CitedMarkdown content={a.content} toolResults={a.toolResults} charts={a.charts} /></div> : <p className="mt-2 pl-4 text-xs text-muted-foreground">No answer was recorded.</p>}
                </details>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
