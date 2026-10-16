/**
 * P4.4 — AOI signature for the "layer memory" manifest.
 *
 * Each layer is tagged with the signature of the AOI it was computed for. When
 * the user redraws or changes the AOI, the signature changes, so prior layers
 * drop out of the reusable manifest and the agent re-runs the relevant tools
 * instead of citing numbers that describe a different area.
 *
 * Pure + framework-free so it can be unit-tested in isolation and shared between
 * the SSE hook (tagging + manifest build) and the chat header (reuse pill).
 */

import turfArea from '@turf/area'

/** Geodesic area of a (multi)polygon in km², or null for any other geometry. */
export function aoiAreaKm2(geometry: GeoJSON.Geometry | null | undefined): number | null {
  if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) return null
  try {
    return turfArea({ type: 'Feature', properties: {}, geometry }) / 1e6
  } catch {
    return null
  }
}

/** "820 m²", "9.52 km²", "1,240 km²": area at the precision that means something at that size. */
export function formatAreaKm2(km2: number): string {
  if (km2 < 1) return `${Math.round(km2 * 1e6).toLocaleString('en-US')} m²`
  if (km2 < 100) return `${km2.toFixed(2)} km²`
  return `${Math.round(km2).toLocaleString('en-US')} km²`
}

/** Accepts either an `AOI` object (with `.geometry`) or a raw GeoJSON geometry. */
export function aoiSignature(aoi: unknown): string {
  const a = aoi as { geometry?: { coordinates?: unknown }; coordinates?: unknown } | null
  const geom = a?.geometry ?? a
  const coords = (geom as { coordinates?: unknown })?.coordinates
  if (!coords) return ''
  try {
    // Round coordinates to ~1 m (5 decimal places) so trivial float jitter
    // doesn't break reuse, then hash the JSON to a short stable string.
    const rounded = JSON.stringify(coords, (_k, v) =>
      typeof v === 'number' ? Math.round(v * 1e5) / 1e5 : v,
    )
    let h = 0
    for (let i = 0; i < rounded.length; i++) {
      h = (h * 31 + rounded.charCodeAt(i)) | 0
    }
    return `aoi_${(h >>> 0).toString(36)}_${rounded.length}`
  } catch {
    return ''
  }
}
