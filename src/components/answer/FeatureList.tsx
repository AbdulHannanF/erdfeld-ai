'use client'

import { useMemo, useState } from 'react'
import { ChevronRight, Download } from 'lucide-react'
import { toast } from 'sonner'
import { useStore } from '@/store/useStore'
import { exportCSV, extractFeatures, type FlatFeature } from '@/components/answer/features'
import { cn } from '@/lib/utils'

const SHOWN = 100

const select = 'field field-sm min-w-0 flex-1'

/** The features on the map as a list. It is the keyboard (and screen reader) route to a feature:
 *  every row is a button that selects the feature, outlines it on the map and moves the map to it. */
export default function FeatureList() {
  const layers = useStore((s) => s.layers)
  const highlight = useStore((s) => s.highlight)
  const setHighlight = useStore((s) => s.setHighlight)
  const setZoomToFeature = useStore((s) => s.setZoomToFeature)
  const [open, setOpen] = useState(false)
  const [layerId, setLayerId] = useState('all')
  const [type, setType] = useState('all')

  const all = useMemo(() => extractFeatures(layers.filter((l) => l.visible)), [layers])
  const layerOptions = useMemo(() => [...new Map(all.map((f) => [f.layerId, f.layerName])).entries()], [all])
  const inLayer = layerId === 'all' ? all : all.filter((f) => f.layerId === layerId)
  const types = useMemo(() => [...new Set(inLayer.map((f) => f.type))].sort(), [inLayer])
  const rows = (type === 'all' ? inLayer : inLayer.filter((f) => f.type === type))
  if (all.length === 0) return null

  const select_ = (f: FlatFeature) => {
    setHighlight({ layerId: f.layerId, fid: f.featureIndex })
    if (f.lng !== null && f.lat !== null) setZoomToFeature({ layerId: f.layerId, featureIndex: f.featureIndex })
  }

  return (
    <section aria-label="Features on the map">
      <h3 className="text-muted-foreground text-label">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 rounded-sm py-0.5 text-left text-label"
        >
          <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} aria-hidden />
          Features on the map
          <span className="font-semibold normal-case tracking-normal tabular-nums">{all.length.toLocaleString('en-US')}</span>
        </button>
      </h3>
      {open && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-2">
            {layerOptions.length > 1 && (
              <select aria-label="Layer" value={layerId} onChange={(e) => { setLayerId(e.target.value); setType('all') }} className={select}>
                <option value="all">All layers</option>
                {layerOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            )}
            {types.length > 1 && (
              <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} className={select}>
                <option value="all">All types</option>
                {types.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
            <button
              type="button"
              onClick={() => {
                exportCSV(rows)
                toast.success(`Exported ${rows.length} features as CSV`)
              }}
              className="btn btn-secondary btn-sm ml-auto"
            >
              <Download aria-hidden />CSV
            </button>
          </div>
          <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {rows.slice(0, SHOWN).map((f) => {
              const selected = highlight?.layerId === f.layerId && highlight.fid === f.featureIndex
              return (
                <li key={`${f.layerId}-${f.featureIndex}`}>
                  <button
                    type="button"
                    onClick={() => select_(f)}
                    aria-pressed={selected}
                    className={cn('menu-item', selected && 'bg-accent')}
                  >
                    <span className="min-w-0 truncate text-foreground">{f.name}<span className="ml-2 text-caption text-muted-foreground">{f.type}</span></span>
                    <span className="text-caption tabular-nums text-muted-foreground">{f.confidence != null ? `${Math.round(f.confidence * 100)}%` : ''}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          {rows.length > SHOWN && (
            <p className="text-caption text-muted-foreground">Showing the first {SHOWN} of {rows.length.toLocaleString('en-US')}. Filter to narrow the list, or export all as CSV.</p>
          )}
        </div>
      )}
    </section>
  )
}
