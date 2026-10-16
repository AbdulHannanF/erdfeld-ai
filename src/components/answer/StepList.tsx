'use client'

import { memo } from 'react'
import { AlertTriangle, Check, Circle, Loader2, MinusCircle, ShieldX, XCircle } from 'lucide-react'
import { useStore, type ToolCallStatus } from '@/store/useStore'
import { stepOutcome, type StepOutcome } from '@/components/answer/derive'
import { cn } from '@/lib/utils'

const OUTCOME: Record<StepOutcome, { icon: typeof Check; className: string; word: string }> = {
  running: { icon: Loader2, className: 'text-warning animate-spin', word: 'running' },
  ok: { icon: Check, className: 'text-brand-text', word: 'done' },
  flagged: { icon: AlertTriangle, className: 'text-warning', word: 'ran, flagged' },
  refused: { icon: ShieldX, className: 'text-danger', word: 'not run' },
  failed: { icon: XCircle, className: 'text-danger', word: 'failed' },
  no_data: { icon: MinusCircle, className: 'text-muted-foreground', word: 'no data' },
}

export function formatDuration(ms: number): string {
  return ms < 950 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`
}

const pretty = (tool: string) => tool.replace(/_/g, ' ')

/** A compact list of what was run: one line per step with its outcome and how long it took. A step
 *  that failed, was refused or found nothing says so on its line; the reason is on the next. */
export const StepList = memo(function StepList() {
  const toolCalls = useStore((s) => s.toolCalls)
  const plan = useStore((s) => s.currentPlan)
  const toolResults = useStore((s) => s.toolResults)
  const layers = useStore((s) => s.layers)

  // Steps the plan has queued but the run has not reached yet.
  const reached = new Set(toolCalls.map((t) => t.toolName))
  const queued = (plan?.steps ?? []).filter((s) => s.status === 'queued' && !reached.has(s.tool))
  if (toolCalls.length === 0 && queued.length === 0) return null

  const reasonFor = (tc: ToolCallStatus, i: number) => plan?.steps[i]?.tool === tc.toolName ? plan.steps[i].reason : plan?.steps.find((s) => s.tool === tc.toolName)?.reason
  const total = toolCalls.reduce((sum, t) => sum + (t.durationMs ?? 0), 0)
  const finished = toolCalls.every((t) => t.status !== 'running')

  return (
    <section aria-label="What was run">
      <h3 className="mb-1.5 flex items-baseline justify-between text-muted-foreground text-label">
        <span>What was run</span>
        {finished && total > 0 && <span className="font-semibold normal-case tracking-normal tabular-nums">{toolCalls.length} {toolCalls.length === 1 ? 'step' : 'steps'} · {formatDuration(total)}</span>}
      </h3>
      <ol className="grid gap-px text-body">
        {toolCalls.map((tc, i) => {
          const outcome = stepOutcome(tc, toolResults, layers)
          const { icon: Icon, className, word } = OUTCOME[outcome]
          const reason = reasonFor(tc, i)
          const detail = outcome === 'failed' || outcome === 'refused' ? tc.errorText : outcome === 'flagged' ? tc.verdict?.checks.filter((c) => c.status !== 'pass').map((c) => c.message).join(' ') : outcome === 'no_data' ? 'The step ran and returned no data for this area and period.' : undefined
          return (
            <li key={`${tc.toolName}-${i}`} className="grid grid-cols-[1rem_1fr_auto] items-start gap-x-2.5 py-1">
              <Icon className={cn('mt-[0.1875rem] size-3.5', className)} aria-hidden />
              <span className="min-w-0">
                <span className={cn('block leading-snug', outcome === 'running' ? 'text-foreground' : 'text-muted-foreground')}>
                  {tc.label || pretty(tc.toolName)}
                  {outcome !== 'ok' && outcome !== 'running' && <span className="ml-1.5 text-caption-strong text-foreground">({word})</span>}
                </span>
                {detail ? (
                  <span className="mt-0.5 block text-caption leading-snug text-muted-foreground">{detail}</span>
                ) : reason && outcome === 'running' ? (
                  <span className="mt-0.5 block text-caption leading-snug text-muted-foreground">{reason}</span>
                ) : null}
              </span>
              <span className="pt-px text-caption tabular-nums text-muted-foreground">
                {tc.durationMs != null && tc.status !== 'running' ? formatDuration(tc.durationMs) : ''}
              </span>
            </li>
          )
        })}
        {queued.map((s, i) => (
          <li key={`q-${i}`} className="grid grid-cols-[1rem_1fr] items-start gap-x-2.5 py-1 text-muted-foreground">
            <Circle className="mt-[0.1875rem] size-3.5" aria-hidden />
            <span className="leading-snug">{pretty(s.tool)} <span className="text-caption">(queued)</span></span>
          </li>
        ))}
      </ol>
    </section>
  )
})
