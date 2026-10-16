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
            <div className="mb-1 flex items-center justify-between px-1 text-caption text-muted-foreground">
              <span className="truncate">{sets.length > 1 ? layer.name : `By ${layer.vectorStyle?.property}`}</span>
              {current && (
                <button type="button" onClick={() => setClassFilter(layer.id, null)} className="link-btn">
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
                        'menu-item',
                        !on && 'opacity-45',
                        current && on && 'bg-muted',
                      )}
                    >
                      <i className="size-2.5 rounded-sm" style={{ background: row.color }} aria-hidden />
                      <span className="truncate text-foreground">{row.label}</span>
                      <span className="min-w-[2.5ch] text-right text-caption tabular-nums text-muted-foreground">{row.count.toLocaleString('en-US')}</span>
                      <span className="min-w-[6ch] text-right text-caption tabular-nums text-foreground">{row.areaHa != null ? `${Math.round(row.areaHa).toLocaleString('en-US')} ha` : ''}</span>
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
