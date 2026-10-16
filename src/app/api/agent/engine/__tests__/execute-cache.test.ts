import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { ToolOutput } from '../../lib/types'
import { createEvidenceStore } from '../evidence-store'
import { DAY, HOUR, defineOperation, type AnyOperation } from '../operation'
import { memoryStore } from './memory-store'

const fake = vi.hoisted(() => ({ op: null as AnyOperation | null }))
vi.mock('../registry', () => ({
  resolveOperation: (name: string, args: Record<string, unknown>) => (fake.op && fake.op.name === name ? { op: fake.op, args } : null),
}))

import { runOperation } from '../execute'

const AOI = { type: 'Polygon', coordinates: [[[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]]] }
const NOW = Date.parse('2026-10-12T12:00:00Z')
const run = vi.fn<(ctx: any, args: any) => Promise<ToolOutput>>()

const good = (): ToolOutput => ({
  summary: 'mean 0.4',
  summary_data: { mean: 0.4 },
  layer: {
    id: 'l', name: 'L', type: 'raster',
    raster: { kind: 'continuous', stretch: 'p2-p98', rescale: [[0, 1]], sceneId: 'S2A_1', index: 'NDVI' },
    provenance: { source: 'Sentinel-2 L2A', method: 'titiler', clip: 'polygon', date: '2026-09-12' },
    confidence: 'high',
  },
})

beforeEach(() => {
  run.mockReset()
  run.mockResolvedValue(good())
  fake.op = defineOperation({
    name: 'fake_raster', label: 'x', version: '1.0.0', description: 'x',
    params: z.object({ band: z.string(), date: z.string().optional() }),
    output: 'raster', cost: { typicalSeconds: 1 }, limitations: [], confidence: 'x',
    cacheTtl: { liveMs: 6 * HOUR, settledMs: 30 * DAY }, run,
  })
})

describe('result cache in the executor', () => {
  it('computes once, then serves the stored GeoResult marked cached with its original timestamp', async () => {
    const { store, rows } = memoryStore()
    const first = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW, evidence: store })
    const second = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW + HOUR, evidence: store })
    expect(run).toHaveBeenCalledTimes(1)
    expect(first.provenance.cached).toBeUndefined()
    expect(second.provenance).toMatchObject({ cached: true, computed_at: new Date(NOW).toISOString() })
    expect(second.result_id).toBe(first.result_id)
    expect(second.stats).toEqual(first.stats)
    expect(rows.get(first.result_id)?.cacheKey).toBeTruthy()
  })

  it('does not serve an expired entry, nor an open-ended one on the next day', async () => {
    const { store } = memoryStore()
    await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW, evidence: store })
    await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW + 7 * HOUR, evidence: store })
    expect(run).toHaveBeenCalledTimes(2)
    await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW + DAY + 7 * HOUR, evidence: store })
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('reuses a settled window across days', async () => {
    const { store } = memoryStore()
    const args = { band: 'B08', date: '2026-06-01' }
    await runOperation('fake_raster', args, { aoi: AOI, now: NOW, evidence: store })
    await runOperation('fake_raster', args, { aoi: AOI, now: NOW + 20 * DAY, evidence: store })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('never caches a failed or refused result, but still stores it as evidence', async () => {
    const { store, puts } = memoryStore()
    run.mockRejectedValue(new Error('titiler 500'))
    const failed = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW, evidence: store })
    const refused = await runOperation('fake_raster', { band: 'B08', date: '2999-01-01' }, { aoi: AOI, now: NOW, evidence: store })
    expect([failed.status, refused.status]).toEqual(['failed', 'refused'])
    expect(puts.map((p) => p.opts.cacheKey)).toEqual([null, null])
    run.mockResolvedValue(good())
    const ok = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW, evidence: store })
    expect(ok.status).toBe('ok')
    expect(run).toHaveBeenCalledTimes(2) // the failure was not replayed
  })

  it('caches a flagged result and keeps its flags', async () => {
    const { store } = memoryStore()
    run.mockResolvedValue({ ...good(), layer: { ...good().layer!, provenance: undefined } })
    const first = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW, evidence: store })
    expect(first.status).toBe('flagged')
    const second = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW, evidence: store })
    expect(run).toHaveBeenCalledTimes(1)
    expect(second.status).toBe('flagged')
    expect(second.validation).toEqual(first.validation)
  })

  it('never caches an operation without a cacheTtl', async () => {
    const { store, puts } = memoryStore()
    fake.op = defineOperation({ ...fake.op!, cacheTtl: undefined } as any)
    await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW, evidence: store })
    await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW, evidence: store })
    expect(run).toHaveBeenCalledTimes(2)
    expect(puts.every((p) => p.opts.cacheKey === null)).toBe(true)
  })

  it('`refresh` recomputes even when a fresh entry exists', async () => {
    const { store } = memoryStore()
    await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW, evidence: store })
    const again = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW, evidence: store, cache: 'refresh' })
    expect(run).toHaveBeenCalledTimes(2)
    expect(again.provenance.cached).toBeUndefined()
  })

  it('runs normally when the evidence store is unreachable', async () => {
    const boom = () => Promise.reject(new Error('no such table'))
    const store = createEvidenceStore({
      result: { findFirst: boom, findUnique: boom, findMany: boom, upsert: boom },
      planRun: { create: boom, findUnique: boom },
      planNode: { findMany: boom },
      job: { findMany: boom },
    })
    const r = await runOperation('fake_raster', { band: 'B08' }, { aoi: AOI, now: NOW, evidence: store })
    expect(r.status).toBe('ok')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
