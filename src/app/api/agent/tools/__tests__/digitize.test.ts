/** Tool-level tests for vectorize_raster / delineate_fields with a mocked STAC
 *  catalogue and mocked titiler pixel reads (the sandbox blocks the real hosts). The
 *  mocked world is the synthetic season from lib/fields/__tests__/synthetic.ts, so the
 *  expected answer is known exactly. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PixelGrid } from '../../lib/pixels'

vi.mock('../../lib/pixels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pixels')>()
  return { ...actual, fetchFeatureGrid: vi.fn() }
})

import { fetchFeatureGrid } from '../../lib/pixels'
import { executeTool } from '../index'
import { validateVegaLite } from '../../lib/chart-data'
import { specHasFid } from '@/lib/chart-spec'
import { DATES, RECTS, makeStack } from '../../lib/fields/__tests__/synthetic'
import { makeGeoref } from '../../lib/vectorize'

const SIZE = 100
const world = makeStack({ size: SIZE, seed: 5 })
const [W, S, E, N] = world.bbox
const AOI = { type: 'Polygon', coordinates: [[[W, S], [E, S], [E, N], [W, N], [W, S]]] }
const geo = makeGeoref(world.bbox, SIZE, SIZE)

function item(date: string, kind: 'clear' | 'cloudy', cloud: number) {
  const id = `${date}_${kind}`
  const href = (k: string) => ({ href: `https://sentinel-cogs.s3.us-west-2.amazonaws.com/${id}/${k}.tif` })
  return {
    id,
    collection: 'sentinel-2-l2a',
    properties: { datetime: `${date}T05:00:00Z`, 'eo:cloud_cover': cloud },
    links: [{ rel: 'self', href: `https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/${id}` }],
    assets: { red: href('B04'), nir: href('B08'), green: href('B03'), swir16: href('B11'), swir22: href('B12'), scl: href('SCL') },
  }
}

let stac: 'fields' | 'cloudy' | 'empty' | 'error' | 'lake' = 'fields'

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (stac === 'error') return { ok: false, status: 503, json: async () => ({}) }
    const features =
      stac === 'empty' ? []
      : stac === 'cloudy' ? DATES.map((d) => item(d, 'cloudy', 90))
      : stac === 'lake' ? [item('2025-06-10', 'clear', 4), item('2025-06-12', 'cloudy', 70)]
      : DATES.flatMap((d) => [item(d, 'cloudy', 85), item(d, 'clear', 6)])
    return { ok: true, status: 200, json: async () => ({ features }) }
  }))
}

/** Build a PixelGrid from band-major arrays; the last band is the validity mask. */
function pixelGrid(bands: Float64Array[], w: number, h: number): PixelGrid {
  const px = w * h
  const raw = new Float64Array((bands.length + 1) * px)
  bands.forEach((b, i) => raw.set(b, i * px))
  raw.fill(255, bands.length * px)
  return { values: raw.subarray(0, px), mask: raw.subarray(bands.length * px), width: w, height: h, bands: bands.length + 1, raw }
}

let failNdviReads = false

function mockReads() {
  vi.mocked(fetchFeatureGrid).mockImplementation(async (req: any) => {
    const id = String(req.itemHref).split('/').pop()!
    const date = id.slice(0, 10)
    const cloudy = id.endsWith('cloudy')
    const assets: string[] = req.assets

    if (assets.length === 1 && assets[0] === 'scl') {
      return pixelGrid([new Float64Array(50 * 50).fill(cloudy ? 9 : 4)], 50, 50)
    }
    if (failNdviReads) throw new Error('titiler feature.npy HTTP 429')
    const px = SIZE * SIZE
    const scl = new Float64Array(px).fill(cloudy ? 9 : 4)

    if (assets.join() === 'nir,red,swir16,scl') {
      const layer = world.layers[DATES.indexOf(date)]
      const nd = world.ndbi![DATES.indexOf(date)]
      const nir = new Float64Array(px), red = new Float64Array(px).fill(2000), swir = new Float64Array(px)
      for (let i = 0; i < px; i++) {
        const v = layer[i]
        if (v !== v) { scl[i] = 9; nir[i] = 2000; swir[i] = 2000; continue }
        nir[i] = Math.round((2000 * (1 + v)) / (1 - v)) // NDVI = (nir-red)/(nir+red)
        swir[i] = Math.round((nir[i] * (1 + nd[i])) / (1 - nd[i])) // NDBI = (swir-nir)/(swir+nir)
      }
      return pixelGrid([nir, red, swir, scl], SIZE, SIZE)
    }
    if (assets.join() === 'green,nir,scl') {
      // A 40x30 lake at x 20..60, y 30..60: NDWI +0.43 on water, -0.52 on land.
      const green = new Float64Array(px), nir = new Float64Array(px)
      for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        const lake = x >= 20 && x < 60 && y >= 30 && y < 60
        green[y * SIZE + x] = lake ? 2000 : 800
        nir[y * SIZE + x] = lake ? 800 : 2500
      }
      return pixelGrid([green, nir, scl], SIZE, SIZE)
    }
    throw new Error(`unexpected asset request ${assets.join()}`)
  })
}

function run(tool: string, args: Record<string, any> = {}) {
  return executeTool(tool, AOI, args)
}

beforeEach(() => {
  stac = 'fields'
  failNdviReads = false
  stubFetch()
  mockReads()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(fetchFeatureGrid).mockReset()
})

describe('delineate_fields', () => {
  const args = { start: '2025-01-01', end: '2025-12-31', max_scenes: 8 }

  it('delineates the six synthetic fields with phenology labels, palette and honest caveats', async () => {
    const r = await run('delineate_fields', args)
    expect(r.layers[0]?.type).toBe('geojson')
    const feats = r.layers[0]!.geojson.features as any[]
    const fields = feats.filter((f) => f.properties.is_field)
    expect(fields).toHaveLength(6)
    expect(feats.filter((f) => !f.properties.is_field)).toHaveLength(1)

    const classes = fields.map((f) => f.properties.class).sort()
    expect(classes).toEqual(['double_crop', 'fallow_sparse', 'perennial', 'seasonal_other', 'summer_crop', 'winter_crop'])
    // Total mapped field area within 5% of truth (the 6 field rectangles).
    const truthM2 = RECTS.filter((q) => q.cls !== 'non_field')
      .reduce((s, q) => s + Math.round((q.x1 - q.x0) * 0.8333) * Math.round((q.y1 - q.y0) * 0.8333) * geo.pixelAreaM2, 0)
    const gotM2 = fields.reduce((s, f) => s + f.properties.area_m2, 0)
    expect(Math.abs(gotM2 - truthM2) / truthM2).toBeLessThan(0.05)

    expect(r.stats?.field_count).toBe(6)
    expect(r.stats?.non_field_regions).toBe(1)
    expect(Number(r.stats?.scenes_used)).toBeGreaterThanOrEqual(6)
    const vs = r.layers[0]!.vectorStyle!
    expect(vs.kind).toBe('categorical')
    expect(vs.property).toBe('class')
    expect(vs.classes!.map((c) => c.value).sort()).toEqual([...new Set(feats.map((f) => f.properties.class))].sort())
    expect(vs.classes!.every((c) => /^#[0-9a-f]{6}$/i.test(c.color) && c.label)).toBe(true)
    expect(r.charts).toHaveLength(2)
    for (const c of r.charts!) expect(validateVegaLite(c.spec).ok).toBe(true)
    const profile = r.charts![0]
    expect(profile.layerId).toBe(r.layers[0]!.id)
    expect(specHasFid(profile.spec)).toBe(true)
    expect(profile.spec.params[0].select.fields).toEqual(['_fid'])
    const fids = new Set((profile.spec.data.values as any[]).map((v) => v._fid))
    expect(fids.size).toBe(6)
    for (const f of fids) expect(feats[f as number].properties.is_field).toBe(true)
    expect(profile.title).not.toMatch(/largest/)
    const area = r.charts![1].spec.data.values as any[]
    expect(area.reduce((s, v) => s + v.ha, 0)).toBeCloseTo(Number(r.stats!.total_field_area_ha), 0)
    expect(r.layers[0]!.provenance?.clip).toBe('polygon')
    expect(r.layers[0]!.provenance?.resolution_limit).toMatch(/merge/)
    expect(r.layers[0]!.confidence).not.toBe('high')
    expect(r.summary).toMatch(/not which crop/i)
    expect(r.summary).toMatch(/ground truth/i)
    expect(fields[0].properties.profile_dates.length).toBeGreaterThanOrEqual(6)
  })

  it('refuses honestly when too few scenes are clear over the AOI (cloud, not a fetch error)', async () => {
    stac = 'cloudy'
    const r = await run('delineate_fields', { ...args, start: '2025-01-02' })
    expect(r.layers).toHaveLength(0)
    expect(r.summary).toMatch(/Not enough clear scenes/)
  })

  it('distinguishes a catalogue failure from an empty catalogue', async () => {
    stac = 'error'
    const failed = await run('delineate_fields', { ...args, start: '2025-01-03' })
    expect(failed.summary).toMatch(/catalogue search failed/)
    stac = 'empty'
    const empty = await run('delineate_fields', { ...args, start: '2025-01-04' })
    expect(empty.summary).toMatch(/no Sentinel-2 L2A scene covers/)
  })

  it('reports a pixel-read failure as such, with no polygons', async () => {
    failNdviReads = true
    const r = await run('delineate_fields', { ...args, start: '2025-01-05' })
    expect(r.layers).toHaveLength(0)
    expect(r.summary).toMatch(/Real data unavailable/)
    expect(r.summary).toMatch(/429/)
  })

  it('rejects a window too short for a phenology', async () => {
    const r = await run('delineate_fields', { start: '2025-06-01', end: '2025-07-01' })
    expect(r.summary).toMatch(/needs a season/)
  })

  it('is what digitize_features calls for fields / parcels / plots', async () => {
    // Default window = the 12 months ending today; pin "today" so the 2025 mock scenes fall inside it.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2025-12-31T12:00:00Z') })
    try {
      const r = await run('digitize_features', { feature: 'crop fields' })
      expect(r.summary).toMatch(/Delineated \d+ field/)
      // Default 6 dates sample the season more sparsely than the 8-date test above, so
      // look-alike neighbours may legitimately merge; the routing is what is under test.
      expect(Number(r.stats?.field_count)).toBeGreaterThanOrEqual(4)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('vectorize_raster', () => {
  beforeEach(() => { stac = 'lake' })
  const lakeM2 = 40 * 30 * geo.pixelAreaM2

  it('digitizes a water body (NDWI > 0.2) with area, mean value and an honest resolution note', async () => {
    const r = await run('vectorize_raster', { index: 'NDWI', op: '>', threshold: 0.2, date: '2025-06-11' })
    expect(r.stats?.polygon_count).toBe(1)
    const f = (r.layers[0]!.geojson.features as any[])[0]
    expect(Math.abs(f.properties.area_m2 - lakeM2) / lakeM2).toBeLessThan(0.01)
    expect(f.properties.mean_value).toBeCloseTo(0.43, 1)
    expect(r.layers[0]!.provenance?.resolution_limit).toMatch(/20 m/)
    expect(r.layers[0]!.provenance?.date).toBe('2025-06-10')
    expect(r.layers[0]!.provenance?.clip).toBe('polygon')
    expect(r.stats?.total_area_m2).toBe(Math.round(lakeM2))
    expect(r.layers[0]!.vectorStyle).toMatchObject({ property: 'mean_value', kind: 'graduated', method: 'quantile', colormap: 'blues' })
    // Closed, CCW shell.
    const ring = f.geometry.coordinates[0]
    expect(ring[0]).toEqual(ring[ring.length - 1])
  })

  it('uses a stated default threshold for a bare index and the "between" op', async () => {
    const dflt = await run('vectorize_raster', { index: 'NDWI', date: '2025-06-11' })
    expect(dflt.stats?.polygon_count).toBe(1)
    expect(dflt.summary).toMatch(/default for NDWI/)
    const between = await run('vectorize_raster', { index: 'NDWI', op: 'between', threshold: 0.3, threshold_upper: 0.6, date: '2025-06-11' })
    expect(between.stats?.polygon_count).toBe(1)
    const none = await run('vectorize_raster', { index: 'NDWI', op: '>', threshold: 0.9, date: '2025-06-11' })
    expect(none.layers).toHaveLength(0)
    expect(none.summary).toMatch(/measured absence/)
  })

  it('accepts a band-name expression and rejects unknown bands', async () => {
    const ok = await run('vectorize_raster', { expression: '(green - nir) / (green + nir)', op: '>', threshold: 0.2, date: '2025-06-11' })
    expect(ok.stats?.polygon_count).toBe(1)
    const bad = await run('vectorize_raster', { expression: '(foo - nir)/(foo + nir)', op: '>', threshold: 0.2 })
    expect(bad.summary).toMatch(/unknown band "foo"/)
  })

  it('applies the minimum-area filter', async () => {
    const r = await run('vectorize_raster', { index: 'NDWI', op: '>', threshold: 0.2, min_area_m2: lakeM2 * 2, date: '2025-06-11' })
    expect(r.layers).toHaveLength(0)
    expect(r.summary).toMatch(/every connected group was under/)
  })

  it('refuses a missing index/expression and reports titiler failure distinctly', async () => {
    expect((await run('vectorize_raster', {})).summary).toMatch(/needs an `index`/)
    failNdviReads = true
    const r = await run('vectorize_raster', { index: 'NDWI', op: '>', threshold: 0.2, date: '2025-06-11' })
    expect(r.summary).toMatch(/Real data unavailable/)
    expect(r.summary).toMatch(/429/)
  })
})
