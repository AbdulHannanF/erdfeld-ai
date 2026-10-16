/** Overture GeoParquet reader: STAC file selection, row filtering, counts, style, cap. Parquet decoding is mocked. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pq = vi.hoisted(() => ({ rows: [] as any[], reads: [] as any[], groups: null as number[] | null }))
vi.mock('hyparquet', () => ({
  asyncBufferFromUrl: async ({ url }: any) => ({ url }),
  cachedAsyncBuffer: (b: any) => b,
  parquetMetadataAsync: async () => ({ row_groups: (pq.groups ?? [pq.rows.length]).map((n) => ({ num_rows: n })) }),
  parquetReadObjects: async (o: any) => {
    pq.reads.push(o)
    // A row-range read returns that slice of the file, like hyparquet does.
    return o.rowStart == null ? pq.rows : pq.rows.slice(o.rowStart, o.rowEnd)
  },
}))
vi.mock('hyparquet-compressors', () => ({ compressors: {} }))

import { featureInAoi, MAX_FEATURES, overtureSpec, readOverture, readOvertureRows } from '../overture'
import { AOI, entry, installFetch, json } from './fixtures'

const REL = '2026-09-23.1'
const overture = (local: string) => entry({
  id: `overture:${local}`, source: 'overture', title: `Overture ${local}`, themes: ['buildings'], license: 'ODbL-1.0',
  access: { kind: 'geoparquet', url: `https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&prefix=release/${REL}/theme%3D${local}/`, requires_auth: null, notes: '' },
})

const stacRoutes = (hits: boolean = true) => [
  { match: (u: string) => u === 'https://stac.overturemaps.org/catalog.json', respond: () => json({ links: [{ rel: 'child', href: 'https://stac.overturemaps.org/2026-08-19.0/catalog.json' }, { rel: 'child', latest: true, href: `https://stac.overturemaps.org/${REL}/catalog.json` }] }) },
  {
    match: (u: string) => /collection\.json$/.test(u),
    respond: () => json({
      links: [{ rel: 'item', href: './00000/00000.json' }, { rel: 'item', href: './00428/00428.json' }],
      extent: { spatial: { bbox: [[-180, -85, 180, 85], [-180, -84, -85, 14], hits ? [73.6, 30.9, 74.9, 32.5] : [10, 10, 11, 11]] } },
    }),
  },
  { match: (u: string) => /00428\.json$/.test(u), respond: () => json({ bbox: [73.6, 30.9, 74.9, 32.5], assets: { aws: { href: 'https://s3/part-00428.zstd.parquet' }, azure: { href: 'https://azure/x.parquet' } } }) },
]

const sq = (x: number, y: number, h: number | null, extra: Record<string, any> = {}) => ({
  id: `b-${x}-${y}`, height: h, num_floors: null, class: null, subtype: null, ...extra,
  bbox: { xmin: x, xmax: x + 0.0001, ymin: y, ymax: y + 0.0001 },
  geometry: { type: 'Polygon', coordinates: [[[x, y], [x + 0.0001, y], [x + 0.0001, y + 0.0001], [x, y + 0.0001], [x, y]]] },
})

beforeEach(() => { pq.rows = []; pq.reads = []; pq.groups = null })
afterEach(() => vi.unstubAllGlobals())

describe('feature selection', () => {
  it('keeps features whose bbox centre is inside the polygon and lines with any vertex inside', () => {
    const l = { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2], [0, 0]]] } // L shape
    expect(featureInAoi({ bbox: { xmin: 0.4, xmax: 0.6, ymin: 1.4, ymax: 1.6 } }, l)).toBe(true)
    expect(featureInAoi({ bbox: { xmin: 1.4, xmax: 1.6, ymin: 1.4, ymax: 1.6 } }, l)).toBe(false) // inside the L's bbox but in the notch
    const road = { bbox: { xmin: 1.5, xmax: 5, ymin: 1.4, ymax: 1.6 }, geometry: { type: 'LineString', coordinates: [[1.5, 1.5], [5, 1.5]] } }
    expect(featureInAoi(road, l)).toBe(false)
    const road2 = { bbox: { xmin: -1, xmax: 1.5, ymin: 0.4, ymax: 0.6 }, geometry: { type: 'LineString', coordinates: [[-1, 0.5], [1.5, 0.5]] } }
    expect(featureInAoi(road2, l)).toBe(true)
  })

  it('maps registry ids to Overture themes', () => {
    expect(overtureSpec(overture('buildings'))?.type).toBe('building')
    expect(overtureSpec(overture('places'))?.type).toBe('place')
    expect(overtureSpec(overture('transportation'))?.type).toBe('segment')
    expect(overtureSpec(overture('base'))).toBeNull()
  })
})

describe('readOverture buildings', () => {
  it('counts buildings in the AOI, summarises footprints and heights, and styles the layer by height', async () => {
    const { calls } = installFetch(stacRoutes())
    pq.rows = [sq(74.06, 31.13, 10), sq(74.061, 31.131, 30), sq(74.062, 31.132, null), sq(74.07, 31.14, 6, { class: 'residential' }), sq(80, 40, 5)] // last: far outside
    const res = await readOverture(overture('buildings'), AOI, {})
    expect(res.status).toBe('ok')
    // The release comes from the STAC root, the file from the item whose footprint meets the AOI.
    expect(pq.reads).toHaveLength(1)
    expect(pq.reads[0].file.url).toBe('https://s3/part-00428.zstd.parquet')
    expect(pq.reads[0].filter).toMatchObject({ 'bbox.xmin': { $lte: 74.08 }, 'bbox.xmax': { $gte: 74.05 }, 'bbox.ymin': { $lte: 31.15 }, 'bbox.ymax': { $gte: 31.12 } })
    expect(calls.some((c) => c.url.includes(`${REL}/buildings/building/collection.json`))).toBe(true)
    expect(res.summary_data).toMatchObject({ feature_count: 4, features_in_aoi: 4, release: REL, buildings_with_height: 3 })
    expect(res.summary_data.height_mean_m).toBeCloseTo(15.3, 1)
    expect(res.stats).toMatchObject({ kind: 'vector', count: 4, with_height: 3 })
    expect(res.layer?.type).toBe('geojson')
    expect(res.layer?.geojson.features).toHaveLength(4)
    expect(res.layer?.geojson.features[0].properties).toMatchObject({ id: 'b-74.06-31.13', height: 10 })
    expect(res.layer?.vectorStyle).toEqual({ property: 'height', kind: 'graduated', method: 'quantile', numClasses: 5, colormap: 'viridis' })
    expect(res.summary).toMatch(/\*\*4 buildings\*\* inside the AOI/)
  })

  it('says plainly when no building carries a height and colours by footprint area instead', async () => {
    installFetch(stacRoutes())
    pq.rows = [sq(74.06, 31.13, null), sq(74.07, 31.14, null)]
    const res = await readOverture(overture('buildings'), AOI, {})
    expect(res.layer?.vectorStyle?.property).toBe('area_m2')
    expect(res.summary).toMatch(/No building here carries a height attribute/)
    expect(res.summary_data.buildings_with_height).toBeUndefined()
    expect(res.stats?.footprint_area_m2).toBeGreaterThan(0)
  })

  it(`caps at ${MAX_FEATURES} features and says how many exist`, async () => {
    installFetch(stacRoutes())
    pq.rows = Array.from({ length: MAX_FEATURES + 5 }, (_, i) => sq(74.051 + (i % 200) * 0.00013, 31.121 + Math.floor(i / 200) * 0.00013, 8))
    const res = await readOverture(overture('buildings'), AOI, {})
    expect(res.summary_data).toMatchObject({ feature_count: MAX_FEATURES, features_in_aoi: MAX_FEATURES + 5 })
    expect(res.layer?.geojson.features).toHaveLength(MAX_FEATURES)
    expect(res.summary).toMatch(/Showing the first 20,000 of 20,005 features/)
  })

  it('does not build a layer when render is false', async () => {
    installFetch(stacRoutes())
    pq.rows = [sq(74.06, 31.13, 10)]
    const res = await readOverture(overture('buildings'), AOI, { render: false })
    expect(res.layer).toBeUndefined()
    expect(res.summary_data.feature_count).toBe(1)
  })

  it('reports an empty AOI as empty (files were searched), not as a failure', async () => {
    installFetch(stacRoutes())
    const res = await readOverture(overture('buildings'), AOI, {})
    expect(res.status).toBe('ok')
    expect(res.summary_data.feature_count).toBe(0)
    expect(res.coverage.verdict).toBe('none')
    expect(res.layer).toBeUndefined()
  })
})

describe('readOverture other themes and limits', () => {
  it('reads places with a categorical style on category', async () => {
    installFetch(stacRoutes())
    pq.rows = [
      { id: 'p1', names: { primary: 'Cafe A' }, categories: { primary: 'cafe' }, confidence: 0.9, bbox: { xmin: 74.06, xmax: 74.06, ymin: 31.13, ymax: 31.13 }, geometry: { type: 'Point', coordinates: [74.06, 31.13] } },
      { id: 'p2', names: { primary: 'Clinic' }, categories: { primary: 'hospital' }, confidence: 0.8, bbox: { xmin: 74.07, xmax: 74.07, ymin: 31.14, ymax: 31.14 }, geometry: { type: 'Point', coordinates: [74.07, 31.14] } },
    ]
    const res = await readOverture(overture('places'), AOI, {})
    expect(res.layer?.vectorStyle).toEqual({ property: 'category', kind: 'categorical' })
    expect(res.layer?.geojson.features[0].properties).toMatchObject({ name: 'Cafe A', category: 'cafe' })
    expect(res.stats?.classes?.map((c) => c.name)).toEqual(['cafe', 'hospital'])
  })

  it('measures road length for transportation', async () => {
    installFetch(stacRoutes())
    pq.rows = [{ id: 's1', class: 'primary', subtype: 'road', names: { primary: 'Ring Rd' }, bbox: { xmin: 74.055, xmax: 74.065, ymin: 31.13, ymax: 31.13 }, geometry: { type: 'LineString', coordinates: [[74.055, 31.13], [74.065, 31.13]] } }]
    const res = await readOverture(overture('transportation'), AOI, {})
    expect(res.summary_data.length_km).toBeCloseTo(0.95, 1) // 0.01 deg of longitude at 31 N
    expect(res.layer?.vectorStyle).toEqual({ property: 'class', kind: 'categorical' })
  })

  it('refuses an AOI above the in-app limit without touching the network', async () => {
    const { fn } = installFetch(stacRoutes())
    const res = await readOverture(overture('buildings'), { ...AOI, areaKm2: 120 }, {})
    expect(res.status).toBe('unavailable')
    expect(res.summary).toMatch(/limit of 30 km²/)
    expect(fn).not.toHaveBeenCalled()
  })

  it('says so when no Overture file intersects the AOI, and when the STAC is down', async () => {
    installFetch(stacRoutes(false))
    expect((await readOverture(overture('buildings'), AOI, {})).status).toBe('no_coverage')
    installFetch([{ match: () => true, respond: () => new Response('x', { status: 500 }) }])
    const res = await readOverture(overture('buildings'), AOI, {})
    expect(res.status).toBe('error')
  })
})

describe('readOvertureRows memory shape', () => {
  const spec = overtureSpec(overture('buildings'))!
  const BOX = [74.05, 31.12, 74.08, 31.15]
  const inside = (i: number) => sq(74.06 + i * 0.0001, 31.13, 10)

  it('reads one row range per row group, not the whole file at once', async () => {
    pq.rows = Array.from({ length: 10 }, (_, i) => inside(i))
    pq.groups = [4, 4, 2]
    const out = await readOvertureRows(['https://s3/a.parquet'], spec, BOX)
    expect(pq.reads.map((r) => [r.rowStart, r.rowEnd])).toEqual([[0, 4], [4, 8], [8, 10]])
    expect(out.rows).toHaveLength(10)
    expect(out.scanned).toBe(10)
    expect(out.capped).toBe(false)
  })

  it('passes a column projection through and lets select reduce each batch before it is kept', async () => {
    pq.rows = Array.from({ length: 8 }, (_, i) => inside(i))
    pq.groups = [4, 4]
    const out = await readOvertureRows(['https://s3/a.parquet'], spec, BOX, { columns: ['id', 'geometry', 'bbox'], select: (rows) => rows.filter((_, i) => i === 0).map((r) => r.id) })
    expect(pq.reads.every((r) => r.columns.join() === 'id,geometry,bbox')).toBe(true)
    expect(out.scanned).toBe(8) // all eight met the box ...
    expect(out.rows).toHaveLength(2) // ... but only the selection is held
  })

  it('stops at the limit and says the rows are a prefix', async () => {
    pq.rows = Array.from({ length: 12 }, (_, i) => inside(i))
    pq.groups = [4, 4, 4]
    pq.reads = []
    const out = await readOvertureRows(['https://s3/a.parquet'], spec, BOX, { limit: 5 })
    expect(out.capped).toBe(true)
    expect(out.scanned).toBe(5)
  })
})
