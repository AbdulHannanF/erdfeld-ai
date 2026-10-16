/** Q-08 — every route refuses malformed input with 400 `invalid_request` (or 413) and does nothing. */

import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ dbCalls: 0 }))
vi.mock('@/lib/db', () => ({ db: new Proxy({}, { get: () => { h.dbCalls++; throw new Error('db must not be touched') } }) }))
vi.mock('../agent/engine/evidence-store', () => ({ defaultEvidenceStore: async () => { throw new Error('store must not be touched') } }))
vi.mock('@/lib/rate-limit', () => ({ enforceRateLimit: async () => null }))

import { POST as agent } from '../agent/route'
import { GET as operations } from '../operations/route'
import { POST as projectsPost } from '../projects/route'
import { PATCH as projectPatch, GET as projectGet } from '../projects/[id]/route'
import { POST as share } from '../projects/[id]/share/route'
import { GET as shared } from '../share/[token]/route'
import { POST as quick } from '../quick-layer/route'
import { GET as ledger } from '../ledger/[runId]/route'
import { POST as rerun } from '../ledger/[runId]/rerun/route'
import { GET as results } from '../results/[resultId]/route'
import { GET as tiles } from '../geo/tiles/[id]/[z]/[x]/[y]/route'
import { POST as upload } from '../upload/route'

const RING = [[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]]
const AOI = { type: 'Polygon', coordinates: [RING] }
const post = (url: string, body: unknown, raw = false) =>
  new NextRequest(`http://localhost${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? (body as string) : JSON.stringify(body) })
const get = (url: string) => new NextRequest(`http://localhost${url}`)
const p = <T,>(v: T) => ({ params: Promise.resolve(v) })

async function expectInvalid(res: Response | Promise<Response>, path?: string) {
  const r = await res
  expect(r.status).toBe(400)
  const body = await r.json()
  expect(body.error).toBe('invalid_request')
  expect(Array.isArray(body.issues) && body.issues.length > 0).toBe(true)
  for (const i of body.issues) expect(typeof i.message).toBe('string')
  if (path) expect(body.issues.map((i: { path: string }) => i.path)).toContain(path)
}

describe('POST /api/agent', () => {
  it.each([
    ['no body fields', {}, 'aoi'],
    ['empty query', { aoi: AOI, query: '' }, 'query'],
    ['oversized query', { aoi: AOI, query: 'x'.repeat(5000) }, 'query'],
    ['bad provider', { aoi: AOI, query: 'q', aiProvider: 'nope' }, 'aiProvider'],
    ['point AOI', { aoi: { type: 'Point', coordinates: [1, 2] }, query: 'q' }, undefined],
    ['bad focus', { aoi: AOI, query: 'q', focus: { lat: 'a', lng: 1 } }, 'focus.lat'],
    ['bad manifest', { aoi: AOI, query: 'q', layers: [{ tool: 1 }] }, undefined],
  ])('400s %s', async (_n, body, path) => { await expectInvalid(agent(post('/api/agent', body)), path) })

  it('400s non-JSON and 413s an oversized body', async () => {
    const bad = await agent(post('/api/agent', '{nope', true))
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toBe('invalid_json')
    const big = await agent(post('/api/agent', JSON.stringify({ aoi: AOI, query: 'q', pad: 'x'.repeat(5 * 1024 * 1024) }), true))
    expect(big.status).toBe(413)
  })

  it('accepts a Feature AOI (the stream starts)', async () => {
    const res = await agent(post('/api/agent', { aoi: { type: 'Feature', properties: {}, geometry: AOI }, query: 'q', aiProvider: 'stub' }))
    expect(res.status).toBe(200)
    await res.body?.cancel()
  })
})

describe('projects', () => {
  it('POST /api/projects', async () => {
    await expectInvalid(projectsPost(post('/api/projects', {})))
    await expectInvalid(projectsPost(post('/api/projects', { layers: [{ id: 1 }] })))
    await expectInvalid(projectsPost(post('/api/projects', { aoi: { type: 'Polygon', geometry: { type: 'Point', coordinates: ['a', 'b'] } } })))
    expect((await projectsPost(post('/api/projects', '[', true))).status).toBe(400)
  })
  it('PATCH and GET /api/projects/:id', async () => {
    await expectInvalid(projectPatch(post('/api/projects/x', { name: 5 }), p({ id: 'abc' })), 'name')
    await expectInvalid(projectPatch(post('/api/projects/x', {}), p({ id: '../etc/passwd' })), 'id')
    await expectInvalid(projectGet(get('/api/projects/x'), p({ id: 'a b' })), 'id')
  })
  it('POST /api/projects/:id/share and GET /api/share/:token', async () => {
    await expectInvalid(share(post('/x', {}), p({ id: 'a/b' })), 'id')
    await expectInvalid(shared(get('/x'), p({ token: '!!' })), 'token')
  })
  it('never touched the database', () => { expect(h.dbCalls).toBe(0) })
})

describe('quick-layer, ledger, results, tiles, operations, upload', () => {
  it('POST /api/quick-layer', async () => {
    await expectInvalid(quick(post('/api/quick-layer', { op: 'nope', aoi: AOI })), 'op')
    await expectInvalid(quick(post('/api/quick-layer', { op: 'ndvi' })), 'aoi')
    expect((await quick(post('/api/quick-layer', { op: 'ndvi', aoi: AOI, pad: 'x'.repeat(300_000) }))).status).toBe(413)
  })
  it('ledger and results params', async () => {
    await expectInvalid(ledger(get('/x'), p({ runId: 'a b' })), 'runId')
    await expectInvalid(rerun(post('/x', {}), p({ runId: '../x' })), 'runId')
    await expectInvalid(rerun(post('/x', { force: true }), p({ runId: 'run1' })))
    await expectInvalid(results(get('/x'), p({ resultId: 'r_;drop' })), 'resultId')
  })
  it('GET /api/geo/tiles', async () => {
    const id = 'a'.repeat(24)
    await expectInvalid(tiles(get('/x'), p({ id: 'zz', z: '1', x: '0', y: '0' })), 'id')
    await expectInvalid(tiles(get('/x'), p({ id, z: '1', x: '2', y: '0' })), 'x')
    await expectInvalid(tiles(get('/x?rescale=a,b'), p({ id, z: '1', x: '0', y: '0' })), 'rescale')
    await expectInvalid(tiles(get('/x?bidx=0'), p({ id, z: '1', x: '0', y: '0' })))
  })
  it('GET /api/operations', async () => {
    await expectInvalid(operations(get('/api/operations?name=Bad-Name')), 'name')
    expect((await operations(get('/api/operations?name=no_such_op'))).status).toBe(404)
    const all = await (await operations(get('/api/operations'))).json()
    const one = await (await operations(get(`/api/operations?name=${all.operations[0].name}`))).json()
    expect(one.operations).toHaveLength(1)
  })
  it('POST /api/upload without a file field', async () => {
    process.env.ENABLE_UPLOADS = '1'
    const form = new FormData()
    form.set('note', 'no file')
    await expectInvalid(upload(new NextRequest('http://localhost/api/upload', { method: 'POST', body: form })), 'file')
    const huge = new NextRequest('http://localhost/api/upload', { method: 'POST', headers: { 'content-length': String(2 * 1024 ** 3), 'content-type': 'multipart/form-data; boundary=x' }, body: 'x' })
    expect((await upload(huge)).status).toBe(413)
    delete process.env.ENABLE_UPLOADS
  })
})
