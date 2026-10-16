'use client'

import { useCallback, useId, useState } from 'react'
import { AlertTriangle, ChevronRight, Crosshair, RefreshCw, Trash2 } from 'lucide-react'
import { useStore, type MapLayer } from '@/store/useStore'
import { useAgentWS } from '@/hooks/useAgentWS'
import LayerLegend, { useTemporalLegendCaption } from '@/components/map/LayerLegend'
import { ValidationBadge } from '@/components/evidence/ValidationBadge'
import RasterControls from '@/components/map/RasterControls'
import VectorControls from '@/components/map/VectorControls'
import VectorLayerActions from '@/components/map/VectorIO'
import { layerSourceLine, layerSwatches } from '@/components/map/layer-meta'
import { layerBounds } from '@/components/map/layers'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// One layer: checkbox, source and date line, legend swatches, opacity. The style controls and the
// full legend sit behind "Style and legend" so a long list stays readable.
// ---------------------------------------------------------------------------

const TIER_BADGE: Record<string, string> = {
  'commercial-submeter': 'PRO',
  'user-upload': 'YOURS',
}

function LayerRow({ layer, onRefresh, canRefresh }: { layer: MapLayer; onRefresh: () => void; canRefresh: boolean }) {
  const toggleVisibility = useStore((s) => s.toggleLayerVisibility)
  const setLayerOpacity = useStore((s) => s.setLayerOpacity)
  const removeLayer = useStore((s) => s.removeLayer)
  const setFitBoundsTarget = useStore((s) => s.setFitBoundsTarget)
  const temporalCaption = useTemporalLegendCaption(layer.id)
  const [open, setOpen] = useState(false)
  const id = useId()
  const swatches = layerSwatches(layer)
  const source = layerSourceLine(layer)
  const hasStyle = !!(layer.palette || layer.raster || layer.vectorStyle || layer.type === 'geojson' || layer.verdict)
  const pct = Math.round(layer.opacity * 100)
  const tier = layer.tier ? TIER_BADGE[layer.tier] ?? (layer.tier === 'free-10m' && layer.resolutionM != null ? `${layer.resolutionM} m` : null) : null

  const zoomTo = () => {
    const b = layerBounds(layer)
    if (b) setFitBoundsTarget(b)
  }

  return (
    <li className={cn('rounded-[0.3125rem] border border-border bg-sunk px-2 py-2 transition-colors hover:border-input', !layer.visible && 'opacity-60')} data-testid="layer-row">
      <div className="grid grid-cols-[1.125rem_1fr_auto] items-start gap-x-2.5">
        <input
          id={id}
          type="checkbox"
          checked={layer.visible}
          onChange={() => toggleVisibility(layer.id)}
          className="mt-0.5 size-[0.9375rem] cursor-pointer accent-[var(--primary)]"
        />
        <label htmlFor={id} className="min-w-0 cursor-pointer">
          <span className="block truncate text-[0.8125rem] font-medium leading-snug text-foreground" title={layer.name}>{layer.name}</span>
          {source && <span className="mt-0.5 block truncate text-xs text-muted-foreground" title={source}>{source}</span>}
        </label>
        <span className="flex items-center gap-1.5 pt-0.5">
          <ValidationBadge verdict={layer.verdict} />
          {tier && <span className="rounded bg-muted px-1 py-px text-xs font-medium text-muted-foreground" title={layer.tierLabel}>{tier}</span>}
          {swatches.length > 0 && (
            <span className="flex gap-0.5" aria-hidden>
              {swatches.map((c, i) => <i key={i} className="size-2 rounded-[0.125rem]" style={{ background: c }} />)}
            </span>
          )}
        </span>
      </div>

      {layer.provisional && (
        <p className="ml-7 mt-1 text-xs text-warning" data-testid="layer-provisional">Preview while the statistics compute</p>
      )}

      {layer.expired && (
        <div className="ml-7 mt-1 flex items-center justify-between gap-2 text-xs text-danger">
          <span className="inline-flex items-center gap-1"><AlertTriangle className="size-3" aria-hidden />Tiles are not loading</span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={!canRefresh}
            className="inline-flex items-center gap-1 font-medium underline underline-offset-2 disabled:no-underline disabled:opacity-40"
            title={canRefresh ? 'Run the last question again to get fresh tile links' : 'Wait for the current analysis to finish'}
          >
            <RefreshCw className="size-3" aria-hidden />Refresh
          </button>
        </div>
      )}

      {layer.visible && (
        <div className="ml-7 mt-1.5 flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={pct}
            onChange={(e) => setLayerOpacity(layer.id, Number(e.target.value) / 100)}
            aria-label={`${layer.name} opacity`}
            className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--primary)]"
          />
          <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">{pct}%</span>
        </div>
      )}

      <div className="ml-7 mt-1 flex items-center gap-1">
        {hasStyle && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} aria-hidden />
            {layer.type === 'geojson' ? 'Style, legend, export' : 'Style and legend'}
          </button>
        )}
        <span className="ml-auto flex items-center gap-0.5">
          {(layer.bounds || layer.geojson) && (
            <button type="button" onClick={zoomTo} className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Zoom to ${layer.name}`} title="Zoom to layer">
              <Crosshair className="size-3.5" aria-hidden />
            </button>
          )}
          <button type="button" onClick={() => removeLayer(layer.id)} className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-danger/10 hover:text-danger" aria-label={`Remove ${layer.name}`} title="Remove layer">
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        </span>
      </div>

      {open && (
        <div className="-ml-1 mt-1 space-y-1 border-t border-border pt-1.5">
          <LayerLegend layer={layer} caption={temporalCaption} />
          {layer.visible && layer.raster && <RasterControls layer={layer} />}
          {layer.visible && <VectorControls layer={layer} />}
          <VectorLayerActions layer={layer} />
        </div>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------
// The Layers section of the workspace sidebar
// ---------------------------------------------------------------------------

export default function LayerPanel() {
  const layers = useStore((s) => s.layers)
  const lastQuery = useStore((s) => s.lastQuery)
  const isLoading = useStore((s) => s.isLoading)
  const { sendQuery } = useAgentWS()

  // An expired layer is refreshed by re-running the last analysis, which re-mints its tile URLs.
  const refreshExpired = useCallback(() => {
    const q = lastQuery?.trim()
    if (q && !isLoading) sendQuery(q)
  }, [lastQuery, isLoading, sendQuery])

  if (layers.length === 0) {
    return <p className="rounded-[0.3125rem] border border-dashed border-input p-3 text-[0.8125rem] leading-relaxed text-muted-foreground" data-testid="layers-empty">No layers yet. Add one with Add data or a quick layer, or ask a question about the area.</p>
  }
  return (
    <ul className="grid gap-[0.3125rem]">
      {layers.map((layer) => (
        <LayerRow key={layer.id} layer={layer} onRefresh={refreshExpired} canRefresh={!!lastQuery && !isLoading} />
      ))}
    </ul>
  )
}
