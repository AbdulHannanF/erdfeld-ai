'use client'

import { MAP_HALO } from '@/lib/map-colors'
import * as maplibregl from '@/lib/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useRef, useState } from 'react'

import { AOI_COLOR } from '@/lib/categorical-palette'
import { PENDING_COLOR, VERDICT_COLOR, type BatchRow } from '@/lib/case-batch'
import { DARK_BASEMAP_STYLE } from '@/components/map/basemaps'

const colorOf = (r: BatchRow) => (r.verdict ? VERDICT_COLOR[r.verdict] : PENDING_COLOR)

const bboxOf = (g: GeoJSON.Geometry): [number, number, number, number] => {
  let [w, s, e, n] = [180, 90, -180, -90]
  const walk = (c: any) => {
    if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]) } else c.forEach(walk)
  }
  walk((g as any).coordinates)
  return [w, s, e, n]
}

/** Every plot of a batch, coloured by its verdict: data colours from the categorical palette,
 *  Cannot determine grey, plots without a verdict yet dimmer. At wide zoom a dot marks each plot
 *  (a 300 m field is under a pixel there); the outline takes over when zoomed in. */
export default function BatchMap({ rows, selected, onSelect }: { rows: BatchRow[]; selected: number | null; onSelect: (idx: number) => void }) {
  const el = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const fitted = useRef(false)
  const onSelectRef = useRef(onSelect)
  const [ready, setReady] = useState(false)
  useEffect(() => { onSelectRef.current = onSelect })

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
      map.addSource('plots', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource('dots', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({ id: 'plots-fill', type: 'fill', source: 'plots', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['get', 'decided'], 0.55, 0.2] } })
      map.addLayer({ id: 'plots-line', type: 'line', source: 'plots', paint: { 'line-color': ['get', 'color'], 'line-width': 2 } })
      map.addLayer({ id: 'plots-sel', type: 'line', source: 'plots', filter: ['==', ['get', 'idx'], -1], paint: { 'line-color': AOI_COLOR, 'line-width': 4 } })
      map.addLayer({ id: 'dots', type: 'circle', source: 'dots', maxzoom: 13, paint: { 'circle-radius': 6, 'circle-color': ['get', 'color'], 'circle-stroke-color': MAP_HALO, 'circle-stroke-width': 1.5, 'circle-opacity': ['case', ['get', 'decided'], 1, 0.5] } })
      for (const id of ['plots-fill', 'dots']) {
        map.on('click', id, (e) => { const idx = e.features?.[0]?.properties?.idx; if (typeof idx === 'number') onSelectRef.current(idx) })
        map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer' })
        map.on('mouseleave', id, () => { map.getCanvas().style.cursor = '' })
      }
      setReady(true)
    })
    return () => { setReady(false); fitted.current = false; map.remove(); mapRef.current = null }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const feats = rows.map((r) => ({ type: 'Feature' as const, geometry: r.geometry, properties: { idx: r.idx, color: colorOf(r), decided: !!r.verdict } }))
    ;(map.getSource('plots') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: feats })
    ;(map.getSource('dots') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: feats.map((f) => { const [w, s, e, n] = bboxOf(f.geometry); return { ...f, geometry: { type: 'Point' as const, coordinates: [(w + e) / 2, (s + n) / 2] } } }),
    })
    if (!fitted.current && rows.length) {
      fitted.current = true
      const boxes = rows.map((r) => bboxOf(r.geometry))
      map.fitBounds([[Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1]))], [Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))]], { padding: 50, maxZoom: 15, animate: false })
    }
  }, [rows, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    map.setFilter('plots-sel', ['==', ['get', 'idx'], selected ?? -1])
  }, [selected, ready])

  return <div ref={el} className="h-full w-full" data-testid="batch-map" role="img" aria-label="Map of all plots, coloured by verdict" />
}
