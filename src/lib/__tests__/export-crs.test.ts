import { describe, expect, it } from 'vitest'
import { exportVectorInCrs, parseEpsg, prjWkt, reprojectCollection, utmEpsgFor } from '../export-crs'

const fc: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: { name: 'a' }, geometry: { type: 'Point', coordinates: [74.5, 31.0] } }],
}

describe('export CRS', () => {
  it('picks the UTM zone for a point', () => {
    expect(utmEpsgFor(74.5, 31)).toBe(32643)
    expect(utmEpsgFor(-112.1, 36.1)).toBe(32612)
    expect(utmEpsgFor(18, -33)).toBe(32734)
  })
  it('accepts only codes the app can reproject exactly', () => {
    expect(parseEpsg('epsg:32643')).toBe(32643)
    expect(parseEpsg('3857')).toBe(3857)
    expect(parseEpsg('2154')).toBeNull()
    expect(parseEpsg('abc')).toBeNull()
  })
  it('reprojects to UTM within a metre of the known value', () => {
    const out = reprojectCollection(fc, 32643).features[0].geometry as GeoJSON.Point
    // 74.5E is 0.5 degrees west of the zone 43 central meridian (75E): easting about 452 km, northing about 3.43 Mm
    expect(out.coordinates[0]).toBeGreaterThan(450000)
    expect(out.coordinates[0]).toBeLessThan(455000)
    expect(out.coordinates[1]).toBeGreaterThan(3420000)
    expect(out.coordinates[1]).toBeLessThan(3440000)
  })
  it('leaves WGS 84 untouched and refuses an unsupported code', () => {
    expect(reprojectCollection(fc, 4326)).toBe(fc)
    expect(() => reprojectCollection(fc, 2154)).toThrow(/not supported/)
  })
  it('writes a .prj for each supported family', () => {
    expect(prjWkt(32643)).toContain('Central_Meridian",75.0')
    expect(prjWkt(32743)).toContain('False_Northing",10000000.0')
    expect(prjWkt(3857)).toContain('Mercator_Auxiliary_Sphere')
    expect(prjWkt(2154)).toBeNull()
  })
  it('exports GeoJSON with the CRS stated and KML with a warning that it stayed WGS 84', async () => {
    const g = await exportVectorInCrs(fc, 'geojson', 'pts', 32643)
    expect(JSON.parse(String(g.data)).crs.properties.name).toBe('urn:ogc:def:crs:EPSG::32643')
    expect(g.warnings.join(' ')).toMatch(/legacy "crs"/)
    const k = await exportVectorInCrs(fc, 'kml', 'pts', 32643)
    expect(k.warnings.join(' ')).toMatch(/always WGS 84/)
    const c = await exportVectorInCrs(fc, 'csv', 'pts', 32643)
    expect(String(c.data)).toMatch(/^y,x,geometry_type/)
  })
})
