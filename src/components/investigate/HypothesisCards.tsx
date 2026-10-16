'use client'

import { currentBelief, leading, ruledOut, ruledOutReason, type InvestigationState } from '@/components/investigate/state'
import { cn } from '@/lib/utils'

const pct = (p: number) => `${Math.round(p * 100)}%`

/** The competing explanations and how likely each is now. The bars animate from step to step, so
 *  the evidence visibly moves the belief. */
export function HypothesisCards({ state }: { state: InvestigationState }) {
  const now = currentBelief(state)
  const live = leading(state)
  const out = ruledOut(state)
  if (state.hypotheses.length === 0) return null
  const top = live[0]?.hypothesis.id

  return (
    <div className="grid gap-4">
      <ul className="grid gap-2" aria-label="Hypotheses still in play">
        {live.map(({ hypothesis: h, probability }) => (
          <li key={h.id} className={cn('rounded-lg border bg-card p-3', h.id === top ? 'border-foreground/30' : 'border-border')} data-testid="hypothesis" data-hypothesis={h.id}>
            <div className="flex items-baseline justify-between gap-3">
              <p className="min-w-0 text-body-strong leading-snug text-foreground">{h.label}</p>
              <p className="shrink-0 font-heading text-body-strong tabular-nums text-foreground" data-testid="hypothesis-probability">{pct(probability)}</p>
            </div>
            <div
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
              role="meter"
              aria-label={`Probability of ${h.label}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(probability * 100)}
            >
              <div
                className={cn('h-full rounded-full transition-[width] duration-700 ease-[cubic-bezier(0.23,1,0.32,1)]', h.id === top ? 'bg-primary' : 'bg-muted-foreground/50')}
                style={{ width: `${Math.max(1, probability * 100)}%` }}
              />
            </div>
            <p className="mt-1.5 text-caption text-muted-foreground">
              {h.family} · started at {pct(h.prior)}
            </p>
          </li>
        ))}
      </ul>

      {out.length > 0 && (
        <section aria-label="Ruled out">
          <h4 className="mb-1 text-muted-foreground text-label">Ruled out</h4>
          <ul className="divide-y divide-border border-y border-border">
            {out.map((r) => (
              <li key={r.hypothesis.id} className="py-2" data-testid="ruled-out">
                <p className="flex items-baseline justify-between gap-3 text-body text-muted-foreground">
                  <span className="min-w-0 line-through decoration-muted-foreground/50">{r.hypothesis.label}</span>
                  <span className="shrink-0 tabular-nums">{pct(r.probability)}</span>
                </p>
                <p className="mt-0.5 text-caption leading-relaxed text-muted-foreground" data-testid="ruled-out-reason">{ruledOutReason(r)}</p>
                {r.step?.evidence && (
                  <details className="group mt-1 text-caption text-muted-foreground">
                    <summary className="w-fit cursor-pointer select-none underline-offset-2 hover:text-foreground hover:underline">Details</summary>
                    <p className="mt-1 leading-relaxed">Check {r.step.n}: {r.step.evidence.summary}</p>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
