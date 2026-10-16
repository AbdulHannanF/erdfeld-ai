'use client'

import { useMemo } from 'react'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { classRows, toggleClass } from '@/components/map/class-filter'
import { cn } from '@/lib/utils'

const SHOWN = 4

/** How the classes of the main categorical layer divide up the area (or, without areas, the
 *  count). The bar and its rows are computed from the layer's features, and a row switches that
 *  class on the map the same way the sidebar does. */
export default function DistributionBar() {
  const layers = useStore((s) => s.layers)
  const filter = useUi((s) => s.classFilter)
  const setClassFilter = useUi((s) => s.setClassFilter)
  const found = useMemo(() => {
    for (const layer of layers) {
      const rows = layer.visible ? classRows(layer) : null
      if (rows && rows.some((r) => r.count > 0)) return { layer, rows: rows.filter((r) => r.count > 0) }
    }
    return null
  }, [layers])
  if (!found) return null

  const { layer, rows } = found
  const byArea = rows.every((r) => r.areaHa != null)
  const weight = (r: (typeof rows)[number]) => (byArea ? (r.areaHa as number) : r.count)
  const total = rows.reduce((a, r) => a + weight(r), 0)
  if (total <= 0) return null
  const sorted = [...rows].sort((a, b) => weight(b) - weight(a))
  const current = filter[layer.id]
  const all = sorted.map((r) => r.value)

  return (
    <div className="grid gap-2" data-testid="distribution">
      <div
        className="dist-in flex h-2.5 gap-px overflow-hidden rounded-sm bg-border"
        role="img"
        aria-label={`${layer.name} by ${layer.vectorStyle?.property}: ${sorted.map((r) => `${r.label} ${Math.round((weight(r) / total) * 100)}%`).join(', ')}`}
      >
        {sorted.map((r) => (
          <i key={String(r.value)} className="block h-full" style={{ width: `${(weight(r) / total) * 100}%`, background: r.color }} />
        ))}
      </div>
      <dl className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-1 text-caption">
        {sorted.slice(0, SHOWN).map((r) => {
          const on = !current || current.map(String).includes(String(r.value))
          return (
            <button
              key={String(r.value)}
              type="button"
              aria-pressed={on}
              onClick={() => setClassFilter(layer.id, toggleClass(current, r.value, all))}
              className={cn('col-span-3 grid grid-cols-subgrid items-center rounded-md text-left transition-opacity hover:bg-hover', !on && 'opacity-45')}
            >
              <dt className="flex items-center gap-1.5 text-foreground">
                <i className="size-2 rounded-sm" style={{ background: r.color }} aria-hidden />
                {r.label}
              </dt>
              <dd className="text-right text-muted-foreground">{r.count.toLocaleString('en-US')} {r.count === 1 ? 'feature' : 'features'}</dd>
              <dd className="text-right text-foreground">{byArea ? `${Math.round(r.areaHa as number).toLocaleString('en-US')} ha` : `${Math.round((r.count / total) * 100)}%`}</dd>
            </button>
          )
        })}
      </dl>
      {sorted.length > SHOWN && <p className="text-caption text-muted-foreground">and {sorted.length - SHOWN} more in the sidebar</p>}
    </div>
  )
}
