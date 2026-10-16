import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { composite } from '../geo-service'
import { geoAuthHeaders, resetGeoAuthCache } from '../geo-auth'

const AUD = 'https://erdfeld-geo-abc-uc.a.run.app'
const jwt = (expSec: number) => `h.${Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url')}.s`
const nowSec = () => Math.floor(Date.now() / 1000)

describe('geoAuthHeaders', () => {
  const fetchMock = vi.fn()
  beforeEach(() => { vi.stubGlobal('fetch', fetchMock); resetGeoAuthCache() })
  afterEach(() => { fetchMock.mockReset(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

  it('adds nothing, and never calls the metadata server, when no audience is configured', async () => {
    expect(await geoAuthHeaders()).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches an ID token for the audience from the metadata server and sends it as a bearer token', async () => {
    vi.stubEnv('GEO_SERVICE_AUDIENCE', `${AUD}/`)
    const token = jwt(nowSec() + 3600)
    fetchMock.mockResolvedValue(new Response(token))
    expect(await geoAuthHeaders()).toEqual({ authorization: `Bearer ${token}` })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(AUD)}`)
    expect(init.headers).toEqual({ 'Metadata-Flavor': 'Google' })
  })

  it('caches the token until shortly before it expires, then renews it', async () => {
    vi.stubEnv('GEO_SERVICE_AUDIENCE', AUD)
    fetchMock.mockImplementation(async () => new Response(jwt(nowSec() + 3600)))
    await geoAuthHeaders()
    await geoAuthHeaders()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockImplementation(async () => new Response(jwt(nowSec() + 30))) // expires inside the renewal margin
    resetGeoAuthCache()
    await geoAuthHeaders()
    await geoAuthHeaders()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('shares one metadata request between concurrent callers', async () => {
    vi.stubEnv('GEO_SERVICE_AUDIENCE', AUD)
    fetchMock.mockImplementation(async () => new Response(jwt(nowSec() + 3600)))
    await Promise.all([geoAuthHeaders(), geoAuthHeaders(), geoAuthHeaders()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['metadata server unreachable', () => Promise.reject(new TypeError('fetch failed'))],
    ['metadata server refuses', () => Promise.resolve(new Response('no', { status: 404 }))],
    ['a body that is not a JWT', () => Promise.resolve(new Response('garbage'))],
  ])('returns null, not an unauthenticated request, when %s', async (_n, answer) => {
    vi.stubEnv('GEO_SERVICE_AUDIENCE', AUD)
    fetchMock.mockImplementation(answer)
    expect(await geoAuthHeaders()).toBeNull()
  })
})

describe('geo-service client with auth', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    resetGeoAuthCache()
    vi.stubEnv('GEO_SERVICE_URL', AUD)
  })
  afterEach(() => { fetchMock.mockReset(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
  const req = { bbox: [1, 2, 3, 4] as [number, number, number, number], start: '2026-09-01', end: '2026-09-30', expression: 'NDVI' }

  it('sends the bearer token to the geo service', async () => {
    vi.stubEnv('GEO_SERVICE_AUDIENCE', AUD)
    const token = jwt(nowSec() + 3600)
    fetchMock.mockImplementation(async (url: string) =>
      String(url).startsWith('http://metadata.google.internal')
        ? new Response(token)
        : new Response(JSON.stringify({ id: 'x', items: [], item_count: 0, valid_pixel_pct: null, message: null, cached: false }), { status: 200 }),
    )
    await composite(req)
    const geoCall = fetchMock.mock.calls.find(([u]) => String(u).startsWith(AUD))!
    expect(geoCall[1].headers).toMatchObject({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })
  })

  it('fails as unreachable, without calling the service, when no token can be had', async () => {
    vi.stubEnv('GEO_SERVICE_AUDIENCE', AUD)
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    await expect(composite(req)).rejects.toMatchObject({ kind: 'unreachable' })
    expect(fetchMock.mock.calls.every(([u]) => String(u).startsWith('http://metadata.google.internal'))).toBe(true)
  })
})
