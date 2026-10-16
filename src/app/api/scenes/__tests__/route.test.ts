/**
 * GET /api/scenes: validation, paging, caching headers, the 502 for an unreachable catalogue and the
 * rate limit. The catalogue is a fake `fetch`; the route, the schema and the search are the real ones.
 */

import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _resetCache } from '../../agent/lib/cache'
import { GET } from '../route'

const item = (i: number) => ({
  id: `S2A_43RDQ_2024${String(i + 1).padStart(2, '0')}01_0_L2A`,
  collection: 'sentinel-2-l2a',
  bbox: [73.0, 30.0, 76.0, 32.5],
  properties: { datetime: `2024-${String(i + 1).padStart(2, '0')}-01T05:40:00Z`, 'eo:cloud_cover': i * 10, platform: 'sentinel-2a' },
  assets: Object.fromEntries(['red', 'green', 'blue', 'nir'].map((k) => [k, { href: `https://sentinel-cogs.s3.amazonaws.com/${i}/${k}.tif` }])),
  links: [{ rel: 'self', href: `https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/x${i}` }],
})

const url = (qs: string, ip = '10.1.1.1') => new NextRequest(`http://localhost/api/scenes?${qs}`, { headers: { 'x-forwarded-for': ip } })
const BBOX = 'bbox=74.05,31.12,74.08,31.15'

beforeEach(() => {
  _resetCache()
  process.env.GEOAGENT_TRUST_PROXY = '1'
  process.env.SCENES_RETRY_MS = '1'
  delete process.env.RATE_LIMIT_SCENES_MAX
})
afterEach(() => vi.unstubAllGlobals())

describe('GET /api/scenes', () => {
  it('rejects a bad request with the reasons, and runs nothing', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    for (const qs of [
      '',
      'bbox=74,31',
      `${BBOX}&sensor=modis`,
      `${BBOX}&from=2024-13-01`,
      `${BBOX}&from=2024-05-01&to=2024-01-01`,
      `${BBOX}&maxCloud=101`,
      `${BBOX}&limit=0`,
      `${BBOX}&limit=500`,
      `${BBOX}&order=sideways`,
      'bbox=70,20,90,40', // far over 5,000 km2
      'bbox=74.08,31.15,74.05,31.12', // west is east of east
    ]) {
      const res = await GET(url(qs))
      expect(res.status, qs).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('invalid_request')
      expect(body.issues.length).toBeGreaterThan(0)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('pages through the scenes oldest first with a cursor, and states the archive extent and the cloud basis', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: Array.from({ length: 5 }, (_, i) => item(i)), links: [] }), { status: 200 })))
    const first = await GET(url(`${BBOX}&sensor=sentinel-2&from=2024-01-01&to=2024-12-31&limit=2&render=ndvi`))
    expect(first.status).toBe(200)
    const a = await first.json()
    expect(a).toMatchObject({ sensor: 'sentinel-2', total: 5, first: '2024-01-01', last: '2024-05-01', next: '2', truncated: false })
    expect(a.scenes.map((s: { date: string }) => s.date)).toEqual(['2024-01-01', '2024-02-01'])
    expect(a.scenes[0]).toMatchObject({ cloudBasis: 'scene', cloudPct: 0, sensor: 'sentinel-2' })
    expect(a.scenes[0].tileUrl).toContain('rescale=-0.1%2C0.9')
    expect(a.render).toMatchObject({ mode: 'ndvi', rescale: [-0.1, 0.9] })
    expect(first.headers.get('cache-control')).toContain('max-age=300')

    const last = await (await GET(url(`${BBOX}&sensor=sentinel-2&from=2024-01-01&to=2024-12-31&limit=2&cursor=4`))).json()
    expect(last.scenes.map((s: { date: string }) => s.date)).toEqual(['2024-05-01'])
    expect(last.next).toBeNull()
  })

  it('is a 502, not an empty list, when the catalogue cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
    const res = await GET(url(`${BBOX}&from=2024-01-01&to=2024-02-01`))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toBe('catalogue_unavailable')
    expect(body.message).toMatch(/Could not reach/)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('an empty catalogue answer is a 200 with no scenes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: [], links: [] }), { status: 200 })))
    const body = await (await GET(url(`${BBOX}&from=2024-01-01&to=2024-02-01`))).json()
    expect(body).toMatchObject({ total: 0, scenes: [], next: null, first: null, last: null })
  })

  it('429 with Retry-After once the policy is used up (per IP)', async () => {
    process.env.RATE_LIMIT_SCENES_MAX = '2'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: [], links: [] }), { status: 200 })))
    const ip = '10.9.9.9'
    expect((await GET(url(`${BBOX}&from=2024-01-01&to=2024-02-01`, ip))).status).toBe(200)
    expect((await GET(url(`${BBOX}&from=2024-01-01&to=2024-02-01`, ip))).status).toBe(200)
    const third = await GET(url(`${BBOX}&from=2024-01-01&to=2024-02-01`, ip))
    expect(third.status).toBe(429)
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0)
  })
})
