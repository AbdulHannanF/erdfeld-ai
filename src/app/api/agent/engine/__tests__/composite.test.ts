import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GeoResultSchema } from '@/lib/geo-result'

import { GeoServiceError, type CompositeResponse } from '../../lib/geo-service'
import { getOperation, getToolDefinitions, plannerOperations, registryJson } from '../registry'

const mock = vi.hoisted(() => ({ composite: vi.fn() }))
vi.mock('../../lib/geo-service', async (orig) => ({ ...(await orig<typeof import('../../lib/geo-service')>()), composite: mock.composite }))

import { runOperation } from '../execute'

const AOI = { type: 'Polygon', coordinates: [[[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]]] }
const NOW = Date.parse('2026-10-12T12:00:00Z')
const ID = 'a1b2c3d4e5f60718293a4b5c'

const ok = (over: Partial<CompositeResponse> = {}): CompositeResponse => ({
  id: ID, items: ['S2A_43RCN_20260902_0_L2A', 'S2B_43RCN_20260907_0_L2A'], item_count: 2, scene_days: 2, valid_pixel_pct: 99.5,
  message: null, cached: false, bands: ['NDVI'], expression: 'NDVI',
  stats: { NDVI: { min: -0.1, max: 0.9, mean: 0.55, p2: 0.11, p98: 0.84, n: 97000 } },
  valid_obs_per_pixel: { mean: 8.5, min: 6, max: 11 }, bounds: [74.05, 31.12, 74.08, 31.15],
  tile_url_template: `http://127.0.0.1:8101/composite/${ID}/tiles/{z}/{x}/{y}.png`,
  ...over,
})

const run = (args: Record<string, unknown> = { expression: 'NDVI', start: '2026-09-01', end: '2026-09-30' }) =>
  runOperation('composite', args, { aoi: AOI, now: NOW })

beforeEach(() => { vi.stubEnv('GEO_SERVICE_URL', 'http://127.0.0.1:8101') })
afterEach(() => { mock.composite.mockReset(); vi.unstubAllEnvs() })

describe('composite operation', () => {
  it('returns a tile layer through the proxy, a measured stretch, stats, items and caveats', async () => {
    mock.composite.mockResolvedValue(ok())
    const r = await run()
    expect(GeoResultSchema.safeParse(r).success).toBe(true)
    expect(r.status).toBe('ok')
    expect(mock.composite.mock.calls[0][0]).toMatchObject({ expression: 'NDVI', start: '2026-09-01', end: '2026-09-30', resolution: 10, geometry: AOI })
    const layer = r.layers[0]
    expect(layer.tileUrl).toBe(`/api/geo/tiles/${ID}/{z}/{x}/{y}?colormap_name=rdylgn&rescale=0.11,0.84`)
    expect(layer.raster).toMatchObject({ kind: 'continuous', index: 'NDVI', rescale: [[0.11, 0.84]], stretch: 'p2-p98', colormap: 'rdylgn' })
    expect(layer.aoiMask).toBe(true)
    expect(r.stats).toMatchObject({ valid_pixel_pct: 99.5, item_count: 2, mean: 0.55, p2: 0.11, p98: 0.84, obs_per_pixel_mean: 8.5 })
    expect(r.provenance.items).toEqual(['S2A_43RCN_20260902_0_L2A', 'S2B_43RCN_20260907_0_L2A'])
    expect(r.uncertainty?.notes.join(' ')).toMatch(/not a single acquisition date/)
    expect(r.summary).toMatch(/not a single acquisition date/)
    expect(r.validation.map((c) => c.id)).toEqual(expect.arrayContaining(['window_span', 'valid_pixels', 'index_range', 'observations_per_pixel']))
  })

  it('a geo service 502 is status failed with an honest message, not "no data"', async () => {
    mock.composite.mockRejectedValue(new GeoServiceError('fetch_failed', 'COG read failed', 502))
    const r = await run()
    expect(r.status).toBe('failed')
    expect(r.layers).toEqual([])
    expect(r.summary).toMatch(/fetch failure/)
    expect(r.summary).toMatch(/not an absence of data/)
  })

  it('an unreachable service is also failed', async () => {
    mock.composite.mockRejectedValue(new GeoServiceError('unreachable', 'ECONNREFUSED'))
    expect((await run()).status).toBe('failed')
  })

  it('zero scenes is an explicit "no scenes" answer, not failed, with no layer', async () => {
    mock.composite.mockResolvedValue({ id: null, items: [], item_count: 0, valid_pixel_pct: null, message: 'No scenes', cached: false })
    const r = await run()
    expect(r.status).toBe('ok')
    expect(r.layers).toEqual([])
    expect(r.summary).toMatch(/No Sentinel-2 scenes/)
    expect(r.summary).toMatch(/not a failed fetch/)
    expect(r.stats).toMatchObject({ item_count: 0 })
  })

  it('scenes found but every pixel masked is explicit, with the scene ids, and draws nothing', async () => {
    mock.composite.mockResolvedValue({ id: null, items: ['S2A_x'], item_count: 1, valid_pixel_pct: 0, message: 'masked', cached: false })
    const r = await run()
    expect(r.layers).toEqual([])
    expect(r.summary).toMatch(/Every pixel was masked/)
    expect(r.provenance.items).toEqual(['S2A_x'])
    expect(r.status).not.toBe('failed')
  })

  it('a mostly-masked composite is flagged by the valid-pixel check, not shown as fine', async () => {
    mock.composite.mockResolvedValue(ok({ valid_pixel_pct: 12 }))
    const r = await run()
    expect(r.status).toBe('flagged')
    expect(r.validation.find((c) => c.id === 'valid_pixels')?.status).toBe('fail')
  })

  it('thin support (few clear observations) lowers confidence and warns', async () => {
    mock.composite.mockResolvedValue(ok({ valid_obs_per_pixel: { mean: 1.2, min: 1, max: 2 } }))
    const r = await run()
    expect(r.layers[0].confidence).toBe('low')
    expect(r.validation.find((c) => c.id === 'observations_per_pixel')?.status).toBe('warn')
  })

  it('3 bands render as RGB with the fixed reflectance stretch and no colormap', async () => {
    mock.composite.mockResolvedValue(ok({ bands: ['red', 'green', 'blue'], expression: null, stats: Object.fromEntries(['red', 'green', 'blue'].map((b) => [b, { min: 0, max: 0.4, mean: 0.1, p2: 0.02, p98: 0.3, n: 9 }])) }))
    const r = await run({ bands: ['B04', 'B03', 'B02'], start: '2026-09-01', end: '2026-09-30' })
    expect(r.layers[0].raster).toMatchObject({ kind: 'rgb', rescale: [[0, 0.3], [0, 0.3], [0, 0.3]] })
    expect(r.layers[0].tileUrl).not.toMatch(/colormap_name/)
  })

  describe('static checks refuse before calling the service', () => {
    it.each([
      ['a window over a year', { expression: 'NDVI', start: '2025-01-01', end: '2026-09-30' }, /window_span|at most 366/],
      ['an unknown band', { bands: ['B99'], start: '2026-09-01', end: '2026-09-30' }, /B99/],
      ['an invalid expression', { expression: '(B08-B04)/', start: '2026-09-01', end: '2026-09-30' }, /./],
      ['both bands and expression', { expression: 'NDVI', bands: ['B04'], start: '2026-09-01', end: '2026-09-30' }, /not both/],
      ['neither bands nor expression', { start: '2026-09-01', end: '2026-09-30' }, /Pass `bands`/],
      ['a start after the end', { expression: 'NDVI', start: '2026-09-30', end: '2026-09-01' }, /on or before/],
      ['a future end', { expression: 'NDVI', start: '2026-10-01', end: '2026-12-01' }, /future/],
      ['a date before Sentinel-2', { expression: 'NDVI', start: '2014-01-01', end: '2014-02-01' }, /before Sentinel-2/],
      ['an unknown colormap', { expression: 'NDVI', colormap: 'nope', start: '2026-09-01', end: '2026-09-30' }, /Unknown colormap/],
      ['a colormap on RGB', { bands: ['B04', 'B03', 'B02'], colormap: 'viridis', start: '2026-09-01', end: '2026-09-30' }, /RGB/],
      ['a resolution below 10 m', { expression: 'NDVI', resolution: 5, start: '2026-09-01', end: '2026-09-30' }, /between 10 and 100/],
    ])('%s', async (_n, args, msg) => {
      const r = await run(args)
      expect(r.status).toBe('refused')
      expect(r.summary).toMatch(msg)
      expect(mock.composite).not.toHaveBeenCalled()
    })

    it('an AOI over the limit names it', async () => {
      const big = { type: 'Polygon', coordinates: [[[74, 31], [75, 31], [75, 32], [74, 32], [74, 31]]] }
      const r = await runOperation('composite', { expression: 'NDVI', start: '2026-09-01', end: '2026-09-30' }, { aoi: big, now: NOW })
      expect(r.status).toBe('refused')
      expect(r.summary).toMatch(/composite is built for/)
    })
  })

  it('a service-side refusal (too_large) is reported as such, not as a fetch failure', async () => {
    mock.composite.mockRejectedValue(new GeoServiceError('too_large', 'stack over cap', 413))
    const r = await run()
    expect(r.status).not.toBe('failed')
    expect(r.summary).toMatch(/refused the request/)
  })
})

describe('registry routing by GEO_SERVICE_URL', () => {
  it('is offered to the planner and listed only while the geo service is configured', () => {
    expect(getOperation('composite')).toBeDefined()
    expect(plannerOperations().map((o) => o.name)).toContain('composite')
    expect(getToolDefinitions().map((t: any) => t.function.name)).toContain('composite')
    expect(registryJson().map((o) => o.name)).toContain('composite')
  })

  it('is absent without GEO_SERVICE_URL, and a call to it is refused as an unknown tool', async () => {
    vi.stubEnv('GEO_SERVICE_URL', '')
    expect(getOperation('composite')).toBeUndefined()
    expect(getToolDefinitions().map((t: any) => t.function.name)).not.toContain('composite')
    expect(registryJson().map((o) => o.name)).not.toContain('composite')
    expect((await run()).status).toBe('refused')
  })
})
