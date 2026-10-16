import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { ToolOutput } from '../../lib/types'
import { HOUR, defineOperation, type AnyOperation } from '../operation'
import { memoryStore } from './memory-store'

const fake = vi.hoisted(() => ({ ops: new Map<string, AnyOperation>() }))
vi.mock('../registry', () => ({
  resolveOperation: (name: string, args: Record<string, unknown>) => (fake.ops.has(name) ? { op: fake.ops.get(name)!, args } : null),
}))

import { runOperation } from '../execute'
import { LedgerRecorder } from '../ledger'
import { rerunLedger } from '../rerun'

const AOI = { type: 'Polygon', coordinates: [[[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]]] }
const NOW = Date.parse('2026-10-12T12:00:00Z')

let scenes = ['S2_1']
const out = (): ToolOutput => ({
  summary: 'ok', summary_data: { n: scenes.length },
  layer: {
    id: 'l', name: 'L', type: 'raster', provenance: { source: 'S2', method: 'm', clip: 'polygon' },
    raster: { kind: 'continuous', stretch: 'p2-p98', rescale: [[0, 1]], sceneId: scenes[0], index: 'x' },
  } as any,
  provenance_items: scenes,
})

const define = (name: string) =>
  defineOperation({
    name, label: name, version: '1.0.0', description: name, params: z.object({ from: z.string().optional() }),
    output: 'raster', cost: { typicalSeconds: 1 }, limitations: [], confidence: 'x', cacheTtl: { liveMs: HOUR },
    run: async () => out(),
  })

beforeEach(() => {
  scenes = ['S2_1']
  fake.ops = new Map([['load', define('load')], ['derive', define('derive')]])
})

/** Execute a two-node plan the way the route does and return its stored ledger run. */
async function original() {
  const m = memoryStore()
  const ledger = new LedgerRecorder()
  const a = ledger.start({ name: 'load' }, {}, { step: 0, refBase: 0 })
  const ra = await runOperation('load', {}, { aoi: AOI, now: NOW, evidence: m.store })
  ledger.finish(a, ra)
  const b = ledger.start({ name: 'derive' }, { from: { from_node: 0 } }, { step: 1, refBase: 0, dependsOn: [0] })
  const rb = await runOperation('derive', { from: ra.result_id }, { aoi: AOI, now: NOW, evidence: m.store })
  ledger.finish(b, rb)
  const id = await m.store.saveRun({ ownerToken: 'o', query: 'q', aoi: AOI, focus: null, nodes: ledger.snapshot })
  return { ...m, run: (await m.store.getRun(id))!, ra, rb }
}

describe('rerunLedger', () => {
  it('reproduces every node when the data is unchanged, bypassing the cache', async () => {
    const o = await original()
    const spy = vi.spyOn(fake.ops.get('load')!, 'run')
    const report = await rerunLedger(o.run, o.store, { now: NOW })
    expect(spy).toHaveBeenCalledTimes(1) // re-executed, not served from the cache
    expect(report.reproduced).toBe(true)
    expect(report.nodes.map((n) => [n.op, n.outcome, n.newResultId])).toEqual([['load', 'reproduced', o.ra.result_id], ['derive', 'reproduced', o.rb.result_id]])
  })

  it('reports which data items changed, and that the downstream node was asked something else', async () => {
    const o = await original()
    scenes = ['S2_1', 'S2_2']
    const report = await rerunLedger(o.run, o.store, { now: NOW })
    expect(report.reproduced).toBe(false)
    expect(report.nodes[0]).toMatchObject({ op: 'load', outcome: 'changed', itemsAdded: ['S2_2'], itemsRemoved: [] })
    expect(report.nodes[1]).toMatchObject({ op: 'derive', outcome: 'changed' })
    expect(report.nodes[1].reason).toMatch(/upstream|different data items/)
  })

  it('does not run a node whose upstream failed', async () => {
    const o = await original()
    fake.ops.get('load')!.run = async () => { throw new Error('down') }
    const report = await rerunLedger(o.run, o.store, { now: NOW })
    expect(report.nodes.map((n) => n.outcome)).toEqual(['not_run', 'not_run'])
    expect(report.reproduced).toBe(false)
  })
})
