'use client'

import { AlertTriangle, CircleHelp, CloudOff, RotateCcw, ShieldX } from 'lucide-react'
import type { RunSummary } from '@/components/answer/derive'
import { Button } from '@/components/ui/button'

/**
 * The states an answer can honestly be in when it is not simply "here are the figures". Each says
 * what happened and why, in the words the run recorded, and none is dressed up as a result.
 */

const shell = 'rounded-lg border px-3.5 py-3 text-body leading-relaxed'

/** Every step was refused before it ran: nothing was computed, and the reasons say why. */
export function RefusedNotice({ run }: { run: RunSummary }) {
  return (
    <div role="alert" className={`${shell} border-danger/30 bg-danger/10`} data-testid="state-refused">
      <p className="flex items-center gap-2 font-semibold text-danger"><ShieldX className="size-4 shrink-0" aria-hidden />Not run</p>
      <p className="mt-1 text-foreground">Nothing was computed for this question. The checks before running refused it:</p>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-foreground">
        {run.reasons.map((r, i) => <li key={i}><span className="font-semibold">{r.label}.</span> {r.text}</li>)}
      </ul>
    </div>
  )
}

/** The data could not be read. Different from "there is no data": the answer is unknown, not empty. */
export function FetchFailedNotice({ run }: { run: RunSummary }) {
  return (
    <div role="alert" className={`${shell} border-danger/30 bg-danger/10`} data-testid="state-failed">
      <p className="flex items-center gap-2 font-semibold text-danger"><CloudOff className="size-4 shrink-0" aria-hidden />The data could not be read</p>
      <p className="mt-1 text-foreground">
        This is a failed fetch, not an empty result, so nothing can be said about the area from it. Try again; if it keeps failing the source may be down.
      </p>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted-foreground">
        {run.reasons.map((r, i) => <li key={i}><span className="font-semibold text-foreground">{r.label}.</span> {r.text}</li>)}
      </ul>
    </div>
  )
}

/** The steps ran but none returned usable evidence. The honest answer is that it cannot be determined. */
export function CannotDetermineNotice({ run }: { run: RunSummary }) {
  return (
    <div role="status" className={`${shell} border-info/30 bg-info/10`} data-testid="state-cannot-determine">
      <p className="flex items-center gap-2 font-semibold text-info"><CircleHelp className="size-4 shrink-0" aria-hidden />Cannot determine</p>
      <p className="mt-1 text-foreground">No step returned usable data for this area and period, so there is no figure to give.</p>
      {run.reasons.length > 0 && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted-foreground">
          {run.reasons.map((r, i) => <li key={i}><span className="font-semibold text-foreground">{r.label}.</span> {r.text}</li>)}
        </ul>
      )}
    </div>
  )
}

/** Things worth knowing before relying on the answer: recorded uncertainty, warned checks, low confidence. */
export function CaveatNote({ items }: { items: string[] }) {
  if (items.length === 0) return null
  return (
    <aside role="note" className="grid grid-cols-[1rem_1fr] gap-3 rounded-md bg-amber-wash px-4 py-3 text-body text-warning" data-testid="caveat-note">
      <AlertTriangle className="mt-0.5 size-[0.9375rem]" aria-hidden />
      <div>
        <p className="font-semibold">Read with care</p>
        <ul className="mt-0.5 space-y-0.5">
          {items.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
      </div>
    </aside>
  )
}

/** The model call itself failed (provider, key, connection). Retrying re-sends the last question. */
export function AgentErrorNotice({ message, onRetry, onOpenSettings, noProvider }: { message: string; onRetry: () => void; onOpenSettings: () => void; noProvider: boolean }) {
  return (
    <div role="alert" className={`${shell} flex items-start justify-between gap-3 ${noProvider ? 'border-warning/30 bg-warning/10' : 'border-danger/30 bg-danger/10'}`} data-testid="state-agent-error">
      <p className={noProvider ? 'text-foreground' : 'text-foreground'}>
        <span className={`font-semibold ${noProvider ? 'text-warning' : 'text-danger'}`}>{noProvider ? 'No AI provider is set up. ' : 'The question could not be answered. '}</span>
        {noProvider ? 'Choose a provider in Settings to ask questions.' : message}
      </p>
      {noProvider ? (
        <Button size="sm" variant="secondary" onClick={onOpenSettings}>Open settings</Button>
      ) : (
        <Button size="sm" variant="secondary" onClick={onRetry}><RotateCcw aria-hidden />Retry</Button>
      )}
    </div>
  )
}
