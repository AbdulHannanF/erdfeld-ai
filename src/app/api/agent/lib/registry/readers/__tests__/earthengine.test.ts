/** Earth Engine reader: honest without credentials, mapped result with them. The EE client itself is mocked. */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const gee = vi.hoisted(() => ({ isGeeConfigured: vi.fn(), geeReadAsset: vi.fn() }))
vi.mock('../../../gee', () => gee)

import { eeAssetId, eeWindow, readEarthEngine } from '../earthengine'
import { AOI, entry } from './fixtures'

const ee = entry({
  id: 'gee:CIESIN/GPWv411/GPW_Population_Density', source: 'gee', title: 'GPWv4 Population Density', themes: ['population'],
  variables: [{ name: 'population_density', unit: 'people/km²' }], temporal: { start: '2000-01-01', end: '2020-01-01' }, resolution_m: 927, license: 'CC-BY-4.0',
  access: { kind: 'earthengine', url: 'https://developers.google.com/earth-engine/datasets/catalog/CIESIN_GPWv411_GPW_Population_Density', requires_auth: 'earthengine', notes: '' },
})

beforeEach(() => { gee.isGeeConfigured.mockReset(); gee.geeReadAsset.mockReset() })

describe('earthengine reader', () => {
  it('without credentials: says so, names GEE_KEY_FILE, the asset id and the catalog page, and computes nothing', async () => {
    gee.isGeeConfigured.mockReturnValue(false)
    const res = await readEarthEngine(ee, AOI, {})
    expect(res.status).toBe('auth_required')
    expect(res.needs).toBe('GEE_KEY_FILE')
    expect(res.summary).toMatch(/Earth Engine credentials not configured \(GEE_KEY_FILE\)/)
    expect(res.summary).toContain('CIESIN/GPWv411/GPW_Population_Density')
    expect(res.summary).toContain('developers.google.com/earth-engine/datasets/catalog/CIESIN_GPWv411_GPW_Population_Density')
    expect(res.stats).toBeNull()
    expect(res.layer).toBeUndefined()
    expect(gee.geeReadAsset).not.toHaveBeenCalled()
  })

  it('with credentials: passes the asset, band, window and scale, and maps statistics plus a legend-bearing layer', async () => {
    gee.isGeeConfigured.mockReturnValue(true)
    gee.geeReadAsset.mockResolvedValue({
      assetType: 'IMAGE_COLLECTION', band: 'population_density', bands: ['population_density', 'other'], scaleM: 927,
      stats: { mean: 1234.5, min: 800, max: 2000, std: 200, p2: 900, p98: 1800 }, tileUrl: 'https://earthengine.googleapis.com/v1/x/tiles/{z}/{x}/{y}',
      window: { start: '2019-01-01', end: '2020-01-01' },
    })
    const res = await readEarthEngine(ee, AOI, { variable: 'population_density' })
    expect(gee.geeReadAsset).toHaveBeenCalledWith(AOI.aoi, expect.objectContaining({ assetId: 'CIESIN/GPWv411/GPW_Population_Density', band: 'population_density', start: '2019-01-01', end: '2020-01-01', scaleM: 927 }))
    expect(res.status).toBe('ok')
    expect(res.stats).toMatchObject({ kind: 'continuous', mean: 1234.5, unit: 'people/km²', p98: 1800 })
    expect(res.layer?.tileUrl).toContain('earthengine.googleapis.com')
    expect(res.layer?.palette).toMatchObject({ kind: 'gradient', min: 900, max: 1800 })
    expect(res.layer?.raster).toBeUndefined() // no titiler params to restyle on an EE url
    expect(res.summary_data).toMatchObject({ mean: 1234.5, band: 'population_density', window_end: '2020-01-01' })
  })

  it('relays an Earth Engine failure as an error with no numbers', async () => {
    gee.isGeeConfigured.mockReturnValue(true)
    gee.geeReadAsset.mockResolvedValue({ error: 'Earth Engine returned no valid pixels for "x" band b over this polygon' })
    const res = await readEarthEngine(ee, AOI, {})
    expect(res.status).toBe('error')
    expect(res.stats).toBeNull()
    expect(res.summary).toMatch(/no valid pixels/)
  })

  it('derives asset id and a one-year window ending at the dataset end', () => {
    expect(eeAssetId(ee)).toBe('CIESIN/GPWv411/GPW_Population_Density')
    expect(eeWindow(ee, {})).toEqual({ start: '2019-01-01', end: '2020-01-01' })
    expect(eeWindow(ee, { date: '2020-06-15' })).toEqual({ start: '2020-05-31', end: '2020-06-30' })
    expect(eeWindow(ee, { start: '2018', end: '2018' })).toEqual({ start: '2018-01-01', end: '2018-12-31' })
  })
})
