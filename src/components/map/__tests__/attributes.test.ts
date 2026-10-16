import { describe, expect, it } from 'vitest'
import { aoiSource, attributeSources, cellText, columnsOf, featuresBounds, geometryValue, rowsFor } from '../attributes'
import { filterRows } from '@/lib/expression'
import type { AOI, MapLayer } from '@/store/useStore'

const square = (x: number, y: number, d = 0.01): GeoJSON.Polygon => ({
  type: 'Polygon',
  coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]],
})
const feat = (props: Record<string, unknown>, geometry: GeoJSON.Geometry = square(74, 31)): GeoJSON.Feature => ({ type: 'Feature', properties: props, geometry })

const AOI_FIXTURE: AOI = { type: 'Rectangle', geometry: square(74.05, 31.12, 0.03), center: { lng: 74.065, lat: 31.135 } }

describe('attribute sources', () => {
  it('lists vector layers with features, then the drawn area, and nothing invented', () => {
    const layers = [
      { id: 'a', name: 'Fields', type: 'geojson', geojson: { type: 'FeatureCollection', features: [feat({ crop: 'wheat' })] } },
      { id: 'b', name: 'Empty', type: 'geojson', geojson: { type: 'FeatureCollection', features: [] } },
      { id: 'c', name: 'NDVI', type: 'raster' },
    ] as unknown as MapLayer[]
    const out = attributeSources(layers, AOI_FIXTURE)
    expect(out.map((s) => s.name)).toEqual(['Fields', 'Area of interest'])
    expect(attributeSources([], null)).toEqual([])
  })
  it('describes the AOI from its own geometry', () => {
    const a = aoiSource(AOI_FIXTURE)!
    const p = a.features[0].properties!
    expect(p.fid).toBe('AOI-001')
    expect(p.shape).toBe('Rectangle')
    expect(p.area_km2 as number).toBeGreaterThan(8)
    expect(p.area_km2 as number).toBeLessThan(12)
  })
})

describe('columns and cells', () => {
  it('orders columns by how many features have them, fid first, and counts the rest', () => {
    const fs = [feat({ fid: 1, a: 1, b: 2 }), feat({ fid: 2, a: 3 }), feat({ fid: 3, a: 4, c: 5 })]
    expect(columnsOf(fs).columns).toEqual(['fid', 'a', 'b', 'c'])
    expect(columnsOf(fs, 2)).toEqual({ columns: ['fid', 'a'], hidden: 2 })
  })
  it('summarises arrays and objects instead of dumping them', () => {
    expect(cellText([1, 2, 3])).toBe('[3 values]')
    expect(cellText({ a: 1 })).toBe('{…}')
    expect(cellText(0.123456789)).toBe('0.12346')
    expect(cellText(null)).toBe('')
  })
})

describe('geometry values and expressions over features', () => {
  it('computes $area in km2 and returns null where the geometry cannot give it', () => {
    const a = geometryValue(feat({}, square(74, 31, 0.1)), '$area')!
    expect(a).toBeGreaterThan(90)
    expect(a).toBeLessThan(110)
    expect(geometryValue(feat({}, { type: 'Point', coordinates: [1, 2] }), '$area')).toBeNull()
    expect(geometryValue(feat({}, { type: 'Point', coordinates: [1, 2] }), '$x')).toBe(1)
  })
  it('filters features by attribute and geometry in one expression', () => {
    const fs = [feat({ crop: 'wheat' }, square(74, 31, 0.1)), feat({ crop: 'wheat' }, square(74, 31, 0.001)), feat({ crop: 'rice' }, square(74, 31, 0.1))]
    const r = filterRows("crop = 'wheat' AND $area > 1", rowsFor(fs))
    expect(r.matches).toEqual([0])
  })
  it('finds the bounds of features', () => {
    expect(featuresBounds([feat({}, square(74, 31, 0.5)), feat({}, { type: 'Point', coordinates: [75, 32] })])).toEqual([74, 31, 75, 32])
    expect(featuresBounds([])).toBeNull()
  })
})
