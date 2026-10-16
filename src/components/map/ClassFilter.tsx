'use client'

import { useMemo } from 'react'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { classRows, toggleClass } from '@/components/map/class-filter'
import { cn } from '@/lib/utils'

/** Switch classes of a categorical layer on and off. The map and its legend follow. */
export default function ClassFilter() {
  const layers = useStore((s) => s.layers)
  const filter = useUi((s) => s.classFilter)
  const setClassFilter = useUi((s) => s.setClassFilter)
  const sets = useMemo(
    () => layers.flatMap((layer) => {
      const rows = layer.visible ? classRows(layer) : null
      return rows ? [{ layer, rows }] : []
    }),
    [layers],
  )
  if (sets.length === 0) return null

  return (
    <div className="grid gap-3">
      {sets.map(({ layer, rows }) => {
        const current = filter[layer.id]
        const allValues = rows.map((r) => r.value)
        return (
          <div key={layer.id}>
            <div className="mb-1 flex items-center justify-between px-1 text-xs text-muted-foreground">
              <span className="truncate">{sets.length > 1 ? layer.name : `By ${layer.vectorStyle?.property}`}</span>
              {current && (
                <button type="button" onClick={() => setClassFilter(layer.id, null)} className="font-medium text-brand-text underline-offset-2 hover:underline">
                  Show all
                </button>
              )}
            </div>
            <ul className="grid gap-px" aria-label={`Classes of ${layer.name}`}>
              {rows.map((row) => {
                const on = !current || current.map(String).includes(String(row.value))
                return (
                  <li key={String(row.value)}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => setClassFilter(layer.id, toggleClass(current, row.value, allValues))}
                      className={cn(
                        'grid w-full grid-cols-[0.625rem_1fr_auto_auto] items-center gap-2 rounded-sm px-1.5 py-1.5 text-left text-[0.8125rem] transition-[background-color,opacity] duration-150 hover:bg-muted',
                        !on && 'opacity-45',
                        current && on && 'bg-muted',
                      )}
                    >
                      <i className="size-2.5 rounded-[0.125rem]" style={{ background: row.color }} aria-hidden />
                      <span className="truncate text-foreground">{row.label}</span>
                      <span className="min-w-[2.5ch] text-right text-xs tabular-nums text-muted-foreground">{row.count.toLocaleString('en-US')}</span>
                      <span className="min-w-[6ch] text-right text-xs tabular-nums text-foreground/80">{row.areaHa != null ? `${Math.round(row.areaHa).toLocaleString('en-US')} ha` : ''}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
