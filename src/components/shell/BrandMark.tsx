import { cn } from '@/lib/utils'

/**
 * The Erdfeld AI mark and wordmark as the workbench design draws them: the layered-terrain mark,
 * then "ERDFELD AI" in tracked caps with the "SPATIAL INTELLIGENCE" tagline beneath. Inline SVG and
 * live text, so it takes the theme with no image to load. `variant="mark"` is the mark alone.
 */
export function BrandMark({
  variant = 'lockup',
  height = 38,
  tagline = true,
  className,
}: {
  variant?: 'lockup' | 'mark'
  /** Rendered height of the mark in px at the base scale (set in rem, so it follows the UI scale). */
  height?: number
  /** Show "SPATIAL INTELLIGENCE" under the wordmark. */
  tagline?: boolean
  className?: string
}) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-2.5 text-foreground', className)} role="img" aria-label="Erdfeld AI">
      <svg viewBox="0 0 88 92" style={{ width: `${(height * 88) / 92 / 16}rem`, height: `${height / 16}rem` }} fill="none" aria-hidden="true" className="shrink-0">
        <path d="M44 2 84 24 44 47 4 24 44 2Z" fill="#2E8C78" stroke="#8ED6B2" strokeWidth="1.3" />
        <path d="M9 25 44 45 79 25M13 20c8-8 14-6 19-12m0 17c9-8 16-6 22-13m1 20c8-8 14-7 20-15" stroke="#C2E8D0" strokeOpacity=".72" />
        <path d="M4 31 44 53 84 31v11L44 65 4 42V31Z" fill="#438B70" stroke="#DBEADB" strokeWidth="1.2" />
        <path d="M4 51 44 73 84 51v12L44 86 4 63V51Z" fill="#143D42" stroke="#79C5BE" strokeWidth="1.2" />
        <path d="M4 42 44 64 84 42M4 63 44 85 84 63" stroke="#D9EBDD" strokeWidth="1.2" />
      </svg>
      {variant === 'lockup' && (
        <span aria-hidden="true" className="min-w-0 whitespace-nowrap font-heading text-[0.875rem] font-bold leading-none tracking-[0.16em]">
          ERDFELD<em className="ml-[0.4em] not-italic text-brand-text">AI</em>
          {tagline && <span className="mt-[0.3125rem] block whitespace-normal font-mono text-xs font-normal leading-[1.25] tracking-[0.04em] text-muted-foreground">SPATIAL<br />INTELLIGENCE</span>}
        </span>
      )}
    </span>
  )
}
