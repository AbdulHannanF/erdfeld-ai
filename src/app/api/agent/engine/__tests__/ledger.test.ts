import { describe, expect, it } from 'vitest'

import type { GeoResult } from '@/lib/geo-result'

import { LedgerRecorder, compareRerun, toLedgerExport, type LedgerNode } from '../ledger'

const result = (id: string, over: Partial<GeoResult> = {}, items: string[] = ['S2_1'], inputs = 'h1'): GeoResult => ({
  schema: 'geo-result/1', result_id: id, op: { name: 'op', version: '1.0.0' }, status: 'ok', summary: 's', layers: [],
  stats: { mean: 0.4 }, provenance: { sources: ['S2'], items, method: 'm', inputs_hash: inputs }, validation: [], ...over,
})

describe('LedgerRecorder', () => {
  it('records nodes in start order with hashes, status, cache flag and timings', () => {
    const r = new LedgerRecorder()
    const i = r.start({ name: 'render_raster' }, { bands: ['B08'] }, undefined, 1000)
    r.finish(i, result('r_a', { provenance: { sources: [], items: [], method: 'm', inputs_hash: 'hh', cached: true } }), 1250)
    expect(r.snapshot).toEqual([expect.objectContaining({
      idx: 0, op: 'render_raster', version: '1.0.0', args: { bands: ['B08'] }, dependsOn: [],
      inputsHash: 'hh', resultId: 'r_a', status: 'ok', cached: true, ms: 250,
    })])
  })

  it('writes plan references as ${node:idx} and keeps the dependency edges', () => {
    const r = new LedgerRecorder()
    const a = r.start({ name: 'a' }, {}, { step: 0, refBase: 0 })
    r.finish(a, result('r_a'))
    const b = r.start({ name: 'b' }, { layer: { from_node: 0 }, note: 'uses ${node:0}' }, { step: 1, refBase: 0, dependsOn: [0] })
    expect(r.snapshot[b]).toMatchObject({ args: { layer: '${node:0}', note: 'uses ${node:0}' }, dependsOn: [0] })
  })

  it('maps a replan (local references, absolute step indices) onto node idx', () => {
    const r = new LedgerRecorder()
    r.start({ name: 'direct' }, {}) // idx 0, not a plan step
    r.start({ name: 'p0' }, {}, { step: 0, refBase: 0 }) // idx 1
    const n = r.start({ name: 'p1' }, { x: { from_node: 0 } }, { step: 1, refBase: 1 }) // replan: local 0 = step 1?
    // refBase 1 means local reference 0 is absolute step 1 (itself not yet recorded): unresolved
    expect(r.snapshot[n].dependsOn).toEqual([])
    const m = r.start({ name: 'p2' }, { x: { from_node: 0 } }, { step: 2, refBase: 1, dependsOn: [0] })
    expect(r.snapshot[m]).toMatchObject({ dependsOn: [n], args: { x: `\${node:${n}}` } })
  })

  it('records a skipped node as skipped, with no result', () => {
    const r = new LedgerRecorder()
    const s = r.skipped({ name: 'b' }, {}, { step: 1, refBase: 0 })
    expect(r.snapshot[s]).toMatchObject({ status: 'skipped', resultId: null })
  })
})

describe('toLedgerExport', () => {
  it('joins each node to the provenance items of its stored result', () => {
    const node = { idx: 0, op: 'op', version: '1.0.0', args: {}, dependsOn: [], inputsHash: 'h1', resultId: 'r_a', status: 'ok', cached: false, startedAt: 't', ms: 1 } as LedgerNode
    const out = toLedgerExport(
      { id: 'run1', ownerToken: 'o', query: 'q', aoi: {}, focus: null, createdAt: 'c', nodes: [node, { ...node, idx: 1, resultId: 'r_missing' }] },
      new Map([['r_a', { result: result('r_a'), computedAt: 0 }]]),
    )
    expect(out.nodes[0]).toMatchObject({ provenance: { items: ['S2_1'], sources: ['S2'] }, stats: { mean: 0.4 }, computedAt: '1970-01-01T00:00:00.000Z' })
    expect(out.nodes[1]).toMatchObject({ provenance: null, stats: null, computedAt: null })
  })
})

describe('compareRerun', () => {
  const node = { idx: 2, op: 'op', resultId: 'r_a' } as LedgerNode

  it('reproduced: same id and same figures', () => {
    expect(compareRerun(node, result('r_a'), result('r_a'))).toMatchObject({ outcome: 'reproduced', newResultId: 'r_a' })
  })

  it('changed, naming the data items, when the same request reads different items', () => {
    const r = compareRerun(node, result('r_a', {}, ['S2_1', 'S2_2']), result('r_b', {}, ['S2_2', 'S2_3']))
    expect(r).toMatchObject({ outcome: 'changed', itemsRemoved: ['S2_1'], itemsAdded: ['S2_3'] })
  })

  it('changed, blaming upstream, when the inputs themselves differ', () => {
    const r = compareRerun(node, result('r_a', {}, ['x'], 'h1'), result('r_b', {}, ['x'], 'h2'))
    expect(r.outcome).toBe('changed')
    expect(r.reason).toMatch(/upstream/)
  })

  it('changed when id and data are identical but the figures are not', () => {
    const r = compareRerun(node, result('r_a'), result('r_a', { stats: { mean: 0.9 } }))
    expect(r).toMatchObject({ outcome: 'changed' })
    expect(r.reason).toMatch(/figures differ/)
  })

  it('not_run, never reproduced, when the re-execution failed or was blocked', () => {
    expect(compareRerun(node, result('r_a'), result('r_x', { status: 'failed', summary: 'down' })).outcome).toBe('not_run')
    expect(compareRerun(node, result('r_a'), null).outcome).toBe('not_run')
  })
})
