'use client'

import { cn } from '@/lib/utils'

export interface SegmentedOption<T extends string> {
  value: T
  label: React.ReactNode
  /** Accessible name when `label` is an icon. */
  title?: string
  disabled?: boolean
}

/** A small exclusive choice, drawn the same way everywhere (view mode, basemap, theme, Ask or
 *  Investigate). Buttons with `aria-pressed` inside a labelled group: the same semantics as a
 *  toolbar of toggles, and keyboard order is the visual order. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = 'md',
  surface = 'muted',
  className,
}: {
  value: T
  onChange: (value: T) => void
  options: SegmentedOption<T>[]
  label: string
  size?: 'sm' | 'md'
  /** 'card' for controls that float over the map: a card-coloured track, the chosen option sunk. */
  surface?: 'muted' | 'card'
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('inline-flex items-center gap-0.5 rounded-lg border border-border p-[0.1875rem]', surface === 'card' ? 'rounded-[0.625rem] bg-card shadow-float' : 'bg-muted', className)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          aria-label={o.title}
          title={o.title}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex items-center justify-center gap-1.5 font-medium transition-colors disabled:opacity-40',
            surface === 'card' ? 'rounded-[0.4375rem]' : 'rounded-md',
            size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-3 text-[0.8125rem]',
            surface === 'card' && 'h-auto px-3 py-[0.3125rem]',
            value === o.value
              ? surface === 'card' ? 'bg-muted text-foreground' : 'bg-card text-foreground shadow-sm ring-1 ring-border'
              : surface === 'card' ? 'text-muted-foreground hover:text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
