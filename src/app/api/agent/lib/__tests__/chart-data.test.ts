import { describe, expect, it } from 'vitest'
import {
  featureRowsOf,
  listDataNames,
  resolveChartSpec,
  resolveDataName,
  storeManifestLayer,
  storeResult,
  summaryRows,
  validateVegaLite,
} from '../chart-data'
import type { ResultStore } from '../types'

const NDVI_SERIES = [
  { label: '2025-05-01', value: 0.31 },
  { label: '2025-06-01', value: 0.52 },
  { label: '2025-07-01', value: 0.64 },
]

function store(): ResultStore {
  const s: ResultStore = new Map()
  storeResult(s, 'fetch_temporal_stack-0', 'fetch_temporal_stack', { ndvi_by_date: NDVI_SERIES, mean_ndvi: 0.49, index: 'NDVI' }, [])
  storeResult(s, 'detect_objects-1', 'detect_objects', { count: 3 }, [
    {
      id: 'fields-1', name: 'Fields', type: 'geojson',
      geojson: {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: { name: 'A', ndvi: 0.4, nested: { x: 1 } }, geometry: null },
          { type: 'Feature', properties: { name: 'B', ndvi: 0.7 }, geometry: null },
        ],
      },
    },
  ])
  return s
}

const BAR = (name: string, x = 'label', y = 'value') => ({
  data: { name },
  mark: 'bar',
  encoding: { x: { field: x, type: 'nominal' }, y: { field: y, type: 'quantitative' } },
})

describe('rows', () => {
  it('array summary figures become tidy rows, with a date field for ISO labels', () => {
    expect(summaryRows('ndvi_by_date', NDVI_SERIES)![0]).toEqual({ label: '2025-05-01', value: 0.31, date: '2025-05-01' })
    expect(summaryRows('land', [{ label: 'Trees', value: 60 }])).toEqual([{ label: 'Trees', value: 60 }])
    expect(summaryRows('mean_ndvi', 0.49)).toEqual([{ label: 'mean_ndvi', value: 0.49 }])
    expect(summaryRows('missing', undefined)).toBeNull()
  })
  it('feature rows keep scalar properties and add _fid = feature index', () => {
    const rows = featureRowsOf({
      geojson: { features: [{ properties: { a: 1, o: { z: 1 }, s: 'x', n: null } }, { properties: { a: 2 } }] },
    })
    expect(rows).toEqual([{ a: 1, s: 'x', n: null, _fid: 0 }, { a: 2, _fid: 1 }])
  })
  it('resolves names, including #features with the layer id', () => {
    const s = store()
    expect(resolveDataName('fetch_temporal_stack-0#ndvi_by_date', s)!.rows).toHaveLength(3)
    const f = resolveDataName('detect_objects-1#features', s)!
    expect(f.layerId).toBe('fields-1')
    expect(f.rows).toEqual([{ name: 'A', ndvi: 0.4, _fid: 0 }, { name: 'B', ndvi: 0.7, _fid: 1 }])
    expect(resolveDataName('nope-9#x', s)).toBeNull()
    expect(resolveDataName('detect_objects-1#nokey', s)).toBeNull()
  })
  it('manifest layers from earlier turns are addressable too', () => {
    const s: ResultStore = new Map()
    storeManifestLayer(s, { result_id: 'r-0', tool: 'query_osm', name: 'Fields', layer_id: 'L1', feature_rows: [{ a: 1 }, { a: 2 }] })
    expect(resolveDataName('r-0#features', s)).toEqual({ rows: [{ a: 1, _fid: 0 }, { a: 2, _fid: 1 }], layerId: 'L1' })
  })
  it('lists the available names with their shape', () => {
    const names = listDataNames(store()).join('\n')
    expect(names).toContain('fetch_temporal_stack-0#ndvi_by_date (3 rows: label, value)')
    expect(names).toContain('detect_objects-1#features (2 rows: name, ndvi, _fid)')
  })
})

describe('resolveChartSpec', () => {
  it('inlines summary rows for a referenced name and validates', () => {
    const r = resolveChartSpec(BAR('fetch_temporal_stack-0#ndvi_by_date'), store())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.data.values).toHaveLength(3)
    expect(r.spec.data.values[1]).toEqual({ label: '2025-06-01', value: 0.52, date: '2025-06-01' })
    expect(r.layerId).toBeUndefined()
  })
  it('inlines feature rows and reports the linked layer', () => {
    const r = resolveChartSpec(BAR('detect_objects-1#features', 'name', 'ndvi'), store())
    expect(r.ok && r.layerId).toBe('fields-1')
    expect(r.ok && r.spec.data.values[0]).toEqual({ name: 'A', ndvi: 0.4, _fid: 0 })
  })
  it('resolves data inside layered / concatenated specs', () => {
    const spec = {
      hconcat: [
        { data: { name: 'fetch_temporal_stack-0#ndvi_by_date' }, mark: 'line', encoding: { x: { field: 'date', type: 'temporal' }, y: { field: 'value', type: 'quantitative' } } },
        { layer: [{ data: { name: 'detect_objects-1#features' }, mark: 'point', encoding: { x: { field: 'ndvi', type: 'quantitative' } } }] },
      ],
    }
    const r = resolveChartSpec(spec, store())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.hconcat[0].data.values).toHaveLength(3)
    expect(r.spec.hconcat[1].layer[0].data.values).toHaveLength(2)
    expect(r.names).toHaveLength(2)
  })
  it('rejects an unknown name and lists the available ones', () => {
    const r = resolveChartSpec(BAR('made_up-3#series'), store())
    expect(r.ok).toBe(false)
    expect((r as any).error).toContain('Unknown data name "made_up-3#series"')
    expect((r as any).error).toContain('fetch_temporal_stack-0#ndvi_by_date')
    expect((r as any).error).toContain('detect_objects-1#features')
  })
  it('rejects inline values, urls, datasets and unnamed data', () => {
    const s = store()
    const inline = resolveChartSpec({ ...BAR('x'), data: { values: [{ label: 'a', value: 999 }] } }, s)
    expect(inline.ok).toBe(false)
    expect((inline as any).error).toMatch(/Inline `data.values` is not allowed/)
    expect((resolveChartSpec({ ...BAR('x'), data: { url: 'https://evil/x.csv' } }, s) as any).error).toMatch(/url/)
    expect((resolveChartSpec({ ...BAR('x'), datasets: { a: [] } }, s) as any).error).toMatch(/datasets/)
    expect((resolveChartSpec({ ...BAR('x'), data: { sequence: { start: 0, stop: 5 } } }, s) as any).error).toMatch(/name/)
    // Nested inline values are caught too.
    const nested = resolveChartSpec({ layer: [BAR('fetch_temporal_stack-0#ndvi_by_date'), { data: { values: [{ a: 1 }] }, mark: 'rule' }] }, s)
    expect(nested.ok).toBe(false)
  })
  it('rejects a spec with no data, and non-objects', () => {
    expect(resolveChartSpec({ mark: 'bar' }, store()).ok).toBe(false)
    expect(resolveChartSpec('nope', store()).ok).toBe(false)
  })
  it('rejects fields the data does not have, naming the real ones', () => {
    const r = resolveChartSpec(BAR('fetch_temporal_stack-0#ndvi_by_date', 'label', 'ndvi'), store())
    expect(r.ok).toBe(false)
    expect((r as any).error).toContain('"ndvi"')
    expect((r as any).error).toContain('label, value, date')
  })
  it('lets derived fields through when a transform creates them', () => {
    const spec = { ...BAR('fetch_temporal_stack-0#ndvi_by_date', 'label', 'pct'), transform: [{ calculate: 'datum.value*100', as: 'pct' }] }
    expect(resolveChartSpec(spec, store()).ok).toBe(true)
  })
  it('does not mutate the caller\'s spec', () => {
    const spec = BAR('fetch_temporal_stack-0#ndvi_by_date')
    resolveChartSpec(spec, store())
    expect(spec.data).toEqual({ name: 'fetch_temporal_stack-0#ndvi_by_date' })
  })
})

describe('validateVegaLite (compiled in Node)', () => {
  const good = { data: { values: [{ a: 1, b: 2 }] }, mark: 'point', encoding: { x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' } } }
  it('accepts a good spec', () => {
    expect(validateVegaLite(good)).toEqual({ ok: true, warnings: [] })
  })
  it('rejects an unknown mark with a readable message', () => {
    const r = validateVegaLite({ ...good, mark: 'banana' })
    expect(r.ok).toBe(false)
    expect((r as any).error).toContain('Unknown mark "banana"')
  })
  it('rejects an invalid field type via the compiler', () => {
    const r = validateVegaLite({ ...good, encoding: { x: { field: 'a', type: 'nope' } } })
    expect(r.ok).toBe(false)
    expect((r as any).error).toMatch(/Vega-Lite rejected the spec/)
  })
  it('surfaces compiler warnings without failing', () => {
    const r = validateVegaLite({ ...good, encoding: { x: { type: 'quantitative' } } })
    expect(r.ok).toBe(true)
    expect((r as any).warnings.length).toBeGreaterThan(0)
  })
})
