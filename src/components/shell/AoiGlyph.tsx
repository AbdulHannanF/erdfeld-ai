'use client'

import { useMemo } from 'react'
import { AOI_COLOR } from '@/lib/categorical-palette'

/** The outline of the drawn area, scaled to fit a square: real geometry only. Renders nothing for
 *  geometries without a polygon ring. */
export function AoiGlyph({ geometry, size = 32, label = 'Outline of the drawn area' }: { geometry: GeoJSON.Geometry; size?: number; label?: string }) {
  const path = useMemo(() => {
    const rings =
      geometry.type === 'Polygon'
        ? (geometry as GeoJSON.Polygon).coordinates
        : geometry.type === 'MultiPolygon'
          ? (geometry as GeoJSON.MultiPolygon).coordinates.flat()
          : null
    if (!rings || rings.length === 0 || rings[0].length < 3) return null
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const ring of rings)
      for (const [x, y] of ring) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    // Longitude degrees shrink with latitude; keep the aspect of the shape on the ground.
    const k = Math.cos((((minY + maxY) / 2) * Math.PI) / 180)
    const w = (maxX - minX) * k || 1e-9
    const h = maxY - minY || 1e-9
    const pad = 4
    const s = (size - pad * 2) / Math.max(w, h)
    const ox = (size - w * s) / 2
    const oy = (size - h * s) / 2
    return rings
      .map(
        (ring) =>
          'M' + ring.map(([x, y]) => `${(ox + (x - minX) * k * s).toFixed(1)},${(oy + (maxY - y) * s).toFixed(1)}`).join(' L') + ' Z',
      )
      .join(' ')
  }, [geometry, size])

  if (!path) return null
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 rounded-md border border-border bg-muted" role="img" aria-label={label}>
      <path d={path} fill={AOI_COLOR} fillOpacity={0.2} stroke={AOI_COLOR} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}
