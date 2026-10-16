/** Routing of registry entries to readers, REST passthrough, and the honest not-readable-yet results. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readDataset } from '../index'
import { readRest } from '../rest'
import { REST_TOOLS, readability, routeFor } from '../routing'
import { readUnavailable } from '../unavailable'
import { AOI, entry } from './fixtures'

afterEach(() => { vi.unstubAllGlobals(); delete process.env.GFW_API_KEY })

const rest = (id: string) => entry({ id, source: id.split(':')[0], title: id, access: { kind: 'rest', url: 'https://api.example.org', requires_auth: null, notes: '' } })

describe('routeFor', () => {
  it('sends each access kind to its reader', () => {
    expect(routeFor(entry({ collection: 'x' }))).toBe('stac')
    expect(routeFor(entry({ access: { kind: 'stac-other', url: 'u', requires_auth: 'earthdata', notes: '' } }))).toBe('stac')
    expect(routeFor(entry({ id: 'planetary-computer:3dep-lidar-hag' }))).toBe('lidar-derived')
    expect(routeFor(entry({ id: 'planetary-computer:3dep-lidar-copc' }))).toBe('lidar-pointcloud')
    expect(routeFor(entry({ id: 'usgs-3dep:lidar-ept', access: { kind: 'ept', url: 'u', requires_auth: null, notes: '' } }))).toBe('lidar-pointcloud')
    expect(routeFor(entry({ id: 'opentopography:1', source: 'opentopography', access: { kind: 'rest', url: 'u', requires_auth: 'opentopography', notes: '' } }))).toBe('lidar-pointcloud')
    expect(routeFor(entry({ access: { kind: 'earthengine', url: 'u', requires_auth: 'earthengine', notes: '' } }))).toBe('earthengine')
    expect(routeFor(entry({ access: { kind: 'geoparquet', url: 'u', requires_auth: null, notes: '' } }))).toBe('geoparquet')
    expect(routeFor(rest('open-meteo:era5-archive'))).toBe('rest-tool')
    expect(routeFor(rest('gfw:thing'))).toBe('rest-other')
    for (const kind of ['stac-zarr', 'zarr', 'openeo', 'cog'] as const) {
      expect(routeFor(entry({ access: { kind, url: 'u', requires_auth: null, notes: '' } }))).toBe('unavailable')
    }
  })

  it('describes what use_dataset will do, for find_dataset', () => {
    const none = () => false
    expect(readability(entry({ collection: 'x' }), none).state).toBe('readable')
    expect(readability(entry({ access: { kind: 'stac-other', url: 'u', requires_auth: 'earthdata', notes: '' } }), none).state).toBe('auth')
    expect(readability(entry({ access: { kind: 'stac-other', url: 'u', requires_auth: 'earthdata', notes: '' } }), () => true).state).toBe('readable')
    expect(readability(entry({ access: { kind: 'earthengine', url: 'u', requires_auth: 'earthengine', notes: '' } }), none).note).toMatch(/GEE_KEY_FILE/)
    expect(readability(entry({ access: { kind: 'stac-zarr', url: 'u', requires_auth: null, notes: '' } }), none).note).toMatch(/Q-22/)
    expect(readability(entry({ id: 'planetary-computer:3dep-lidar-copc' }), none).state).toBe('info-only')
  })
})

describe('REST passthrough', () => {
  it.each(Object.entries(REST_TOOLS))('%s -> %s, result returned untouched', async (id, tool) => {
    const runTool = vi.fn(async () => ({ summary: `tool says hi from ${tool}`, summary_data: { clay_pct: 20 }, layer: { id: 'l', name: 'n', type: 'geojson' as const } }))
    const res = await readRest(rest(id), AOI, { runTool })
    expect(runTool).toHaveBeenCalledWith(tool, {})
    expect(res.status).toBe('ok')
    expect(res.passthrough?.layer?.id).toBe('l')
    expect(res.summary).toContain(`tool says hi from ${tool}`)
    expect(res.summary_data).toMatchObject({ clay_pct: 20, routed_to: tool })
  })

  it('routes Open-Meteo ERA5 to the precipitation tool when asked for rainfall', async () => {
    const runTool = vi.fn(async () => ({ summary: 'rain' }))
    await readRest(rest('open-meteo:era5-archive'), AOI, { runTool, variable: 'precipitation' })
    expect(runTool).toHaveBeenCalledWith('fetch_precipitation_history', {})
  })

  it('has no fake fallback: an Open-Meteo endpoint with no tool says so', async () => {
    const res = await readRest(rest('open-meteo:marine'), AOI, { runTool: vi.fn() })
    expect(res.status).toBe('unavailable')
    expect(res.stats).toBeNull()
    expect(res.summary).toMatch(/No in-app reader/)
  })

  it('GFW needs its API key first, and reports it', async () => {
    delete process.env.GFW_API_KEY; delete process.env.FIRMS_MAP_KEY; delete process.env.OPENAQ_API_KEY
    const e = entry({ id: 'gfw:tree_cover', source: 'gfw', access: { kind: 'rest', url: 'https://data-api.globalforestwatch.org/dataset/tree_cover', requires_auth: 'api-key', notes: '' } })
    const res = await readRest(e, AOI, {})
    expect(res.status).toBe('auth_required')
    expect(res.needs).toBe('GFW_API_KEY')
  })

  it('errors honestly when no dispatcher was supplied', async () => {
    const res = await readRest(rest('open-meteo:era5-archive'), AOI, {})
    expect(res.status).toBe('error')
  })
})

describe('not readable in-app yet (no fake numbers)', () => {
  it('Zarr: names the Python geo service (Q-22), gives the open recipe, keeps the variables', async () => {
    const e = entry({ id: 'arco-era5:pressure-levels', title: 'ARCO-ERA5', variables: [{ name: '2m_temperature', unit: 'K' }], access: { kind: 'zarr', url: 'gs://gcp-public-data-arco-era5/ar/full.zarr', requires_auth: null, notes: '' } })
    const res = await readUnavailable(e, AOI, {})
    expect(res.status).toBe('unavailable')
    expect(res.needs).toBe('python-geo-service-Q-22')
    expect(res.summary).toMatch(/queue Q-22/)
    expect(res.summary).toContain('xr.open_zarr("gs://gcp-public-data-arco-era5/ar/full.zarr")')
    expect(res.summary).toContain('2m_temperature [K]')
    expect(res.stats).toBeNull()
    expect(res.layer).toBeUndefined()
    expect(Object.keys(res.summary_data)).not.toContain('mean')
  })

  it('openEO: needs an account, gives the back end', async () => {
    const e = entry({ id: 'openeo-cdse:CLMS_BA', source: 'openeo-cdse', access: { kind: 'openeo', url: 'https://openeo.dataspace.copernicus.eu/openeo/1.2/collections/CLMS_BA', requires_auth: 'copernicus', notes: '' } })
    const res = await readDataset(e, AOI, {})
    expect(res.status).toBe('unavailable')
    expect(res.needs).toBe('openeo-account')
    expect(res.summary).toContain('https://openeo.dataspace.copernicus.eu/openeo/1.2')
  })
})
