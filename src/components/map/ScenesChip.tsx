'use client'

import { useMemo } from 'react'
import { useStore } from '@/store/useStore'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { collectScenes, shortDate } from '@/components/map/scenes'
import { cn } from '@/lib/utils'

const INLINE = 4

/** The dated scenes behind the layers, as the design's strip: the latest few inline, the newest
 *  marked, and the full list (sensor or scene id, clear and cloud %) one click away. */
export function ScenesChip() {
  const frames = useStore((s) => s.temporalFrames)
  const layers = useStore((s) => s.layers)
  const scenes = useMemo(() => collectScenes(frames, layers), [frames, layers])
  if (scenes.length === 0) return null
  const shown = scenes.slice(-INLINE)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="scenes-chip"
          aria-label={`${scenes.length} dated ${scenes.length === 1 ? 'scene' : 'scenes'}, latest ${shortDate(scenes[scenes.length - 1].date)}. Show the list`}
          className="pointer-events-auto flex max-w-full items-center gap-4 overflow-x-auto rounded-[0.625rem] border border-border bg-card px-3 py-2 text-xs shadow-float transition-colors hover:bg-muted"
        >
          <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Scenes</span>
          <ol className="flex gap-3">
            {shown.map((s, i) => {
              const now = i === shown.length - 1
              return (
                <li key={s.key} className={cn('flex items-center gap-1.5 whitespace-nowrap', now ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                  <span className={cn('size-[0.4375rem] rounded-full bg-teal', now && 'shadow-[0_0_0_0.1875rem_var(--accent)]')} aria-hidden />
                  {shortDate(s.date)}
                </li>
              )
            })}
            {scenes.length > INLINE && <li className="whitespace-nowrap text-muted-foreground">+{scenes.length - INLINE} earlier</li>}
          </ol>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-80 p-2">
        <p className="px-1.5 pb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Scenes used</p>
        <ul className="max-h-60 overflow-y-auto">
          {scenes.map((s) => (
            <li key={s.key} className="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-3 rounded px-1.5 py-1 text-[0.8125rem]">
              <span className="font-medium tabular-nums text-foreground">{shortDate(s.date)}</span>
              <span className="truncate text-xs text-muted-foreground" title={s.label}>{s.label}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {s.clear != null ? `${Math.round(s.clear)}% clear` : s.cloud != null ? `${Math.round(s.cloud)}% cloud` : ''}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
