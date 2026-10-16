'use client'

import { useTheme } from 'next-themes'
import { Check, ChevronDown, Columns2, Layers, Locate } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { GLASS, OVERLINE } from '@/components/shell/ui'
import { BASEMAP_CHOICES, basemapStyleId, type BasemapChoice, type BasemapStyleId } from '@/components/map/basemaps'
import { layerBounds } from '@/components/map/layers'
import { layerSwatches } from '@/components/map/layer-meta'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { cn } from '@/lib/utils'

const NAMES: Record<BasemapStyleId, string> = { dark: 'Dark', light: 'Light', voyager: 'Voyager', satellite: 'Imagery' }
const ORDER: BasemapStyleId[] = ['dark', 'light', 'voyager', 'satellite']

const btn =
  'flex h-8 items-center justify-center gap-1.5 rounded-md border border-transparent bg-transparent px-2 text-[0.8125rem] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground aria-pressed:border-[#49b58245] aria-pressed:bg-[#49b58218] aria-pressed:text-[#9bdab8] aria-expanded:bg-hover aria-expanded:text-foreground'

/** The basemap selector (Dark, Light, Voyager, Imagery, and Compare) and the Layers popover, in the
 *  single glass bar at the map's top right. */
export default function MapActions({ className }: { className?: string }) {
  const { resolvedTheme } = useTheme()
  const basemap = useUi((s) => s.basemap)
  const setBasemap = useUi((s) => s.setBasemap)
  const mapView = useUi((s) => s.mapView)
  const setMapView = useUi((s) => s.setMapView)
  const relief = useUi((s) => s.relief)
  const setRelief = useUi((s) => s.setRelief)
  const layers = useStore((s) => s.layers)
  const toggleLayerVisibility = useStore((s) => s.toggleLayerVisibility)
  const setFitBoundsTarget = useStore((s) => s.setFitBoundsTarget)
  const aoi = useStore((s) => s.aoi)

  const current = basemapStyleId(basemap, resolvedTheme)
  const pick = (c: BasemapChoice) => setBasemap(c)

  return (
    <div className={cn('flex gap-1 rounded-[0.5625rem] p-1', GLASS, className)} data-testid="map-actions">
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={btn} aria-label={`Basemap: ${NAMES[current]}`} data-testid="basemap-button">
            <Layers className="size-3.5" aria-hidden />
            <span className="max-[1100px]:max-md:sr-only max-[520px]:sr-only">{NAMES[current]}</span>
            <ChevronDown className="size-3 max-[520px]:hidden" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={8} className="w-56 p-1.5">
          <p className={cn(OVERLINE, 'px-2 pb-1 pt-1')}>Basemap</p>
          <div role="radiogroup" aria-label="Basemap">
            {ORDER.map((id) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={current === id}
                onClick={() => pick(id)}
                data-testid={`basemap-${id}`}
                className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[0.8125rem] text-foreground hover:bg-hover"
              >
                {NAMES[id]}
                {current === id && <Check className="size-3.5 text-brand-text" aria-hidden />}
              </button>
            ))}
          </div>
          {basemap !== 'auto' && (
            <button type="button" onClick={() => pick('auto')} className="mt-0.5 w-full rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-hover hover:text-foreground">
              Follow the theme (Dark or Light)
            </button>
          )}
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            aria-pressed={mapView === 'compare'}
            onClick={() => setMapView(mapView === 'compare' ? 'map' : 'compare')}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[0.8125rem] text-foreground hover:bg-hover aria-pressed:text-brand-text"
            data-testid="compare-toggle"
          >
            <Columns2 className="size-3.5" aria-hidden />Compare two basemaps
          </button>
          <p className="px-2 pb-1 pt-0.5 text-xs text-muted-foreground">{BASEMAP_CHOICES.length - 1} basemaps, no key needed.</p>
        </PopoverContent>
      </Popover>
      <span className="my-auto h-[1.125rem] w-px bg-border" aria-hidden />
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={btn} aria-label="Map layers" data-testid="layers-button">
            <Layers className="size-3.5" aria-hidden />
            <span className="max-[1100px]:max-md:sr-only max-[520px]:sr-only">Layers</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={8} className="w-[min(18.125rem,calc(100vw-1.5rem))] p-3.5">
          <div className="mb-2">
            <strong className="text-[0.875rem] font-semibold">Map layers</strong>
            <span className="mt-0.5 block text-xs text-muted-foreground">Reference overlays and analysis</span>
          </div>
          <div className="flex min-h-10 items-center gap-2.5 border-t border-border py-2">
            <i className="size-2.5 rounded-sm bg-[#b49a78]" aria-hidden />
            <div className="min-w-0 flex-1 text-[0.8125rem]">
              <label htmlFor="relief-toggle">Terrain relief</label>
              <small className="block font-mono text-xs text-muted-foreground">AWS TERRAIN · HILLSHADE</small>
            </div>
            <input id="relief-toggle" type="checkbox" role="switch" checked={relief} onChange={(e) => setRelief(e.target.checked)} className="size-4 accent-[var(--teal)]" data-testid="relief-toggle" />
          </div>
          {aoi && (
            <div className="flex min-h-10 items-center gap-2.5 border-t border-border py-2">
              <i className="size-2.5 rounded-sm bg-[#56b985]" aria-hidden />
              <div className="min-w-0 flex-1 text-[0.8125rem]">Area of interest<small className="block font-mono text-xs text-muted-foreground">{aoi.type.toUpperCase()}</small></div>
              <button type="button" aria-label="Zoom to the area" title="Zoom to the area" className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-foreground" onClick={() => {
                const ring = (aoi.geometry as GeoJSON.Polygon).coordinates?.[0]
                if (ring?.length) setFitBoundsTarget([Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1])), Math.max(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[1]))])
              }}>
                <Locate className="size-3.5" aria-hidden />
              </button>
            </div>
          )}
          <p className={cn(OVERLINE, 'mb-1 mt-2')}>Analysis</p>
          {layers.length === 0 ? (
            <p className="rounded border border-dashed border-input p-2 text-xs leading-snug text-muted-foreground">Analysis layers appear here as Erdfeld works through a question.</p>
          ) : (
            <ul>
              {layers.map((l) => {
                const sw = layerSwatches(l)[0]
                return (
                  <li key={l.id} className="flex min-h-10 items-center gap-2.5 border-t border-border py-1.5">
                    <i className="size-2.5 shrink-0 rounded-sm" style={{ background: sw ?? l.color ?? 'var(--teal)' }} aria-hidden />
                    <label htmlFor={`lp-${l.id}`} className="min-w-0 flex-1 truncate text-[0.8125rem]" title={l.name}>{l.name}</label>
                    {layerBounds(l) && (
                      <button type="button" aria-label={`Zoom to ${l.name}`} title="Zoom to layer" className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-foreground" onClick={() => { const b = layerBounds(l); if (b) setFitBoundsTarget(b) }}>
                        <Locate className="size-3.5" aria-hidden />
                      </button>
                    )}
                    <input id={`lp-${l.id}`} type="checkbox" role="switch" checked={l.visible} onChange={() => toggleLayerVisibility(l.id)} className="size-4 accent-[var(--teal)]" />
                  </li>
                )
              })}
            </ul>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
