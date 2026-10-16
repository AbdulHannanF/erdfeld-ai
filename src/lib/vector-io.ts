/**
 * User vector data in and out (client-side, pure: no DOM, no network).
 *
 * Import  -> GeoJSON FeatureCollection in WGS84 (EPSG:4326, lon/lat order) from
 *            GeoJSON, zipped Shapefile, KML, KMZ, GPX and CSV.
 * Export  <- FeatureCollection to GeoJSON, zipped Shapefile, KML and CSV.
 *
 * Honesty rules: nothing is guessed. A shapefile without a .prj is accepted only if
 * its coordinates are unambiguously lon/lat; a projected CSV needs an explicit supported EPSG
 * code. Invalid features are dropped and COUNTED with reasons, never silently repaired; the
 * report says what happened. Caps on file size and feature count refuse rather than truncate.
 */
import type JSZip from 'jszip'
import proj4 from 'proj4'
// jszip, shpjs and @mapbox/shp-write are loaded on first use (they pull a `util` polyfill whose startup
// probe calls Function(), which the CSP reports): a page that never touches shapefiles never loads them.
import {
  area as turfArea,
  bbox as turfBbox,
  bboxPolygon,
  centroid as turfCentroid,
  featureCollection,
  kinks as turfKinks,
  union as turfUnion,
} from '@turf/turf'
import { descendants, escapeXml, kid, kids, parseXml, type XmlEl } from '@/lib/xml-lite'

// ---------------------------------------------------------------------------
// Limits and types
// ---------------------------------------------------------------------------

export const MAX_FEATURES = 10_000
export const MAX_FILE_BYTES = 50 * 1024 * 1024
/** Polygons with more vertices than this are not checked for self-intersection (cost). */
const KINKS_MAX_VERTICES = 5_000

export type VectorFormat = 'geojson' | 'shapefile' | 'kml' | 'kmz' | 'gpx' | 'csv'
export type ExportFormat = 'geojson' | 'shapefile' | 'kml' | 'csv'

export type ImportErrorCode =
  | 'unsupported-format'
  | 'too-large'
  | 'too-many-features'
  | 'parse'
  | 'no-crs'
  | 'needs-epsg'
  | 'unsupported-crs'
  | 'empty'

export class VectorImportError extends Error {
  constructor(public code: ImportErrorCode, message: string) {
    super(message)
    this.name = 'VectorImportError'
  }
}

export interface DroppedFeature {
  /** Index in the source file (0-based; row number for CSV). */
  index: number
  reason: string
}

export interface ImportResult {
  fc: GeoJSON.FeatureCollection
  format: VectorFormat
  /** Where the coordinates came from, e.g. "EPSG:4326", "reprojected from .prj", "EPSG:32643". */
  crs: string
  /** Features present in the source (after exploding GeometryCollections). */
  sourceCount: number
  /** Features kept. */
  keptCount: number
  dropped: DroppedFeature[]
  /** Kept polygons that self-intersect (reported, not repaired). */
  selfIntersecting: number
  /** Human-readable caveats (assumptions made, things not imported). */
  warnings: string[]
}

export interface ImportOptions {
  /** Source CRS for CSV x/y columns (EPSG code). */
  epsg?: number
}

export function detectFormat(name: string): VectorFormat | null {
  const n = name.toLowerCase()
  if (n.endsWith('.geojson') || n.endsWith('.json')) return 'geojson'
  if (n.endsWith('.zip')) return 'shapefile'
  if (n.endsWith('.kmz')) return 'kmz'
  if (n.endsWith('.kml')) return 'kml'
  if (n.endsWith('.gpx')) return 'gpx'
  if (n.endsWith('.csv') || n.endsWith('.tsv') || n.endsWith('.txt')) return 'csv'
  return null
}

export const IMPORT_ACCEPT = '.geojson,.json,.zip,.kml,.kmz,.gpx,.csv,.tsv'

// ---------------------------------------------------------------------------
// CRS support (explicit; nothing is guessed)
// ---------------------------------------------------------------------------

/** proj4 definition for an EPSG code we can handle exactly, or null. 4326 returns ''. */
export function projDefinition(epsg: number): string | null {
  if (epsg === 4326) return ''
  if (epsg === 3857) return '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs'
  if (epsg === 4269) return '+proj=longlat +datum=NAD83 +no_defs'
  if (epsg >= 32601 && epsg <= 32660) return `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs`
  if (epsg >= 32701 && epsg <= 32760) return `+proj=utm +zone=${epsg - 32700} +south +datum=WGS84 +units=m +no_defs`
  if (epsg >= 25828 && epsg <= 25838) return `+proj=utm +zone=${epsg - 25800} +ellps=GRS80 +units=m +no_defs`
  return null
}

export const SUPPORTED_EPSG_NOTE =
  'supported: 4326, 4269, 3857, 326xx/327xx (WGS84 UTM) and 25828-25838 (ETRS89 UTM)'

// ---------------------------------------------------------------------------
// Validation + cleaning
// ---------------------------------------------------------------------------

type Pos = number[]

function posError(p: unknown): string | null {
  if (!Array.isArray(p) || p.length < 2) return 'malformed coordinate'
  const [x, y] = p as number[]
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    return 'non-numeric coordinate'
  }
  if (p.length > 2 && typeof p[2] === 'number' && !Number.isFinite(p[2])) return 'non-numeric elevation'
  if (x < -180 || x > 180) return `longitude ${x} outside [-180, 180]`
  if (y < -90 || y > 90) return `latitude ${y} outside [-90, 90]`
  return null
}

function lineError(c: unknown, min: number, closed = false): string | null {
  if (!Array.isArray(c) || c.length < min) return `needs at least ${min} positions`
  for (const p of c as Pos[]) {
    const e = posError(p)
    if (e) return e
  }
  if (closed) {
    const a = c[0] as Pos
    const b = c[c.length - 1] as Pos
    if (a[0] !== b[0] || a[1] !== b[1]) return 'polygon ring is not closed'
  }
  return null
}

function polygonError(rings: unknown): string | null {
  if (!Array.isArray(rings) || rings.length === 0) return 'polygon has no rings'
  for (const r of rings) {
    const e = lineError(r, 4, true)
    if (e) return e
  }
  return null
}

/** Reason a (non-collection) geometry is unusable, or null if it is structurally valid. */
export function geometryError(g: GeoJSON.Geometry | null | undefined): string | null {
  if (!g || typeof g !== 'object') return 'no geometry'
  const c = (g as { coordinates?: unknown }).coordinates
  switch (g.type) {
    case 'Point':
      return posError(c)
    case 'MultiPoint':
      return !Array.isArray(c) || c.length === 0 ? 'empty MultiPoint' : (c as Pos[]).map(posError).find(Boolean) ?? null
    case 'LineString':
      return lineError(c, 2)
    case 'MultiLineString':
      return !Array.isArray(c) || c.length === 0 ? 'empty MultiLineString' : (c as unknown[]).map((l) => lineError(l, 2)).find(Boolean) ?? null
    case 'Polygon':
      return polygonError(c)
    case 'MultiPolygon':
      return !Array.isArray(c) || c.length === 0 ? 'empty MultiPolygon' : (c as unknown[]).map(polygonError).find(Boolean) ?? null
    default:
      return `unsupported geometry type "${(g as { type?: string }).type}"`
  }
}

function vertexCount(c: unknown): number {
  if (!Array.isArray(c)) return 0
  if (typeof c[0] === 'number') return 1
  return (c as unknown[]).reduce<number>((n, x) => n + vertexCount(x), 0)
}

interface CleanOutput {
  features: GeoJSON.Feature[]
  dropped: DroppedFeature[]
  selfIntersecting: number
  unchecked: number
  sourceCount: number
}

function plainProps(p: unknown): GeoJSON.GeoJsonProperties {
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as GeoJSON.GeoJsonProperties) : {}
}

/** Explode GeometryCollections, drop structurally invalid features, flag self-intersections. */
export function cleanFeatures(input: unknown[]): CleanOutput {
  const features: GeoJSON.Feature[] = []
  const dropped: DroppedFeature[] = []
  let selfIntersecting = 0
  let unchecked = 0
  let sourceCount = 0

  input.forEach((raw, index) => {
    const f = raw as GeoJSON.Feature | null
    if (!f || typeof f !== 'object' || f.type !== 'Feature') {
      sourceCount++
      dropped.push({ index, reason: 'not a GeoJSON Feature' })
      return
    }
    const geoms: Array<GeoJSON.Geometry | null> =
      f.geometry && f.geometry.type === 'GeometryCollection'
        ? (f.geometry as GeoJSON.GeometryCollection).geometries
        : [f.geometry]
    if (geoms.length === 0) geoms.push(null)
    for (const g of geoms) {
      sourceCount++
      const err = geometryError(g)
      if (err) {
        dropped.push({ index, reason: err })
        continue
      }
      const out: GeoJSON.Feature = { type: 'Feature', properties: plainProps(f.properties), geometry: g as GeoJSON.Geometry }
      if (f.id !== undefined) out.id = f.id
      if (g!.type === 'Polygon' || g!.type === 'MultiPolygon') {
        if (vertexCount((g as GeoJSON.Polygon).coordinates) <= KINKS_MAX_VERTICES) {
          try {
            if (turfKinks(out as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>).features.length > 0) selfIntersecting++
          } catch {
            unchecked++
          }
        } else unchecked++
      }
      features.push(out)
    }
  })
  return { features, dropped, selfIntersecting, unchecked, sourceCount }
}

function finish(
  raw: unknown[],
  format: VectorFormat,
  crs: string,
  warnings: string[] = [],
  pre: DroppedFeature[] = [],
  preCount = 0,
  srcIndex?: number[],
): ImportResult {
  if (raw.length + preCount > MAX_FEATURES) {
    throw new VectorImportError(
      'too-many-features',
      `${raw.length + preCount} features exceeds the ${MAX_FEATURES.toLocaleString('en-US')}-feature cap — split or simplify the file; nothing was imported`,
    )
  }
  const c = cleanFeatures(raw)
  if (c.sourceCount + preCount > MAX_FEATURES) {
    throw new VectorImportError('too-many-features', `file expands to more than ${MAX_FEATURES.toLocaleString('en-US')} features`)
  }
  const dropped = [...pre, ...c.dropped.map((d) => ({ ...d, index: srcIndex?.[d.index] ?? d.index }))]
  const sourceCount = c.sourceCount + preCount
  if (c.features.length === 0) {
    const sample = dropped[0]?.reason
    throw new VectorImportError(
      'empty',
      sourceCount === 0
        ? 'the file contains no features'
        : `none of the ${sourceCount} features is usable${sample ? ` (e.g. ${sample})` : ''}`,
    )
  }
  const w = [...warnings]
  if (dropped.length) {
    const byReason = new Map<string, number>()
    dropped.forEach((d) => byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1))
    const top = [...byReason.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${n}× ${r}`)
    w.push(`${dropped.length} of ${sourceCount} features dropped as invalid (${top.join('; ')})`)
  }
  if (c.selfIntersecting) w.push(`${c.selfIntersecting} polygon(s) self-intersect; kept as supplied, not repaired — area figures may be unreliable`)
  if (c.unchecked) w.push(`${c.unchecked} large polygon(s) were not checked for self-intersection`)
  return {
    fc: { type: 'FeatureCollection', features: c.features },
    format,
    crs,
    sourceCount,
    keptCount: c.features.length,
    dropped,
    selfIntersecting: c.selfIntersecting,
    warnings: w,
  }
}

// ---------------------------------------------------------------------------
// GeoJSON
// ---------------------------------------------------------------------------

const GEOM_TYPES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection'])

export function importGeoJSON(text: string): ImportResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new VectorImportError('parse', 'not valid JSON')
  }
  const p = parsed as { type?: string; features?: unknown[]; geometry?: unknown; crs?: { properties?: { name?: string } } }
  let raw: unknown[]
  if (p && p.type === 'FeatureCollection' && Array.isArray(p.features)) raw = p.features
  else if (p && p.type === 'Feature') raw = [p]
  else if (p && typeof p.type === 'string' && GEOM_TYPES.has(p.type)) raw = [{ type: 'Feature', properties: {}, geometry: p }]
  else throw new VectorImportError('parse', 'not GeoJSON — expected a FeatureCollection, Feature or Geometry')

  // Legacy GeoJSON 2008 "crs" member: only WGS84 names are accepted.
  const crsName = p.crs?.properties?.name
  let crs = 'EPSG:4326'
  if (crsName) {
    if (/CRS84|EPSG:{1,2}4326/i.test(crsName)) crs = 'EPSG:4326'
    else {
      throw new VectorImportError(
        'unsupported-crs',
        `GeoJSON declares CRS "${crsName}"; this importer reads WGS84 only (RFC 7946) — reproject to EPSG:4326 first`,
      )
    }
  }
  return finish(raw, 'geojson', crs)
}

// ---------------------------------------------------------------------------
// Shapefile (zip) via shpjs, which reprojects using the .prj
// ---------------------------------------------------------------------------

function looksLikeLonLat(fc: GeoJSON.FeatureCollection): boolean {
  for (const f of fc.features) {
    if (!f.geometry) continue
    const ok = (c: unknown): boolean => {
      if (!Array.isArray(c)) return true
      if (typeof c[0] === 'number') return Math.abs(c[0] as number) <= 180 && Math.abs(c[1] as number) <= 90
      return (c as unknown[]).every(ok)
    }
    if ('coordinates' in f.geometry && !ok(f.geometry.coordinates)) return false
  }
  return true
}

const loadJsZip = async () => (await import('jszip')).default

export async function importShapefileZip(buf: ArrayBuffer): Promise<ImportResult> {
  let zip: JSZip
  try {
    zip = await (await loadJsZip()).loadAsync(buf)
  } catch {
    throw new VectorImportError('parse', 'not a readable zip archive')
  }
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
  const shpNames = names.filter((n) => /\.shp$/i.test(n))
  if (shpNames.length === 0) {
    throw new VectorImportError('parse', 'the zip contains no .shp file (a shapefile needs .shp, .dbf and ideally .prj)')
  }
  const hasPrj = shpNames.map((s) => names.some((n) => n.toLowerCase() === s.replace(/\.shp$/i, '.prj').toLowerCase()))
  const warnings: string[] = []
  let out: unknown
  try {
    const { default: shp } = await import('shpjs')
    out = await shp(buf)
  } catch (e) {
    throw new VectorImportError('parse', `shapefile could not be read or its .prj reprojected: ${(e as Error).message}`)
  }
  const cols = (Array.isArray(out) ? out : [out]) as GeoJSON.FeatureCollection[]
  const features: unknown[] = []
  for (const c of cols) features.push(...(c.features ?? []))
  if (cols.length > 1) warnings.push(`zip holds ${cols.length} shapefiles; merged into one layer`)
  if (!hasPrj.every(Boolean)) {
    const merged: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: features as GeoJSON.Feature[] }
    if (!looksLikeLonLat(merged)) {
      throw new VectorImportError(
        'no-crs',
        'no .prj file and the coordinates are not lon/lat — the projection cannot be determined, so nothing was imported. Add the .prj to the zip.',
      )
    }
    warnings.push('no .prj file: assumed WGS84 because every coordinate falls inside lon/lat ranges — verify the position on the map')
    return finish(features, 'shapefile', 'assumed EPSG:4326 (no .prj)', warnings)
  }
  return finish(features, 'shapefile', 'from .prj (reprojected to EPSG:4326)', warnings)
}

// ---------------------------------------------------------------------------
// KML / KMZ / GPX
// ---------------------------------------------------------------------------

function coerce(v: string): string | number {
  const t = v.trim()
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(t)) {
    const n = Number(t)
    if (Number.isFinite(n)) return n
  }
  return v
}

function parseCoordText(s: string): Pos[] {
  return s
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.split(',').map(Number))
    .filter((p) => p.length >= 2)
}

function kmlGeometry(el: XmlEl, skipped: Set<string>): GeoJSON.Geometry | null {
  switch (el.name) {
    case 'Point': {
      const c = parseCoordText(kid(el, 'coordinates')?.text ?? '')
      return c.length ? { type: 'Point', coordinates: c[0] } : null
    }
    case 'LineString':
    case 'LinearRing':
      return { type: 'LineString', coordinates: parseCoordText(kid(el, 'coordinates')?.text ?? '') }
    case 'Polygon': {
      const outer = kid(el, 'outerBoundaryIs')
      const ring = (b?: XmlEl) => parseCoordText(b ? descendants(b, 'coordinates')[0]?.text ?? '' : '')
      const rings = [ring(outer), ...kids(el, 'innerBoundaryIs').map(ring)]
      return { type: 'Polygon', coordinates: rings }
    }
    case 'MultiGeometry': {
      const parts = el.children
        .map((c) => kmlGeometry(c, skipped))
        .filter((g): g is GeoJSON.Geometry => !!g)
      if (parts.length === 0) return null
      const t = parts[0].type
      if (parts.every((g) => g.type === t) && (t === 'Point' || t === 'LineString' || t === 'Polygon')) {
        const key = `Multi${t}` as 'MultiPoint' | 'MultiLineString' | 'MultiPolygon'
        return { type: key, coordinates: parts.map((g) => (g as GeoJSON.Polygon).coordinates) } as GeoJSON.Geometry
      }
      return { type: 'GeometryCollection', geometries: parts }
    }
    case 'Track':
    case 'MultiTrack':
      skipped.add('gx:Track')
      return null
    default:
      return null
  }
}

const KML_GEOM = new Set(['Point', 'LineString', 'LinearRing', 'Polygon', 'MultiGeometry', 'Track', 'MultiTrack'])

export function importKML(text: string): ImportResult {
  let root: XmlEl
  try {
    root = parseXml(text)
  } catch (e) {
    throw new VectorImportError('parse', `invalid KML: ${(e as Error).message}`)
  }
  if (root.name !== 'kml' && root.name !== 'Document' && root.name !== 'Placemark') {
    throw new VectorImportError('parse', `not a KML document (root element <${root.name}>)`)
  }
  const placemarks = root.name === 'Placemark' ? [root] : descendants(root, 'Placemark')
  const skipped = new Set<string>()
  const features: GeoJSON.Feature[] = []
  const srcIndex: number[] = []
  const pre: DroppedFeature[] = []
  const warnings: string[] = []
  placemarks.forEach((pm, index) => {
    const props: Record<string, unknown> = {}
    const name = kid(pm, 'name')?.text.trim()
    const desc = kid(pm, 'description')?.text.trim()
    if (name) props.name = name
    if (desc) props.description = desc
    const ext = kid(pm, 'ExtendedData')
    if (ext) {
      for (const d of kids(ext, 'Data')) {
        const k = d.attrs.name
        if (k) props[k] = coerce(kid(d, 'value')?.text ?? '')
      }
      for (const sd of descendants(ext, 'SimpleData')) if (sd.attrs.name) props[sd.attrs.name] = coerce(sd.text)
    }
    const gEl = pm.children.find((c) => KML_GEOM.has(c.name))
    const geometry = gEl ? kmlGeometry(gEl, skipped) : null
    if (!geometry) {
      pre.push({ index, reason: gEl ? `unsupported ${gEl.name}` : 'placemark without geometry' })
      return
    }
    features.push({ type: 'Feature', properties: props, geometry })
    srcIndex.push(index)
  })
  if (descendants(root, 'NetworkLink').length) warnings.push('NetworkLink(s) were not followed (no network access from file import)')
  if (descendants(root, 'GroundOverlay').length) warnings.push('GroundOverlay image(s) are not vector data and were ignored')
  if (skipped.size) warnings.push('gx:Track elements are not supported and were skipped')
  return finish(features, 'kml', 'EPSG:4326 (KML is always WGS84)', warnings, pre, pre.length, srcIndex)
}

export async function importKMZ(buf: ArrayBuffer): Promise<ImportResult> {
  let zip: JSZip
  try {
    zip = await (await loadJsZip()).loadAsync(buf)
  } catch {
    throw new VectorImportError('parse', 'not a readable KMZ (zip) archive')
  }
  const kmls = Object.keys(zip.files).filter((n) => !zip.files[n].dir && /\.kml$/i.test(n))
  if (kmls.length === 0) throw new VectorImportError('parse', 'the KMZ contains no .kml file')
  const main = kmls.find((n) => /(^|\/)doc\.kml$/i.test(n)) ?? kmls[0]
  const text = await zip.files[main].async('string')
  if (text.length > MAX_FILE_BYTES) throw new VectorImportError('too-large', 'KML inside the KMZ is too large when decompressed')
  const r = importKML(text)
  return { ...r, format: 'kmz', warnings: kmls.length > 1 ? [...r.warnings, `KMZ holds ${kmls.length} .kml files; read ${main}`] : r.warnings }
}

export function importGPX(text: string): ImportResult {
  let root: XmlEl
  try {
    root = parseXml(text)
  } catch (e) {
    throw new VectorImportError('parse', `invalid GPX: ${(e as Error).message}`)
  }
  if (root.name !== 'gpx') throw new VectorImportError('parse', `not a GPX document (root element <${root.name}>)`)
  const pt = (e: XmlEl): Pos | null => {
    const lon = Number(e.attrs.lon)
    const lat = Number(e.attrs.lat)
    if (e.attrs.lon === undefined || e.attrs.lat === undefined) return null
    const ele = kid(e, 'ele')?.text.trim()
    return ele !== undefined && ele !== '' && Number.isFinite(Number(ele)) ? [lon, lat, Number(ele)] : [lon, lat]
  }
  const meta = (e: XmlEl) => {
    const p: Record<string, unknown> = {}
    for (const k of ['name', 'desc', 'cmt', 'src', 'type', 'time']) {
      const t = kid(e, k)?.text.trim()
      if (t) p[k] = t
    }
    return p
  }
  const features: GeoJSON.Feature[] = []
  const pre: DroppedFeature[] = []
  const src: number[] = []
  let idx = 0
  const add = (f: GeoJSON.Feature) => {
    features.push(f)
    src.push(idx)
  }
  for (const w of kids(root, 'wpt')) {
    const p = pt(w)
    if (p) add({ type: 'Feature', properties: { ...meta(w), gpxType: 'wpt' }, geometry: { type: 'Point', coordinates: p } })
    else pre.push({ index: idx, reason: 'waypoint without lat/lon' })
    idx++
  }
  for (const r of kids(root, 'rte')) {
    const coords = kids(r, 'rtept').map(pt).filter((p): p is Pos => !!p)
    if (coords.length >= 2) add({ type: 'Feature', properties: { ...meta(r), gpxType: 'rte' }, geometry: { type: 'LineString', coordinates: coords } })
    else pre.push({ index: idx, reason: 'route with fewer than 2 points' })
    idx++
  }
  for (const t of kids(root, 'trk')) {
    const segs = kids(t, 'trkseg')
      .map((s) => kids(s, 'trkpt').map(pt).filter((p): p is Pos => !!p))
      .filter((s) => s.length >= 2)
    if (segs.length === 1) add({ type: 'Feature', properties: { ...meta(t), gpxType: 'trk' }, geometry: { type: 'LineString', coordinates: segs[0] } })
    else if (segs.length > 1) add({ type: 'Feature', properties: { ...meta(t), gpxType: 'trk' }, geometry: { type: 'MultiLineString', coordinates: segs } })
    else pre.push({ index: idx, reason: 'track with no segment of 2+ points' })
    idx++
  }
  return finish(features, 'gpx', 'EPSG:4326 (GPX is always WGS84)', [], pre, pre.length, src)
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** RFC 4180 parser: quoted fields, escaped quotes, embedded newlines, CRLF. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQ = false
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else inQ = false
      } else field += c
    } else if (c === '"' && field === '') inQ = true
    else if (c === delimiter) {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else field += c
  }
  if (inQ) throw new VectorImportError('parse', 'CSV has an unterminated quoted field')
  row.push(field)
  if (row.length > 1 || row[0] !== '') rows.push(row)
  return rows
}

const LAT_NAMES = ['lat', 'latitude', 'lat_deg', 'point_y']
const LON_NAMES = ['lon', 'lng', 'long', 'longitude', 'lon_deg', 'point_x']
const Y_NAMES = ['y', 'ycoord', 'y_coord', 'northing']
const X_NAMES = ['x', 'xcoord', 'x_coord', 'easting']

export function importCSV(text: string, opts: ImportOptions = {}): ImportResult {
  const firstLine = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? ''
  const count = (d: string) => firstLine.split(d).length
  const delimiter = ([',', ';', '\t'] as const).reduce((best, d) => (count(d) > count(best) ? d : best), ',')
  const table = parseCsv(text, delimiter)
  if (table.length < 2) throw new VectorImportError('empty', 'CSV has no data rows')
  const header = table[0].map((h) => h.trim())
  const lower = header.map((h) => h.toLowerCase())
  const find = (names: string[]) => lower.findIndex((h) => names.includes(h))

  let yi = find(LAT_NAMES)
  let xi = find(LON_NAMES)
  let projected = false
  if (yi < 0 || xi < 0) {
    yi = find(Y_NAMES)
    xi = find(X_NAMES)
    projected = true
  }
  if (yi < 0 || xi < 0) {
    throw new VectorImportError('parse', `no coordinate columns found — expected lat/lon (latitude/longitude, lng) or x/y with an EPSG code; columns are: ${header.join(', ')}`)
  }
  const epsg = opts.epsg
  let crs = 'EPSG:4326'
  let convert: ((x: number, y: number) => [number, number]) | null = null
  if (projected && epsg === undefined) {
    throw new VectorImportError('needs-epsg', 'x/y columns need an explicit EPSG code (e.g. 32643 for UTM 43N); lon/lat is not assumed for x/y')
  }
  if (epsg !== undefined) {
    const def = projDefinition(epsg)
    if (def === null) throw new VectorImportError('unsupported-crs', `EPSG:${epsg} is not supported (${SUPPORTED_EPSG_NOTE})`)
    crs = `EPSG:${epsg} -> EPSG:4326`
    if (def !== '') {
      const conv = proj4(def, '+proj=longlat +datum=WGS84 +no_defs')
      convert = (x, y) => conv.forward([x, y]) as [number, number]
    } else crs = 'EPSG:4326'
  }

  const features: GeoJSON.Feature[] = []
  const srcIndex: number[] = []
  const pre: DroppedFeature[] = []
  const rows = table.slice(1)
  rows.forEach((r, i) => {
    const xs = (r[xi] ?? '').trim().replace(',', '.')
    const ys = (r[yi] ?? '').trim().replace(',', '.')
    const x = xs === '' ? NaN : Number(xs)
    const y = ys === '' ? NaN : Number(ys)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      pre.push({ index: i + 1, reason: 'missing or non-numeric coordinate' })
      return
    }
    let pos: [number, number] = [x, y]
    if (convert) {
      try {
        pos = convert(x, y)
      } catch {
        pre.push({ index: i + 1, reason: 'coordinate could not be reprojected' })
        return
      }
    }
    const props: Record<string, unknown> = {}
    header.forEach((h, c) => {
      if (c === xi || c === yi || h === '') return
      const v = r[c] ?? ''
      props[h] = v.trim() === '' ? null : coerce(v)
    })
    features.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: pos } })
    srcIndex.push(i + 1)
  })
  return finish(features, 'csv', crs, [], pre, pre.length, srcIndex)
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function importVectorFile(
  name: string,
  data: ArrayBuffer,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const format = detectFormat(name)
  if (!format) {
    throw new VectorImportError('unsupported-format', `unsupported file type — use GeoJSON, zipped Shapefile, KML/KMZ, GPX or CSV`)
  }
  if (data.byteLength === 0) throw new VectorImportError('empty', 'the file is empty')
  if (data.byteLength > MAX_FILE_BYTES) {
    throw new VectorImportError('too-large', `file is ${(data.byteLength / 1e6).toFixed(0)} MB; the cap is ${MAX_FILE_BYTES / 1024 / 1024} MB`)
  }
  const text = () => new TextDecoder('utf-8').decode(data)
  switch (format) {
    case 'geojson':
      return importGeoJSON(text())
    case 'shapefile':
      return importShapefileZip(data)
    case 'kml':
      return importKML(text())
    case 'kmz':
      return importKMZ(data)
    case 'gpx':
      return importGPX(text())
    case 'csv':
      return importCSV(text(), opts)
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function propKeys(fc: GeoJSON.FeatureCollection): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const f of fc.features) {
    for (const k of Object.keys(f.properties ?? {})) {
      if (!seen.has(k)) {
        seen.add(k)
        keys.push(k)
      }
    }
  }
  return keys
}

function scalarText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function exportGeoJSON(fc: GeoJSON.FeatureCollection): string {
  return JSON.stringify(fc)
}

// -- KML --------------------------------------------------------------------

const xmlName = (s: string) => escapeXml(s)

function kmlCoords(c: Pos[]): string {
  return c.map((p) => p.slice(0, 3).join(',')).join(' ')
}

function kmlPolygon(rings: Pos[][]): string {
  const [outer, ...holes] = rings
  return (
    `<Polygon><outerBoundaryIs><LinearRing><coordinates>${kmlCoords(outer)}</coordinates></LinearRing></outerBoundaryIs>` +
    holes.map((h) => `<innerBoundaryIs><LinearRing><coordinates>${kmlCoords(h)}</coordinates></LinearRing></innerBoundaryIs>`).join('') +
    '</Polygon>'
  )
}

function kmlGeom(g: GeoJSON.Geometry): string {
  switch (g.type) {
    case 'Point':
      return `<Point><coordinates>${kmlCoords([g.coordinates])}</coordinates></Point>`
    case 'LineString':
      return `<LineString><coordinates>${kmlCoords(g.coordinates)}</coordinates></LineString>`
    case 'Polygon':
      return kmlPolygon(g.coordinates)
    case 'MultiPoint':
      return `<MultiGeometry>${g.coordinates.map((p) => kmlGeom({ type: 'Point', coordinates: p })).join('')}</MultiGeometry>`
    case 'MultiLineString':
      return `<MultiGeometry>${g.coordinates.map((l) => kmlGeom({ type: 'LineString', coordinates: l })).join('')}</MultiGeometry>`
    case 'MultiPolygon':
      return `<MultiGeometry>${g.coordinates.map(kmlPolygon).join('')}</MultiGeometry>`
    case 'GeometryCollection':
      return `<MultiGeometry>${g.geometries.map(kmlGeom).join('')}</MultiGeometry>`
  }
}

export function exportKML(fc: GeoJSON.FeatureCollection, docName = 'Export'): string {
  const placemarks = fc.features
    .filter((f) => f.geometry)
    .map((f) => {
      const props = f.properties ?? {}
      const name = typeof props.name === 'string' ? `<name>${escapeXml(props.name)}</name>` : ''
      const data = Object.entries(props)
        .map(([k, v]) => `<Data name="${xmlName(k)}"><value>${escapeXml(scalarText(v))}</value></Data>`)
        .join('')
      return `<Placemark>${name}${data ? `<ExtendedData>${data}</ExtendedData>` : ''}${kmlGeom(f.geometry)}</Placemark>`
    })
    .join('\n')
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
    `<name>${escapeXml(docName)}</name>\n${placemarks}\n</Document></kml>\n`
  )
}

// -- CSV --------------------------------------------------------------------

function csvCell(v: unknown): string {
  let s = scalarText(v)
  // Spreadsheet formula injection: a text cell starting with = + @ (or - that isn't a number)
  // would be executed by Excel/Sheets; neutralise with a leading apostrophe.
  if (typeof v === 'string' && /^[=+@\t\r]/.test(s)) s = `'${s}`
  else if (typeof v === 'string' && /^-/.test(s) && !Number.isFinite(Number(s))) s = `'${s}`
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** CSV with one row per feature: centroid lat/lon, geometry type, then the properties. */
export function exportCSV(fc: GeoJSON.FeatureCollection): string {
  const keys = propKeys(fc).filter((k) => !['lat', 'lon', 'geometry_type'].includes(k.toLowerCase()))
  const lines = [['lat', 'lon', 'geometry_type', ...keys].map(csvCell).join(',')]
  for (const f of fc.features) {
    if (!f.geometry) continue
    let lat = ''
    let lon = ''
    try {
      const [x, y] = turfCentroid(f).geometry.coordinates
      lon = String(x)
      lat = String(y)
    } catch {
      /* leave blank */
    }
    lines.push([lat, lon, f.geometry.type, ...keys.map((k) => (f.properties ?? {})[k])].map(csvCell).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

// -- Shapefile --------------------------------------------------------------

const WGS84_PRJ =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.017453292519943295]]'

/** Shoelace sum; > 0 means counter-clockwise in lon/lat. */
function ringSignedArea(r: Pos[]): number {
  let a = 0
  for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]
  return a / 2
}

/** Shapefile rule: outer rings clockwise, holes counter-clockwise. */
function orientRings(rings: Pos[][]): Pos[][] {
  return rings.map((r, i) => {
    const ccw = ringSignedArea(r) > 0
    const wantCw = i === 0
    return ccw === wantCw ? [...r].reverse() : r
  })
}

interface DbfColumn {
  name: string
  type: 'C' | 'N'
  width: number
  decimals: number
}

const enc8 = new TextEncoder()

function fixedNumber(v: number, decimals: number): string {
  return decimals === 0 ? String(Math.round(v)) : v.toFixed(decimals)
}

/**
 * dBase III table with UTF-8 text (declared by the sibling .cpg). Written here instead of using
 * @mapbox/shp-write's dbf, which writes one byte per UTF-16 unit (corrupting every non-ASCII
 * character), pads every text field to 254 characters and has no per-column numeric precision.
 * A column is numeric only if EVERY feature has a finite number there; otherwise it is text, so
 * no zero or other value is invented for missing data.
 */
function buildDbf(feats: GeoJSON.Feature[], keys: string[], warnings: string[]): Uint8Array {
  const used = new Set<string>()
  const cols: DbfColumn[] = keys.map((k) => {
    const base = (k.replace(/[^A-Za-z0-9_]/g, '_') || 'f').slice(0, 10)
    let name = base
    for (let i = 1; used.has(name.toUpperCase()); i++) name = base.slice(0, 10 - String(i).length) + i
    used.add(name.toUpperCase())
    const vals = feats.map((f) => (f.properties ?? {})[k])
    if (vals.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      const nums = vals as number[]
      let decimals = 0
      for (const v of nums) {
        if (Number.isInteger(v)) continue
        const intDigits = Math.max(1, Math.floor(Math.abs(v)).toString().length)
        const room = Math.min(15, 18 - intDigits - (v < 0 ? 1 : 0))
        const t = v.toFixed(Math.max(room, 1)).replace(/0+$/, '')
        decimals = Math.max(decimals, Math.max(t.length - t.indexOf('.') - 1, 1))
      }
      return { name, type: 'N' as const, width: 20, decimals }
    }
    return { name, type: 'C' as const, width: 1, decimals: 0 }
  })
  const texts = feats.map((f) =>
    cols.map((c, i) => {
      const v = (f.properties ?? {})[keys[i]]
      if (c.type === 'N') return enc8.encode(fixedNumber(v as number, c.decimals).padStart(c.width, ' '))
      let bytes = enc8.encode(scalarText(v))
      if (bytes.length > 254) {
        // cut on a character boundary
        let end = 254
        while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
        bytes = bytes.slice(0, end)
        if (!warnings.some((w) => w.startsWith('text values'))) warnings.push('text values longer than 254 bytes were truncated (dBase limit)')
      }
      if (bytes.length > c.width) c.width = bytes.length
      return bytes
    }),
  )
  cols.forEach((c) => {
    if (c.type === 'C' && c.width < 1) c.width = 1
  })
  const headerLen = 32 + 32 * cols.length + 1
  const recLen = 1 + cols.reduce((n, c) => n + c.width, 0)
  const out = new Uint8Array(headerLen + recLen * feats.length + 1)
  const dv = new DataView(out.buffer)
  const now = new Date()
  out[0] = 0x03
  out[1] = now.getFullYear() - 1900
  out[2] = now.getMonth() + 1
  out[3] = now.getDate()
  dv.setUint32(4, feats.length, true)
  dv.setUint16(8, headerLen, true)
  dv.setUint16(10, recLen, true)
  cols.forEach((c, i) => {
    const o = 32 + i * 32
    out.set(enc8.encode(c.name), o)
    out[o + 11] = c.type.charCodeAt(0)
    out[o + 16] = c.width
    out[o + 17] = c.decimals
  })
  out[headerLen - 1] = 0x0d
  let o = headerLen
  texts.forEach((row) => {
    out[o++] = 0x20
    row.forEach((bytes, i) => {
      out.fill(0x20, o, o + cols[i].width)
      out.set(bytes, o)
      o += cols[i].width
    })
  })
  out[o] = 0x1a
  return out
}

export interface ShapefileExport {
  zip: Uint8Array
  /** Files written, e.g. ["name_polygons.shp", ...]. */
  files: string[]
  warnings: string[]
}

/**
 * Zipped shapefile set. A shapefile holds ONE geometry type, so features are split into
 * `<base>_points`, `<base>_lines` and `<base>_polygons`, each with .shp/.shx/.dbf/.prj/.cpg.
 * (@mapbox/shp-write's own zip() is not used: it names Polygon and MultiPolygon output the same
 * file so one overwrites the other, and it merges all lines into a single record.)
 */
export async function exportShapefile(fc: GeoJSON.FeatureCollection, baseName = 'export', prj: string = WGS84_PRJ): Promise<ShapefileExport> {
  const base = baseName.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'export'
  const warnings: string[] = []
  const pts: GeoJSON.Feature[] = []
  const lines: GeoJSON.Feature[] = []
  const polys: GeoJSON.Feature[] = []
  const flat = (f: GeoJSON.Feature): GeoJSON.Feature[] =>
    f.geometry?.type === 'GeometryCollection'
      ? f.geometry.geometries.map((g) => ({ ...f, geometry: g }))
      : f.geometry
        ? [f]
        : []
  let exploded = false
  for (const f0 of fc.features) {
    for (const f of flat(f0)) {
      switch (f.geometry.type) {
        case 'Point':
          pts.push(f)
          break
        case 'MultiPoint':
          exploded = true
          f.geometry.coordinates.forEach((c) => pts.push({ ...f, geometry: { type: 'Point', coordinates: c } }))
          break
        case 'LineString':
        case 'MultiLineString':
          lines.push(f)
          break
        case 'Polygon':
        case 'MultiPolygon':
          polys.push(f)
          break
      }
    }
  }
  if (exploded) warnings.push('MultiPoint features were split into one point record each')
  if (fc.features.some((f) => f.geometry?.type === 'GeometryCollection')) warnings.push('GeometryCollections were split by member geometry')
  const keys = propKeys(fc)
  const { write: shpWrite } = await import('@mapbox/shp-write')
  const zip = new (await loadJsZip())()
  const files: string[] = []

  const emit = (suffix: string, type: 'POINT' | 'POLYLINE' | 'POLYGON', feats: GeoJSON.Feature[], geoms: unknown[]) => {
    if (!feats.length) return
    const dbf = buildDbf(feats, keys, warnings)
    shpWrite([], type, geoms as object[], (err, out) => {
      if (err) throw err
      const stem = `${base}_${suffix}`
      zip.file(`${stem}.shp`, out.shp.buffer, { binary: true })
      zip.file(`${stem}.shx`, out.shx.buffer, { binary: true })
      zip.file(`${stem}.dbf`, dbf, { binary: true })
      zip.file(`${stem}.prj`, prj)
      zip.file(`${stem}.cpg`, 'UTF-8')
      files.push(`${stem}.shp`)
    })
  }
  emit('points', 'POINT', pts, pts.map((f) => (f.geometry as GeoJSON.Point).coordinates.slice(0, 2)))
  emit(
    'lines',
    'POLYLINE',
    lines,
    lines.map((f) => (f.geometry.type === 'LineString' ? [f.geometry.coordinates] : (f.geometry as GeoJSON.MultiLineString).coordinates)),
  )
  emit(
    'polygons',
    'POLYGON',
    polys,
    polys.map((f) =>
      f.geometry.type === 'Polygon'
        ? orientRings(f.geometry.coordinates)
        : (f.geometry as GeoJSON.MultiPolygon).coordinates.flatMap(orientRings),
    ),
  )
  if (files.length === 0) throw new Error('nothing to export: the layer has no geometries')
  const maxName = Math.max(...keys.map((k) => k.length), 0)
  if (maxName > 10) warnings.push('shapefile field names are limited to 10 characters; longer property names were truncated')
  const out = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return { zip: out, files, warnings }
}

// ---------------------------------------------------------------------------
// Export dispatcher
// ---------------------------------------------------------------------------

export const EXPORT_FORMATS: Record<ExportFormat, { label: string; ext: string; mime: string }> = {
  geojson: { label: 'GeoJSON', ext: 'geojson', mime: 'application/geo+json' },
  shapefile: { label: 'Shapefile (zip)', ext: 'zip', mime: 'application/zip' },
  kml: { label: 'KML', ext: 'kml', mime: 'application/vnd.google-earth.kml+xml' },
  csv: { label: 'CSV (centroids)', ext: 'csv', mime: 'text/csv' },
}

export async function exportVector(
  fc: GeoJSON.FeatureCollection,
  format: ExportFormat,
  name: string,
  /** `prj` replaces the WGS 84 `.prj` when the coordinates were reprojected first (see export-crs). */
  opts: { prj?: string } = {},
): Promise<{ data: Uint8Array | string; filename: string; mime: string; warnings: string[] }> {
  const base = name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60) || 'layer'
  const meta = EXPORT_FORMATS[format]
  const filename = `${base}.${meta.ext}`
  switch (format) {
    case 'geojson':
      return { data: exportGeoJSON(fc), filename, mime: meta.mime, warnings: [] }
    case 'kml':
      return { data: exportKML(fc, name), filename, mime: meta.mime, warnings: [] }
    case 'csv':
      return { data: exportCSV(fc), filename, mime: meta.mime, warnings: [] }
    case 'shapefile': {
      const s = await exportShapefile(fc, base, opts.prj)
      return { data: s.zip, filename, mime: meta.mime, warnings: s.warnings }
    }
  }
}

// ---------------------------------------------------------------------------
// AOI from a vector layer
// ---------------------------------------------------------------------------

export interface AoiCandidate {
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
  areaKm2: number
  centerLonLat: [number, number]
  /** How the geometry was derived, to show the user. */
  method: 'single polygon' | 'union' | 'bounding box'
  note?: string
}

/**
 * Turn the polygons of a layer into one AOI geometry: the polygon itself when there is one,
 * else their union; falls back to the bounding box (stated) if the union fails or `mode` asks.
 */
export function aoiFromCollection(fc: GeoJSON.FeatureCollection, mode: 'union' | 'bbox' = 'union'): AoiCandidate {
  const polys = fc.features.filter(
    (f): f is GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> =>
      f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon',
  )
  if (polys.length === 0) throw new Error('this layer has no polygons to use as an area of interest')
  let geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
  let method: AoiCandidate['method']
  let note: string | undefined
  if (polys.length === 1) {
    geometry = polys[0].geometry
    method = 'single polygon'
  } else if (mode === 'union') {
    try {
      const u = turfUnion(featureCollection(polys))
      if (!u) throw new Error('empty union')
      geometry = u.geometry
      method = 'union'
      note = `union of ${polys.length} polygons`
    } catch {
      geometry = bboxPolygon(turfBbox(featureCollection(polys))).geometry
      method = 'bounding box'
      note = `union failed; used the bounding box of ${polys.length} polygons`
    }
  } else {
    geometry = bboxPolygon(turfBbox(featureCollection(polys))).geometry
    method = 'bounding box'
    note = `bounding box of ${polys.length} polygons`
  }
  const feat: GeoJSON.Feature = { type: 'Feature', properties: {}, geometry }
  const areaKm2 = turfArea(feat) / 1e6
  const [lng, lat] = turfCentroid(feat).geometry.coordinates
  return { geometry, areaKm2, centerLonLat: [lng, lat], method, note }
}

/** [minX, minY, maxX, maxY] of a collection. */
export function collectionBounds(fc: GeoJSON.FeatureCollection): [number, number, number, number] {
  const b = turfBbox(fc)
  return [b[0], b[1], b[2], b[3]]
}
