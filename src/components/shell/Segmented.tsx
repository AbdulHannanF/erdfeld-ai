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
 *  toolbar of toggles, and keyboard order is the visual order. Styled by `.segmented` in globals.css. */
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
      className={cn('segmented', size === 'sm' && 'segmented-sm', surface === 'card' && 'segmented-card', className)}
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
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
