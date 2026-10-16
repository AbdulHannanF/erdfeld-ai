import { afterAll, beforeAll, expect, it } from 'vitest'

import type { GeoResult } from '@/lib/geo-result'
import { createTestDb, describeDb, type TestDb } from '@/test/db'

import { createEvidenceStore, type EvidenceDb, type EvidenceStore } from '../evidence-store'
import type { LedgerNode } from '../ledger'

// A real PostgreSQL schema built by the migrations (skipped without DATABASE_URL_TEST), so the
// columns and the queries are the ones production uses.
let testDb: TestDb
let store: EvidenceStore

beforeAll(async () => {
  testDb = await createTestDb()
  store = createEvidenceStore(testDb.prisma as unknown as EvidenceDb)
}, 60_000)

afterAll(async () => {
  await testDb?.drop()
})

const result = (id: string, over: Partial<GeoResult> = {}): GeoResult => ({
  schema: 'geo-result/1', result_id: id, op: { name: 'render_raster', version: '1.0.0' }, status: 'ok', summary: 's', layers: [],
  stats: { mean: 0.4 }, provenance: { sources: ['S2'], items: ['S2_1'], method: 'm', inputs_hash: 'in_' + id }, validation: [], ...over,
})
const T0 = Date.parse('2026-10-12T12:00:00Z')

describeDb('results', () => {
  it('round-trips a GeoResult by result_id', async () => {
    await store.put(result('r_1'), { cacheKey: 'k1', expiresAt: T0 + 1000, now: T0 })
    const got = await store.getResult('r_1')
    expect(got?.result).toEqual(result('r_1'))
    expect(got?.computedAt).toBe(T0)
    expect(await store.getResult('r_nope')).toBeNull()
    expect((await store.getResults(['r_1', 'r_nope'])).size).toBe(1)
  })

  it('looks up by cache key only while fresh, never without a key', async () => {
    await store.put(result('r_2'), { cacheKey: 'k2', expiresAt: T0 + 1000, now: T0 })
    await store.put(result('r_3', { status: 'failed' }), { cacheKey: null, expiresAt: null, now: T0 })
    expect((await store.lookup('k2', T0 + 999))?.result.result_id).toBe('r_2')
    expect(await store.lookup('k2', T0 + 1001)).toBeNull()
    expect(await store.lookup('k3', T0)).toBeNull()
    expect((await store.getResult('r_2'))?.result.result_id).toBe('r_2') // expired as a hit, still evidence
  })

  it('recomputing the same result_id updates the row instead of duplicating it', async () => {
    await store.put(result('r_4'), { cacheKey: 'k4', expiresAt: T0 + 10, now: T0 })
    await store.put(result('r_4'), { cacheKey: 'k4', expiresAt: T0 + 5000, now: T0 + 100 })
    const hit = await store.lookup('k4', T0 + 2000)
    expect(hit?.computedAt).toBe(T0 + 100)
  })
})

describeDb('ledger runs', () => {
  const node = (idx: number, over: Partial<LedgerNode> = {}): LedgerNode => ({
    idx, op: 'render_raster', version: '1.0.0', args: { bands: ['B08'] }, dependsOn: idx ? [0] : [], inputsHash: 'in_r_1', resultId: 'r_1',
    status: 'ok', cached: false, startedAt: new Date(T0).toISOString(), ms: 12, ...over,
  })

  it('round-trips a run with its nodes', async () => {
    const id = await store.saveRun({ ownerToken: 'anon-1', query: 'show NIR', aoi: { type: 'Polygon' }, focus: { lat: 1, lng: 2 }, nodes: [node(0), node(1, { args: { x: '${node:0}' }, cached: true })] })
    const run = await store.getRun(id)
    expect(run).toMatchObject({ id, ownerToken: 'anon-1', query: 'show NIR', aoi: { type: 'Polygon' }, focus: { lat: 1, lng: 2 } })
    expect(run!.nodes).toEqual([node(0), node(1, { args: { x: '${node:0}' }, cached: true })])
    expect(await store.getRun('missing')).toBeNull()
  })

  it('lets only an owner of a run containing the result read it; ownerless runs are open', async () => {
    await store.saveRun({ ownerToken: 'alice', query: null, aoi: {}, focus: null, nodes: [node(0, { resultId: 'r_priv' })] })
    expect(await store.canReadResult('r_priv', 'alice')).toBe(true)
    expect(await store.canReadResult('r_priv', 'bob')).toBe(false)
    expect(await store.canReadResult('r_priv', '')).toBe(false)
    await store.saveRun({ ownerToken: null, query: null, aoi: {}, focus: null, nodes: [node(0, { resultId: 'r_open' })] })
    expect(await store.canReadResult('r_open', 'bob')).toBe(true)
    await store.saveRun({ ownerToken: 'bob', query: null, aoi: {}, focus: null, nodes: [node(0, { resultId: 'r_priv' })] })
    expect(await store.canReadResult('r_priv', 'bob')).toBe(true) // shared via the cache: bob ran it too
  })
})
