'use client'

import { useEffect, useState } from 'react'
import { CHECKING, describeHealth, UNREACHABLE, type HealthState, type HealthView } from '@/components/shell/health'
import { cn } from '@/lib/utils'

const DOT: Record<HealthState, string> = {
  unknown: 'bg-muted-foreground/50',
  ok: 'bg-success',
  degraded: 'bg-warning',
  down: 'bg-danger',
}

/** Backend health from `/api/health`, read on load and every minute: green "Operational", amber
 *  "Degraded" with the failing dependencies in the tooltip, red only when the app's own API does
 *  not answer. `pill` shows the mono label of the design's environment status; `dot` is the dot
 *  alone. The status is text for assistive technology either way. */
export function HealthDot({ variant = 'dot', className }: { variant?: 'dot' | 'pill'; className?: string }) {
  const [view, setView] = useState<HealthView>(CHECKING)
  useEffect(() => {
    let cancelled = false
    const read = () =>
      fetch('/api/health', { cache: 'no-store' })
        .then(async (r) => {
          // the API answers 503 with a full report when the database is down: that is "degraded", not "unreachable"
          const body = await r.json().catch(() => null)
          if (!cancelled) setView(describeHealth(body))
        })
        .catch(() => {
          if (!cancelled) setView(UNREACHABLE)
        })
    void read()
    const id = window.setInterval(() => void read(), 60_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])
  return (
    <span
      className={cn('inline-flex items-center gap-[0.3125rem]', variant === 'pill' ? 'font-mono text-xs tracking-[0.04em] text-muted-foreground' : 'size-8 justify-center', className)}
      title={view.label}
      role="status"
      data-testid="health-dot"
      data-health={view.state}
    >
      <span className={cn('size-[0.375rem] rounded-full', DOT[view.state], variant === 'pill' && 'shadow-[0_0_0_0.1875rem_color-mix(in_srgb,currentColor_12%,transparent)]')} aria-hidden />
      {variant === 'pill' ? <span aria-hidden>{view.short}</span> : null}
      <span className="sr-only">{view.label}</span>
    </span>
  )
}
