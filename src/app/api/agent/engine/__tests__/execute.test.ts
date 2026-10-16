import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { GeoResultSchema } from '@/lib/geo-result'

import type { ToolOutput } from '../../lib/types'
import { inputsHash, canonicalJson, resultId } from '../hash'
import { defineOperation, type AnyOperation } from '../operation'

// The executor resolves operations through the registry; a fake one lets each path be driven.
const fake = vi.hoisted(() => ({ op: null as AnyOperation | null }))
vi.mock('../registry', () => ({
  resolveOperation: (name: string, args: Record<string, unknown>) => (fake.op && fake.op.name === name ? { op: fake.op, args } : null),
}))

import { runOperation } from '../execute'

const AOI = { type: 'Polygon', coordinates: [[[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]]] }
const NOW = Date.parse('2026-10-12T12:00:00Z')

const run = vi.fn<(ctx: any, args: any) => Promise<ToolOutput>>()

function install(over: Record<string, any> = {}) {
  fake.op = defineOperation({
    name: 'fake_raster',
    label: 'Fake...',
    version: '1.2.0',
    description: 'fake',
    params: z.object({ band: z.string(), date: z.string().optional() }),
    output: 'raster',
    cost: { typicalSeconds: 1 },
    limitations: ['none'],
    confidence: 'test',
    run,
    ...over,
  } as any)
}

const goodOutput = (): ToolOutput => ({
  summary: 'NDVI mean 0.4',
  summary_data: { mean: 0.4, valid_pixel_pct: 92 },
  layer: {
    id: 'ndvi', name: 'NDVI', type: 'raster',
    raster: { kind: 'continuous', stretch: 'p2-p98', rescale: [[0, 1]], sceneId: 'S2A_scene_1', index: 'NDVI' },
    provenance: { source: 'Sentinel-2 L2A', method: 'titiler', clip: 'polygon', date: '2026-09-12' },
    confidence: 'high',
  },
})

beforeEach(() => {
  run.mockReset()
  run.mockResolvedValue(goodOutput())
  install()
})

describe('runOperation: the happy path returns one GeoResult', () => {
  it('validates, runs, and fills provenance, items and the content-addressed id', async () => {
    const r = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW })
    expect(() => GeoResultSchema.parse(r)).not.toThrow()
    expect(r.status).toBe('ok')
    expect(r.op).toEqual({ name: 'fake_raster', version: '1.2.0' })
    expect(r.layers).toHaveLength(1)
    expect(r.stats).toEqual({ mean: 0.4, valid_pixel_pct: 92 })
    expect(r.provenance).toMatchObject({ sources: ['Sentinel-2 L2A'], items: ['S2A_scene_1'], method: 'titiler', date: '2026-09-12' })
    expect(r.result_id).toMatch(/^r_[0-9a-f]{16}$/)
    expect(r.provenance.inputs_hash).toMatch(/^[0-9a-f]{64}$/)
    const phases = r.validation.map((c) => `${c.phase}:${c.id}:${c.status}`)
    expect(phases).toContain('static:aoi_area:pass')
    expect(phases).toContain('dynamic:provenance_sources:pass')
    expect(phases).toContain('dynamic:index_range:pass')
  })

  it('puts the primary layer first and keeps the extra ones', async () => {
    run.mockResolvedValue({ ...goodOutput(), layers: [{ id: 'extra', name: 'Extra', type: 'geojson', provenance: { source: 'OSM', method: 'overpass', clip: 'bbox' } }] })
    const r = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW })
    expect(r.layers.map((l) => l.id)).toEqual(['ndvi', 'extra'])
    expect(r.provenance.sources).toEqual(['Sentinel-2 L2A', 'OSM'])
  })

  it('carries the tool\'s own items and uncertainty, plus layer resolution limits', async () => {
    const out = goodOutput()
    out.provenance_items = ['overture:2026-09-23.1']
    out.uncertainty = { notes: ['lower bound'], ranges: { flood_km2: [1, 2] } }
    out.layer!.provenance!.resolution_limit = '10 m pixels'
    run.mockResolvedValue(out)
    const r = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW })
    expect(r.provenance.items).toEqual(['overture:2026-09-23.1', 'S2A_scene_1'])
    expect(r.uncertainty).toEqual({ notes: ['lower bound', '10 m pixels'], ranges: { flood_km2: [1, 2] } })
  })
})

describe('runOperation: a failed static check refuses without running', () => {
  it('refuses a bad argument: no run, no layers, the reason in the summary', async () => {
    const r = await runOperation('fake_raster', {}, { aoi: AOI, now: NOW })
    expect(run).not.toHaveBeenCalled()
    expect(r.status).toBe('refused')
    expect(r.layers).toEqual([])
    expect(r.stats).toBeUndefined()
    expect(r.summary).toMatch(/fake_raster was not run/)
    expect(r.summary).toMatch(/band/)
    expect(r.validation[0]).toMatchObject({ id: 'params', phase: 'static', status: 'fail' })
  })

  it('refuses a date in the future', async () => {
    const r = await runOperation('fake_raster', { band: 'B08', date: '2026-12-01' }, { aoi: AOI, now: NOW })
    expect(run).not.toHaveBeenCalled()
    expect(r.status).toBe('refused')
    expect(r.validation.find((c) => c.id === 'dates_not_future')).toBeTruthy()
  })

  it('refuses an AOI above the operation limit', async () => {
    install({ limits: { maxAreaKm2: 5 } })
    const r = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW })
    expect(run).not.toHaveBeenCalled()
    expect(r.status).toBe('refused')
    expect(r.summary).toMatch(/km²/)
  })

  it('refuses an operation that is not in the registry', async () => {
    const r = await runOperation('no_such_tool', {}, { aoi: AOI })
    expect(r.status).toBe('refused')
    expect(r.summary).toMatch(/Unknown tool: no_such_tool/)
  })

  it('uses the operation\'s own static checks', async () => {
    install({ staticChecks: () => [{ id: 'mine', phase: 'static', status: 'fail', message: 'not allowed' }] })
    const r = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW })
    expect(r.status).toBe('refused')
    expect(r.summary).toMatch(/not allowed/)
  })
})

describe('runOperation: a failed dynamic check flags the result but keeps the layers', () => {
  it('flags an NDVI outside [-1, 1]', async () => {
    const out = goodOutput()
    out.summary_data = { mean: 1.7, valid_pixel_pct: 92 }
    run.mockResolvedValue(out)
    const r = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW })
    expect(r.status).toBe('flagged')
    expect(r.layers).toHaveLength(1)
    expect(r.validation.find((c) => c.id === 'index_range')).toMatchObject({ status: 'fail', phase: 'dynamic' })
  })

  it('flags a measurement that names no data source', async () => {
    run.mockResolvedValue({ summary: 'Forest is 60%', summary_data: { forest_pct: 60 } })
    const r = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW })
    expect(r.status).toBe('flagged')
    expect(r.validation.find((c) => c.id === 'provenance_sources')!.status).toBe('fail')
  })

  it('runs the operation\'s own dynamic checks', async () => {
    install({ dynamicChecks: () => [{ id: 'mine', phase: 'dynamic', status: 'fail', message: 'implausible' }] })
    const r = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW })
    expect(r.status).toBe('flagged')
  })

  it('warnings alone leave the result ok', async () => {
    const out = goodOutput()
    out.summary_data = { mean: 0.4, valid_pixel_pct: 55 }
    run.mockResolvedValue(out)
    const r = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW })
    expect(r.status).toBe('ok')
    expect(r.validation.find((c) => c.id === 'valid_pixels')!.status).toBe('warn')
  })
})

describe('runOperation: a failure is not "no data"', () => {
  it('turns a thrown error into status failed with its message', async () => {
    run.mockRejectedValue(new Error('titiler HTTP 429'))
    const r = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW })
    expect(r.status).toBe('failed')
    expect(r.summary).toMatch(/titiler HTTP 429/)
    expect(r.summary).toMatch(/not an absence of data/)
    expect(r.layers).toEqual([])
  })

  it('reports a tool\'s own failure flag as failed, and skips the data checks', async () => {
    run.mockResolvedValue({ summary: 'Could not reach X', failed: true, summary_data: { area_km2: 3 } })
    const r = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW })
    expect(r.status).toBe('failed')
    expect(r.validation.some((c) => c.id === 'provenance_sources')).toBe(false)
  })

  it('recognises the standard connectivity note even when the tool did not set the flag', async () => {
    run.mockResolvedValue({ summary: '**Could not reach the Sentinel-2 catalogue** (fetch failed). This is a connectivity failure, not an absence of data — retry shortly.' })
    const r = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW })
    expect(r.status).toBe('failed')
  })
})

describe('content hash', () => {
  const base = { op: 'fake_raster', version: '1.2.0', args: { band: 'B08' }, aoi: AOI }

  it('is stable across key order and sub-centimetre coordinate noise', () => {
    const a = inputsHash({ ...base, args: { band: 'B08', date: '2026-09-01' } })
    const b = inputsHash({ ...base, args: { date: '2026-09-01', band: 'B08' } })
    expect(a).toBe(b)
    const noisy = JSON.parse(JSON.stringify(AOI))
    noisy.coordinates[0][0][0] += 1e-9
    expect(inputsHash({ ...base, args: { band: 'B08', date: '2026-09-01' }, aoi: noisy })).toBe(a)
  })

  it('changes with the arguments, the AOI, the focus and the operation version', () => {
    const h = inputsHash(base)
    expect(inputsHash({ ...base, args: { band: 'B04' } })).not.toBe(h)
    const moved = JSON.parse(JSON.stringify(AOI))
    moved.coordinates[0][0][0] += 1e-4
    expect(inputsHash({ ...base, aoi: moved })).not.toBe(h)
    expect(inputsHash({ ...base, focus: { lat: 31.1, lng: 74.0 } })).not.toBe(h)
    expect(inputsHash({ ...base, version: '1.3.0' })).not.toBe(h)
  })

  it('ignores undefined values and treats them as absent', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
  })

  it('makes the result id depend on the data items read, in any order', () => {
    const h = inputsHash(base)
    const id = resultId(h, ['scene-a', 'scene-b'])
    expect(resultId(h, ['scene-b', 'scene-a'])).toBe(id)
    expect(resultId(h, ['scene-a', 'scene-c'])).not.toBe(id)
    expect(id).toMatch(/^r_[0-9a-f]{16}$/)
  })

  it('gives the same result_id for the same call twice and a different one for another scene', async () => {
    const first = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW })
    const again = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW })
    expect(again.result_id).toBe(first.result_id)
    const out = goodOutput()
    out.layer!.raster!.sceneId = 'S2A_scene_2'
    run.mockResolvedValue(out)
    const newer = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW })
    expect(newer.provenance.inputs_hash).toBe(first.provenance.inputs_hash)
    expect(newer.result_id).not.toBe(first.result_id)
  })
})

describe('runOperation: an operation cannot hold the run', () => {
  it('fails an operation that outlives its own limit, as a failure and not as missing data', async () => {
    install({ timeoutMs: 40 })
    run.mockImplementation(() => new Promise(() => {})) // never settles, ignores every signal
    const r = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW })
    expect(r.status).toBe('failed')
    expect(r.summary).toMatch(/did not finish within its/)
    expect(r.summary).toMatch(/failure, not an absence of data/)
  })

  it('stops waiting as soon as the run signal aborts, and hands the operation that signal', async () => {
    const ac = new AbortController()
    let seen: AbortSignal | undefined
    run.mockImplementation((ctx) => { seen = ctx.signal; return new Promise(() => {}) })
    const pending = runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW, signal: ac.signal })
    setTimeout(() => ac.abort(new Error('budget')), 20)
    const r = await pending
    expect(r.status).toBe('failed')
    expect(r.summary).toMatch(/time budget ran out/)
    expect(seen?.aborted).toBe(true)
  })
})
