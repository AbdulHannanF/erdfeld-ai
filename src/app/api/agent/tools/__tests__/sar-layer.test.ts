/** fetch_sar returns a real Sentinel-1 RTC raster in dB (VV, and VH when the pass has it), stretched to
 *  the AOI's own percentiles with a legend, instead of one flat polygon shaded by a mean. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/flood/scenes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/flood/scenes')>()
  return { ...actual, searchS1Rtc: vi.fn(), readSceneDb: vi.fn() }
})
vi.mock('../../lib/stac', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stac')>()
  return { ...actual, searchPlanetaryComputer: vi.fn(async () => ({ features: [] })) }
})

import { readSceneDb, searchS1Rtc } from '../../lib/flood/scenes'
import { sarDbStats, sarStretch } from '../../lib/sar-layer'
import { readTileStyle } from '@/lib/raster-style'
import { fetchSar } from '../satellite'

const AOI = { type: 'Polygon', coordinates: [[[74.5, 30.9], [74.6, 30.9], [74.6, 31.0], [74.5, 31.0], [74.5, 30.9]]] }
const BBOX: [number, number, number, number] = [74.5, 30.9, 74.6, 31.0]
const ctx = (): any => ({ aoi: AOI, bbox: BBOX, centroid: { lat: 30.95, lng: 74.55 }, areaKm2: 100, emit: vi.fn(), runTool: vi.fn() })

const item = (id: string, datetime: string, vh = true) => ({
  id, bbox: [74, 30, 75, 32], properties: { datetime, platform: 'sentinel-1a', 'sat:relative_orbit': 100, 'sat:orbit_state': 'ascending', 'sar:instrument_mode': 'IW' },
  assets: { vv: { href: `https://blob/${id}-vv.tif` }, ...(vh ? { vh: { href: `https://blob/${id}-vh.tif` } } : {}) },
})
/** n x n dB grid with a left-to-right ramp from `lo` to `hi`; `nanShare` of the pixels have no data. */
const dbGrid = (lo: number, hi: number, nanShare = 0, n = 20) => {
  const db = new Float32Array(n * n)
  for (let i = 0; i < db.length; i++) db[i] = i < db.length * nanShare ? NaN : lo + ((i % n) / (n - 1)) * (hi - lo)
  return { db, width: n, height: n }
}

beforeEach(() => {
  vi.mocked(searchS1Rtc).mockReset().mockResolvedValue({ ok: true, items: [item('S1A_OLD', '2026-09-01T00:00:00Z'), item('S1A_NEW', '2026-09-13T00:00:00Z')] })
  vi.mocked(readSceneDb).mockReset().mockImplementation(async (_scene, _geom, _max, pol) => (pol === 'VV' ? dbGrid(-22, -6) : dbGrid(-30, -14)))
})
afterEach(() => vi.clearAllMocks())

describe('sarDbStats / sarStretch', () => {
  it('averages power, not decibels, and reports the percentiles of the dB values', () => {
    const s = sarDbStats(Float32Array.from([-10, -10, -20, NaN]), 4)!
    expect(s.n).toBe(3)
    expect(s.meanDb).toBeCloseTo(10 * Math.log10((0.1 + 0.1 + 0.01) / 3), 6) // -11.55, not the dB mean -13.33
    expect(s.coveragePct).toBe(75)
    expect(s.p2).toBeGreaterThanOrEqual(-20)
    expect(s.p98).toBeLessThanOrEqual(-10)
  })
  it('nothing observed is null, never a number', () => {
    expect(sarDbStats(Float32Array.from([NaN, NaN]), 2)).toBeNull()
  })
  it('a ramp is never narrower than 3 dB', () => {
    const [lo, hi] = sarStretch({ n: 10, min: -12.2, max: -12, p2: -12.18, p98: -12.02 })
    expect(hi - lo).toBeGreaterThanOrEqual(3)
  })
})

describe('fetch_sar', () => {
  it('returns a per-pixel VV raster in dB with a legend, and a hidden VH layer', async () => {
    const res = await fetchSar(ctx())
    const vv = res.layer!
    expect(vv.type).toBe('raster')
    expect(vv.geojson).toBeUndefined()
    expect(vv.aoiMask).toBe(true)
    expect(vv.tileUrl).toContain('/item/tiles/WebMercatorQuad/{z}/{x}/{y}.png')
    const q = new URL(vv.tileUrl!.replace('{z}/{x}/{y}', '0/0/0')).searchParams
    expect(q.get('item')).toBe('S1A_NEW') // the newest pass
    expect(q.get('expression')).toBe('10*log10(vv)')
    expect(q.get('colormap_name')).toBe('viridis')
    const style = readTileStyle(vv.tileUrl!)
    expect(style.rescale[0][0]).toBeGreaterThan(-23)
    expect(style.rescale[0][1]).toBeLessThan(-5)
    expect(vv.raster).toMatchObject({ kind: 'continuous', units: 'dB', bands: ['VV'], stretch: 'p2-p98', colormap: 'viridis', sceneId: 'S1A_NEW', datetime: '2026-09-13', rescale: style.rescale })
    expect(vv.provenance).toMatchObject({ date: '2026-09-13', clip: 'polygon (display mask)' })

    const vh = res.layers![0]
    expect(vh).toMatchObject({ type: 'raster', defaultVisible: false, raster: { bands: ['VH'], units: 'dB' } })
    expect(new URL(vh.tileUrl!.replace('{z}/{x}/{y}', '0/0/0')).searchParams.get('expression')).toBe('10*log10(vh)')

    expect(res.summary_data).toMatchObject({ calibration: 'gamma0 dB (RTC, terrain-corrected)' })
    expect(res.summary_data!.vv_gamma0_db).toBeLessThan(-6)
    expect(res.summary_data!.vv_gamma0_db).toBeGreaterThan(-22)
    expect(res.summary_data!.vh_gamma0_db).toBeLessThan(res.summary_data!.vv_gamma0_db as number)
    expect(res.summary).toMatch(/Map layer:\*\* per-pixel Sentinel-1 VV backscatter in dB/)
    expect(res.provenance_items).toEqual(['S1A_NEW'])
  })

  it('has no VH layer when the pass carries none', async () => {
    vi.mocked(readSceneDb).mockImplementation(async (_s, _g, _m, pol) => {
      if (pol === 'VH') throw new Error('no vh asset')
      return dbGrid(-22, -6)
    })
    const res = await fetchSar(ctx())
    expect(res.layer).toBeDefined()
    expect(res.layers).toBeUndefined()
    expect(res.summary_data!.vh_gamma0_db).toBeUndefined()
  })

  it('prefers an earlier pass that covers the AOI over a newer one that misses most of it, and says so when none does', async () => {
    vi.mocked(readSceneDb).mockImplementation(async (scene, _g, _m, pol) => {
      if (pol === 'VH') throw new Error('skip')
      return scene.date === '2026-09-13' ? dbGrid(-22, -6, 0.7) : dbGrid(-20, -8, 0)
    })
    const better = await fetchSar(ctx())
    expect(better.layer!.raster!.sceneId).toBe('S1A_OLD')
    expect(better.layer!.confidence).toBe('high')

    vi.mocked(readSceneDb).mockImplementation(async (scene, _g, _m, pol) => {
      if (pol === 'VH') throw new Error('skip')
      return scene.date === '2026-09-13' ? dbGrid(-22, -6, 0.5) : dbGrid(-20, -8, 0.6)
    })
    const partial = await fetchSar(ctx())
    expect(partial.layer!.raster!.sceneId).toBe('S1A_NEW')
    expect(partial.layer!.confidence).toBe('medium')
    expect(partial.summary).toMatch(/observes only \d+% of the AOI/)
  })

  it('an unreachable catalogue is a failure with the reason and no layer, not an absence of scenes', async () => {
    vi.mocked(searchS1Rtc).mockResolvedValue({ ok: false, message: 'The Sentinel-1 catalogue search failed (HTTP 503).' })
    const res = await fetchSar(ctx())
    expect(res.layer).toBeUndefined()
    expect(res.failed).toBe(true)
    expect(res.summary).toMatch(/HTTP 503/)
  })

  it('no scenes at all is an honest "none found" with no layer', async () => {
    vi.mocked(searchS1Rtc).mockResolvedValue({ ok: true, items: [] })
    const res = await fetchSar(ctx())
    expect(res.layer).toBeUndefined()
    expect(res.failed).toBeUndefined()
    expect(res.summary).toMatch(/No Sentinel-1 scene found/)
  })
})
