'use client'

import { useState } from 'react'
import { ExternalLink, FileCheck2, Play, RotateCcw, ShieldCheck, Square, TestTube2 } from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useAgentWS } from '@/hooks/useAgentWS'
import { DiscoveryMap } from '@/components/investigate/DiscoveryMap'
import { HypothesisCards } from '@/components/investigate/HypothesisCards'
import { checkFinding, checkName } from '@/components/investigate/state'
import { useInvestigation } from '@/components/investigate/useInvestigation'
import { INVESTIGATION_FIXTURES, type FixtureName } from '@/components/investigate/fixtures'
import { ResultIdChip, StatusBadge } from '@/components/evidence/EvidencePieces'
import { downloadBundle, openSummary } from '@/components/evidence/ledger-actions'
import type { RowStatus } from '@/components/evidence/rows'
import { Button } from '@/components/ui/button'
import { aoiAreaKm2, formatAreaKm2 } from '@/lib/aoi'
import { cn } from '@/lib/utils'

const EYEBROW = 'mb-1.5 text-muted-foreground text-label'
const pct = (p: number) => `${Math.round(p * 100)}%`
const asRowStatus = (s: string): RowStatus => (['ok', 'flagged', 'refused', 'failed', 'skipped'].includes(s) ? (s as RowStatus) : 'unknown')

/** The investigation board: what an autonomous run looked at, what it believed at each step, which
 *  evidence moved the belief, and the verdict it reached, including "cannot determine". It is fed
 *  by the event stream of `POST /api/investigate`, or by a recorded example that is labelled as one. */
export default function InvestigationBoard() {
  const aoi = useStore((s) => s.aoi)
  const { applyAgentMessage } = useAgentWS()
  const thinking = useStore((st) => st.thinkingTokens)
  const { state, source, run, replay, stop, reset } = useInvestigation(applyAgentMessage)
  const [question, setQuestion] = useState('')
  const [fixture, setFixture] = useState<FixtureName>('resolved')
  const running = state.status === 'running'
  const km2 = aoiAreaKm2(aoi?.geometry)
  const idle = state.status === 'idle'

  return (
    <div className="grid gap-5" data-testid="investigation-board" data-status={state.status} data-source={source ?? undefined}>
      <div>
        <h2 className="font-heading text-panel text-foreground">Investigate this area</h2>
        <p className="mt-1.5 max-w-[52ch] text-body leading-relaxed text-muted-foreground">
          Looks for what changed here, lists the competing explanations, chooses the checks that tell them apart, and weighs each result. It can end in &ldquo;cannot determine&rdquo;.
        </p>
      </div>

      <div className="grid gap-2.5 rounded-lg border border-border p-3">
        <p className="text-caption text-muted-foreground" data-testid="investigate-aoi">
          {aoi ? `${aoi.type} area${km2 != null ? ` · ${formatAreaKm2(km2)}` : ''}` : 'No area drawn. Draw one on the map to investigate it.'}
        </p>
        <label className="grid gap-1 text-caption text-muted-foreground">
          What to look into (optional)
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={300}
            placeholder="For example: why did vegetation drop in September?"
            className="field"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button size="sm" onClick={stop} variant="secondary"><Square className="fill-current" aria-hidden />Stop</Button>
          ) : (
            <Button size="sm" disabled={!aoi?.geometry} onClick={() => aoi?.geometry && void run(aoi.geometry, question.trim())} data-testid="investigate-run">
              <Play aria-hidden />Investigate
            </Button>
          )}
          {!idle && <Button size="sm" variant="ghost" onClick={reset}><RotateCcw aria-hidden />Clear</Button>}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
          <TestTube2 className="size-3.5 text-muted-foreground" aria-hidden />
          <label className="sr-only" htmlFor="fixture-pick">Recorded example</label>
          <select
            id="fixture-pick"
            value={fixture}
            onChange={(e) => setFixture(e.target.value as FixtureName)}
            className="field field-sm w-auto"
          >
            {(Object.keys(INVESTIGATION_FIXTURES) as FixtureName[]).map((k) => (
              <option key={k} value={k}>{k === 'resolved' ? 'Reaches a verdict' : 'Cannot determine'}</option>
            ))}
          </select>
          <Button size="sm" variant="secondary" onClick={() => replay(fixture)} disabled={running} data-testid="investigate-replay">Replay a recorded example</Button>
        </div>
      </div>

      {source === 'fixture' && (
        <p role="note" className="rounded-md bg-amber-wash px-3 py-2 text-body text-warning" data-testid="fixture-banner">
          <b className="font-semibold">Recorded example.</b> These events are invented to show every state of the board. They are not a result for any real place.
        </p>
      )}
      {state.status === 'error' && (
        <p role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-body text-foreground" data-testid="investigate-error">
          <b className="font-semibold text-danger">Investigation stopped. </b>{state.error}
        </p>
      )}

      {running && (
        <div className="grid gap-1 text-body text-muted-foreground" data-testid="investigate-working">
          <p>{source === 'live' ? 'Working. A live investigation can take several minutes.' : 'Replaying the recorded example.'}</p>
          {thinking.slice(-3).map((t) => <p key={t.id} className="text-caption">{t.content}</p>)}
        </div>
      )}

      {state.discovery && (
        <section aria-label="Where it looked">
          <h3 className={EYEBROW}>Where it looked</h3>
          <DiscoveryMap discovery={state.discovery} />
        </section>
      )}

      {state.hypotheses.length > 0 && (
        <section aria-label="Explanations">
          <h3 className={EYEBROW}>Explanations</h3>
          <HypothesisCards state={state} />
        </section>
      )}

      {state.steps.length > 0 && (
        <section aria-label="Checks run">
          <h3 className={EYEBROW}>Checks run</h3>
          <ol className="grid gap-2.5">
            {state.steps.map((s) => (
              <li key={s.n} className="rounded-lg border border-border p-3" data-testid="investigation-step">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 text-body-strong leading-snug text-foreground">
                    <span className="mr-1.5 text-muted-foreground tabular-nums">{s.n}.</span>
                    {checkName(s)}
                  </p>
                  {s.evidence && <StatusBadge status={asRowStatus(s.evidence.status)} />}
                </div>
                {s.evidence ? (
                  <p className="mt-1 text-body leading-relaxed text-foreground" data-testid="check-finding">{checkFinding(s)}</p>
                ) : (
                  <p className="mt-1 text-caption text-muted-foreground">Waiting for the result.</p>
                )}
                {(s.why || s.evidence) && (
                  <details className="mt-1.5 text-caption text-muted-foreground">
                    <summary className="w-fit cursor-pointer select-none underline-offset-2 hover:text-foreground hover:underline">Details</summary>
                    <div className="mt-1.5 grid gap-1.5 border-t border-border pt-2">
                      {s.why && <p className="leading-relaxed">{s.why}{s.voi > 0 && ` Expected information ${s.voi.toFixed(2)}.`}</p>}
                      {s.evidence && <p className="leading-relaxed text-foreground">{s.evidence.summary}</p>}
                      {s.evidence && <ResultIdChip id={s.evidence.resultId} />}
                    </div>
                  </details>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {state.corroboration && (
        <section aria-label="Outside reporting">
          <h3 className={EYEBROW}>Outside reporting</h3>
          <p className="mb-1.5 text-body leading-relaxed text-muted-foreground">{state.corroboration.note}</p>
          <ul className="divide-y divide-border border-y border-border">
            {state.corroboration.sources.map((src) => (
              <li key={src.url} className="py-2">
                <a href={src.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-start gap-1 text-body-strong text-brand-text underline-offset-2 hover:underline">
                  {src.title}<ExternalLink className="mt-1 size-3 shrink-0" aria-hidden />
                </a>
                <p className="text-caption text-muted-foreground">
                  {src.publisher} · {src.date} · <span className={cn(src.inWindow ? 'text-foreground' : '')}>{src.inWindow ? 'inside the event window' : 'outside the event window'}</span>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {state.verdict && (
        <section
          aria-label="Verdict"
          className={cn('rounded-lg border p-4', state.verdict.kind === 'hypothesis' ? 'border-foreground/30' : 'border-border bg-muted')}
          data-testid="verdict"
          data-kind={state.verdict.kind}
        >
          <h3 className={EYEBROW}>{state.verdict.kind === 'hypothesis' ? 'Most probable explanation' : 'Verdict'}</h3>
          <p className="font-heading text-panel leading-tight text-foreground">{state.verdict.label}</p>
          <p className="mt-1 text-body text-muted-foreground">
            {state.verdict.kind === 'hypothesis' ? `${pct(state.verdict.posterior)} probability, from ${state.verdict.decidingEvidence?.length ?? 0} deciding ${state.verdict.decidingEvidence?.length === 1 ? 'result' : 'results'}.` : `The leading explanation reaches only ${pct(state.verdict.posterior)}, too little to call.`}
          </p>
        </section>
      )}

      {state.dossier && (
        <section aria-label="Dossier" className="grid gap-2.5">
          <p className="text-body leading-relaxed text-foreground">{state.dossier.summary}</p>
          {source === 'live' && state.dossier.runId ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void downloadBundle(state.dossier!.runId)}><ShieldCheck aria-hidden />Signed bundle</Button>
              <Button size="sm" variant="secondary" onClick={() => void openSummary(state.dossier!.runId)}><FileCheck2 aria-hidden />PDF summary</Button>
            </div>
          ) : (
            <p className="text-caption text-muted-foreground">{source === 'live' ? 'The evidence ledger was unavailable for this run, so there is no signed bundle.' : 'A recorded example has no ledger run, so it has no signed bundle.'}</p>
          )}
        </section>
      )}
    </div>
  )
}
