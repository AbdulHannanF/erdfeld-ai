import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GeoResult } from '@/lib/geo-result'

import { memoryStore } from './memory-store'

const h = vi.hoisted(() => ({ store: null as any }))
vi.mock('../evidence-store', () => ({ defaultEvidenceStore: async () => h.store }))

import { GET as getLedger } from '../../../ledger/[runId]/route'
import { POST as rerun } from '../../../ledger/[runId]/rerun/route'
import { GET as getResult } from '../../../results/[resultId]/route'

const res: GeoResult = {
  schema: 'geo-result/1', result_id: 'r_a', op: { name: 'x', version: '1' }, status: 'ok', summary: 's', layers: [],
  provenance: { sources: [], items: ['i1'], method: 'm', inputs_hash: 'h' }, validation: [],
}
const node = { idx: 0, op: 'x', version: '1', args: {}, dependsOn: [], inputsHash: 'h', resultId: 'r_a', status: 'ok' as const, cached: false, startedAt: new Date(0).toISOString(), ms: 1 }
const req = (owner?: string, method = 'GET') => new NextRequest('http://localhost/api/x', { method, headers: owner ? { 'x-owner-token': owner } : {} })

let runId: string
beforeEach(async () => {
  const m = memoryStore()
  h.store = m.store
  await m.store.put(res, { cacheKey: null, expiresAt: null, now: 0 })
  runId = await m.store.saveRun({ ownerToken: 'alice', query: 'q', aoi: {}, focus: null, nodes: [node] })
  // The memory store allows every read; the results route needs real scoping.
  h.store.canReadResult = async (_id: string, owner: string) => owner === 'alice'
})

describe('GET /api/ledger/:runId', () => {
  it('returns the plan graph with provenance items to its owner', async () => {
    const r = await getLedger(req('alice'), { params: Promise.resolve({ runId }) })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.nodes[0]).toMatchObject({ op: 'x', resultId: 'r_a', provenance: { items: ['i1'] } })
  })
  it('is 403 for another owner and for an anonymous caller', async () => {
    expect((await getLedger(req('bob'), { params: Promise.resolve({ runId }) })).status).toBe(403)
    expect((await getLedger(req(), { params: Promise.resolve({ runId }) })).status).toBe(403)
  })
  it('is 404 for an unknown run', async () => {
    expect((await getLedger(req('alice'), { params: Promise.resolve({ runId: 'nope' }) })).status).toBe(404)
  })
  it('is 500, not 404, when the store itself is down', async () => {
    h.store.getRun = async () => { throw new Error('db down') }
    expect((await getLedger(req('alice'), { params: Promise.resolve({ runId }) })).status).toBe(500)
  })
})

describe('POST /api/ledger/:runId/rerun', () => {
  it('is 403 for another owner and 404 for an unknown run', async () => {
    expect((await rerun(req('bob', 'POST'), { params: Promise.resolve({ runId }) })).status).toBe(403)
    expect((await rerun(req('alice', 'POST'), { params: Promise.resolve({ runId: 'nope' }) })).status).toBe(404)
  })
})

describe('GET /api/results/:resultId', () => {
  it('returns the stored result to an owner of a run containing it, 403 to anyone else, 404 if unknown', async () => {
    const ok = await getResult(req('alice'), { params: Promise.resolve({ resultId: 'r_a' }) })
    expect(ok.status).toBe(200)
    expect((await ok.json()).result.result_id).toBe('r_a')
    expect((await getResult(req('bob'), { params: Promise.resolve({ resultId: 'r_a' }) })).status).toBe(403)
    expect((await getResult(req('alice'), { params: Promise.resolve({ resultId: 'r_zzz' }) })).status).toBe(404)
  })
})
