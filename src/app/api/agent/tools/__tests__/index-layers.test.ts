/** Q-14a / Q-16: fetch_ndvi and compute_spectral_index ship a tile layer with an AOI mask,
 *  a raster descriptor and a DATA-DRIVEN stretch — not the fixed -1..1 1024 px PNG. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../lib/cloud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/cloud')>()
  return { ...actual, pickClearestScene: vi.fn(), examinedScenes: vi.fn(async () => []) }
})
vi.mock('../../lib/index-stats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/index-stats')>()
  return { ...actual, maskedIndexStats: vi.fn() }
})

import { pickClearestScene } from '../../lib/cloud'
import { maskedIndexStats } from '../../lib/index-stats'
import { computeSpectralIndex, ndviOrImagery } from '../satellite'
import { readTileStyle } from '@/lib/raster-style'

const ITEM = {
  id: 'S2B_TEST',
  collection: 'sentinel-2-l2a',
  properties: { datetime: '2026-08-15T08:00:00Z', 'eo:cloud_cover': 10, platform: 'sentinel-2b' },
  links: [{ rel: 'self', href: 'https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/S2B_TEST' }],
  assets: Object.fromEntries(['blue', 'green', 'red', 'nir', 'swir16', 'swir22', 'scl'].map((k) => [k, { href: `https://cogs/${k}.tif` }])),
}
const AOI = { type: 'Polygon', coordinates: [[[10, 10], [10.1, 10], [10.1, 10.1], [10, 10.1], [10, 10]]] }
const ctx = (): any => ({ aoi: AOI, bbox: [10, 10, 10.1, 10.1], centroid: { lat: 10.05, lng: 10.05 }, areaKm2: 123, emit: vi.fn(), runTool: vi.fn() })

const clarity: any = { kind: 'scl', clearPct: 90, cloudPct: 10, snowPct: 0, waterPct: 0, totalPx: 100, clearPx: 90, coveragePct: 100, breakdown: [{ label: 'Vegetation', pct: 80 }], grid: {} }
const okStats = (index: string) => ({
  ok: true as const,
  stats: {
    mean: 0.42, median: 0.41, std: 0.1, min: -0.05, max: 0.88, count: 5000, insidePolygon: 6000,
    index, sceneId: 'S2B_TEST', sceneDate: '2026-08-15', sceneCloudPct: 10, clearPct: 90, clip: 'polygon' as const,
    clarity, reflectanceNote: 'earth-search', p2: 0.08, p98: 0.74,
  },
})

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: [ITEM] }))))
  vi.mocked(pickClearestScene).mockReset().mockResolvedValue({ item: ITEM, clarity, examined: [], rejected: [] })
  vi.mocked(maskedIndexStats).mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe('fetch_ndvi', () => {
  it('returns an AOI-masked tile layer stretched to the AOI p2-p98, with no baked PNG', async () => {
    vi.mocked(maskedIndexStats).mockResolvedValue(okStats('NDVI'))
    const res = await ndviOrImagery(ctx(), 'fetch_ndvi')
    const layer = res.layer!
    expect(layer.id).toBe('ndvi-active')
    expect(layer.imageBase64).toBeUndefined()
    expect(layer.palette).toBeUndefined()
    expect(layer.aoiMask).toBe(true)
    expect(layer.tileUrl).toContain('/stac/tiles/WebMercatorQuad/{z}/{x}/{y}.png')
    expect(readTileStyle(layer.tileUrl!)).toEqual({ colormap: 'rdylgn', rescale: [[0.08, 0.74]] })
    expect(layer.raster).toMatchObject({ kind: 'continuous', stretch: 'p2-p98', datetime: '2026-08-15', sceneId: 'S2B_TEST', bands: ['B08', 'B04'] })
    expect(layer.provenance!.method).toMatch(/p2–p98/)
    expect(res.summary_data).toMatchObject({ mean: 0.42, p2: 0.08, p98: 0.74 })
    expect(res.summary).toMatch(/Stretch:\*\* 0\.08 to 0\.74/)
  })

  it('without clear-pixel statistics it falls back to the index bounds and says the stretch is fixed', async () => {
    vi.mocked(maskedIndexStats).mockResolvedValue({ ok: false, failure: { reason: 'too_cloudy', clearPct: 20, message: 'too cloudy' } })
    const res = await ndviOrImagery(ctx(), 'fetch_ndvi')
    expect(res.layer!.raster).toMatchObject({ stretch: 'fixed', rescale: [[-1, 1]] })
    expect(res.summary).toMatch(/Stretch:\*\* fixed -1 to 1/)
  })
})

describe('compute_spectral_index', () => {
  it('NDWI: its own colormap, the data-driven stretch, mask and descriptor', async () => {
    vi.mocked(maskedIndexStats).mockResolvedValue(okStats('NDWI'))
    const res = await computeSpectralIndex(ctx(), { index: 'NDWI' })
    const layer = res.layer!
    expect(layer.id).toBe('ndwi-active')
    expect(layer.imageBase64).toBeUndefined()
    expect(layer.aoiMask).toBe(true)
    expect(readTileStyle(layer.tileUrl!)).toEqual({ colormap: 'blues_r', rescale: [[0.08, 0.74]] })
    expect(layer.raster).toMatchObject({ kind: 'continuous', bands: ['B03', 'B08'], expression: '(B03-B08)/(B03+B08)' })
    expect(res.summary_data).toMatchObject({ index: 'NDWI', index_mean: 0.42, p2: 0.08, p98: 0.74 })
  })

  it('EVI keeps its wider mathematical bounds when no statistics exist', async () => {
    vi.mocked(maskedIndexStats).mockResolvedValue({ ok: false, failure: { reason: 'fetch_failed', message: 'x' } })
    const res = await computeSpectralIndex(ctx(), { index: 'EVI' })
    expect(res.layer!.raster).toMatchObject({ stretch: 'fixed', rescale: [[-1, 2.5]] })
  })
})

describe('fetch_ndvi product "imagery"', () => {
  const RGB_ITEM = { ...ITEM, properties: { ...ITEM.properties, 'earthsearch:boa_offset_applied': true }, assets: { ...ITEM.assets, red: { href: 'https://cogs/red.tif' }, preview: { href: 'https://scene/preview.jpg' }, thumbnail: { href: 'https://scene/thumb.jpg' } } }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: [RGB_ITEM] }))))
    vi.mocked(pickClearestScene).mockReset().mockResolvedValue({ item: RGB_ITEM, clarity, examined: [], rejected: [] })
  })

  it('is an AOI-clipped true-colour tile layer, not the scene-wide preview picture', async () => {
    const res = await ndviOrImagery(ctx(), 'fetch_high_res_imagery')
    const layer = res.layer!
    expect(layer.tileUrl).toContain('/stac/tiles/WebMercatorQuad/{z}/{x}/{y}.png')
    expect(layer.tileUrl).not.toMatch(/preview|thumbnail|\.jpg/)
    const q = new URL(layer.tileUrl!.replace('{z}/{x}/{y}', '0/0/0')).searchParams
    expect(q.getAll('assets')).toEqual(['red', 'green', 'blue'])
    expect(q.getAll('rescale')).toHaveLength(3)
    // the layer is on the AOI, not the scene footprint, and hidden outside the polygon
    expect(layer.bounds).toEqual([10, 10, 10.1, 10.1])
    expect(layer.aoiMask).toBe(true)
    expect(layer.raster).toMatchObject({ kind: 'rgb', bands: ['B04', 'B03', 'B02'], sceneId: 'S2B_TEST', datetime: '2026-08-15' })
    expect(layer.provenance).toMatchObject({ clip: 'polygon (display mask)', date: '2026-08-15' })
    expect(layer.provenance!.method).not.toMatch(/covers the scene footprint/)
    expect(layer.confidence).toBe('high')
    expect(res.summary_data).toMatchObject({ scene_date: '2026-08-15', aoi_clear_pct: 90 })
  })

  it('picks the scene by cloud over the AOI and labels an unmasked newest scene as such', async () => {
    vi.mocked(pickClearestScene).mockResolvedValue(null)
    const res = await ndviOrImagery(ctx(), 'fetch_high_res_imagery')
    expect(vi.mocked(pickClearestScene)).toHaveBeenCalled()
    expect(res.layer!.confidence).toBe('low')
    expect(res.summary).toMatch(/no scene reached the clear-sky floor/)
  })

  it('a scene without a colour band draws nothing and says so', async () => {
    const noRed = { ...RGB_ITEM, assets: { blue: { href: 'b' }, green: { href: 'g' } } }
    vi.mocked(pickClearestScene).mockResolvedValue({ item: noRed, clarity, examined: [], rejected: [] })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: [noRed] }))))
    const res = await ndviOrImagery(ctx(), 'fetch_high_res_imagery')
    expect(res.layer).toBeUndefined()
    expect(res.summary).toMatch(/Nothing was drawn/)
  })
})
