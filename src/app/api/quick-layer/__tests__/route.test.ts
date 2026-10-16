/**
 * POST /api/quick-layer — one-click layers through the engine executor, no LLM.
 *
 * The tool implementations are mocked at their edge (no network); the registry, argument
 * validation, static checks, dynamic checks and the GeoResult envelope are the real ones.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GeoResultSchema } from '@/lib/geo-result'

import type { ToolOutput } from '../../agent/lib/types'

const calls: Array<{ tool: string; args: Record<string, any> }> = []
const rasterLayer = (id: string): ToolOutput => ({
  summary: `${id} ready`,
  summary_data: { area_km2: 9.5 },
  layer: {
    id, name: id, type: 'raster', tileUrl: 'https://titiler.example/{z}/{x}/{y}.png', bounds: [74.05, 31.12, 74.08, 31.15],
    provenance: { source: 'Sentinel-2 L2A (test)', method: 'test', clip: 'polygon' }, confidence: 'high',
  },
})

vi.mock('../../agent/tools/satellite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent/tools/satellite')>()),
  ndviOrImagery: vi.fn(async (_ctx: unknown, tool: string) => { calls.push({ tool, args: {} }); return rasterLayer('ndvi-active') }),
}))
vi.mock('../../agent/tools/raster', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent/tools/raster')>()),
  renderRaster: vi.fn(async (_ctx: unknown, args: Record<string, any>) => { calls.push({ tool: 'render_raster', args }); return rasterLayer('raster-s2-b04-b03-b02') }),
}))
vi.mock('../../agent/tools/terrain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent/tools/terrain')>()),
  fetchDem: vi.fn(async () => { calls.push({ tool: 'fetch_dem', args: {} }); return rasterLayer('dem-active') }),
}))

import { NextRequest } from 'next/server'

import { POST } from '../route'

const RING = [[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]]
const AOI = { type: 'Polygon', coordinates: [RING] }

const post = (body: unknown, raw = false) =>
  POST(new NextRequest('http://localhost/api/quick-layer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  }))

beforeEach(() => { calls.length = 0 })

describe('POST /api/quick-layer', () => {
  it('runs the NDVI quick layer through the executor and returns a valid GeoResult', async () => {
    const res = await post({ op: 'ndvi', aoi: AOI })
    expect(res.status).toBe(200)
    const result = GeoResultSchema.parse(await res.json())
    expect(result.op.name).toBe('fetch_ndvi')
    expect(result.status).toBe('ok')
    expect(result.layers[0].id).toBe('ndvi-active')
    expect(result.result_id).toMatch(/^r_/)
    // static checks ran (the AOI limit) alongside the dynamic ones
    expect(result.validation.some((c) => c.phase === 'static' && c.id === 'aoi_area')).toBe(true)
    expect(calls).toEqual([{ tool: 'fetch_ndvi', args: {} }])
  })

  it('maps true colour to a B04/B03/B02 composite and elevation to the DEM, with fixed arguments', async () => {
    const tc = GeoResultSchema.parse(await (await post({ op: 'true_colour', aoi: AOI })).json())
    expect(tc.op.name).toBe('render_raster')
    expect(calls[0].args.bands).toEqual(['B04', 'B03', 'B02'])
    const el = GeoResultSchema.parse(await (await post({ op: 'elevation', aoi: AOI })).json())
    expect(el.op.name).toBe('fetch_dem')
  })

  it('does not let the caller choose the operation or its arguments', async () => {
    const res = await post({ op: 'fetch_dem', aoi: AOI })
    expect(res.status).toBe(400)
    const ok = await post({ op: 'true_colour', aoi: AOI, args: { bands: ['B08'] }, operation: 'fetch_sar' })
    expect(GeoResultSchema.parse(await ok.json()).op.name).toBe('render_raster')
    expect(calls[calls.length - 1].args.bands).toEqual(['B04', 'B03', 'B02'])
  })

  it('accepts a GeoJSON Feature AOI', async () => {
    const res = await post({ op: 'ndvi', aoi: { type: 'Feature', properties: {}, geometry: AOI } })
    expect(res.status).toBe(200)
  })

  it('refuses (200, status refused) an AOI above the operation limit, running nothing', async () => {
    const huge = { type: 'Polygon', coordinates: [[[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]] }
    const res = await post({ op: 'ndvi', aoi: huge })
    expect(res.status).toBe(200)
    const result = GeoResultSchema.parse(await res.json())
    expect(result.status).toBe('refused')
    expect(result.layers).toEqual([])
    expect(result.validation.find((c) => c.id === 'aoi_area')?.status).toBe('fail')
    expect(calls).toEqual([])
  })

  it('400s malformed requests with reasons and runs nothing', async () => {
    const cases: unknown[] = [
      { op: 'nope', aoi: AOI },
      { op: 'ndvi' },
      { op: 'ndvi', aoi: { type: 'Point', coordinates: [1, 2] } },
      { op: 'ndvi', aoi: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] } },
      { op: 'ndvi', aoi: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 'x'], [0, 0]]] } },
      null,
    ]
    for (const body of cases) {
      const res = await post(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((await res.json()).error).toBeTruthy()
    }
    expect((await (await post({ op: 'nope', aoi: AOI })).json()).issues[0].path).toBe('op')
    const notJson = await post('{not json', true)
    expect(notJson.status).toBe(400)
    expect(calls).toEqual([])
  })
})
