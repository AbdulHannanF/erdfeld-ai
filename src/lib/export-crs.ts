/**
 * Output CRS for vector export. Layers are held in WGS 84 (EPSG:4326); an export can be written in
 * any CRS `projDefinition` can handle exactly (the same list import accepts), using proj4 for the
 * coordinates and a matching `.prj` for shapefiles. Nothing is guessed: an unsupported code is
 * refused, KML is always WGS 84 (its specification requires it), and a GeoJSON in another CRS
 * carries the legacy `crs` member that GDAL and QGIS read, with a warning that RFC 7946 does not.
 */
import proj4 from 'proj4'
import { projDefinition } from '@/lib/vector-io'

export interface CrsOption {
  epsg: number
  label: string
}

export const COMMON_CRS: CrsOption[] = [
  { epsg: 4326, label: 'WGS 84' },
  { epsg: 3857, label: 'WGS 84 / Pseudo-Mercator' },
  { epsg: 4269, label: 'NAD83' },
]

/** The WGS 84 UTM zone for a point: 326zz north of the equator, 327zz south. */
export function utmEpsgFor(lng: number, lat: number): number {
  const zone = Math.min(60, Math.max(1, Math.floor((lng + 180) / 6) + 1))
  return (lat >= 0 ? 32600 : 32700) + zone
}

export function parseEpsg(code: string): number | null {
  const m = /^(?:epsg:)?\s*(\d{4,6})$/i.exec(code.trim())
  if (!m) return null
  const n = Number(m[1])
  return projDefinition(n) === null ? null : n
}

export function crsLabel(epsg: number): string {
  const known = COMMON_CRS.find((c) => c.epsg === epsg)
  if (known) return `EPSG:${epsg} · ${known.label}`
  if (epsg >= 32601 && epsg <= 32660) return `EPSG:${epsg} · WGS 84 / UTM zone ${epsg - 32600}N`
  if (epsg >= 32701 && epsg <= 32760) return `EPSG:${epsg} · WGS 84 / UTM zone ${epsg - 32700}S`
  if (epsg >= 25828 && epsg <= 25838) return `EPSG:${epsg} · ETRS89 / UTM zone ${epsg - 25800}N`
  return `EPSG:${epsg}`
}

type Pos = number[]
const mapPos = (c: unknown, f: (p: Pos) => Pos): unknown =>
  Array.isArray(c) && typeof c[0] === 'number' ? f(c as Pos) : Array.isArray(c) ? c.map((x) => mapPos(x, f)) : c

function mapGeometry(g: GeoJSON.Geometry | null, f: (p: Pos) => Pos): GeoJSON.Geometry | null {
  if (!g) return g
  if (g.type === 'GeometryCollection') return { ...g, geometries: g.geometries.map((x) => mapGeometry(x, f) as GeoJSON.Geometry) }
  return { ...g, coordinates: mapPos(g.coordinates, f) } as GeoJSON.Geometry
}

/** The collection with every coordinate converted from WGS 84 to `epsg`. EPSG:4326 returns it unchanged. */
export function reprojectCollection(fc: GeoJSON.FeatureCollection, epsg: number): GeoJSON.FeatureCollection {
  const def = projDefinition(epsg)
  if (def === null) throw new Error(`EPSG:${epsg} is not supported for export`)
  if (def === '') return fc
  const to = proj4('EPSG:4326', def)
  const f = (p: Pos): Pos => {
    const [x, y] = to.forward([p[0], p[1]])
    return p.length > 2 ? [x, y, p[2]] : [x, y]
  }
  return { ...fc, features: fc.features.map((ft) => ({ ...ft, geometry: mapGeometry(ft.geometry, f) as GeoJSON.Geometry })) }
}

const GEOGCS_WGS84 = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
const GEOGCS_ETRS89 = 'GEOGCS["GCS_ETRS_1989",DATUM["D_ETRS_1989",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
const GEOGCS_NAD83 = 'GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'

const utm = (name: string, geogcs: string, zone: number, south: boolean) =>
  `PROJCS["${name}",${geogcs},PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",${south ? '10000000.0' : '0.0'}],PARAMETER["Central_Meridian",${zone * 6 - 183}.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]`

/** ESRI-style WKT for the `.prj` of a supported code, or null. */
export function prjWkt(epsg: number): string | null {
  if (epsg === 4326) return GEOGCS_WGS84
  if (epsg === 4269) return GEOGCS_NAD83
  if (epsg === 3857)
    return `PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",${GEOGCS_WGS84},PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]`
  if (epsg >= 32601 && epsg <= 32660) return utm(`WGS_1984_UTM_Zone_${epsg - 32600}N`, GEOGCS_WGS84, epsg - 32600, false)
  if (epsg >= 32701 && epsg <= 32760) return utm(`WGS_1984_UTM_Zone_${epsg - 32700}S`, GEOGCS_WGS84, epsg - 32700, true)
  if (epsg >= 25828 && epsg <= 25838) return utm(`ETRS_1989_UTM_Zone_${epsg - 25800}N`, GEOGCS_ETRS89, epsg - 25800, false)
  return null
}

export interface ExportInCrs {
  data: Uint8Array | string
  filename: string
  mime: string
  warnings: string[]
}

/** Export a layer in the chosen output CRS, with the caveats that CRS carries stated, not hidden. */
export async function exportVectorInCrs(fc: GeoJSON.FeatureCollection, format: 'geojson' | 'shapefile' | 'kml' | 'csv', name: string, epsg: number): Promise<ExportInCrs> {
  const io = await import('@/lib/vector-io')
  if (epsg === 4326) return io.exportVector(fc, format, name)
  if (format === 'kml') {
    const r = await io.exportVector(fc, format, name)
    return { ...r, warnings: [...r.warnings, `KML is always WGS 84, so EPSG:${epsg} was not applied to this file`] }
  }
  const projected = reprojectCollection(fc, epsg)
  if (format === 'shapefile') {
    const prj = prjWkt(epsg)
    if (!prj) throw new Error(`No .prj is available for EPSG:${epsg}`)
    return io.exportVector(projected, format, name, { prj })
  }
  const base = await io.exportVector(projected, format, name)
  if (format === 'geojson') {
    const withCrs = { ...projected, crs: { type: 'name', properties: { name: `urn:ogc:def:crs:EPSG::${epsg}` } } }
    return { ...base, data: JSON.stringify(withCrs), warnings: [...base.warnings, `GeoJSON in EPSG:${epsg} carries the legacy "crs" member (RFC 7946 allows only WGS 84); QGIS and GDAL read it, many web tools do not`] }
  }
  const csv = String(base.data).replace(/^lat,lon,/, 'y,x,')
  return { ...base, data: csv, warnings: [...base.warnings, `CSV columns y and x are the centroid in EPSG:${epsg}`] }
}
