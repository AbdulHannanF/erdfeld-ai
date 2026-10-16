/** fetch_thermal: the polygon-clipped PNG, the XYZ tile URL, the statistics and the legend all use the
 *  Collection 2 scale/offset (K = 0.00341802 * DN + 149.0), in degrees Celsius, with a stretch taken
 *  from the AOI's own pixels. The regression: a fixed 280-320 K rescale applied to raw DN painted
 *  every pixel one colour. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/stac', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stac')>()
  return { ...actual, searchPCStac: vi.fn(), signPCAsset: vi.fn(async (href: string) => `${href}?sig=test`) }
})
vi.mock('../../lib/cloud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/cloud')>()
  return { ...actual, pickClearestLandsatScene: vi.fn(), landsatClarity: vi.fn() }
})
vi.mock('../../lib/pixels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pixels')>()
  return { ...actual, fetchCogFeatureGrid: vi.fn() }
})

import { _resetCache } from '../../lib/cache'
import { landsatClarity, pickClearestLandsatScene } from '../../lib/cloud'
import { fetchCogFeatureGrid } from '../../lib/pixels'
import { searchPCStac } from '../../lib/stac'
import { LST_OFFSET, LST_SCALE, dnToCelsius } from '../../lib/titiler'
import { fetchThermal } from '../satellite'

const ITEM = {
  id: 'LC09_L2SP_037037_20240819_02_T1',
  properties: { datetime: '2024-08-19T18:03:45Z', 'eo:cloud_cover': 3, platform: 'landsat-9' },
  assets: { lwir11: { href: 'https://blob/lst.tif' } },
}
const AOI = { type: 'Polygon', coordinates: [[[-112.1, 33.4], [-112.0, 33.4], [-112.0, 33.5], [-112.1, 33.5], [-112.1, 33.4]]] }
const ctx = (): any => ({ aoi: AOI, bbox: [-112.1, 33.4, -112.0, 33.5], centroid: { lat: 33.45, lng: -112.05 }, areaKm2: 100, emit: vi.fn(), runTool: vi.fn() })

/** 20 x 20 pixels, DN ramping 46000 to 50000 (about 33 to 47 degrees C), all inside the polygon and all clear. */
const W = 20
const DN = Array.from({ length: W * W }, (_, i) => 46000 + Math.round((i / (W * W - 1)) * 4000))
const grid = (values = DN): any => ({
  values: Float64Array.from(values), mask: new Float64Array(values.length).fill(255), width: W, height: W, bands: 2, raw: Float64Array.from(values),
})
const clarity: any = { kind: 'landsat-qa', clearPct: 100, cloudPct: 0, snowPct: 0, waterPct: 0, totalPx: W * W, clearPx: W * W, coveragePct: 100, breakdown: [{ label: 'Clear', pct: 100 }], grid: { values: new Float64Array(W * W).fill(21824) } }

const titilerCalls: Array<{ url: string; method: string }> = []
const rescaleOf = (url: string): [number, number] => {
  const [lo, hi] = new URL(url).searchParams.get('rescale')!.split(',').map(Number)
  return [lo, hi]
}

beforeEach(() => {
  _resetCache()
  titilerCalls.length = 0
  vi.mocked(searchPCStac).mockReset().mockResolvedValue({ features: [ITEM] })
  vi.mocked(pickClearestLandsatScene).mockReset().mockResolvedValue({ item: ITEM, clarity, examined: [], rejected: [] })
  vi.mocked(landsatClarity).mockReset().mockResolvedValue(clarity)
  vi.mocked(fetchCogFeatureGrid).mockReset().mockResolvedValue(grid())
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
    titilerCalls.push({ url: String(url), method: init?.method ?? 'GET' })
    return new Response(new Uint8Array(600).fill(7), { status: 200 })
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('Landsat surface temperature scale', () => {
  it('converts a DN with the Collection 2 scale and offset', () => {
    expect(LST_SCALE).toBe(0.00341802)
    expect(LST_OFFSET).toBe(149)
    expect(dnToCelsius(44000)).toBeCloseTo(0.00341802 * 44000 + 149 - 273.15, 6)
    expect(dnToCelsius(44000)).toBeCloseTo(26.2, 1)
  })
})

describe('fetch_thermal', () => {
  it('renders the clipped PNG on a stretch in degrees C taken from the AOI, not 280-320 on raw DN', async () => {
    const res = await fetchThermal(ctx(), {})
    const clip = titilerCalls.find((c) => c.url.includes('/cog/feature.png'))!
    expect(clip.method).toBe('POST')
    const q = new URL(clip.url).searchParams
    expect(q.get('expression')).toBe(`b1*${LST_SCALE}+${LST_OFFSET}-273.15`)
    const [lo, hi] = rescaleOf(clip.url)
    // p2-p98 of the ramp, converted: inside the data range, nowhere near 280-320
    expect(lo).toBeGreaterThan(dnToCelsius(46000) - 0.01)
    expect(hi).toBeLessThan(dnToCelsius(50000) + 0.01)
    expect(lo).toBeGreaterThan(30)
    expect(hi).toBeLessThan(50)
    expect(q.get('rescale')).not.toContain('280')
    expect(q.get('nodata')).toBe('0')

    const layer = res.layer!
    expect(layer.imageBase64).toBeTruthy()
    expect(layer.raster).toMatchObject({ kind: 'continuous', stretch: 'p2-p98', colormap: 'plasma', units: '°C', sceneId: ITEM.id, datetime: '2024-08-19', rescale: [[lo, hi]] })
    // statistics use the same scale: the mean of the ramp
    const meanDn = DN.reduce((a, b) => a + b, 0) / DN.length
    expect(res.summary_data!.lst_celsius).toBeCloseTo(Number(dnToCelsius(meanDn).toFixed(1)), 1)
    expect(res.summary_data).toMatchObject({ lst_stretch_min_c: Number(lo.toFixed(1)), lst_stretch_max_c: Number(hi.toFixed(1)) })
    expect(res.summary).toMatch(/2nd–98th percentile/)
    expect(res.provenance_items).toEqual([ITEM.id])
  })

  it('the tile fallback uses the same stretch, is hidden outside the polygon, and carries the same descriptor', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      titilerCalls.push({ url: String(url), method: init?.method ?? 'GET' })
      return new Response('nope', { status: 500 }) // the clip request fails
    }))
    const res = await fetchThermal(ctx(), {})
    const layer = res.layer!
    expect(layer.imageBase64).toBeUndefined()
    expect(layer.aoiMask).toBe(true)
    const tile = new URL(layer.tileUrl!.replace('{z}/{x}/{y}', '0/0/0'))
    expect(tile.searchParams.get('expression')).toBe(`b1*${LST_SCALE}+${LST_OFFSET}-273.15`)
    expect(tile.searchParams.get('rescale')!.split(',').map(Number)).toEqual(layer.raster!.rescale![0])
    expect(layer.raster!.rescale![0][0]).toBeGreaterThan(30)
  })

  it('without a clear pixel the stretch is a stated fixed range, never a data-driven one', async () => {
    vi.mocked(landsatClarity).mockResolvedValue(null)
    const res = await fetchThermal(ctx(), {})
    expect(res.layer!.raster).toMatchObject({ stretch: 'fixed', rescale: [[0, 50]] })
    expect(res.layer!.confidence).toBe('medium')
    expect(res.summary_data!.lst_celsius).toBeUndefined()
  })

  it('a uniform AOI is widened to at least 1 degree so noise is not stretched into colour', async () => {
    vi.mocked(fetchCogFeatureGrid).mockResolvedValue(grid(Array(W * W).fill(48000)))
    const res = await fetchThermal(ctx(), {})
    const [lo, hi] = res.layer!.raster!.rescale![0]
    expect(hi - lo).toBeGreaterThanOrEqual(1)
    expect((lo + hi) / 2).toBeCloseTo(dnToCelsius(48000), 1)
  })

  it('start and end search the clearest scene inside that period', async () => {
    await fetchThermal(ctx(), { start: '2024-06-01', end: '2024-08-31' })
    const [, collection, limit, query, datetime] = vi.mocked(searchPCStac).mock.calls[0]
    expect(collection).toBe('landsat-c2-l2')
    expect(limit).toBeGreaterThan(5)
    expect(query).toMatchObject({ platform: { in: ['landsat-8', 'landsat-9'] } })
    expect(datetime).toBe('2024-06-01/2024-08-31')
    // and with no dates there is no date filter: the newest clear scene
    vi.mocked(searchPCStac).mockClear()
    await fetchThermal(ctx(), {})
    expect(vi.mocked(searchPCStac).mock.calls[0][4]).toBeUndefined()
  })

  it('only an end date searches the 90 days before it', async () => {
    await fetchThermal(ctx(), { end: '2024-08-31' })
    expect(vi.mocked(searchPCStac).mock.calls[0][4]).toBe('2024-06-02/2024-08-31')
  })

  it('names the period when nothing covers it, and never answers a past period with the recent MODIS mean', async () => {
    vi.mocked(searchPCStac).mockResolvedValue({ features: [] })
    const res = await fetchThermal(ctx(), { start: '2015-06-01', end: '2015-08-31' })
    expect(res.layer).toBeUndefined()
    expect(res.summary).toMatch(/2015-06-01 to 2015-08-31/)
  })
})
