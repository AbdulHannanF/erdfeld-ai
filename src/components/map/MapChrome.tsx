'use client'

import type * as maplibregl from 'maplibre-gl'
import { MapPin, Sparkles } from 'lucide-react'
import GeocodingSearch from '@/components/shell/GeocodingSearch'
import DrawRail, { toolHint } from '@/components/map/DrawRail'
import MapActions from '@/components/map/MapActions'
import MapIdentify from '@/components/map/MapIdentify'
import MapMeasure from '@/components/map/MapMeasure'
import MapSideControls from '@/components/map/MapSideControls'
import MapTimelineSlider from '@/components/map/MapTimelineSlider'
import { GLASS } from '@/components/shell/ui'
import { aoiAreaKm2, formatAreaKm2 } from '@/lib/aoi'
import { useMapReadout } from '@/store/useMapReadout'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { cn } from '@/lib/utils'

const coord = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? pos : neg}`

/** The design's AOI card, bottom left: what the area is and where. */
function AoiCard({ className }: { className?: string }) {
  const aoi = useStore((s) => s.aoi)
  const km2 = aoiAreaKm2(aoi?.geometry)

  return (
    <div className={cn('flex max-w-[16.875rem] items-center gap-2.5 rounded-lg px-2.5 py-2', GLASS, className)} data-testid="aoi-card">
      <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-accent text-brand-text"><MapPin className="size-4" aria-hidden /></span>
      <span className="min-w-0">
        <strong className="block truncate text-body-strong text-foreground">{aoi ? `${aoi.type} area` : 'No area drawn'}</strong>
        <small className="mt-0.5 block text-data leading-snug text-muted-foreground" data-testid="aoi-coords">
          {aoi?.center ? (
            <>
              <span className="whitespace-nowrap">{coord(aoi.center.lat, 'N', 'S')}</span>
              <span aria-hidden> · </span>
              <span className="whitespace-nowrap">{coord(aoi.center.lng, 'E', 'W')}</span>
            </>
          ) : 'Choose a shape on the left'}
        </small>
      </span>
      {aoi && (
        <>
          {km2 != null && <span className="badge badge-success">{formatAreaKm2(km2)}</span>}
        </>
      )}
    </div>
  )
}

/** Everything that floats over the map, in the design's places: search at the top centre, the
 *  basemap and layers bar at the top right, the tool rail at the left, zoom and terrain at the
 *  right, the AOI card at the bottom left, time navigation at the bottom centre, and the zoom
 *  readout at the bottom right. Positions are in container-query terms so they follow the map's
 *  width, not the window's. On a phone the bottom items step aside while the sheet is open. */
export default function MapChrome({ map }: { map: maplibregl.Map | null }) {
  const activeDrawMode = useStore((s) => s.activeDrawMode)
  const mapTool = useUi((s) => s.mapTool)
  const zoom = useMapReadout((s) => s.zoom)
  const bearing = useMapReadout((s) => s.bearing)
  const hint = toolHint(activeDrawMode, mapTool)
  const hasFrames = useStore((s) => s.temporalFrames.length > 0)
  // On a phone the open sheet covers the lower map: these step aside (the shell sets data-sheet on <html>).
  const sheetOpen = 'max-md:in-data-[sheet=half]:hidden max-md:in-data-[sheet=full]:hidden'

  return (
    <>
      <div
        className={cn(
          'absolute top-[1.3125rem] z-10 @max-[53.75rem]:left-[4.75rem] @max-[53.75rem]:right-[16.25rem] @[53.75rem]:left-1/2 @[53.75rem]:w-[21.25rem] @[53.75rem]:-translate-x-1/2',
          'max-md:left-2.5 max-md:right-2.5 max-md:top-2.5 max-md:w-auto max-md:translate-x-0',
        )}
      >
        <GeocodingSearch />
      </div>
      <MapActions className={cn('absolute right-5 top-[1.3125rem] z-10 max-md:right-2.5 max-md:top-[3.625rem]', sheetOpen)} />
      <DrawRail className={cn('absolute left-4 top-1/2 z-10 -translate-y-1/2 [@container(max-height:35rem)]:top-[4.5rem] [@container(max-height:35rem)]:translate-y-0 max-md:left-2.5 max-md:top-[calc(50%+1.5rem)]', sheetOpen)} />
      <MapSideControls map={map} className={cn('absolute right-4 top-1/2 z-10 -translate-y-1/2 max-md:right-2.5 max-md:top-[calc(50%+1.5rem)]', sheetOpen)} />

      {hint && (
        <div className={cn('pointer-events-none absolute left-1/2 top-[4.75rem] z-10 flex -translate-x-1/2 items-center gap-2 rounded-md px-3 py-2 text-body text-foreground max-md:top-[6.5rem]', GLASS)} role="status" data-testid="tool-hint">
          <Sparkles className="size-3.5 text-brand-text" aria-hidden />{hint}
        </div>
      )}
      <MapMeasure map={map} className="absolute left-1/2 top-[4.75rem] z-10 -translate-x-1/2 max-md:top-[6.5rem]" />
      <MapIdentify map={map} className="absolute left-[4.25rem] top-[4.75rem] z-20 max-md:left-[3.75rem] max-md:top-[6.5rem]" />

      <AoiCard className={cn('absolute bottom-[1.1875rem] left-5 z-10 max-md:bottom-[calc(var(--sheet-h,4.75rem)+0.625rem)] max-md:left-2.5 max-md:max-w-[calc(100%-5rem)]', sheetOpen)} />
      <div className={cn('absolute bottom-[0.8125rem] left-1/2 z-10 w-[min(20.625rem,100%)] -translate-x-1/2 @max-[56.25rem]:hidden', hasFrames && '@max-[56.25rem]:block @max-[56.25rem]:bottom-[4.875rem] @max-[56.25rem]:left-[4.5rem] @max-[56.25rem]:right-[4.5rem] @max-[56.25rem]:w-auto @max-[56.25rem]:translate-x-0', 'max-md:bottom-[calc(var(--sheet-h,4.75rem)+3.875rem)] max-md:left-3 max-md:right-3 max-md:w-auto', !hasFrames && 'max-md:hidden', sheetOpen)}>
        <MapTimelineSlider />
      </div>
      {zoom != null && (
        <div className="pointer-events-none absolute bottom-[4.875rem] right-5 z-10 rounded-sm border border-border bg-[color-mix(in_srgb,var(--background)_75%,transparent)] px-1.5 py-1 text-data text-muted-foreground max-md:hidden" aria-hidden>
          {zoom.toFixed(1)}× · N {Math.abs(bearing) < 1 ? '↑' : `${Math.round(((bearing % 360) + 360) % 360)}°`}
        </div>
      )}
    </>
  )
}
