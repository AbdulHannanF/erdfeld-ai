/**
 * Q-15 — the SSE contract for early layers, through the real route.
 *
 * A preview (`layer` with provisional: true) is followed by the final `layer` with the same
 * `layer_id` (one layer on the map, no duplicate); a preview whose tool then yields no such layer
 * is taken down with `layer_remove`; the completed `tool_call` carries per-stage `timings`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { GEO_RESULT_SCHEMA, type GeoResult } from '@/lib/geo-result'

import type { RunEnv } from '../engine/execute'
import type { ResultLayer } from '../lib/types'
import { LAYER_PREVIEW_EVENT } from '../lib/layer-preview'
import { span } from '../lib/timings'

const AOI = { type: 'Polygon', coordinates: [[[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]]] }

const layer = (over: Partial<ResultLayer> = {}): ResultLayer => ({
  id: 'ndvi-active', name: 'NDVI 2026-09-23', type: 'raster', tileUrl: 'https://tiles.example/{z}/{x}/{y}.png', bounds: [74.05, 31.12, 74.08, 31.15], ...over,
})

let mode: 'keeps' | 'drops' = 'keeps'

vi.mock('../engine/execute', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/execute')>()
  return {
    ...actual,
    runOperation: vi.fn(async (name: string, _args: unknown, env: RunEnv): Promise<GeoResult> => {
      await span('stac_search', async () => {})
      env.emit?.(LAYER_PREVIEW_EVENT, { layer: layer({ name: 'NDVI 2026-09-23 · statistics computing' }) })
      const layers = mode === 'keeps' ? [layer()] : []
      return {
        schema: GEO_RESULT_SCHEMA, result_id: 'r_test', op: { name, version: '1.0.0' },
        status: mode === 'keeps' ? 'ok' : 'failed', summary: mode === 'keeps' ? 'ok' : 'failed after the scene was chosen',
        layers, provenance: { sources: [], items: [], method: 'm', inputs_hash: 'h' }, validation: [],
      }
    }),
  }
})

let savedStub: string | undefined
beforeAll(() => { savedStub = process.env.AGENT_ALLOW_STUB; process.env.AGENT_ALLOW_STUB = '1' })
afterAll(() => { if (savedStub === undefined) delete process.env.AGENT_ALLOW_STUB; else process.env.AGENT_ALLOW_STUB = savedStub })
beforeEach(() => { mode = 'keeps' })

async function run(): Promise<Array<{ event: string; data: any }>> {
  const { NextRequest } = await import('next/server')
  const { POST } = await import('../route')
  const res = await POST(new NextRequest('http://localhost/api/agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ aoi: AOI, query: 'stub-run: [{"tool":"fetch_ndvi","args":{}}]', lang: 'en', aiProvider: 'stub', aiModel: 'stub' }),
  }))
  const text = await res.text()
  return text.split('\n\n').filter((f) => f.includes('data:')).map((frame) => {
    const ev = /^event: (.*)$/m.exec(frame)?.[1] ?? 'message'
    return { event: ev, data: JSON.parse(/^data: (.*)$/m.exec(frame)![1]) }
  })
}

describe('early layer over SSE', () => {
  it('sends a provisional layer, then the authoritative one with the same layer_id and no layer_remove', async () => {
    const events = await run()
    const layers = events.filter((e) => e.event === 'layer')
    expect(layers.map((l) => [l.data.layer_id, l.data.provisional])).toEqual([['ndvi-active', true], ['ndvi-active', false]])
    expect(layers[0].data.name).toMatch(/computing/)
    expect(layers[1].data.result_id).toBe('r_test')
    expect(layers[0].data.result_id).toBeUndefined() // the id is a content hash, known only at the end
    expect(events.some((e) => e.event === 'layer_remove')).toBe(false)
    // The preview precedes the completed tool_call, which precedes the final layer.
    const names = events.map((e) => e.event)
    const completed = events.findIndex((e) => e.event === 'tool_call' && e.data.status === 'completed')
    expect(names.indexOf('layer')).toBeLessThan(completed)
    expect(completed).toBeLessThan(names.lastIndexOf('layer'))
  }, 30_000)

  it('removes the preview when the tool ends without that layer, and says the tool failed', async () => {
    mode = 'drops'
    const events = await run()
    const remove = events.filter((e) => e.event === 'layer_remove')
    expect(remove.map((e) => e.data.layer_id)).toEqual(['ndvi-active'])
    expect(events.filter((e) => e.event === 'layer')).toHaveLength(1) // the preview only
    expect(events.find((e) => e.event === 'tool_call' && e.data.status === 'error')).toBeTruthy()
  }, 30_000)

  it('puts per-stage timings on the completed tool_call and the request totals on done', async () => {
    const events = await run()
    const completed = events.find((e) => e.event === 'tool_call' && e.data.status === 'completed')!
    expect(completed.data.timings).toMatchObject({ stac_search: expect.any(Number), total: expect.any(Number), llm_plan: expect.any(Number) })
    const done = events.find((e) => e.event === 'done')!
    expect(done.data.timings).toMatchObject({ llm_plan: expect.any(Number), llm_synthesis: expect.any(Number), total: expect.any(Number) })
  }, 30_000)
})
