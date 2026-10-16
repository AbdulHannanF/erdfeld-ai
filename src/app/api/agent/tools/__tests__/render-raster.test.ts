/** render_raster end-to-end with a mocked STAC search + mocked pixel reads.
 *
 *  The grid is 10x10: pixels 0..79 are clear (SCL vegetation) with NIR DN 1000 + 10*i,
 *  80..89 are cloud with a wild NIR value that must NOT reach the stretch, 90..99 lie
 *  outside the polygon (mask 0). So the expected stretch is computable by hand. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PixelGrid } from '../../lib/pixels'

vi.mock('../../lib/pixels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pixels')>()
  return { ...actual, fetchFeatureGrid: vi.fn() }
})
vi.mock('../../lib/cloud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/cloud')>()
  return {
    ...actual,
    pickClearestScene: vi.fn(),
    pickClearestLandsatScene: vi.fn(),
    examinedScenes: vi.fn(async () => []),
  }
})

import { fetchFeatureGrid } from '../../lib/pixels'
import { pickClearestLandsatScene, pickClearestScene } from '../../lib/cloud'
import { renderRaster, resolveWindow } from '../raster'
import { readTileStyle } from '@/lib/raster-style'

const AOI = { type: 'Polygon', coordinates: [[[10, 10], [10.1, 10], [10.1, 10.1], [10, 10.1], [10, 10]]] }
const ctx = (): any => ({
  aoi: AOI,
  bbox: [10, 10, 10.1, 10.1],
  centroid: { lat: 10.05, lng: 10.05 },
  areaKm2: 123.4,
  emit: vi.fn(),
  runTool: vi.fn(),
})

const ITEM = {
  id: 'S2B_32PQA_20260815',
  collection: 'sentinel-2-l2a',
  properties: { datetime: '2026-08-15T08:00:00Z', 'eo:cloud_cover': 12.5 },
  links: [{ rel: 'self', href: 'https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/S2B_32PQA_20260815' }],
  assets: Object.fromEntries(['blue', 'green', 'red', 'nir', 'swir16', 'swir22', 'scl'].map((k) => [k, { href: `https://cogs/${k}.tif` }])),
}
const CLARITY: any = { kind: 'scl', clearPct: 92, cloudPct: 8, totalPx: 90, clearPx: 80, coveragePct: 100, breakdown: [{ label: 'Vegetation', pct: 80 }] }

/** Band-major raw: `bandDn(b, i)` for each data band, then SCL, then mask. */
function makeGrid(nData: number, bandDn: (b: number, i: number) => number): PixelGrid {
  const px = 100
  const raw = new Float64Array((nData + 2) * px)
  for (let i = 0; i < px; i++) {
    const inside = i < 90
    const cloud = i >= 80 && i < 90
    for (let b = 0; b < nData; b++) raw[b * px + i] = inside ? (cloud ? 9000 : bandDn(b, i)) : 0
    raw[nData * px + i] = cloud ? 9 : 4
    raw[(nData + 1) * px + i] = inside ? 255 : 0
  }
  return {
    values: raw.subarray(0, px) as Float64Array,
    mask: raw.subarray((nData + 1) * px) as Float64Array,
    width: 10, height: 10, bands: nData + 2, raw,
  }
}

function stubSearch(features: any[], status = 200) {
  const f = vi.fn(async () => new Response(JSON.stringify({ features }), { status }))
  vi.stubGlobal('fetch', f)
  return f
}

let n = 0
/** Unique window per test so the 10-minute search cache never leaks between tests. */
const win = () => ({ start: `2025-0${(n % 9) + 1}-01`, end: `2025-0${(n % 9) + 1}-${10 + n++}` })

beforeEach(() => {
  vi.mocked(fetchFeatureGrid).mockReset()
  vi.mocked(pickClearestScene).mockReset().mockResolvedValue({ item: ITEM, clarity: CLARITY, examined: [], rejected: [] })
})
afterEach(() => vi.unstubAllGlobals())

describe('resolveWindow', () => {
  const now = Date.parse('2026-10-10T12:00:00Z')
  it('defaults to the last 90 days, widens a date to +-3 days, rejects bad input', () => {
    expect(resolveWindow({}, now)).toMatchObject({ datetime: '2026-07-12/2026-10-10', explicit: false })
    expect(resolveWindow({ date: '2026-08-15' }, now)).toMatchObject({ datetime: '2026-08-12/2026-08-18', explicit: true })
    expect(resolveWindow({ start: '2026-01-01', end: '2026-02-01' }, now)).toMatchObject({ datetime: '2026-01-01/2026-02-01' })
    expect(resolveWindow({ date: 'last tuesday' }, now)).toMatchObject({ ok: false })
    expect(resolveWindow({ start: '2026-03-01', end: '2026-02-01' }, now)).toMatchObject({ ok: false })
  })
})

describe('render_raster (Sentinel-2)', () => {
  it('single band: AOI-driven p2-p98 stretch on reflectance, cloud pixels excluded, mask + descriptor set', async () => {
    const search = stubSearch([ITEM])
    vi.mocked(fetchFeatureGrid).mockResolvedValue(makeGrid(1, (_b, i) => 1000 + 10 * i))

    const res = await renderRaster(ctx(), { bands: ['B08'], ...win() })

    // Search hit Earth Search for the sentinel-2-l2a collection.
    const body = JSON.parse((search.mock.calls[0] as any)[1].body)
    expect(body.collections).toEqual(['sentinel-2-l2a'])
    // One request reads the band AND the SCL together (common grid).
    expect(vi.mocked(fetchFeatureGrid).mock.calls[0][0].assets).toEqual(['nir', 'scl'])

    const layer = res.layer!
    expect(layer.aoiMask).toBe(true)
    expect(layer.type).toBe('raster')
    expect(layer.tileUrl).toMatch(/\/stac\/tiles\/WebMercatorQuad\/\{z\}\/\{x\}\/\{y\}\.png\?/)
    expect(decodeURIComponent(layer.tileUrl!)).toContain('expression=(b1*0.0001)')
    expect(layer.tileUrl).toContain('assets=nir')
    // Hand-computed from the 80 clear values 0.100..0.179 (the 0.9 cloud pixels must not appear).
    const [[lo, hi]] = readTileStyle(layer.tileUrl!).rescale
    expect(lo).toBeCloseTo(0.10158, 5)
    expect(hi).toBeCloseTo(0.17742, 5)
    expect(readTileStyle(layer.tileUrl!).colormap).toBe('viridis')
    expect(layer.raster).toMatchObject({
      kind: 'continuous', sensor: 'sentinel-2-l2a', sceneId: ITEM.id, datetime: '2026-08-15',
      bands: ['B08'], stretch: 'p2-p98', colormap: 'viridis', units: 'reflectance', rescale: [[lo, hi]],
    })
    expect(layer.provenance).toMatchObject({ date: '2026-08-15', clip: 'polygon (display mask)' })
    expect(layer.provenance!.source).toContain('Sentinel-2 L2A')
    expect(layer.confidence).toBe('high')
    expect(res.summary_data).toMatchObject({ scene_date: '2026-08-15', cloud_pct: 12.5, valid_pixel_pct: 92, clear_pixels: 80 })
    expect(res.summary_data!.max).toBeCloseTo(0.179, 5)
    expect(res.summary_data!.min).toBeCloseTo(0.1, 5)
    expect(res.summary_data!.mean).toBeCloseTo(0.1395, 4)
  })

  it('RGB false colour: three assets in order, per-band DN stretch, no colormap', async () => {
    stubSearch([ITEM])
    vi.mocked(fetchFeatureGrid).mockResolvedValue(makeGrid(3, (b, i) => 500 * (b + 1) + 10 * i))

    const res = await renderRaster(ctx(), { bands: ['B08', 'B04', 'B03'], ...win() })

    expect(vi.mocked(fetchFeatureGrid).mock.calls[0][0].assets).toEqual(['nir', 'red', 'green', 'scl'])
    const url = res.layer!.tileUrl!
    expect(url.match(/assets=/g)).toHaveLength(3)
    expect(url).not.toContain('colormap_name')
    expect(url).not.toContain('expression')
    const { rescale } = readTileStyle(url)
    expect(rescale).toHaveLength(3)
    expect(rescale[0][0]).toBeGreaterThan(500) // band 0 base is 500; p2 sits just above it
    expect(rescale[2][0]).toBeGreaterThan(1500)
    expect(res.layer!.raster).toMatchObject({ kind: 'rgb', bands: ['B08', 'B04', 'B03'], units: 'DN' })
    expect(res.layer!.id).toBe('raster-s2-b08-b04-b03-rgb')
  })

  it('expression: distinct assets, positional reflectance-scaled formula, evaluated stats', async () => {
    stubSearch([ITEM])
    // swir16 = 2000 flat, nir = 1000 + 10 i  ->  (B11-B08)/(B11+B08)
    vi.mocked(fetchFeatureGrid).mockResolvedValue(makeGrid(2, (b, i) => (b === 0 ? 2000 : 1000 + 10 * i)))

    const res = await renderRaster(ctx(), { expression: '(B11-B08)/(B11+B08)', colormap: 'rdylgn', ...win() })

    const layer = res.layer!
    expect(vi.mocked(fetchFeatureGrid).mock.calls[0][0].assets).toEqual(['swir16', 'nir', 'scl'])
    expect(layer.tileUrl).toContain('assets=swir16&assets=nir')
    const expr = new URL(layer.tileUrl!.replace(/\{z\}|\{x\}|\{y\}/g, '0')).searchParams.get('expression')
    expect(expr).toBe('((b1*0.0001)-(b2*0.0001))/((b1*0.0001)+(b2*0.0001))')
    expect(layer.raster!.expression).toBe('(B11-B08)/(B11+B08)')
    // i=0: (2000-1000)/3000 = 0.3333 (max); i=79: (2000-1790)/3790 = 0.0554 (min)
    expect(res.summary_data!.max).toBeCloseTo(0.3333, 3)
    expect(res.summary_data!.min).toBeCloseTo(0.0554, 3)
    expect(readTileStyle(layer.tileUrl!).colormap).toBe('rdylgn')
  })

  it('a caller-supplied rescale is honoured verbatim and marked fixed', async () => {
    stubSearch([ITEM])
    vi.mocked(fetchFeatureGrid).mockResolvedValue(makeGrid(1, (_b, i) => 1000 + 10 * i))
    const res = await renderRaster(ctx(), { bands: ['B08'], rescale: [0, 0.5], colormap: 'greys', ...win() })
    expect(readTileStyle(res.layer!.tileUrl!)).toEqual({ colormap: 'greys', rescale: [[0, 0.5]] })
    expect(res.layer!.raster!.stretch).toBe('fixed')
  })

  it('unknown band: honest error naming the valid bands, no search, no layer', async () => {
    const search = stubSearch([ITEM])
    const res = await renderRaster(ctx(), { bands: ['B13'], ...win() })
    expect(res.layer).toBeUndefined()
    expect(res.summary).toContain('"B13"')
    expect(res.summary).toContain('B08 (NIR, 10 m)')
    expect(search).not.toHaveBeenCalled()
  })

  it('unknown colormap and bad expression are refused before any network call', async () => {
    const search = stubSearch([ITEM])
    expect((await renderRaster(ctx(), { bands: ['B08'], colormap: 'bogus' })).summary).toMatch(/Unknown colormap/)
    expect((await renderRaster(ctx(), { expression: '(B08-', ...win() })).summary).toMatch(/Cannot evaluate/)
    expect((await renderRaster(ctx(), { bands: ['B08', 'B04', 'B03'], colormap: 'viridis' })).summary).toMatch(/does not apply/)
    expect(search).not.toHaveBeenCalled()
  })

  it('distinguishes a catalogue failure from "no scenes"', async () => {
    stubSearch([], 503)
    const failed = await renderRaster(ctx(), { bands: ['B08'], ...win() })
    expect(failed.layer).toBeUndefined()
    expect(failed.summary).toMatch(/Could not search/)
    expect(failed.summary).toMatch(/not an absence of data/)

    stubSearch([])
    const empty = await renderRaster(ctx(), { bands: ['B08'], ...win() })
    expect(empty.layer).toBeUndefined()
    expect(empty.summary).toMatch(/No Sentinel-2 L2A scenes cover this AOI/)
  })

  it('distinguishes a pixel-read failure from a read that found no usable pixels', async () => {
    stubSearch([ITEM])
    vi.mocked(fetchFeatureGrid).mockRejectedValue(new Error('titiler feature.npy HTTP 429'))
    const failed = await renderRaster(ctx(), { bands: ['B08'], ...win() })
    expect(failed.layer).toBeUndefined()
    expect(failed.summary).toMatch(/fetch failure, not an absence of data/)
    expect(failed.summary).toContain('429')

    stubSearch([ITEM])
    const allCloud = makeGrid(1, () => 1000)
    for (let i = 0; i < 100; i++) allCloud.raw[100 + i] = 9 // SCL: everything cloud
    vi.mocked(fetchFeatureGrid).mockResolvedValue(allCloud)
    const none = await renderRaster(ctx(), { bands: ['B08'], ...win() })
    expect(none.layer).toBeUndefined()
    expect(none.summary).toMatch(/No usable pixels/)
  })

  it('with a rescale it still renders when the stats read fails, and says so', async () => {
    stubSearch([ITEM])
    vi.mocked(fetchFeatureGrid).mockRejectedValue(new Error('boom'))
    const res = await renderRaster(ctx(), { bands: ['B08'], rescale: [0, 0.4], ...win() })
    expect(res.layer).toBeDefined()
    expect(res.summary).toMatch(/AOI statistics were unavailable/)
  })

  it('no scene clear enough: shows the newest scene unmasked, flagged low confidence', async () => {
    stubSearch([ITEM])
    vi.mocked(pickClearestScene).mockResolvedValue(null)
    vi.mocked(fetchFeatureGrid).mockResolvedValue(makeGrid(1, (_b, i) => 1000 + 10 * i))
    const res = await renderRaster(ctx(), { bands: ['B08'], ...win() })
    expect(res.layer!.confidence).toBe('low')
    expect(res.summary).toMatch(/UNMASKED/)
    expect(res.layer!.provenance!.method).toMatch(/unmasked newest scene/)
  })

  it('an item missing the band asset is an error, not a substitution', async () => {
    const item = { ...ITEM, assets: { red: ITEM.assets.red, scl: ITEM.assets.scl } }
    stubSearch([item])
    vi.mocked(pickClearestScene).mockResolvedValue({ item, clarity: CLARITY, examined: [], rejected: [] })
    const res = await renderRaster(ctx(), { bands: ['B08'], ...win() })
    expect(res.layer).toBeUndefined()
    expect(res.summary).toMatch(/does not carry an asset for band B08/)
  })

  it('a requested date that resolves to another scene date says so', async () => {
    stubSearch([ITEM])
    vi.mocked(fetchFeatureGrid).mockResolvedValue(makeGrid(1, (_b, i) => 1000 + 10 * i))
    const res = await renderRaster(ctx(), { bands: ['B08'], date: '2026-08-13' })
    expect(res.summary).toMatch(/requested 2026-08-13/)
  })
})

describe('render_raster (Landsat)', () => {
  function npy(shape: number[], values: Float64Array): Buffer {
    let header = `{'descr': '<f8', 'fortran_order': False, 'shape': (${shape.join(', ')}), }`
    const pad = (64 - ((10 + header.length + 1) % 64)) % 64
    header += ' '.repeat(pad) + '\n'
    const head = Buffer.alloc(10)
    head[0] = 0x93; head.write('NUMPY', 1, 'ascii'); head[6] = 1; head.writeUInt16LE(header.length, 8)
    const data = Buffer.alloc(values.length * 8)
    values.forEach((v, i) => data.writeDoubleLE(v, i * 8))
    return Buffer.concat([head, Buffer.from(header, 'ascii'), data])
  }

  const LS_ITEM = {
    id: 'LC09_L2SP_TEST',
    properties: { datetime: '2026-07-30T07:00:00Z', 'eo:cloud_cover': 3 },
    assets: Object.fromEntries(['red', 'nir08', 'qa_pixel'].map((k) => [k, { href: `https://pc/${k}.tif` }])),
  }

  it('reads via Planetary Computer, applies the Landsat scale+offset, and builds a PC tile URL', async () => {
    // 1 data band (nir08), QA, mask; 10x10. DN 20000 -> 20000*0.0000275-0.2 = 0.35
    const px = 100
    const raw = new Float64Array(3 * px)
    for (let i = 0; i < px; i++) {
      raw[i] = 20000
      raw[px + i] = 1 << 6 // QA: clear
      raw[2 * px + i] = 255
    }
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      calls.push(String(u))
      if (String(u).includes('/stac/v1/search')) return new Response(JSON.stringify({ features: [LS_ITEM] }))
      return new Response(new Uint8Array(npy([3, 10, 10], raw)))
    }))
    vi.mocked(pickClearestLandsatScene).mockResolvedValue({ item: LS_ITEM, clarity: { ...CLARITY, kind: 'landsat-qa' }, examined: [], rejected: [] } as any)

    const res = await renderRaster(ctx(), { sensor: 'landsat-c2-l2', bands: ['nir'], ...win() })

    expect(calls.some((c) => c.includes('/item/feature.npy') && c.includes('assets=nir08') && c.includes('assets=qa_pixel'))).toBe(true)
    const layer = res.layer!
    expect(layer.tileUrl).toMatch(/^https:\/\/planetarycomputer\.microsoft\.com\/api\/data\/v1\/item\/tiles\/WebMercatorQuad\/\{z\}\/\{x\}\/\{y\}\.png\?/)
    expect(layer.tileUrl).toContain('collection=landsat-c2-l2')
    expect(layer.tileUrl).toContain('item=LC09_L2SP_TEST')
    expect(decodeURIComponent(layer.tileUrl!)).toContain('(b1*0.0000275+(-0.2))')
    expect(res.summary_data!.mean).toBeCloseTo(0.35, 4)
    expect(layer.raster).toMatchObject({ sensor: 'landsat-c2-l2', bands: ['nir08'] })
  })

  it('rejects a Sentinel-2 band name on Landsat and lists the Landsat bands', async () => {
    const res = await renderRaster(ctx(), { sensor: 'landsat-c2-l2', bands: ['B08'] })
    expect(res.layer).toBeUndefined()
    expect(res.summary).toContain('Landsat')
    expect(res.summary).toContain('swir22')
  })
})
