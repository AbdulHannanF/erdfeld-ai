/** Geometry + spatial helpers (pure, no I/O). */

import turfArea from '@turf/area'
import turfCentroid from '@turf/centroid'
import turfBooleanPointInPolygon from '@turf/boolean-point-in-polygon'

import { toGeometry } from '@/lib/api-schemas'

export function genId(): string {
  return Math.random().toString(36).substring(2, 10)
}

export function getBbox(input: any): [number, number, number, number] {
  const geometry = toGeometry(input)
  if (!geometry) return [0, 0, 1, 1]
  let coords: number[][] = []
  if (geometry.type === 'Polygon') coords = geometry.coordinates[0]
  else if (geometry.type === 'Point') { const c = geometry.coordinates; return [c[0], c[1], c[0], c[1]] }
  if (coords.length === 0) return [0, 0, 1, 1]
  const lngs = coords.map((c: number[]) => c[0])
  const lats = coords.map((c: number[]) => c[1])
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)]
}

/** A `[west, south, east, north]` bbox as a closed GeoJSON rectangle Polygon.
 *
 *  Exists because titiler's GET `/cog/statistics?bbox=…` **silently ignores the
 *  bbox** and returns whole-COG statistics (ISS-102, re-verified live 2026-08-10:
 *  identical mean 2678.755 / count 1 048 576 for the AOI bbox and for a bbox
 *  400 km away). The only correct way to ask titiler for a bbox is to POST this
 *  rectangle as a cutline feature.
 *
 *  Returns null for a malformed or zero-area bbox — callers must degrade
 *  honestly rather than fall through to a whole-scene number. */
export function bboxToPolygon(bbox: number[]): { type: 'Polygon'; coordinates: number[][][] } | null {
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) return null
  const w = Math.min(bbox[0], bbox[2])
  const e = Math.max(bbox[0], bbox[2])
  const s = Math.min(bbox[1], bbox[3])
  const n = Math.max(bbox[1], bbox[3])
  if (w === e || s === n) return null
  return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }
}

/** True polygon area in km² (Turf, spherical). Falls back to bbox area for
 *  non-polygon inputs so callers don't crash on legacy code paths. */
export function getAreaKm2(input: any): number {
  const geometry = toGeometry(input)
  if (!geometry) return 0
  if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
    try {
      return turfArea(geometry) / 1_000_000
    } catch {
      // fall through to bbox approximation
    }
  }
  const bbox = getBbox(geometry)
  const dx = (bbox[2] - bbox[0]) * 111
  const dy = (bbox[3] - bbox[1]) * 111 * Math.cos(((bbox[1] + bbox[3]) / 2) * Math.PI / 180)
  return Math.abs(dx * dy)
}

/** True polygon centroid (Turf). Falls back to bbox-center for non-polygon inputs. */
export function getCentroid(input: any): { lat: number; lng: number } {
  const geometry = toGeometry(input)
  if (geometry && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')) {
    try {
      const c = turfCentroid(geometry as any)
      const [lng, lat] = c.geometry.coordinates
      return { lat, lng }
    } catch {
      // fall through to bbox-center
    }
  }
  const bbox = getBbox(geometry)
  return { lat: (bbox[1] + bbox[3]) / 2, lng: (bbox[0] + bbox[2]) / 2 }
}

/** True point-in-polygon (Turf). Returns false for non-polygon geometries. */
export function pointInAoi(lng: number, lat: number, input: any): boolean {
  const geometry = toGeometry(input)
  if (!geometry) return false
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return false
  try {
    return turfBooleanPointInPolygon([lng, lat], geometry as any)
  } catch {
    return false
  }
}

/** Extract bbox from any GeoJSON FeatureCollection by walking all coords. */
export function extractBboxFromGeojson(geojson: any): [number, number, number, number] | null {
  if (!geojson?.features?.length) return null
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
  const flatCoords = (geometry: any): number[][] => {
    if (!geometry) return []
    switch (geometry.type) {
      case 'Point': return [geometry.coordinates]
      case 'LineString': return geometry.coordinates
      case 'Polygon': return geometry.coordinates[0] ?? []
      case 'MultiLineString': return (geometry.coordinates as number[][][]).flat()
      case 'MultiPolygon': return (geometry.coordinates as number[][][][]).flat(2)
      default: return []
    }
  }
  for (const f of geojson.features) {
    for (const [lng, lat] of flatCoords(f.geometry)) {
      if (lng < minLng) minLng = lng
      if (lat < minLat) minLat = lat
      if (lng > maxLng) maxLng = lng
      if (lat > maxLat) maxLat = lat
    }
  }
  return isFinite(minLng) ? [minLng, minLat, maxLng, maxLat] : null
}

/** Build an ephemeral circular AOI polygon (approximated by `steps` vertices)
 *  centered on a clicked point. Used by P4.3 "click-to-explain" focus mode so the
 *  existing polygon-clipping tools naturally sample at that point. `radiusM`
 *  defaults to 200 m — small enough to read as "this point", large enough that
 *  bbox-clipped raster stats have pixels to average. */
export function buildPointAoi(lat: number, lng: number, radiusM = 200, steps = 32): any {
  const ring: number[][] = []
  // Meters → degrees: latitude is ~constant; longitude shrinks by cos(lat).
  const dLat = radiusM / 111_320
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180) || 1)
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * 2 * Math.PI
    ring.push([lng + dLng * Math.cos(theta), lat + dLat * Math.sin(theta)])
  }
  return { type: 'Polygon', coordinates: [ring] }
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** (lon, lat, zoom) → slippy-map tile (x, y). */
export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = Math.pow(2, z)
  const x = Math.floor(((lon + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) }
}
