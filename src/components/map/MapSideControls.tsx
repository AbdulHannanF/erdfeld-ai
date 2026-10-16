'use client'

import { useEffect, useState } from 'react'
import type * as maplibregl from 'maplibre-gl'
import { Camera, Compass, Maximize2, Minimize2, Minus, Plus } from 'lucide-react'
import MapTerrainToggle from '@/components/map/MapTerrainToggle'
import { GLASS } from '@/components/shell/ui'
import { useStore } from '@/store/useStore'
import { requestMapAction } from '@/lib/ui-events'
import { cn } from '@/lib/utils'

const ctl =
  'grid size-9 place-items-center bg-transparent text-muted-foreground transition-colors hover:bg-hover hover:text-foreground aria-pressed:bg-[#49b58220] aria-pressed:text-[#a2dbb8] [&_svg]:size-4'

/** The map's own bearing, kept in step with the camera. */
export function useBearing(map: maplibregl.Map | null): number {
  const [bearing, setBearing] = useState(0)
  useEffect(() => {
    if (!map) return
    const read = () => setBearing(map.getBearing())
    map.on('rotate', read)
    map.on('rotateend', read)
    read()
    return () => {
      map.off('rotate', read)
      map.off('rotateend', read)
    }
  }, [map])
  return bearing
}

/** Zoom in and out, 3D terrain, the compass (resets bearing and pitch), a screenshot and focus
 *  mode, on the right edge of the map. The compass needle turns with the map. */
export default function MapSideControls({ map, className }: { map: maplibregl.Map | null; className?: string }) {
  const bearing = useBearing(map)
  const isFocus = useStore((s) => s.isMapFullscreen)
  const setFocus = useStore((s) => s.setMapFullscreen)
  const terrain = useStore((s) => s.terrainEnabled)

  return (
    <div className={cn('grid gap-1.5', className)} data-testid="map-controls">
      <div className={cn('grid overflow-hidden rounded-lg', GLASS)}>
        <button type="button" className={ctl} onClick={() => map?.zoomIn({ duration: 250 })} aria-label="Zoom in" data-testid="zoom-in"><Plus aria-hidden /></button>
        <button type="button" className={cn(ctl, 'border-t border-border')} onClick={() => map?.zoomOut({ duration: 250 })} aria-label="Zoom out" data-testid="zoom-out"><Minus aria-hidden /></button>
      </div>
      <div className={cn('grid overflow-hidden rounded-lg', GLASS)}>
        <MapTerrainToggle map={map} className={cn(ctl, 'size-9 rounded-none border-0 p-0 shadow-none')} active={terrain} />
        <button type="button" className={cn(ctl, 'border-t border-border')} onClick={() => map?.easeTo({ bearing: 0, pitch: terrain ? 45 : 0, duration: 350 })} aria-label={`Reset the bearing (map is turned ${Math.round(bearing)} degrees)`} title="Reset bearing">
          <Compass aria-hidden style={{ transform: `rotate(${-bearing}deg)` }} />
        </button>
      </div>
      <div className={cn('grid overflow-hidden rounded-lg', GLASS)}>
        <button type="button" className={ctl} onClick={() => requestMapAction('screenshot')} aria-label="Save a screenshot of the map" title="Save a screenshot of the map"><Camera aria-hidden /></button>
        <button
          type="button"
          className={cn(ctl, 'border-t border-border')}
          onClick={() => setFocus(!isFocus)}
          aria-pressed={isFocus}
          aria-label={isFocus ? 'Show the sidebar, dock and inspector' : 'Focus on the map'}
          title={isFocus ? 'Show the panels' : 'Focus on the map'}
        >
          {isFocus ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
        </button>
      </div>
    </div>
  )
}
