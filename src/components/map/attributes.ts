/**
 * What the attribute table and the expression console read: the vector layers' features, plus the
 * drawn area as a one-feature source, with the geometry values (`$area`, `$length`, `$x`, `$y`) an
 * expression may use. Pure: no DOM, no store.
 */
import { area as turfArea, centroid as turfCentroid, length as turfLength } from '@turf/turf'
import type { AOI, MapLayer } from '@/store/useStore'
import type { Row } from '@/lib/expression'
import { aoiAreaKm2 } from '@/lib/aoi'

export interface AttrSource {
  id: string
  name: string
  kind: 'layer' | 'aoi'
  features: GeoJSON.Feature[]
}

export const AOI_SOURCE_ID = '__aoi__'

/** The drawn area as a source of one feature, with what is known about it and nothing else. */
export function aoiSource(aoi: AOI | null): AttrSource | null {
  if (!aoi?.geometry) return null
  const km2 = aoiAreaKm2(aoi.geometry)
  const props: Record<string, unknown> = { fid: 'AOI-001', name: 'Area of interest', shape: aoi.type }
  if (km2 != null) props.area_km2 = Number(km2.toFixed(4))
  if (aoi.center) {
    props.center_lat = Number(aoi.center.lat.toFixed(5))
    props.center_lng = Number(aoi.center.lng.toFixed(5))
  }
  if (aoi.radiusKm != null) props.radius_km = aoi.radiusKm
  return { id: AOI_SOURCE_ID, name: 'Area of interest', kind: 'aoi', features: [{ type: 'Feature', properties: props, geometry: aoi.geometry }] }
}

/** Vector layers with at least one feature, then the drawn area. */
export function attributeSources(layers: MapLayer[], aoi: AOI | null): AttrSource[] {
  const out: AttrSource[] = layers
    .filter((l) => l.type === 'geojson' && (l.geojson?.features.length ?? 0) > 0)
    .map((l) => ({ id: l.id, name: l.name, kind: 'layer' as const, features: l.geojson!.features }))
  const a = aoiSource(aoi)
  if (a) out.push(a)
  return out
}

/** Property names across the features, most common first, `fid` leading, capped. */
export function columnsOf(features: GeoJSON.Feature[], max = 14): { columns: string[]; hidden: number } {
  const count = new Map<string, number>()
  for (const f of features.slice(0, 2000)) {
    for (const [k, v] of Object.entries(f.properties ?? {})) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) continue
      count.set(k, (count.get(k) ?? 0) + 1)
    }
  }
  const names = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k)
  const lead = names.includes('fid') ? ['fid'] : []
  const rest = names.filter((n) => n !== 'fid')
  const cols = [...lead, ...rest].slice(0, max)
  return { columns: cols, hidden: Math.max(0, names.length - cols.length) }
}

/** A table cell as text: arrays and objects are summarised, never dumped. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e5) / 1e5)
  if (Array.isArray(v)) return `[${v.length} values]`
  if (typeof v === 'object') return '{…}'
  return String(v)
}

export function geometryLabel(f: GeoJSON.Feature): string {
  return f.geometry?.type ?? 'None'
}

/** The geometry value an expression asks for, or null when the geometry cannot give it. */
export function geometryValue(f: GeoJSON.Feature, name: '$area' | '$length' | '$x' | '$y'): number | null {
  const g = f.geometry
  if (!g) return null
  try {
    if (name === '$area') return g.type === 'Polygon' || g.type === 'MultiPolygon' ? turfArea(f) / 1e6 : null
    if (name === '$length') return g.type === 'LineString' || g.type === 'MultiLineString' || g.type === 'Polygon' || g.type === 'MultiPolygon' ? turfLength(f, { units: 'kilometers' }) : null
    const [x, y] = turfCentroid(f).geometry.coordinates
    return name === '$x' ? x : y
  } catch {
    return null
  }
}

/** Features as expression rows; geometry values are computed only if the expression asks. */
export function rowsFor(features: GeoJSON.Feature[]): Row[] {
  return features.map((f) => ({ props: (f.properties ?? {}) as Record<string, unknown>, geom: (n) => geometryValue(f, n) }))
}

/** [west, south, east, north] of some features, or null when none has coordinates. */
export function featuresBounds(features: GeoJSON.Feature[]): [number, number, number, number] | null {
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  const visit = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
      w = Math.min(w, c[0])
      e = Math.max(e, c[0])
      s = Math.min(s, c[1])
      n = Math.max(n, c[1])
    } else if (Array.isArray(c)) c.forEach(visit)
  }
  for (const f of features) {
    const g = f.geometry as { coordinates?: unknown; geometries?: GeoJSON.Geometry[] } | null
    if (g?.coordinates) visit(g.coordinates)
    g?.geometries?.forEach((x) => visit((x as { coordinates?: unknown }).coordinates))
  }
  return Number.isFinite(w) ? [w, s, e, n] : null
}
