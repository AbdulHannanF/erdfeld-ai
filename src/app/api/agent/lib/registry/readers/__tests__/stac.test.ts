/** stac-cog reader with mocked HTTP: item choice, assets, SAR dB, DEM, categorical, mosaics, auth. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const grids = vi.hoisted(() => ({ fetchCogFeatureGrid: vi.fn() }))
const stats = vi.hoisted(() => ({ fetchCogPolygonStats: vi.fn() }))
vi.mock('../../../pixels', async (orig) => ({ ...(await orig<typeof import('../../../pixels')>()), fetchCogFeatureGrid: grids.fetchCogFeatureGrid }))
vi.mock('../../../titiler', async (orig) => ({ ...(await orig<typeof import('../../../titiler')>()), fetchCogPolygonStats: stats.fetchCogPolygonStats }))
vi.mock('../../../stac', async (orig) => ({ ...(await orig<typeof import('../../../stac')>()), signPCAsset: async (h: string) => `${h}?sig=1` }))

import {
  buildTileUrl, datetimeWindow, groupItems, listDataAssets, matchAsset, parseAccessUrl, pickColormap, rankItems, readStac, resolveAsset, transformFor,
} from '../stac'
import { AOI, collectionRoute, entry, grid, installFetch, item, json, searchRoute } from './fixtures'

beforeEach(() => { grids.fetchCogFeatureGrid.mockReset(); stats.fetchCogPolygonStats.mockReset() })
afterEach(() => { vi.unstubAllGlobals(); delete process.env.EARTHDATA_TOKEN; delete process.env.CDSE_TOKEN })

describe('stac helpers', () => {
  it('splits a registry access URL into STAC root and collection, including CMR provider roots', () => {
    expect(parseAccessUrl('https://planetarycomputer.microsoft.com/api/stac/v1/collections/sentinel-1-rtc'))
      .toEqual({ root: 'https://planetarycomputer.microsoft.com/api/stac/v1', collection: 'sentinel-1-rtc' })
    expect(parseAccessUrl('https://cmr.earthdata.nasa.gov/stac/ASF/collections/ALOS2_L1_PSR2_1'))
      .toEqual({ root: 'https://cmr.earthdata.nasa.gov/stac/ASF', collection: 'ALOS2_L1_PSR2_1' })
    expect(parseAccessUrl('https://example.org/not-stac')).toBeNull()
  })

  it('builds the datetime window: a date allows nearest-item fallback, an explicit period does not', () => {
    expect(datetimeWindow({}).datetime).toBeUndefined()
    const d = datetimeWindow({ date: '2024-06-15' })
    expect(d.relax).toBe(true)
    expect(d.datetime).toBe('2024-05-01T00:00:00Z/2024-07-30T23:59:59Z')
    const p = datetimeWindow({ start: '2023', end: '2023-06' })
    expect(p.relax).toBe(false)
    expect(p.datetime).toBe('2023-01-01T00:00:00Z/2023-06-28T23:59:59Z')
  })

  it('ranks by closeness to the requested date, else newest first, undated last', () => {
    const a = item('a', { datetime: '2024-01-01T00:00:00Z' })
    const b = item('b', { datetime: '2024-06-10T00:00:00Z' })
    const c = item('c', { datetime: '2024-12-31T00:00:00Z' })
    const u = item('u', { datetime: null })
    expect(rankItems([a, u, b, c], Date.parse('2024-06-15')).map((i) => i.id)).toEqual(['b', 'a', 'c', 'u'])
    expect(rankItems([a, u, b, c]).map((i) => i.id)).toEqual(['c', 'b', 'a', 'u'])
  })

  it('groups neighbouring items of one acquisition (same project and day)', () => {
    const g = groupItems([
      item('t1', { datetime: '2000-02-20T00:00:00Z' }), item('t2', { datetime: '2000-02-20T00:00:00Z' }),
      item('p1', { datetime: null, props: { start_datetime: '2013-10-25T00:00:00Z', end_datetime: '2014-05-31T00:00:00Z', '3dep:usgs_id': 'P1' } }),
    ])
    expect(g.map((x) => x.map((i) => i.id))).toEqual([['t1', 't2'], ['p1']])
  })

  it('lists only GeoTIFF data assets (no previews, tilejson, HDF) and matches variables flexibly', () => {
    const it0 = item('m', { assets: ['500m_16_days_NDVI', '500m_16_days_EVI'] })
    it0.assets.hdf = { href: 'https://x/a.hdf', type: 'application/x-hdf' }
    const keys = listDataAssets(it0).map((a) => a.key)
    expect(keys).toEqual(['500m_16_days_NDVI', '500m_16_days_EVI'])
    const assets = listDataAssets(it0)
    expect(matchAsset(assets, 'ndvi')?.key).toBe('500m_16_days_NDVI')
    expect(matchAsset(assets, '500m 16 days evi')?.key).toBe('500m_16_days_EVI')
    expect(matchAsset(assets, 'nonsense')).toBeNull()
    const sar = item('s', { assets: ['vh', 'vv'] })
    expect(matchAsset(listDataAssets(sar), 'VV')?.key).toBe('vv')
  })

  it('picks the right default asset per theme and lists the alternatives', () => {
    const sar = resolveAsset(item('s', { assets: ['vh', 'vv'] }), entry({ collection: 'sentinel-1-rtc', themes: ['sar'] }), undefined, {})
    expect('asset' in sar && sar.asset.key).toBe('vv')
    expect('others' in sar && sar.others).toEqual(['vh'])
    const bad = resolveAsset(item('s', { assets: ['vh', 'vv'] }), entry(), 'hh', {})
    expect('error' in bad && bad.error).toMatch(/No asset or band matches variable "hh".*vh, vv/)
  })
})

describe('transforms and styling', () => {
  it('converts Sentinel-1 RTC linear power and PALSAR amplitude to dB, and applies raster:bands scale', () => {
    const s1 = transformFor(entry({ collection: 'sentinel-1-rtc' }), 'vv', {}, {})
    expect(s1.unit).toBe('dB')
    expect(s1.apply(0.1)).toBeCloseTo(-10, 6)
    expect(s1.apply(0)).toBeNaN()
    expect(s1.expr('vv')).toBe('10*log10(vv)')
    const pal = transformFor(entry({ collection: 'alos-palsar-mosaic' }), 'HH', {}, {})
    expect(pal.apply(5623)).toBeCloseTo(20 * Math.log10(5623) - 83, 6)
    expect(pal.expr('b1')).toBe('20*log10(b1)-83')
    const modis = transformFor(entry({ collection: 'modis-13A1-061' }), '500m_16_days_NDVI', { 'raster:bands': [{ scale: 0.0001 }] }, {})
    expect(modis.apply(8000)).toBeCloseTo(0.8, 9)
    expect(modis.expr('b1')).toBe('b1*0.0001')
    expect(transformFor(entry(), 'data', {}, {}).id).toBe('identity')
  })

  it('chooses a colormap per theme: terrain, greys (dB), rdylgn, blues, magma, inferno', () => {
    const id = transformFor(entry(), 'data', {}, {})
    const db = transformFor(entry({ collection: 'sentinel-1-rtc' }), 'vv', {}, {})
    expect(pickColormap(entry({ themes: ['elevation'] }), 'data', id, {})).toBe('terrain')
    expect(pickColormap(entry({ themes: ['sar'] }), 'vv', db, {})).toBe('greys_r')
    expect(pickColormap(entry({ themes: ['vegetation'] }), 'x', id, {})).toBe('rdylgn')
    expect(pickColormap(entry({ collection: 'modis-13A1-061' }), '500m_16_days_NDVI', id, {})).toBe('rdylgn')
    expect(pickColormap(entry({ themes: ['water'] }), 'x', id, {})).toBe('blues')
    expect(pickColormap(entry({ themes: ['population'] }), 'x', id, {})).toBe('magma')
    expect(pickColormap(entry({ themes: ['temperature'] }), 'x', id, {})).toBe('inferno')
    expect(pickColormap(entry(), 'x', id, {})).toBe('viridis')
  })

  it('builds Planetary Computer item tiles when the expression can use asset names, else a signed single-COG url', () => {
    const e = entry({ collection: 'sentinel-1-rtc' })
    const db = transformFor(e, 'vv', {}, {})
    const pc = buildTileUrl({ entry: e, pc: { collection: 'sentinel-1-rtc', itemId: 'I1' }, key: 'vv', signedHref: 'https://x/vv.tif?sig=1', transform: db, rescale: [-20, -5], colormap: 'greys_r' })
    expect(pc).toContain('planetarycomputer.microsoft.com/api/data/v1/item/tiles/WebMercatorQuad/{z}/{x}/{y}.png')
    expect(pc).toContain('expression=10*log10%28vv%29')
    expect(pc).toContain('asset_as_band=true')
    expect(pc).toContain('rescale=-20%2C-5')
    expect(pc).toContain('return_mask=true')
    const scaled = transformFor(entry(), '500m_16_days_NDVI', { 'raster:bands': [{ scale: 0.0001 }] }, {})
    const cog = buildTileUrl({ entry: entry(), pc: { collection: 'm', itemId: 'I' }, key: '500m_16_days_NDVI', signedHref: 'https://x/n.tif?sig=1', transform: scaled, rescale: [0, 1], colormap: 'rdylgn' })
    expect(cog).toContain('/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png')
    expect(cog).toContain('url=https%3A%2F%2Fx%2Fn.tif%3Fsig%3D1')
    expect(cog).toContain('expression=b1*0.0001')
    const hs = buildTileUrl({ entry: entry(), pc: { collection: 'c', itemId: 'I' }, key: 'data', signedHref: 'u', transform: transformFor(entry(), 'data', {}, {}), algorithm: 'hillshade' })
    expect(hs).toContain('algorithm=hillshade')
    expect(hs).not.toContain('colormap')
  })
})

describe('readStac: SAR in dB', () => {
  it('averages per-pixel dB (not the dB of the mean) and labels the polarisation', async () => {
    const e = entry({ collection: 'sentinel-1-rtc', themes: ['sar', 'elevation'], variables: [{ name: 'vh' }, { name: 'vv' }] })
    installFetch([searchRoute([item('S1A', { collection: 'sentinel-1-rtc', assets: ['vh', 'vv'] })]), collectionRoute({ id: 'sentinel-1-rtc', item_assets: {} })])
    // Half the pixels at -10 dB (0.1), half at -20 dB (0.01): mean dB = -15, whereas 10*log10(mean power) = -12.6.
    grids.fetchCogFeatureGrid.mockResolvedValue(grid(10, 10, [0.1, 0.01]))
    const res = await readStac(e, AOI, { variable: 'vv' })
    expect(res.status).toBe('ok')
    expect(res.stats?.mean).toBeCloseTo(-15, 6)
    expect(res.stats?.unit).toBe('dB')
    expect(res.summary_data.unit).toBe('dB')
    expect(res.summary).toMatch(/VV polarisation/)
    expect(res.summary).toMatch(/mean \*\*-15\.00 dB\*\*/)
    expect(res.layer?.tileUrl).toContain('expression=10*log10%28vv%29')
    expect(res.layer?.tileUrl).toContain('colormap_name=greys_r')
    expect(res.layer?.aoiMask).toBe(true)
    expect(res.layer?.raster).toMatchObject({ kind: 'continuous', units: 'dB', stretch: 'p2-p98', colormap: 'greys_r' })
    const [lo, hi] = res.layer!.raster!.rescale![0]
    expect(lo).toBeGreaterThanOrEqual(-20); expect(hi).toBeLessThanOrEqual(-10)
  })

  it('drops non-positive linear values instead of turning them into -inf', async () => {
    const e = entry({ collection: 'sentinel-1-rtc', themes: ['sar'] })
    installFetch([searchRoute([item('S1B', { collection: 'sentinel-1-rtc', assets: ['vv'] })]), collectionRoute({ id: 'sentinel-1-rtc' })])
    grids.fetchCogFeatureGrid.mockResolvedValue(grid(4, 4, [0, 0.1, -3, 0.1]))
    const res = await readStac(e, AOI, { variable: 'vv' })
    expect(res.stats?.count).toBe(8)
    expect(res.stats?.min).toBeCloseTo(-10, 6)
  })
})

describe('readStac: DEM', () => {
  const dem = () => entry({ collection: 'cop-dem-glo-30', themes: ['elevation'], variables: [{ name: 'data' }] })
  it('reports elevation in metres with a terrain layer, and a hillshade layer on request', async () => {
    installFetch([searchRoute([item('DEM1', { collection: 'cop-dem-glo-30', datetime: '2021-04-22T00:00:00Z' })]), collectionRoute({ id: 'cop-dem-glo-30' })])
    grids.fetchCogFeatureGrid.mockResolvedValue(grid(10, 10, [200, 202, 204, 206, 208]))
    const res = await readStac(dem(), AOI, { hillshade: true })
    expect(res.status).toBe('ok')
    expect(res.stats).toMatchObject({ kind: 'continuous', unit: 'm', mean: 204, min: 200, max: 208 })
    expect(res.summary).toMatch(/Elevation over the AOI polygon/)
    expect(res.layer?.tileUrl).toContain('colormap_name=terrain')
    expect(res.layers?.[0].tileUrl).toContain('algorithm=hillshade')
    expect(res.coverage).toMatchObject({ verdict: 'covered', items_matched: 1 })
  })

  it('does not build layers when render is false', async () => {
    installFetch([searchRoute([item('DEM2', { collection: 'cop-dem-glo-30' })]), collectionRoute({ id: 'cop-dem-glo-30' })])
    grids.fetchCogFeatureGrid.mockResolvedValue(grid(4, 4, [10, 20]))
    const res = await readStac(dem(), AOI, { render: false })
    expect(res.layer).toBeUndefined()
    expect(res.stats?.mean).toBe(15)
  })

  it('mosaics neighbouring tiles of one acquisition without double counting overlap', async () => {
    const tiles = [item('N1', { collection: 'nasadem', datetime: '2000-02-20T00:00:00Z' }), item('N2', { collection: 'nasadem', datetime: '2000-02-20T00:00:00Z' })]
    installFetch([searchRoute(tiles), collectionRoute({ id: 'nasadem' })])
    grids.fetchCogFeatureGrid
      .mockResolvedValueOnce(grid(10, 2, [100], (i) => i % 10 < 6))  // covers columns 0-5
      .mockResolvedValueOnce(grid(10, 2, [300], (i) => i % 10 >= 4))  // covers columns 4-9 (overlaps 4-5)
    const res = await readStac(entry({ collection: 'nasadem', themes: ['elevation'] }), AOI, {})
    expect(res.stats?.count).toBe(20) // full window, overlap counted once
    expect(res.stats?.mean).toBeCloseTo((12 * 100 + 8 * 300) / 20, 6) // first valid pixel wins in the overlap
    expect(res.summary).toMatch(/2 neighbouring items of the same acquisition were mosaicked/)
    expect(res.coverage.aoi_valid_pct).toBeGreaterThan(90)
    expect(1 + (res.layers?.length ?? 0)).toBe(2)
  })
})

describe('readStac: categorical', () => {
  const wc = {
    id: 'esa-worldcover-test',
    item_assets: { map: { 'classification:classes': [{ value: 10, description: 'Tree cover', color_hint: '006400' }, { value: 40, description: 'Cropland', color_hint: 'f096ff' }, { value: 50, description: 'Built-up', color_hint: 'fa0000' }] } },
  }
  it('counts classes by the names the collection declares and colours the layer from them', async () => {
    installFetch([searchRoute([item('W1', { collection: 'esa-worldcover-test', assets: ['map', 'input_quality'] })]), collectionRoute(wc)])
    grids.fetchCogFeatureGrid.mockResolvedValue(grid(10, 10, [40, 40, 40, 10, 50]))
    const res = await readStac(entry({ collection: 'esa-worldcover-test', themes: ['land-cover'] }), AOI, { variable: 'map' })
    expect(res.stats?.kind).toBe('categorical')
    expect(res.stats?.classes?.map((c) => [c.name, c.pct])).toEqual([['Cropland', 60], ['Tree cover', 20], ['Built-up', 20]])
    expect(res.summary_data.dominant_class).toBe('Cropland')
    expect(res.summary_data.class_pct).toEqual([{ label: 'Cropland', value: 60 }, { label: 'Tree cover', value: 20 }, { label: 'Built-up', value: 20 }])
    expect(res.layer?.raster?.kind).toBe('categorical')
    const cm = JSON.parse(new URL(res.layer!.tileUrl!.replace('{z}/{x}/{y}', '0/0/0')).searchParams.get('colormap')!)
    expect(cm).toEqual({ '40': '#f096ff', '10': '#006400', '50': '#fa0000' })
  })

  it('reads a palette (colormapped) COG through the statistics endpoint instead of its RGBA expansion', async () => {
    installFetch([searchRoute([item('P1', { collection: 'esa-worldcover-test', assets: ['map'] })]), collectionRoute(wc)])
    grids.fetchCogFeatureGrid.mockResolvedValue(grid(4, 4, [240], undefined, 4)) // 3 bands + mask = titiler expanded the palette
    stats.fetchCogPolygonStats.mockResolvedValue({ mean: 37, count: 100, histogram: [[80, 20], [40, 10]] })
    const res = await readStac(entry({ collection: 'esa-worldcover-test' }), AOI, { variable: 'map' })
    expect(stats.fetchCogPolygonStats).toHaveBeenCalledWith(expect.stringContaining('?sig=1'), AOI.aoi, { categorical: 'true' })
    expect(res.stats?.classes?.map((c) => [c.name, c.count])).toEqual([['Cropland', 80], ['Tree cover', 20]])
    expect(res.provenance?.method).toMatch(/POST \/cog\/statistics/)
    expect(res.coverage.aoi_valid_pct).toBeUndefined()
  })

  it('reports continuous palette COGs from raw statistics (never the colours)', async () => {
    installFetch([searchRoute([item('P2', { collection: 'jrc-gsw-test', assets: ['occurrence'] })]), collectionRoute({ id: 'jrc-gsw-test' })])
    grids.fetchCogFeatureGrid.mockResolvedValue(grid(4, 4, [255], undefined, 4))
    stats.fetchCogPolygonStats.mockResolvedValue({ mean: 0.0017, min: 0, max: 7, std: 0.07, median: 0, count: 14400, valid_pixels: 14400, percentile_2: 0, percentile_98: 0 })
    const res = await readStac(entry({ collection: 'jrc-gsw-test', themes: ['water'] }), AOI, { variable: 'occurrence' })
    expect(res.stats).toMatchObject({ kind: 'continuous', max: 7, count: 14400 })
    expect(res.stats?.max).toBeLessThanOrEqual(100)
  })
})

describe('readStac: failures are stated', () => {
  it('says the dataset has no items over the AOI (declared extent is not coverage)', async () => {
    installFetch([searchRoute([])])
    const res = await readStac(entry({ collection: 'empty-one' }), AOI, {})
    expect(res.status).toBe('no_coverage')
    expect(res.summary).toMatch(/declared extent is not coverage/)
    expect(res.stats).toBeNull()
  })

  it('does not fall back to other dates when an explicit period has no items', async () => {
    const { calls } = installFetch([searchRoute([])])
    const res = await readStac(entry({ collection: 'periodic' }), AOI, { start: '2019', end: '2019' })
    expect(res.status).toBe('no_coverage')
    expect(res.summary).toMatch(/requested period/)
    expect(calls.filter((c) => /search/.test(c.url))).toHaveLength(1)
  })

  it('falls back to the nearest acquisition for a single target date and says so', async () => {
    const early = item('E1', { collection: 'sparse', datetime: '2020-01-01T00:00:00Z' })
    installFetch([
      { match: (u, i) => /\/search$/.test(u) && i?.method === 'POST', respond: (_u, i) => json({ features: JSON.parse(String(i!.body)).datetime ? [] : [early] }) },
      collectionRoute({ id: 'sparse' }),
    ])
    grids.fetchCogFeatureGrid.mockResolvedValue(grid(4, 4, [5]))
    const res = await readStac(entry({ collection: 'sparse' }), AOI, { date: '2024-06-01' })
    expect(res.status).toBe('ok')
    expect(res.summary).toMatch(/No item within 45 days of 2024-06-01/)
    expect(res.summary_data.date).toBe('2020-01-01')
  })

  it('reports a search outage as an error, not as empty data', async () => {
    installFetch([searchRoute([], 500)])
    const res = await readStac(entry({ collection: 'down' }), AOI, {})
    expect(res.status).toBe('error')
    expect(res.summary).toMatch(/unreachable or refused/)
  })

  it('lists the available assets when the requested variable does not exist', async () => {
    installFetch([searchRoute([item('X', { collection: 'multi', assets: ['red', 'nir'] })]), collectionRoute({ id: 'multi' })])
    const res = await readStac(entry({ collection: 'multi' }), AOI, { variable: 'swir' })
    expect(res.status).toBe('error')
    expect(res.summary).toMatch(/No asset or band matches variable "swir"\. Available: red, nir/)
  })

  it('reports an AOI that falls between footprints as no valid pixels, with no statistic', async () => {
    installFetch([searchRoute([item('G', { collection: 'gap' })]), collectionRoute({ id: 'gap' })])
    grids.fetchCogFeatureGrid.mockResolvedValue(grid(4, 4, [1], () => false))
    const res = await readStac(entry({ collection: 'gap' }), AOI, {})
    expect(res.status).toBe('error')
    expect(res.stats).toBeNull()
    expect(res.summary).toMatch(/no valid pixels/)
  })
})

describe('readStac: gated hosts (NASA Earthdata, Copernicus)', () => {
  const cmr = () => entry({
    id: 'cmr:ASF/ALOS2_L1_PSR2_1', source: 'cmr', collection: 'ALOS2_L1_PSR2_1', root: 'https://cmr.earthdata.nasa.gov/stac/ASF',
    access: { kind: 'stac-other', url: 'https://cmr.earthdata.nasa.gov/stac/ASF/collections/ALOS2_L1_PSR2_1', requires_auth: 'earthdata', notes: '' },
  })
  const granule = { ...item('ALOS2022943000', { datetime: '2014-10-26T07:01:28Z', assets: [] }), assets: { '1__D': { href: 'https://cumulus.asf.earthdatacloud.nasa.gov/L1.1/a.zip', type: 'application/zip' } } }

  it('without a token: searches the public STAC for real granule facts, reads no pixels, says what is needed', async () => {
    delete process.env.EARTHDATA_TOKEN
    installFetch([searchRoute([granule, { ...granule, id: 'G2' }])])
    const res = await readStac(cmr(), AOI, {})
    expect(res.status).toBe('auth_required')
    expect(res.needs).toBe('EARTHDATA_TOKEN')
    expect(res.summary).toMatch(/requires a free NASA Earthdata token/)
    expect(res.summary).toMatch(/EARTHDATA_TOKEN/)
    expect(res.summary).toMatch(/found \*\*2 granule\(s\)\*\*/)
    expect(res.stats).toBeNull()
    expect(res.layer).toBeUndefined()
    expect(grids.fetchCogFeatureGrid).not.toHaveBeenCalled()
  })

  it('with a token the data host rejects anonymously: states that the hosted titiler cannot forward the bearer', async () => {
    process.env.EARTHDATA_TOKEN = 'tok'
    const cog = { ...item('C1', { datetime: '2024-01-01T00:00:00Z', assets: ['data'] }) }
    cog.assets.data.href = 'https://data.lpdaac.earthdatacloud.nasa.gov/x.tif'
    installFetch([
      searchRoute([cog]),
      {
        match: (u) => /data\.lpdaac/.test(u),
        respond: (_u, init) => ((init?.headers as any)?.Authorization === 'Bearer tok'
          ? new Response('x', { status: 206, headers: { 'content-type': 'image/tiff' } })
          : new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } })),
      },
    ])
    const res = await readStac(cmr(), AOI, {})
    expect(res.status).toBe('unavailable')
    expect(res.summary).toMatch(/credential found, but pixels cannot be read in-app/)
    expect(res.summary).toMatch(/accepted by the data host \(HTTP 206\)/)
    expect(res.summary).toMatch(/cannot forward an Authorization header/)
    expect(grids.fetchCogFeatureGrid).not.toHaveBeenCalled()
  })

  it('same pattern for Copernicus Data Space (CDSE_TOKEN)', async () => {
    delete process.env.CDSE_TOKEN
    const e = entry({
      id: 'cdse:sentinel-2-l2a', source: 'cdse', collection: 'sentinel-2-l2a', root: 'https://stac.dataspace.copernicus.eu/v1',
      access: { kind: 'stac-other', url: 'https://stac.dataspace.copernicus.eu/v1/collections/sentinel-2-l2a', requires_auth: 'copernicus', notes: '' },
    })
    installFetch([searchRoute([{ ...item('S2X'), assets: { B04: { href: 's3://eodata/x/B04.jp2', type: 'image/jp2' } } }])])
    const res = await readStac(e, AOI, {})
    expect(res.status).toBe('auth_required')
    expect(res.needs).toBe('CDSE_TOKEN')
    expect(res.summary).toMatch(/Copernicus Data Space/)
  })
})

describe('readStac: optical clarity', () => {
  const optical = () => entry({ collection: 'sentinel-2-l2a', themes: ['optical'] })
  const s2 = (id: string, datetime: string) => item(id, { collection: 'sentinel-2-l2a', datetime, assets: ['B04', 'SCL'] })

  it('chooses the clear scene over the newer cloudy one and masks cloud pixels per pixel', async () => {
    installFetch([searchRoute([s2('NEW_CLOUDY', '2026-10-05T00:00:00Z'), s2('OLD_CLEAR', '2026-09-20T00:00:00Z')]), collectionRoute({ id: 'sentinel-2-l2a' })])
    grids.fetchCogFeatureGrid.mockImplementation(async ({ cogUrl, maxSize }: any) => {
      if (/NEW_CLOUDY\/SCL/.test(cogUrl)) return grid(10, 10, [9]) // cloud high probability everywhere
      if (/OLD_CLEAR\/SCL/.test(cogUrl)) return grid(10, 10, [4, 4, 4, 9]) // 75% vegetation, 25% cloud
      if (/OLD_CLEAR\/B04/.test(cogUrl)) return grid(10, 10, [1000, 1000, 1000, 9999]) // cloud pixels carry bright DN
      throw new Error(`unexpected read ${cogUrl} ${maxSize}`)
    })
    const res = await readStac(optical(), AOI, { variable: 'B04' })
    expect(res.status).toBe('ok')
    expect(res.summary_data.date).toBe('2026-09-20')
    expect(res.stats?.mean).toBe(1000) // the 9999 DN cloud pixels were excluded
    expect(res.summary).toMatch(/Cloud screening: 75% of the AOI was clear/)
  })

  it('refuses honestly when every candidate scene is cloudy', async () => {
    installFetch([searchRoute([s2('C1', '2026-10-05T00:00:00Z'), s2('C2', '2026-10-01T00:00:00Z')]), collectionRoute({ id: 'sentinel-2-l2a' })])
    grids.fetchCogFeatureGrid.mockResolvedValue(grid(10, 10, [9]))
    const res = await readStac(optical(), AOI, { variable: 'B04' })
    expect(res.status).toBe('no_coverage')
    expect(res.summary).toMatch(/No usable optical scene/)
    expect(res.stats).toBeNull()
  })
})
