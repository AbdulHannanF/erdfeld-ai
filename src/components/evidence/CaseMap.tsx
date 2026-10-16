'use client'

import { MAP_HALO } from '@/lib/map-colors'
import * as maplibregl from '@/lib/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useRef, useState } from 'react'

import { AOI_COLOR, CATEGORICAL_PALETTE } from '@/lib/categorical-palette'
import { DARK_BASEMAP_STYLE } from '@/components/map/basemaps'

/** One evidence layer of a case, in the form a stored GeoResult holds it. */
export interface CaseMapLayer {
  id: string
  tileUrl?: string
  imageBase64?: string
  geojson?: GeoJSON.FeatureCollection
  bounds?: [number, number, number, number]
  visible: boolean
}

const bboxOf = (g: GeoJSON.Geometry): [number, number, number, number] => {
  let [w, s, e, n] = [180, 90, -180, -90]
  const walk = (c: any) => {
    if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]) } else c.forEach(walk)
  }
  walk((g as any).coordinates)
  return [w, s, e, n]
}

/** The plot and the evidence layers recorded for a case. The style is inline (a plain
 *  background and one raster basemap), so the map exists even when the basemap cannot load. */
export default function CaseMap({ geometry, layers }: { geometry: GeoJSON.Geometry; layers: CaseMapLayer[] }) {
  const el = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const added = useRef<string[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!el.current) return
    const map = new maplibregl.Map({
      container: el.current,
      // CARTO's vector basemap: its raster tiles (dark_all/*.png) now answer "API KEY REQUIRED".
      style: DARK_BASEMAP_STYLE,
      attributionControl: { compact: true },
    })
    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.on('load', () => {
      map.addSource('plot', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry } })
      map.addLayer({ id: 'plot-fill', type: 'fill', source: 'plot', paint: { 'fill-color': AOI_COLOR, 'fill-opacity': 0.08 } })
      map.addLayer({ id: 'plot-line', type: 'line', source: 'plot', paint: { 'line-color': AOI_COLOR, 'line-width': 2.5 } })
      const [w, s, e, n] = bboxOf(geometry)
      map.fitBounds([[w, s], [e, n]], { padding: 60, maxZoom: 16, animate: false })
      setReady(true)
    })
    return () => { setReady(false); map.remove(); mapRef.current = null }
  }, [geometry])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const sync = () => {
      for (const id of added.current) {
        if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(id)) map.removeSource(id)
      }
      added.current = []
      const before = map.getLayer('plot-fill') ? 'plot-fill' : undefined
      for (const l of layers) {
        if (!l.visible) continue
        const id = `ev-${l.id}`
        if (l.geojson) {
          map.addSource(id, { type: 'geojson', data: l.geojson })
          const sample = l.geojson.features[0]?.geometry.type
          if (sample === 'Point' || sample === 'MultiPoint') map.addLayer({ id, type: 'circle', source: id, paint: { 'circle-radius': 3, 'circle-color': ['coalesce', ['get', 'color'], CATEGORICAL_PALETTE[4]] } }, before)
          else map.addLayer({ id, type: 'fill', source: id, paint: { 'fill-color': ['coalesce', ['get', 'color'], CATEGORICAL_PALETTE[4]], 'fill-opacity': 0.55, 'fill-outline-color': MAP_HALO } }, before)
        } else if (l.tileUrl) {
          map.addSource(id, { type: 'raster', tiles: [l.tileUrl], tileSize: 256 })
          map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': 0.85 } }, before)
        } else if (l.imageBase64 && l.bounds) {
          const [w, s, e, n] = l.bounds
          map.addSource(id, { type: 'image', url: l.imageBase64.startsWith('data:') ? l.imageBase64 : `data:image/png;base64,${l.imageBase64}`, coordinates: [[w, n], [e, n], [e, s], [w, s]] })
          map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 } }, before)
        } else continue
        added.current.push(id)
      }
    }
    sync()
  }, [layers, ready])

  return <div ref={el} className="h-full w-full" data-testid="case-map" role="img" aria-label="Map of the plot and the evidence layers" />
}
