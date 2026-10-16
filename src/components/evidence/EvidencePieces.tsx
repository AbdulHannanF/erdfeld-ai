'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { RowStatus } from '@/components/evidence/rows'
import { cn } from '@/lib/utils'

/** Small shared pieces of an evidence listing: the Evidence tab and the case page draw the same
 *  statuses, result ids and figure grids, so they look and read the same. */

const STATUS: Record<RowStatus, { label: string; className: string }> = {
  ok: { label: 'Checks passed', className: 'border-success/30 bg-success/10 text-success' },
  flagged: { label: 'Flagged', className: 'border-warning/40 bg-warning/10 text-warning' },
  refused: { label: 'Refused', className: 'border-danger/30 bg-danger/10 text-danger' },
  failed: { label: 'Failed', className: 'border-danger/30 bg-danger/10 text-danger' },
  skipped: { label: 'Skipped', className: 'border-border bg-muted text-muted-foreground' },
  unknown: { label: 'Not recorded', className: 'border-border bg-muted text-muted-foreground' },
}

/** The validation status of a result, in words. */
export function StatusBadge({ status, className }: { status: RowStatus; className?: string }) {
  const s = STATUS[status]
  return (
    <span data-status={status} className={cn('inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-xs font-medium leading-none', s.className, className)}>
      {s.label}
    </span>
  )
}

/** A content-hash result id with a copy button: the id is what a citation and a ledger refer to. */
export function ResultIdChip({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <code className="truncate rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-foreground" title="Content-hash id of this result">{id}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(id).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={copied ? 'Result id copied' : 'Copy the result id'}
      >
        {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
      </button>
    </span>
  )
}

/** Figures of a result as a compact grid of name over value. `mark` outlines the one a citation named. */
export function FigureGrid({ entries, mark, className }: { entries: Array<[string, string]>; mark?: string; className?: string }) {
  if (entries.length === 0) return null
  return (
    <dl className={cn('grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3', className)}>
      {entries.map(([k, v]) => (
        <div key={k} className={cn('min-w-0 rounded px-1 py-0.5', mark === k && 'bg-accent ring-1 ring-ring')} data-marked={mark === k || undefined}>
          <dt className="truncate text-muted-foreground">{k.replace(/_/g, ' ')}</dt>
          <dd className="truncate tabular-nums text-foreground" title={v}>{v}</dd>
        </div>
      ))}
    </dl>
  )
}
