import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { composite, GeoServiceError, isGeoServiceConfigured, timeseries, zonal } from '../geo-service'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('geo-service client', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('GEO_SERVICE_URL', 'http://geo:8100/')
  })
  afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('isGeoServiceConfigured follows GEO_SERVICE_URL', () => {
    expect(isGeoServiceConfigured()).toBe(true)
    vi.stubEnv('GEO_SERVICE_URL', '')
    expect(isGeoServiceConfigured()).toBe(false)
  })

  it('throws not_configured without calling fetch when the URL is unset', async () => {
    vi.stubEnv('GEO_SERVICE_URL', '')
    await expect(composite({ bbox: [1, 2, 3, 4], start: '2026-09-01', end: '2026-09-30', expression: 'NDVI' }))
      .rejects.toMatchObject({ kind: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POSTs the request to /composite and returns the typed body', async () => {
    const body = { id: 'abc', items: ['a'], item_count: 1, valid_pixel_pct: 99.5, message: null, cached: false }
    fetchMock.mockResolvedValue(json(body))
    const req = { bbox: [74.05, 31.12, 74.08, 31.15] as [number, number, number, number], start: '2026-09-01', end: '2026-09-30', expression: 'NDVI' }
    const out = await composite(req)
    expect(out.id).toBe('abc')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://geo:8100/composite')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual(req)
  })

  it('returns an explicit empty result (not an error) when no scenes exist', async () => {
    fetchMock.mockResolvedValue(json({ id: null, items: [], item_count: 0, valid_pixel_pct: null, cached: false, message: 'No sentinel-2-l2a scenes intersect the AOI' }))
    const out = await composite({ bbox: [1, 2, 3, 4], start: '2020-01-01', end: '2020-01-02', bands: ['red'] })
    expect(out.item_count).toBe(0)
    expect(out.id).toBeNull()
    expect(out.message).toMatch(/No sentinel-2-l2a scenes/)
  })

  it('maps 502 fetch_failed to a typed upstream failure', async () => {
    fetchMock.mockResolvedValue(json({ error: 'fetch_failed', detail: 'STAC search failed: timeout' }, 502))
    const err = await timeseries({ bbox: [1, 2, 3, 4], start: '2026-09-01', end: '2026-09-30', band: 'red' }).catch((e) => e)
    expect(err).toBeInstanceOf(GeoServiceError)
    expect(err).toMatchObject({ kind: 'fetch_failed', status: 502, detail: 'STAC search failed: timeout' })
    expect(err.isUpstreamFailure).toBe(true)
  })

  it('maps 422 / 413 / 404 to their kinds, which are not upstream failures', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'bad_request', detail: 'unknown band' }, 422))
    const e1 = await zonal({ features: { type: 'FeatureCollection', features: [] }, source: 'x' }).catch((e) => e)
    expect(e1).toMatchObject({ kind: 'bad_request', status: 422 })
    expect(e1.isUpstreamFailure).toBe(false)
    fetchMock.mockResolvedValueOnce(json({ error: 'too_large', detail: 'AOI too big' }, 413))
    expect(await composite({ bbox: [1, 2, 3, 4], start: 'a', end: 'b', bands: ['red'] }).catch((e) => e)).toMatchObject({ kind: 'too_large' })
    fetchMock.mockResolvedValueOnce(json({ error: 'not_found', detail: 'composite gone' }, 404))
    expect(await zonal({ features: { type: 'FeatureCollection', features: [] }, source: 'x' }).catch((e) => e)).toMatchObject({ kind: 'not_found' })
  })

  it('reports unreachable service and non-JSON errors honestly', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    const e1 = await composite({ bbox: [1, 2, 3, 4], start: 'a', end: 'b', bands: ['red'] }).catch((e) => e)
    expect(e1).toMatchObject({ kind: 'unreachable' })
    expect(e1.isUpstreamFailure).toBe(true)
    fetchMock.mockResolvedValueOnce(new Response('Bad gateway', { status: 503 }))
    expect(await composite({ bbox: [1, 2, 3, 4], start: 'a', end: 'b', bands: ['red'] }).catch((e) => e)).toMatchObject({ kind: 'http_error', status: 503, detail: 'Bad gateway' })
  })

  it('times out via AbortSignal', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'TimeoutError')))))
    const err = await composite({ bbox: [1, 2, 3, 4], start: 'a', end: 'b', bands: ['red'] }, { timeoutMs: 20 }).catch((e) => e)
    expect(err).toMatchObject({ kind: 'timeout' })
  })
})
