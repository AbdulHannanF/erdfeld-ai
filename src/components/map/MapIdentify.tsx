'use client'

import { useEffect, useState } from 'react'
import type * as maplibregl from 'maplibre-gl'
import { Crosshair, X } from 'lucide-react'
import { GLASS, OVERLINE } from '@/components/shell/ui'
import { cellText } from '@/components/map/attributes'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { cn } from '@/lib/utils'

interface Hit {
  lng: number
  lat: number
  zoom: number
  features: Array<{ layer: string; props: Array<[string, string]> }>
}

const fmt = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(5)}° ${v >= 0 ? pos : neg}`

/** The identify tool: click the map, read the coordinates and the attributes of every data-layer
 *  feature under the pointer. "Ask about this point" sends that point to the assistant. */
export default function MapIdentify({ map, className }: { map: maplibregl.Map | null; className?: string }) {
  const tool = useUi((s) => s.mapTool)
  const showInspector = useUi((s) => s.showInspector)
  const setPointFocus = useStore((s) => s.setPointFocus)
  const [hit, setHit] = useState<Hit | null>(null)
  const active = tool === 'identify'

  useEffect(() => {
    if (!map || !active) return
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const ids = (map.getStyle()?.layers ?? []).map((l) => l.id).filter((id) => id.startsWith('layer-'))
      const found = ids.length ? map.queryRenderedFeatures(e.point, { layers: ids }) : []
      const layers = useStore.getState().layers
      const seen = new Set<string>()
      const features: Hit['features'] = []
      for (const f of found) {
        const key = `${f.layer.id}:${f.id ?? JSON.stringify(f.properties)}`
        if (seen.has(key)) continue
        seen.add(key)
        const layer = layers.find((l) => `layer-${l.id}` === f.layer.id || f.source === `layer-${l.id}`)
        features.push({
          layer: layer?.name ?? f.layer.id,
          props: Object.entries(f.properties ?? {}).filter(([k]) => k !== 'color' && k !== 'id').slice(0, 8).map(([k, v]) => [k, cellText(v)] as [string, string]),
        })
        if (features.length >= 4) break
      }
      setHit({ lng: e.lngLat.lng, lat: e.lngLat.lat, zoom: map.getZoom(), features })
    }
    map.on('click', onClick)
    map.getCanvas().style.cursor = 'help'
    return () => {
      map.off('click', onClick)
      map.getCanvas().style.cursor = ''
      setHit(null) // leaving the tool closes the card
    }
  }, [map, active])

  if (!active || !hit) return null
  return (
    <div className={cn('w-[min(15.625rem,calc(100%-1rem))] rounded-[0.4375rem] p-2.5', GLASS, className)} role="dialog" aria-label="Map location" data-testid="identify-card">
      <div className="flex items-center justify-between text-[0.8125rem] font-semibold text-foreground">
        Map location
        <button type="button" onClick={() => setHit(null)} className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-foreground" aria-label="Close map information"><X className="size-3.5" aria-hidden /></button>
      </div>
      <p className="mt-1.5 whitespace-pre-line font-mono text-xs leading-relaxed text-secondary-foreground">
        {fmt(hit.lat, 'N', 'S')}{'\n'}{fmt(hit.lng, 'E', 'W')}{'\n'}Zoom {hit.zoom.toFixed(1)}
      </p>
      {hit.features.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">No data-layer feature here. Basemap features are not queried.</p>
      ) : (
        <div className="mt-2 grid max-h-40 gap-2 overflow-y-auto">
          {hit.features.map((f, i) => (
            <div key={i} className="border-t border-border pt-1.5">
              <p className={OVERLINE}>{f.layer}</p>
              <dl className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-2 text-xs">
                {f.props.map(([k, v]) => (
                  <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="truncate text-foreground" title={v}>{v}</dd></div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        className="mt-2 inline-flex h-7 w-full items-center justify-center gap-1.5 rounded border border-input bg-secondary text-xs hover:bg-hover"
        onClick={() => {
          setPointFocus({ lat: hit.lat, lng: hit.lng })
          showInspector('assistant')
        }}
      >
        <Crosshair className="size-3.5" aria-hidden />Ask about this point
      </button>
    </div>
  )
}
