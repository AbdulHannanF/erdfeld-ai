'use client'

import { useEffect, useMemo, useState } from 'react'
import type * as maplibregl from 'maplibre-gl'
import { Check, Eraser, Undo2 } from 'lucide-react'
import { GLASS } from '@/components/shell/ui'
import { haversineM } from '@/lib/geo-ops'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { cn } from '@/lib/utils'

const SRC = 'erdfeld-measure'
const LINE = 'erdfeld-measure-line'
const DOTS = 'erdfeld-measure-dots'

/** Length of a polyline in metres, summed segment by segment on the sphere. */
export function pathLengthM(points: Array<[number, number]>): number {
  let m = 0
  for (let i = 1; i < points.length; i++) m += haversineM(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1])
  return m
}

export function formatDistance(m: number, units: 'metric' | 'imperial'): string {
  if (units === 'imperial') {
    const ft = m * 3.28084
    return ft < 5280 ? `${Math.round(ft).toLocaleString('en-US')} ft` : `${(ft / 5280).toFixed(2)} mi`
  }
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 3 : 2)} km`
}

/** The measure tool: click points on the map, read the distance along them. The path is drawn as a
 *  map layer that survives a basemap change; Esc, Finish or choosing another tool ends it. */
export default function MapMeasure({ map, className }: { map: maplibregl.Map | null; className?: string }) {
  const tool = useUi((s) => s.mapTool)
  const setTool = useUi((s) => s.setMapTool)
  const units = useStore((s) => s.settings.distanceUnit)
  const active = tool === 'measure'
  const [points, setPoints] = useState<Array<[number, number]>>([])

  useEffect(() => {
    if (!map || !active) return
    const onClick = (e: maplibregl.MapMouseEvent) => setPoints((p) => [...p, [e.lngLat.lng, e.lngLat.lat]])
    map.on('click', onClick)
    map.getCanvas().style.cursor = 'crosshair'
    return () => {
      map.off('click', onClick)
      map.getCanvas().style.cursor = ''
      setPoints([]) // leaving the tool clears the path
    }
  }, [map, active])

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTool('select')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, setTool])

  useEffect(() => {
    if (!map) return
    const draw = () => {
      try {
        if (!map.getSource(SRC)) {
          map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
          map.addLayer({ id: LINE, type: 'line', source: SRC, filter: ['==', '$type', 'LineString'], paint: { 'line-color': '#f2c46d', 'line-width': 2.5, 'line-dasharray': [2, 1.2] } })
          map.addLayer({ id: DOTS, type: 'circle', source: SRC, filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 4.5, 'circle-color': '#101314', 'circle-stroke-color': '#f2c46d', 'circle-stroke-width': 2 } })
        }
        const features: GeoJSON.Feature[] = points.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }))
        if (points.length > 1) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: points } })
        ;(map.getSource(SRC) as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features })
      } catch {
        // the style is reloading: styledata fires again when it is ready
      }
    }
    draw()
    map.on('styledata', draw)
    return () => {
      map.off('styledata', draw)
    }
  }, [map, points])

  const length = useMemo(() => pathLengthM(points), [points])
  if (!active) return null

  return (
    <div className={cn('flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-body', GLASS, className)} role="status" data-testid="measure-readout">
      <span className="text-muted-foreground text-label">Distance</span>
      <strong className="min-w-[4rem] tabular-nums text-foreground">{points.length > 1 ? formatDistance(length, units) : 'Click 2+ points'}</strong>
      {points.length > 1 && <span className="text-data text-muted-foreground">{points.length} points</span>}
      <button type="button" className="btn btn-ghost btn-icon-sm" disabled={points.length === 0} onClick={() => setPoints((p) => p.slice(0, -1))} aria-label="Remove the last point" title="Undo a point"><Undo2 aria-hidden /></button>
      <button type="button" className="btn btn-ghost btn-icon-sm" disabled={points.length === 0} onClick={() => setPoints([])} aria-label="Clear the measurement" title="Clear"><Eraser aria-hidden /></button>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTool('select')}><Check aria-hidden />Finish</button>
    </div>
  )
}
