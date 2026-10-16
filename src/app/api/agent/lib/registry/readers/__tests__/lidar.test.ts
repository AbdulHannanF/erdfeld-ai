/** Lidar readers: 3DEP derived rasters (with the HAG sanity check), point-cloud metadata, OpenTopography. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const grids = vi.hoisted(() => ({ fetchCogFeatureGrid: vi.fn() }))
vi.mock('../../../pixels', async (orig) => ({ ...(await orig<typeof import('../../../pixels')>()), fetchCogFeatureGrid: grids.fetchCogFeatureGrid }))
vi.mock('../../../stac', async (orig) => ({ ...(await orig<typeof import('../../../stac')>()), signPCAsset: async (h: string) => `${h}?sig=1` }))

import { copcDensity, hagLooksWrong, lidarProfile, otCatalog, readLidarDerived, readPointCloud, ASPRS_CLASSES } from '../lidar'
import { DENVER, entry, grid, installFetch, item, json } from './fixtures'

beforeEach(() => { grids.fetchCogFeatureGrid.mockReset() })
afterEach(() => vi.unstubAllGlobals())

const PROJECT = 'USGS_LPC_CO_TEST_2013'
const lidarEntry = (kind: string) => entry({
  id: `planetary-computer:3dep-lidar-${kind}`, collection: `3dep-lidar-${kind}`, themes: ['lidar', 'elevation'],
  spatial: { bbox: [-166.85, 17.66, -64.56, 71.39], global: false }, variables: [{ name: 'data', unit: 'metre' }],
})
const tile = (collection: string, id: string) => item(`${PROJECT}-${id}`, {
  collection, datetime: null, assets: ['data'],
  props: { 'start_datetime': '2013-10-25T00:00:00Z', 'end_datetime': '2014-05-31T00:00:00Z', '3dep:usgs_id': PROJECT },
})
const byCollection = (map: Record<string, any[]>) => ({
  match: (u: string, i?: RequestInit) => /\/search$/.test(u) && i?.method === 'POST',
  respond: (_u: string, i?: RequestInit) => json({ features: map[JSON.parse(String(i!.body)).collections[0]] ?? [] }),
})
const OT_EMPTY = { match: (u: string) => /otCatalog/.test(u), respond: () => json({ Datasets: [] }) }

describe('profiles and small helpers', () => {
  it('knows when a HAG raster contradicts DSM minus DTM', () => {
    expect(hagLooksWrong({ mean: 89, p95: 358 }, { mean: 6.6, p95: 24.9 })).toBe(true) // downtown Denver, measured
    expect(hagLooksWrong({ mean: 7.95, p95: 29.7 }, { mean: 3.7, p95: 21.8 })).toBe(false) // Washington DC, measured
    expect(hagLooksWrong({ mean: 10, p95: 30 }, { mean: 10, p95: 30 })).toBe(false)
  })

  it('computes COPC point density from pc:count and the projected tile bbox', () => {
    const t = { properties: { 'pc:count': 11463220, 'proj:bbox': [501000.01, 4399500, 1285.58, 502500, 4401000, 2184.17] } }
    expect(copcDensity(t)).toBeCloseTo(11463220 / (1499.99 * 1500), 3)
    expect(copcDensity({ properties: {} })).toBeNull()
  })

  it('gives each derived raster its own label, and classification the ASPRS vocabulary', () => {
    expect(lidarProfile(lidarEntry('hag'))).toMatchObject({ height: true, unit: 'm' })
    expect(lidarProfile(lidarEntry('dsm')).label).toMatch(/DSM/)
    expect(lidarProfile(lidarEntry('classification')).classes).toBe(ASPRS_CLASSES)
    expect(ASPRS_CLASSES.find((c) => c.value === 6)?.name).toBe('Building')
  })
})

describe('OpenTopography catalog (no key)', () => {
  it('parses datasets and builds links by identifier kind', async () => {
    installFetch([{
      match: (u) => /otCatalog/.test(u),
      respond: (u) => {
        expect(u).toMatch(/productFormat=PointCloud&minx=-104\.995&miny=39\.735&maxx=-104\.975&maxy=39\.75/)
        return json({ Datasets: [
          { Dataset: { name: 'CO DRCOG 2 2020', identifier: { propertyID: 'USGS_3DEP_ID', value: 'CO_DRCOG_2_2020' }, fileFormat: 'Point Cloud Data', temporalCoverage: '2020-05-26 / 2020-06-12', dateCreated: '2021-12-23' } },
          { Dataset: { name: 'Lidar: Somewhere', identifier: { propertyID: 'opentopoID', value: 'OT.1234' }, fileFormat: 'Point Cloud Data', temporalCoverage: '2017-04-22 / 2017-04-25' } },
        ] })
      },
    }])
    const ot = await otCatalog(DENVER.bbox, 'PointCloud')
    expect(ot.ok && ot.datasets.map((d) => d.url)).toEqual([
      'https://usgs-lidar-public.s3.amazonaws.com/CO_DRCOG_2_2020/ept.json',
      'https://portal.opentopography.org/lidarDataset?opentopoID=OT.1234',
    ])
    expect(ot.ok && ot.datasets[0].temporal).toBe('2020-05-26 to 2020-06-12')
  })

  it('reports a failed lookup as a failure, not as "no lidar"', async () => {
    installFetch([{ match: (u) => /otCatalog/.test(u), respond: () => new Response('x', { status: 503 }) }])
    const ot = await otCatalog(DENVER.bbox, 'PointCloud')
    expect(ot).toEqual({ ok: false, error: 'OpenTopography catalog answered HTTP 503' })
  })
})

describe('3DEP height above ground', () => {
  const setup = (hag: number, dsm: number, dtm: number) => {
    installFetch([byCollection({
      '3dep-lidar-hag': [tile('3dep-lidar-hag', 'hag-2m-6-7')],
      '3dep-lidar-dsm': [tile('3dep-lidar-dsm', 'dsm-2m-6-7')],
      '3dep-lidar-dtm': [tile('3dep-lidar-dtm', 'dtm-2m-6-7')],
    }), { match: (u) => /\/collections\/3dep-lidar-hag$/.test(u), respond: () => json({ id: '3dep-lidar-hag' }) }, OT_EMPTY])
    grids.fetchCogFeatureGrid.mockImplementation(async ({ cogUrl }: any) => {
      if (/hag-2m/.test(cogUrl)) return grid(10, 10, [hag])
      if (/dsm-2m/.test(cogUrl)) return grid(10, 10, [dsm])
      if (/dtm-2m/.test(cogUrl)) return grid(10, 10, [dtm])
      throw new Error(`unexpected ${cogUrl}`)
    })
  }

  it('keeps the HAG tile layer and says so when DSM - DTM agrees', async () => {
    setup(11, 1610, 1600)
    const res = await readLidarDerived(lidarEntry('hag'), DENVER, { variable: 'canopy height' })
    expect(res.status).toBe('ok')
    expect(res.summary_data.hag_cross_check).toBe('consistent')
    expect(res.summary_data.mean_height_m).toBe(11)
    expect(res.summary_data.ndsm_mean_m).toBe(10)
    expect(res.layer?.tileUrl).toContain('collection=3dep-lidar-hag')
    expect(res.layer?.tileUrl).toContain('rescale=0%2C')
    expect(res.summary).toMatch(/Cross-check: DSM minus DTM .* consistent/)
  })

  it('replaces an implausible HAG raster with DSM - DTM, keeps the raw HAG numbers out of the height fields, and renders an image layer', async () => {
    setup(100, 1610, 1600)
    const res = await readLidarDerived(lidarEntry('hag'), DENVER, {})
    expect(res.status).toBe('ok')
    expect(res.summary_data).toMatchObject({ height_source: 'dsm_minus_dtm', mean_height_m: 10, p95_height_m: 10, hag_raster_mean_m: 100, hag_cross_check: 'inconsistent' })
    expect(res.stats).toMatchObject({ kind: 'continuous', unit: 'm', mean: 10 })
    expect(res.summary).toMatch(/the HAG raster looks wrong here, so height comes from DSM minus DTM/)
    expect(res.layer?.imageBase64?.startsWith('iVBOR')).toBe(true) // PNG signature
    expect(res.layer?.tileUrl).toBeUndefined()
    expect(res.layer?.palette).toMatchObject({ kind: 'gradient', unit: 'm' })
  })

  it('floors negative differences at zero', async () => {
    setup(100, 1599, 1600)
    const res = await readLidarDerived(lidarEntry('hag'), DENVER, {})
    // HAG 100 vs nDSM 0 -> flagged; nDSM clipped to 0, never negative.
    expect(res.summary_data.min).toBe(0)
    expect(res.summary_data.mean_height_m).toBe(0)
  })

  it('says it was not cross-checked when the project has no DSM/DTM pair, and still reports non-negative heights', async () => {
    installFetch([byCollection({ '3dep-lidar-hag': [tile('3dep-lidar-hag', 'hag-2m-6-7')] }), { match: (u) => /\/collections\//.test(u), respond: () => json({ id: 'x' }) }])
    grids.fetchCogFeatureGrid.mockResolvedValue(grid(10, 10, [-3, 5, 12]))
    const res = await readLidarDerived(lidarEntry('hag'), DENVER, {})
    expect(res.summary).toMatch(/Not cross-checked/)
    expect(res.stats?.min).toBe(0)
  })

  it('on no items inside the US it points to other lidar sources', async () => {
    installFetch([byCollection({}), { match: (u) => /\/collections\//.test(u), respond: () => json({ id: 'x' }) }, OT_EMPTY])
    const res = await readLidarDerived(lidarEntry('dsm'), DENVER, {})
    expect(res.status).toBe('no_coverage')
    expect(res.summary).toMatch(/Other lidar sources/)
  })
})

describe('point-cloud metadata (no renderer)', () => {
  it('summarises 3DEP COPC coverage, density, years and projects, links the derived rasters, and computes no point statistics', async () => {
    const copc = (id: string, count: number, project: string, end: string) => ({
      id, properties: { 'pc:count': count, 'proj:bbox': [0, 0, 0, 1000, 1000, 100], '3dep:usgs_id': project, start_datetime: '2013-10-25T00:00:00Z', end_datetime: end },
      assets: { data: { href: `https://blob/${id}.copc.laz?x=1` } },
    })
    installFetch([
      byCollection({ '3dep-lidar-copc': [copc('A1', 4_000_000, PROJECT, '2014-05-31T00:00:00Z'), copc('A2', 6_000_000, PROJECT, '2014-05-31T00:00:00Z'), copc('B1', 2_000_000, 'CO_OLD_2008', '2008-04-19T00:00:00Z')] }),
      { match: (u) => /ept\.json$/.test(u), respond: (u) => (u.includes(PROJECT) ? json({ points: 33_000_000_000 }) : new Response('nope', { status: 404 })) },
      { match: (u) => /otCatalog/.test(u), respond: () => json({ Datasets: [{ Dataset: { name: 'CO DRCOG 2 2020', identifier: { propertyID: 'USGS_3DEP_ID', value: 'CO_DRCOG_2_2020' }, fileFormat: 'Point Cloud Data', temporalCoverage: '2020-05-26 / 2020-06-12' } }] }) },
    ])
    const e = entry({ id: 'planetary-computer:3dep-lidar-copc', collection: '3dep-lidar-copc', themes: ['lidar'], access: { kind: 'stac-other', url: 'https://planetarycomputer.microsoft.com/api/stac/v1/collections/3dep-lidar-copc', requires_auth: null, notes: '' } })
    const res = await readPointCloud(e, DENVER, {})
    expect(res.status).toBe('ok')
    expect(res.stats?.kind).toBe('metadata')
    expect(res.summary_data).toMatchObject({ read: 'metadata', copc_tiles: 3, projects: 2, point_density_median_pts_m2: 4, acquired_first: '2008-04-19', acquired_last: '2014-05-31', opentopography_surveys: 1 })
    expect(res.layer).toBeUndefined()
    expect(res.summary).toMatch(/33,000,000,000 points project-wide/)
    expect(res.summary).toMatch(/3dep-lidar-hag/)
    expect(res.summary).toMatch(/Not done in-app/)
    expect(res.summary).toMatch(/CO DRCOG 2 2020/)
  })

  it('reports no lidar when neither 3DEP nor OpenTopography has any here', async () => {
    installFetch([byCollection({}), OT_EMPTY])
    const e = entry({ id: 'planetary-computer:3dep-lidar-copc', collection: '3dep-lidar-copc', themes: ['lidar'] })
    const res = await readPointCloud(e, DENVER, {})
    expect(res.status).toBe('no_coverage')
    expect(res.summary_data.read).toBe('no_coverage')
  })

  it('an OpenTopography survey entry: metadata, and the API key it would need', async () => {
    delete process.env.OPENTOPO_API_KEY
    installFetch([OT_EMPTY])
    const e = entry({
      id: 'opentopography:10005', source: 'opentopography', title: '2017 USGS Lidar: Forest County, WI', themes: ['lidar'],
      spatial: { bbox: [-89.05, 45.38, -88.42, 46.08], global: false }, temporal: { start: '2017-04-22', end: '2017-04-25' },
      access: { kind: 'rest', url: 'https://portal.opentopography.org/lidarDataset?opentopoID=10005', requires_auth: 'opentopography', notes: '' },
    })
    const wisconsin = { ...DENVER, bbox: [-88.9, 45.5, -88.8, 45.6] as [number, number, number, number] }
    const res = await readPointCloud(e, wisconsin, {})
    expect(res.status).toBe('ok')
    expect(res.summary).toMatch(/Download needs an OpenTopography API key \(OPENTOPO_API_KEY, not set here\)/)
    expect(res.stats?.kind).toBe('metadata')
  })
})
