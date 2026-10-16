'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import type * as maplibregl from 'maplibre-gl'
import { Mountain } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { useStore } from '@/store/useStore'
import { prefersReducedMotion } from '@/components/map/layers'
import { cn } from '@/lib/utils'

/** 3D terrain, globe and atmosphere. The state is in the store so it survives basemap switches;
 *  MapPanel applies it to the map. Here: the controls, and the camera tilt that makes relief readable. */
export default function MapTerrainToggle({ map, className }: { map: maplibregl.Map | null; className?: string; active?: boolean }) {
  const terrainEnabled = useStore((s) => s.terrainEnabled)
  const setTerrainEnabled = useStore((s) => s.setTerrainEnabled)
  const exaggeration = useStore((s) => s.terrainExaggeration)
  const setExaggeration = useStore((s) => s.setTerrainExaggeration)
  const projection = useStore((s) => s.projection)
  const setProjection = useStore((s) => s.setProjection)
  const skyEnabled = useStore((s) => s.skyEnabled)
  const setSkyEnabled = useStore((s) => s.setSkyEnabled)
  const [pitch, setPitch] = useState(0)
  const id = useId()
  const isGlobe = projection === 'globe'

  useEffect(() => {
    if (!map) return
    const read = () => setPitch(Math.round(map.getPitch()))
    map.on('pitchend', read)
    read()
    return () => {
      map.off('pitchend', read)
    }
  }, [map])

  const toggleTerrain = useCallback(
    (next: boolean) => {
      setTerrainEnabled(next)
      // Tilt to read the relief; ease back flat when it is switched off.
      map?.easeTo({ pitch: next ? 60 : 0, duration: prefersReducedMotion() ? 0 : next ? 1000 : 800 })
    },
    [map, setTerrainEnabled],
  )

  const active = terrainEnabled || isGlobe
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="3D terrain and globe"
          title="3D terrain and globe"
          aria-pressed={active}
          data-testid="terrain-button"
          className={cn(
            'btn btn-ghost btn-md',
            active ? 'text-brand-text' : 'text-muted-foreground hover:text-foreground',
            className,
          )}
        >
          <Mountain aria-hidden />
          <span className="sr-only">3D</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" side="left" sideOffset={10} className="w-64 space-y-3 p-3">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={`${id}-terrain`} className="text-body text-foreground">3D terrain</label>
          <Switch id={`${id}-terrain`} checked={terrainEnabled} onCheckedChange={toggleTerrain} />
        </div>
        {terrainEnabled && (
          <div>
            <div className="flex items-center justify-between text-caption text-muted-foreground">
              <label htmlFor={`${id}-ex`}>Vertical scale</label>
              <span className="tabular-nums">{exaggeration.toFixed(1)}×</span>
            </div>
            <input
              id={`${id}-ex`}
              type="range"
              min={0.5}
              max={3}
              step={0.1}
              value={exaggeration}
              onChange={(e) => setExaggeration(Number(e.target.value))}
              className="mt-1 w-full accent-[var(--primary)]"
            />
            {Math.abs(exaggeration - 1) > 0.05 && (
              <p className="mt-1 text-caption leading-snug text-warning">Relief is drawn {exaggeration.toFixed(1)}× taller than it is.</p>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={`${id}-globe`} className="text-body text-foreground">Globe view</label>
          <Switch id={`${id}-globe`} checked={isGlobe} onCheckedChange={(on) => setProjection(on ? 'globe' : 'mercator')} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={`${id}-sky`} className="text-body text-foreground">Atmosphere</label>
          <Switch id={`${id}-sky`} checked={skyEnabled || isGlobe} disabled={isGlobe} onCheckedChange={setSkyEnabled} />
        </div>
        <p className="border-t border-border pt-2 text-caption tabular-nums text-muted-foreground">Camera pitch {pitch}°</p>
      </PopoverContent>
    </Popover>
  )
}
