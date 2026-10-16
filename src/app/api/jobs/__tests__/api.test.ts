import { NextRequest } from 'next/server'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { defaultEvidenceStore } from '@/app/api/agent/engine/evidence-store'
import { claim } from '@/lib/jobs/queue'
import { createOperationRunner } from '@/lib/jobs/runner'
import { startWorker } from '@/lib/jobs/worker'
import { createTestDb, describeDb, type TestDb } from '@/test/db'

// The routes use the app's shared Prisma client, which reads DATABASE_URL: point it at the test schema first.
let t: TestDb
let routes: { list: typeof import('../route'); one: typeof import('../[id]/route'); sse: typeof import('../[id]/events/route') }

beforeAll(async () => {
  t = await createTestDb()
  process.env.DATABASE_URL = t.url
  routes = { list: await import('../route'), one: await import('../[id]/route'), sse: await import('../[id]/events/route') }
}, 60_000)
afterAll(async () => {
  const { db } = await import('@/lib/db')
  await db.$disconnect()
  await t?.drop()
})

const AOI = { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] }
const post = (owner: string, body: unknown) => routes.list.POST(new NextRequest('http://x/api/jobs', { method: 'POST', headers: { 'x-owner-token': owner }, body: JSON.stringify(body) }))
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const get = (owner: string, id: string, path = '') => new NextRequest(`http://x/api/jobs/${id}${path}`, { headers: { 'x-owner-token': owner } })

describeDb('/api/jobs', () => {
  it('refuses a malformed batch, an unknown operation and bad arguments, naming the entry', async () => {
    expect((await post('a', { jobs: [] })).status).toBe(400)
    expect((await post('a', { jobs: [{ op: 'fetch_dem', aoi: { type: 'Point', coordinates: [0, 0] } }] })).status).toBe(400)
    const unknown = await post('a', { jobs: [{ op: 'fetch_dem', aoi: AOI }, { op: 'no_such_op', aoi: AOI }] })
    expect(unknown.status).toBe(400)
    expect((await unknown.json()).error).toContain('jobs.1: unknown operation no_such_op')
    const badArgs = await post('a', { jobs: [{ op: 'style_layer', args: {}, aoi: AOI }] })
    expect(badArgs.status).toBe(400)
    expect((await badArgs.json()).error).toContain('jobs.0: Invalid arguments for style_layer')
  })

  it('refuses an operation that works on an existing result when no result is named', async () => {
    for (const op of ['style_layer', 'make_chart']) {
      const res = await post('a', { jobs: [{ op, args: { property: 'p', spec: '{}' }, aoi: AOI }] })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(new RegExp(`jobs.0: ${op} works on an existing result: pass \`result_id\``))
    }
    // naming one is enough to queue it (the worker loads it from the evidence store)
    expect((await post('a', { jobs: [{ op: 'make_chart', args: { spec: '{}', result_id: 'r_0000000000000000' }, aoi: AOI }] })).status).toBe(202)
  })

  it('queues a batch, scopes it to its owner, runs it through the executor and streams progress', async () => {
    // style_layer on a result that does not exist: the executor refuses it (offline, deterministic),
    // which is a finished job whose refusal is a stored result, not something to retry.
    const res = await post('alice', { label: 'two fields', jobs: [0, 1].map(() => ({ op: 'style_layer', args: { result_id: 'r_0000000000000000', property: 'p' }, aoi: AOI })) })
    expect(res.status).toBe(202)
    const { id, total } = await res.json()
    expect(total).toBe(2)

    expect((await routes.one.GET(get('alice', id), ctx(id))).status).toBe(200)
    expect((await routes.one.GET(get('bob', id), ctx(id))).status).toBe(403)
    expect((await routes.one.GET(get('alice', 'missing'), ctx('missing'))).status).toBe(404)
    expect((await routes.sse.GET(get('bob', id, '/events') as NextRequest, ctx(id))).status).toBe(403)

    const { db } = await import('@/lib/db')
    const w = startWorker({ db, run: createOperationRunner(await defaultEvidenceStore()), concurrency: 2, pollMs: 20, leaseMs: 5000 })
    const sse = await routes.sse.GET(get('alice', id, '/events'), ctx(id))
    const text = await sse.text() // closes itself at batch_done
    await w.stop()
    const types = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1])
    expect(types).toEqual(['batch_queued', 'job_done', 'job_done', 'batch_done'])
    expect(text).toMatch(/^id: \d+$/m)

    const state = await (await routes.one.GET(get('alice', id), ctx(id))).json()
    expect(state).toMatchObject({ state: 'finished', progress: { total: 2, done: 2, failed: 0 } })
    expect(state.jobs.map((j: any) => j.resultStatus)).toEqual(['refused', 'refused'])

    // the job's result is in the evidence store and readable by its batch's owner only
    const store = await defaultEvidenceStore()
    const rid = state.jobs[0].resultId
    expect((await store.getResult(rid))?.result.status).toBe('refused')
    expect(await store.canReadResult(rid, 'alice')).toBe(true)
    expect(await store.canReadResult(rid, 'bob')).toBe(false)

    // resuming after the last event id yields nothing new but the stream still ends
    const rest = await (await routes.sse.GET(get('alice', id, '/events?after=999999'), ctx(id))).body!.getReader()
    void rest.cancel()
    expect(await claim(db, 'x', 1000)).toBeNull()
  })

  it('lists the caller\'s batches newest first, with pages, and nobody else\'s', async () => {
    const mk = async (owner: string, label: string) => (await (await post(owner, { label, jobs: [{ op: 'style_layer', args: { result_id: 'r_0000000000000000', property: 'p' }, aoi: AOI }] })).json()).id as string
    const ids = [await mk('carol', 'first'), await mk('carol', 'second'), await mk('carol', 'third')]
    await mk('dave', 'not carol\'s')
    const list = (owner: string, qs = '') => routes.list.GET(new NextRequest(`http://x/api/jobs${qs}`, { headers: { 'x-owner-token': owner } }))

    const page1 = await (await list('carol', '?limit=2')).json()
    expect(page1.batches.map((b: any) => b.label)).toEqual(['third', 'second'])
    expect(page1.batches[0]).toMatchObject({ id: ids[2], state: 'active', ops: ['style_layer'], progress: { total: 1, queued: 1 } })
    const page2 = await (await list('carol', `?limit=2&cursor=${page1.nextCursor}`)).json()
    expect(page2.batches.map((b: any) => b.label)).toEqual(['first'])
    expect(page2.nextCursor).toBeNull()
    expect((await (await list('')).json()).batches).toEqual([])
    expect((await list('carol', '?limit=0')).status).toBe(400)
  })
})
