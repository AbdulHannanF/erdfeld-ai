import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GET } from '../[id]/[z]/[x]/[y]/route'

const ID = 'a1b2c3d4e5f60718293a4b5c'
const fetchMock = vi.fn()

const call = (path: string, query = '') =>
  GET(new NextRequest(`http://localhost/api/geo/tiles/${path}${query}`), {
    params: Promise.resolve(Object.fromEntries(['id', 'z', 'x', 'y'].map((k, i) => [k, path.split('/')[i]])) as any),
  })

beforeEach(() => { vi.stubGlobal('fetch', fetchMock); vi.stubEnv('GEO_SERVICE_URL', 'http://geo:8100') })
afterEach(() => { fetchMock.mockReset(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('/api/geo/tiles proxy', () => {
  it('forwards a valid tile request with the whitelisted style params and returns the PNG', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } }))
    const res = await call(`${ID}/14/11567/6637`, '?rescale=0.1,0.8&colormap_name=rdylgn&evil=1')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer()).subarray(1, 4).toString()).toBe('PNG')
    expect(fetchMock.mock.calls[0][0]).toBe(`http://geo:8100/composite/${ID}/tiles/14/11567/6637.png?rescale=0.1%2C0.8&colormap_name=rdylgn`)
  })

  it.each([
    ['a non-hex id', '../etc/passwd/1/0/0'],
    ['a short id', 'abc/1/0/0'],
    ['a path-like id', `${ID.replace('a1', '..')}/1/0/0`],
    ['x out of range', `${ID}/2/4/0`],
    ['y out of range', `${ID}/0/0/1`],
    ['a non-integer z', `${ID}/1.5/0/0`],
    ['an absurd zoom', `${ID}/30/0/0`],
  ])('rejects %s with 400 without calling upstream', async (_n, path) => {
    const res = await call(path)
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['rescale', '?rescale=1;2'],
    ['rescale', '?rescale=http://x,1'],
    ['colormap_name', '?colormap_name=../x'],
    ['bidx', '?bidx=0'],
  ])('rejects a bad %s', async (_n, q) => {
    expect((await call(`${ID}/1/0/0`, q)).status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('passes upstream statuses through (404 evicted, 204 outside bounds)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"not_found"}', { status: 404, headers: { 'content-type': 'application/json' } }))
    const r404 = await call(`${ID}/1/0/0`)
    expect(r404.status).toBe(404)
    expect(r404.headers.get('cache-control')).toBe('no-store')
    expect(await r404.json()).toMatchObject({ error: 'not_found' })
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect((await call(`${ID}/1/0/0`)).status).toBe(204)
  })

  it('a geo service that cannot be reached is a 502 fetch_failed, never an empty tile', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const res = await call(`${ID}/1/0/0`)
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: 'fetch_failed' })
  })

  it('is 503 when GEO_SERVICE_URL is not configured', async () => {
    vi.stubEnv('GEO_SERVICE_URL', '')
    expect((await call(`${ID}/1/0/0`)).status).toBe(503)
  })
})
