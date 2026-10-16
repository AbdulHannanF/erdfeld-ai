import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import proj4 from 'proj4'
import { write as shpWrite } from '@mapbox/shp-write'
import {
  MAX_FEATURES,
  VectorImportError,
  aoiFromCollection,
  detectFormat,
  exportCSV,
  exportGeoJSON,
  exportKML,
  exportShapefile,
  exportVector,
  importCSV,
  importGPX,
  importGeoJSON,
  importKML,
  importKMZ,
  importShapefileZip,
  importVectorFile,
  parseCsv,
} from '@/lib/vector-io'
import { parseXml } from '@/lib/xml-lite'

const poly = (x: number, y: number, d = 0.01): GeoJSON.Polygon => ({
  type: 'Polygon',
  coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]],
})
const sample: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'Plot <A> & "B"', crop: 'rice', ha: 1.5 }, geometry: poly(72.5, 12.5) },
    {
      type: 'Feature',
      properties: { name: 'Plot C', crop: 'ragi', ha: 2 },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [[[73, 12], [73.1, 12], [73.1, 12.1], [73, 12.1], [73, 12]], [[73.02, 12.02], [73.02, 12.04], [73.04, 12.04], [73.04, 12.02], [73.02, 12.02]]],
        ],
      },
    },
    { type: 'Feature', properties: { name: 'Road', crop: null, ha: 3 }, geometry: { type: 'LineString', coordinates: [[72, 12], [72.5, 12.5]] } },
    { type: 'Feature', properties: { name: 'Road2', crop: 'x', ha: 4 }, geometry: { type: 'LineString', coordinates: [[73, 12], [73.5, 12.5]] } },
    { type: 'Feature', properties: { name: 'Well ü', crop: 'y', ha: 5 }, geometry: { type: 'Point', coordinates: [72.25, 12.75] } },
  ],
}

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer
const toAB = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer

function coordsClose(a: unknown, b: unknown, tol = 1e-6): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tol
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => coordsClose(x, b[i], tol))
  return false
}

describe('detectFormat', () => {
  it('maps extensions', () => {
    expect(detectFormat('a.GeoJSON')).toBe('geojson')
    expect(detectFormat('a.zip')).toBe('shapefile')
    expect(detectFormat('a.kmz')).toBe('kmz')
    expect(detectFormat('a.gpx')).toBe('gpx')
    expect(detectFormat('a.csv')).toBe('csv')
    expect(detectFormat('a.tif')).toBeNull()
  })
})

describe('GeoJSON import', () => {
  it('reads FeatureCollection, Feature and bare Geometry', () => {
    expect(importGeoJSON(JSON.stringify(sample)).keptCount).toBe(5)
    expect(importGeoJSON(JSON.stringify(sample.features[0])).keptCount).toBe(1)
    expect(importGeoJSON(JSON.stringify(poly(1, 1))).fc.features[0].geometry.type).toBe('Polygon')
  })
  it('drops invalid features and reports why', () => {
    const r = importGeoJSON(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [200, 10] } },
          { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [10, 95] } },
          { type: 'Feature', properties: {}, geometry: null },
          { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[1, 1]] } },
          { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] } },
          { type: 'Feature', properties: { ok: 1 }, geometry: { type: 'Point', coordinates: [10, 10] } },
        ],
      }),
    )
    expect(r.keptCount).toBe(1)
    expect(r.dropped).toHaveLength(5)
    expect(r.dropped.map((d) => d.reason).join('|')).toMatch(/longitude 200/)
    expect(r.dropped.map((d) => d.reason).join('|')).toMatch(/not closed/)
    expect(r.warnings.join(' ')).toMatch(/5 of 6 features dropped/)
  })
  it('flags (does not repair) self-intersecting polygons', () => {
    const bow: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]] }
    const r = importGeoJSON(JSON.stringify(bow))
    expect(r.keptCount).toBe(1)
    expect(r.selfIntersecting).toBe(1)
    expect(r.warnings.join(' ')).toMatch(/self-intersect/)
  })
  it('explodes GeometryCollections', () => {
    const gc = { type: 'Feature', properties: { a: 1 }, geometry: { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [1, 2] }, poly(0, 0)] } }
    expect(importGeoJSON(JSON.stringify(gc)).keptCount).toBe(2)
  })
  it('refuses non-WGS84 crs members, non-GeoJSON and bad JSON', () => {
    const fc = { type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32643' } }, features: [] }
    expect(() => importGeoJSON(JSON.stringify(fc))).toThrow(/WGS84 only/)
    expect(() => importGeoJSON('{"a":1}')).toThrow(/not GeoJSON/)
    expect(() => importGeoJSON('{nope')).toThrow(/not valid JSON/)
    expect(() => importGeoJSON('{"type":"FeatureCollection","features":[]}')).toThrow(/no features/)
  })
  it('accepts the CRS84 crs name', () => {
    const fc = { type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } }, features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 1] } }] }
    expect(importGeoJSON(JSON.stringify(fc)).crs).toBe('EPSG:4326')
  })
  it('refuses more than the feature cap instead of truncating', () => {
    const features = Array.from({ length: MAX_FEATURES + 1 }, (_, i) => ({ type: 'Feature', properties: { i }, geometry: { type: 'Point', coordinates: [i % 100, 1] } }))
    try {
      importGeoJSON(JSON.stringify({ type: 'FeatureCollection', features }))
      expect.unreachable()
    } catch (e) {
      expect((e as VectorImportError).code).toBe('too-many-features')
    }
  })
  it('importVectorFile enforces the file size cap and unknown formats', async () => {
    await expect(importVectorFile('a.tif', enc('x'))).rejects.toMatchObject({ code: 'unsupported-format' })
    await expect(importVectorFile('a.geojson', new ArrayBuffer(0))).rejects.toMatchObject({ code: 'empty' })
    await expect(importVectorFile('a.geojson', { byteLength: 60 * 1024 * 1024 } as ArrayBuffer)).rejects.toMatchObject({ code: 'too-large' })
  })
})

describe('GeoJSON export', () => {
  it('round-trips exactly', () => {
    const back = importGeoJSON(exportGeoJSON(sample))
    expect(back.fc.features.map((f) => f.geometry)).toEqual(sample.features.map((f) => f.geometry))
    expect(back.fc.features.map((f) => f.properties)).toEqual(sample.features.map((f) => f.properties))
  })
})

describe('XML reader', () => {
  it('handles entities, CDATA, comments, prefixes and refuses custom entities / malformed input', () => {
    const el = parseXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "boom">]><a xmlns:g="u"><!-- c --><g:b k="1 &amp; 2">&lt;&#65;&e;<![CDATA[<raw>]]></g:b></a>')
    expect(el.children[0].name).toBe('b')
    expect(el.children[0].attrs.k).toBe('1 & 2')
    expect(el.children[0].text).toBe('<A&e;<raw>')
    expect(() => parseXml('<a><b></a>')).toThrow()
    expect(() => parseXml('<a>')).toThrow()
    expect(() => parseXml('')).toThrow()
  })
})

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><name>t</name>
<Folder><Placemark><name>Farm &amp; Co</name><description><![CDATA[<b>hi</b>]]></description>
<ExtendedData><Data name="crop"><value>rice</value></Data><Data name="ha"><value>1.5</value></Data>
<SchemaData><SimpleData name="x">7</SimpleData></SchemaData></ExtendedData>
<Polygon><outerBoundaryIs><LinearRing><coordinates>72.5,12.5,0 72.51,12.5,0 72.51,12.51,0 72.5,12.5,0</coordinates></LinearRing></outerBoundaryIs>
<innerBoundaryIs><LinearRing><coordinates>72.502,12.502 72.504,12.502 72.504,12.504 72.502,12.502</coordinates></LinearRing></innerBoundaryIs></Polygon></Placemark>
<Placemark><name>pt</name><Point><coordinates>73.1,12.2</coordinates></Point></Placemark>
<Placemark><name>multi</name><MultiGeometry><Point><coordinates>1,2</coordinates></Point><Point><coordinates>3,4</coordinates></Point></MultiGeometry></Placemark>
<Placemark><name>mixed</name><MultiGeometry><Point><coordinates>1,2</coordinates></Point><LineString><coordinates>0,0 1,1</coordinates></LineString></MultiGeometry></Placemark>
<Placemark><name>nogeom</name></Placemark>
<Placemark><name>bad</name><Point><coordinates>999,2</coordinates></Point></Placemark>
</Folder><NetworkLink><Link><href>http://x</href></Link></NetworkLink></Document></kml>`

describe('KML / KMZ import', () => {
  it('parses placemarks, ExtendedData, holes, multi-geometries; reports drops and caveats', () => {
    const r = importKML(KML)
    const byName = Object.fromEntries(r.fc.features.map((f) => [f.properties!.name, f]))
    expect(byName['Farm & Co'].properties).toMatchObject({ crop: 'rice', ha: 1.5, x: 7, description: '<b>hi</b>' })
    expect((byName['Farm & Co'].geometry as GeoJSON.Polygon).coordinates).toHaveLength(2)
    expect(byName.pt.geometry).toEqual({ type: 'Point', coordinates: [73.1, 12.2] })
    expect(byName.multi.geometry.type).toBe('MultiPoint')
    // mixed MultiGeometry is exploded into its members
    expect(r.fc.features.filter((f) => f.properties!.name === 'mixed')).toHaveLength(2)
    expect(r.dropped.map((d) => d.reason)).toEqual(expect.arrayContaining(['placemark without geometry', expect.stringMatching(/longitude 999/)]))
    expect(r.warnings.join(' ')).toMatch(/NetworkLink/)
  })
  it('rejects non-KML', () => {
    expect(() => importKML('<html/>')).toThrow(/not a KML/)
    expect(() => importKML('<kml><Placemark>')).toThrow(/invalid KML/)
  })
  it('reads a KMZ (zip with doc.kml)', async () => {
    const z = new JSZip()
    z.file('doc.kml', KML)
    z.file('icon.png', 'x')
    const r = await importKMZ(toAB(await z.generateAsync({ type: 'uint8array' })))
    expect(r.format).toBe('kmz')
    expect(r.keptCount).toBeGreaterThan(3)
    await expect(importKMZ(toAB(await new JSZip().file('a.txt', 'x').generateAsync({ type: 'uint8array' })))).rejects.toThrow(/no .kml/)
    await expect(importKMZ(enc('not a zip'))).rejects.toThrow(/not a readable/)
  })
})

describe('KML export', () => {
  const kml = exportKML(sample, 'My <layer>')
  it('is well-formed XML with escaped content', () => {
    expect(kml).toContain('<name>My &lt;layer&gt;</name>')
    expect(kml).toContain('Plot &lt;A&gt; &amp; &quot;B&quot;')
    expect(() => parseXml(kml)).not.toThrow()
  })
  it('strips characters that are illegal in XML', () => {
    const k = exportKML({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'a\u0001b' }, geometry: { type: 'Point', coordinates: [1, 2] } }] })
    expect(k).toContain('<name>ab</name>')
    expect(() => parseXml(k)).not.toThrow()
  })
  it('round-trips geometry and properties', () => {
    const back = importKML(kml)
    expect(back.keptCount).toBe(sample.features.length)
    back.fc.features.forEach((f, i) => {
      const o = sample.features[i]
      expect(f.geometry.type).toBe(o.geometry.type)
      expect(coordsClose((f.geometry as GeoJSON.Polygon).coordinates, (o.geometry as GeoJSON.Polygon).coordinates)).toBe(true)
      expect(f.properties!.name).toBe(o.properties!.name)
      expect(f.properties!.ha).toBe(o.properties!.ha)
    })
  })
})

describe('GPX import', () => {
  const GPX = `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="12.5" lon="72.5"><ele>100.5</ele><name>Camp</name></wpt>
  <wpt lon="1"><name>no lat</name></wpt>
  <rte><name>R</name><rtept lat="1" lon="1"/><rtept lat="2" lon="2"/></rte>
  <trk><name>T</name><trkseg><trkpt lat="3" lon="3"/><trkpt lat="3.1" lon="3.1"/></trkseg><trkseg><trkpt lat="4" lon="4"/><trkpt lat="4.1" lon="4.1"/></trkseg></trk>
  <trk><name>single</name><trkseg><trkpt lat="3" lon="3"/></trkseg></trk></gpx>`
  it('reads waypoints, routes and tracks', () => {
    const r = importGPX(GPX)
    const g = (n: string) => r.fc.features.find((f) => f.properties!.name === n)!.geometry
    expect(g('Camp')).toEqual({ type: 'Point', coordinates: [72.5, 12.5, 100.5] })
    expect(g('R').type).toBe('LineString')
    expect(g('T').type).toBe('MultiLineString')
    expect(r.keptCount).toBe(3)
    expect(r.dropped).toHaveLength(2)
  })
  it('rejects non-GPX', () => expect(() => importGPX('<kml/>')).toThrow(/not a GPX/))
})

describe('CSV import', () => {
  it('parses RFC 4180 quoting', () => {
    expect(parseCsv('a,b\r\n"x,1","he said ""hi""\nnext"\r\n', ',')).toEqual([['a', 'b'], ['x,1', 'he said "hi"\nnext']])
    expect(() => parseCsv('a\n"open', ',')).toThrow(/unterminated/)
  })
  it('reads lat/lon columns, coerces numbers, reports bad rows', () => {
    const r = importCSV('name,Latitude,Longitude,ha\nA,12.5,72.5,1.5\nB,,72.6,2\nC,95,72.7,3\nD,12.7,72.8,\n')
    expect(r.keptCount).toBe(2)
    expect(r.fc.features[0].properties).toEqual({ name: 'A', ha: 1.5 })
    expect(r.fc.features[1].properties!.ha).toBeNull()
    expect(r.dropped.map((d) => d.index).sort()).toEqual([2, 3])
  })
  it('handles semicolons and decimal commas', () => {
    const r = importCSV('id;lat;lon\n1;12,5;72,5\n')
    expect(r.fc.features[0].geometry).toEqual({ type: 'Point', coordinates: [72.5, 12.5] })
  })
  it('reprojects x/y from EPSG:32643 to within 1e-6 degrees', () => {
    const lon = 72.8777
    const lat = 19.076
    const [e, n] = proj4('+proj=utm +zone=43 +datum=WGS84 +units=m +no_defs').forward([lon, lat])
    const r = importCSV(`id,x,y\n1,${e},${n}\n`, { epsg: 32643 })
    const c = (r.fc.features[0].geometry as GeoJSON.Point).coordinates
    expect(Math.abs(c[0] - lon)).toBeLessThan(1e-6)
    expect(Math.abs(c[1] - lat)).toBeLessThan(1e-6)
    expect(r.crs).toMatch(/32643/)
  })
  it('does not guess a CRS for x/y or unknown EPSG codes', () => {
    expect(() => importCSV('x,y\n1,2\n')).toThrow(VectorImportError)
    try {
      importCSV('x,y\n1,2\n')
    } catch (e) {
      expect((e as VectorImportError).code).toBe('needs-epsg')
    }
    expect(() => importCSV('x,y\n1,2\n', { epsg: 27700 })).toThrow(/not supported/)
    expect(() => importCSV('a,b\n1,2\n')).toThrow(/no coordinate columns/)
    expect(() => importCSV('lat,lon\n')).toThrow(/no data rows/)
  })
  it('rejects projected values wrongly treated as lon/lat (all rows dropped)', () => {
    expect(() => importCSV('lat,lon\n2100000,300000\n')).toThrow(/none of the 1 features is usable/)
  })
})

describe('CSV export', () => {
  it('writes centroid lat/lon, geometry type and properties; escapes; neutralises formulas', () => {
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { name: 'a,"b"', note: '=SUM(A1)', n: 2 }, geometry: { type: 'Point', coordinates: [10, 20] } },
        { type: 'Feature', properties: { name: 'sq', n: -3 }, geometry: poly(0, 0, 2) },
      ],
    }
    const csv = exportCSV(fc)
    const t = parseCsv(csv, ',')
    expect(t[0]).toEqual(['lat', 'lon', 'geometry_type', 'name', 'note', 'n'])
    expect(t[1]).toEqual(['20', '10', 'Point', 'a,"b"', "'=SUM(A1)", '2'])
    expect(Number(t[2][0])).toBeCloseTo(1, 6)
    expect(Number(t[2][1])).toBeCloseTo(1, 6)
    expect(t[2][5]).toBe('-3')
  })
  it('round-trips point layers through importCSV', () => {
    const pts: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { name: 'w', ha: 1.25 }, geometry: { type: 'Point', coordinates: [72.123456, 12.654321] } }],
    }
    const back = importCSV(exportCSV(pts))
    expect(coordsClose((back.fc.features[0].geometry as GeoJSON.Point).coordinates, [72.123456, 12.654321])).toBe(true)
    expect(back.fc.features[0].properties).toMatchObject({ name: 'w', ha: 1.25, geometry_type: 'Point' })
  })
})

describe('Shapefile export + import', () => {
  it('splits by geometry type, keeps Polygon and MultiPolygon, writes .prj', async () => {
    const s = await exportShapefile(sample, 'farm')
    expect(s.files.sort()).toEqual(['farm_lines.shp', 'farm_points.shp', 'farm_polygons.shp'])
    const z = await JSZip.loadAsync(s.zip)
    for (const stem of ['farm_points', 'farm_lines', 'farm_polygons']) {
      for (const ext of ['shp', 'shx', 'dbf', 'prj', 'cpg']) expect(z.file(`${stem}.${ext}`), `${stem}.${ext}`).not.toBeNull()
    }
    expect(await z.file('farm_polygons.prj')!.async('string')).toMatch(/GCS_WGS_1984/)
  })
  it('round-trips features, geometry and attributes', async () => {
    const s = await exportShapefile(sample, 'farm')
    const back = await importShapefileZip(toAB(s.zip))
    expect(back.keptCount).toBe(5)
    expect(back.crs).toMatch(/\.prj/)
    const byName = Object.fromEntries(back.fc.features.map((f) => [f.properties!.name, f]))
    // polygon ring orientation is shapefile-native, so compare areas and vertex sets
    expect(Object.keys(byName).sort()).toEqual(['Plot <A> & "B"', 'Plot C', 'Road', 'Road2', 'Well ü'].sort())
    expect(byName['Road2'].geometry).toMatchObject({ type: 'LineString' })
    expect(coordsClose((byName['Road2'].geometry as GeoJSON.LineString).coordinates, [[73, 12], [73.5, 12.5]])).toBe(true)
    expect(coordsClose((byName['Well ü'].geometry as GeoJSON.Point).coordinates, [72.25, 12.75])).toBe(true)
    expect(byName['Well ü'].properties).toMatchObject({ crop: 'y', ha: 5 })
    const c = byName['Plot C'].geometry
    expect(c.type === 'Polygon' || c.type === 'MultiPolygon').toBe(true)
    const rings = c.type === 'Polygon' ? c.coordinates : (c as GeoJSON.MultiPolygon).coordinates.flat()
    expect(rings).toHaveLength(2) // outer + hole survive
    expect(byName['Road'].properties!.crop).toBe('') // null -> empty text, not an invented value
  })
  it('splits MultiPoint and reports it', async () => {
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { a: 1 }, geometry: { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] } }] }
    const s = await exportShapefile(fc, 'mp')
    expect(s.warnings.join(' ')).toMatch(/MultiPoint/)
    expect((await importShapefileZip(toAB(s.zip))).keptCount).toBe(2)
  })
  it('refuses an empty export', async () => {
    await expect(exportShapefile({ type: 'FeatureCollection', features: [] })).rejects.toThrow(/nothing to export/)
  })
})

// --- Shapefile import: reprojection from .prj, and no-.prj handling ---------
const UTM43_PRJ =
  'PROJCS["WGS_1984_UTM_Zone_43N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",75.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]'

async function pointShapefileZip(coords: number[][], prj?: string): Promise<ArrayBuffer> {
  const zip = new JSZip()
  shpWrite(coords.map((_, i) => ({ id: i + 1 })) as unknown as object[], 'POINT', coords as unknown as object[], (err, out) => {
    if (err) throw err
    zip.file('pts.shp', out.shp.buffer, { binary: true })
    zip.file('pts.shx', out.shx.buffer, { binary: true })
    zip.file('pts.dbf', out.dbf.buffer, { binary: true })
    if (prj) zip.file('pts.prj', prj)
  })
  return toAB(await zip.generateAsync({ type: 'uint8array' }))
}

describe('Shapefile import CRS handling', () => {
  it('reprojects a UTM 43N shapefile to WGS84 via its .prj (within 1e-6 deg)', async () => {
    const lon = 72.8777
    const lat = 19.076
    const [e, n] = proj4('+proj=utm +zone=43 +datum=WGS84 +units=m +no_defs').forward([lon, lat])
    const r = await importShapefileZip(await pointShapefileZip([[e, n]], UTM43_PRJ))
    const c = (r.fc.features[0].geometry as GeoJSON.Point).coordinates
    expect(Math.abs(c[0] - lon)).toBeLessThan(1e-6)
    expect(Math.abs(c[1] - lat)).toBeLessThan(1e-6)
  })
  it('accepts a missing .prj only when coordinates are plainly lon/lat, and says so', async () => {
    const r = await importShapefileZip(await pointShapefileZip([[72.5, 12.5]]))
    expect(r.crs).toMatch(/assumed/)
    expect(r.warnings.join(' ')).toMatch(/no \.prj/)
  })
  it('refuses a missing .prj with projected-looking coordinates', async () => {
    await expect(importShapefileZip(await pointShapefileZip([[500000, 2100000]]))).rejects.toMatchObject({ code: 'no-crs' })
  })
  it('refuses a zip with no .shp and a non-zip', async () => {
    const z = toAB(await new JSZip().file('a.txt', 'x').generateAsync({ type: 'uint8array' }))
    await expect(importShapefileZip(z)).rejects.toThrow(/no \.shp/)
    await expect(importShapefileZip(enc('nope'))).rejects.toThrow(/not a readable zip/)
  })
})

describe('exportVector', () => {
  it('produces named files for every format', async () => {
    for (const f of ['geojson', 'shapefile', 'kml', 'csv'] as const) {
      const r = await exportVector(sample, f, 'My layer!')
      expect(r.filename.startsWith('My_layer_.')).toBe(true)
      expect(r.data.length).toBeGreaterThan(10)
    }
  })
})

describe('aoiFromCollection', () => {
  it('uses a single polygon as is', () => {
    const a = aoiFromCollection({ type: 'FeatureCollection', features: [sample.features[0]] })
    expect(a.method).toBe('single polygon')
    expect(a.areaKm2).toBeGreaterThan(0.5)
  })
  it('unions several polygons and can fall back to a bounding box', () => {
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [poly(0, 0), poly(0.005, 0), poly(1, 1)].map((g) => ({ type: 'Feature', properties: {}, geometry: g })),
    }
    const u = aoiFromCollection(fc)
    expect(u.method).toBe('union')
    expect(u.geometry.type).toBe('MultiPolygon')
    const b = aoiFromCollection(fc, 'bbox')
    expect(b.method).toBe('bounding box')
    expect(b.areaKm2).toBeGreaterThan(u.areaKm2)
  })
  it('refuses layers without polygons', () => {
    expect(() => aoiFromCollection({ type: 'FeatureCollection', features: [sample.features[2]] })).toThrow(/no polygons/)
  })
})

// --- Committed fixtures (real files, as a user would supply them) -------------
const FIX = path.join(__dirname, '__fixtures__')
const fixBuf = (n: string) => {
  const b = readFileSync(path.join(FIX, n))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

describe('committed fixtures through importVectorFile', () => {
  it('sample.kml', async () => {
    const r = await importVectorFile('sample.kml', fixBuf('sample.kml'))
    expect(r.keptCount).toBeGreaterThan(3)
  })
  it('sample.gpx', async () => {
    expect((await importVectorFile('sample.gpx', fixBuf('sample.gpx'))).keptCount).toBe(3)
  })
  it('utm43.csv in EPSG:32643 lands on the expected lon/lat within 1e-6 deg', async () => {
    const expected = JSON.parse(readFileSync(path.join(FIX, 'utm43.expected.json'), 'utf8')) as number[][]
    const r = await importVectorFile('utm43.csv', fixBuf('utm43.csv'), { epsg: 32643 })
    r.fc.features.forEach((f, i) => {
      const c = (f.geometry as GeoJSON.Point).coordinates
      // the fixture's metres are rounded to 1 mm, which is ~1e-8 deg
      expect(Math.abs(c[0] - expected[i][0])).toBeLessThan(1e-6)
      expect(Math.abs(c[1] - expected[i][1])).toBeLessThan(1e-6)
    })
  })
  it('sample-shp.zip (written by exportShapefile) imports back', async () => {
    const f = path.join(FIX, 'sample-shp.zip')
    if (!existsSync(f)) writeFileSync(f, (await exportShapefile(sample, 'farm')).zip)
    const r = await importVectorFile('sample-shp.zip', fixBuf('sample-shp.zip'))
    expect(r.keptCount).toBe(5)
  })
})
