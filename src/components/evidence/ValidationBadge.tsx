'use client'

import { AlertTriangle, ShieldX } from 'lucide-react'
import type { ResultVerdict } from '@/store/useStore'

/** The checks that did not pass, failures first, as one line each. */
function messages(verdict: ResultVerdict): string[] {
  return [...verdict.checks]
    .sort((a, b) => Number(b.status === 'fail') - Number(a.status === 'fail'))
    .map((c) => c.message)
}

/** Small pill for a result the validation did not pass cleanly: `flagged` (it ran, a dynamic
 *  check failed, so the figures are drawn but never presented as fine) or `refused` (a static
 *  check failed, nothing ran). Warnings alone show nothing here; they ride in the tooltip text. */
export function ValidationBadge({ verdict }: { verdict?: ResultVerdict }) {
  if (!verdict || (verdict.status !== 'flagged' && verdict.status !== 'refused')) return null
  const refused = verdict.status === 'refused'
  const Icon = refused ? ShieldX : AlertTriangle
  return (
    <span
      data-testid="validation-badge"
      data-status={verdict.status}
      title={messages(verdict).join('\n')}
      className={`badge ${
        refused ? 'badge-danger' : 'badge-warning'
      }`}
    >
      <Icon aria-hidden />
      {verdict.status}
    </span>
  )
}

/** The failing checks written out, for a legend or a tool step that has the room. */
export function ValidationNotice({ verdict }: { verdict?: ResultVerdict }) {
  if (!verdict || (verdict.status !== 'flagged' && verdict.status !== 'refused')) return null
  const refused = verdict.status === 'refused'
  return (
    <ul
      data-testid="validation-notice"
      className={`mt-1 space-y-0.5 rounded-sm border px-2 py-1 text-caption leading-snug ${
        refused ? 'border-danger/30 bg-danger/10 text-danger' : 'border-warning/30 bg-warning/10 text-warning'
      }`}
    >
      {messages(verdict).map((m, i) => (
        <li key={i}>{m}</li>
      ))}
    </ul>
  )
}
