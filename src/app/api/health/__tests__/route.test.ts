import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbQuery = vi.fn()
vi.mock('@/lib/db', () => ({ db: { $queryRaw: (...args: unknown[]) => dbQuery(...args) } }))

import { GET } from '../route'

const fetchMock = vi.fn()
const ok = () => new Response('{}', { status: 200 })
const status = (code: number) => new Response('', { status: code })
const refused = () => Promise.reject(new TypeError('fetch failed'))
const timedOut = () => Promise.reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))

/** Answer each probe by its URL; a value is a Response, or a function returning a promise. */
function route(answers: Record<string, () => Promise<Response> | Response>) {
  fetchMock.mockImplementation((url: string) => {
    const key = Object.keys(answers).find((k) => String(url).startsWith(k))
    if (!key) return Promise.reject(new Error(`unexpected probe ${url}`))
    return Promise.resolve(answers[key]())
  })
}

const healthy = {
  'https://earth-search.aws.element84.com/v1': ok,
  'https://overpass-api.de/api/interpreter': ok,
  'https://titiler.xyz/healthz': ok,
}

async function body() {
  const res = await GET()
  return { res, json: (await res.json()) as { status: string; checks: Record<string, string> } }
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('GEO_SERVICE_URL', '')
  vi.stubEnv('TITILER_ENDPOINT', '')
  vi.stubEnv('OLLAMA_BASE_URL', '')
  dbQuery.mockReset().mockResolvedValue([{ '?column?': 1 }])
  fetchMock.mockReset()
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('GET /api/health', () => {
  it('is ok (200) when the database and every configured dependency respond; geo not configured is fine', async () => {
    route(healthy)
    const { res, json } = await body()
    expect(res.status).toBe(200)
    expect(json.status).toBe('ok')
    expect(json.checks).toMatchObject({ database: 'ok', stac: 'ok', overpass: 'ok', titiler: 'ok', geo: 'not configured', llm: 'client-configured' })
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/health'))).toBe(false)
    expect(dbQuery).toHaveBeenCalledTimes(1)
  })

  it('probes the geo service /health and the TiTiler /healthz of the configured endpoints', async () => {
    vi.stubEnv('GEO_SERVICE_URL', 'http://geo:8100/')
    vi.stubEnv('TITILER_ENDPOINT', 'http://titiler:8000/')
    route({ ...healthy, 'http://geo:8100/health': ok, 'http://titiler:8000/healthz': ok })
    const { json } = await body()
    expect(json.status).toBe('ok')
    expect(json.checks.geo).toBe('ok')
    expect(json.checks.titiler).toBe('ok')
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls).toContain('http://geo:8100/health')
    expect(urls).toContain('http://titiler:8000/healthz')
  })

  it('is degraded, with the reason listed, in production without EVIDENCE_SIGNING_KEY', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('EVIDENCE_SIGNING_KEY', '')
    route(healthy)
    const { res, json } = await body()
    expect(res.status).toBe(200)
    expect(json.status).toBe('degraded')
    expect(JSON.stringify(json)).toMatch(/EVIDENCE_SIGNING_KEY/)
    vi.stubEnv('EVIDENCE_SIGNING_KEY', 'configured')
    expect((await body()).json.status).toBe('ok')
  })

  it('probes the geo service with its ID token when GEO_SERVICE_AUDIENCE is set', async () => {
    vi.stubEnv('GEO_SERVICE_URL', 'http://geo:8100')
    vi.stubEnv('GEO_SERVICE_AUDIENCE', 'http://geo:8100')
    const jwt = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.s`
    route({ ...healthy, 'http://metadata.google.internal': () => new Response(jwt), 'http://geo:8100/health': ok })
    const { json } = await body()
    expect(json.checks.geo).toBe('ok')
    const geoCall = fetchMock.mock.calls.find((c) => String(c[0]) === 'http://geo:8100/health')!
    expect(geoCall[1].headers).toEqual({ authorization: `Bearer ${jwt}` })
  })

  it('is down (503) when the database does not answer', async () => {
    route(healthy)
    dbQuery.mockRejectedValue(new Error("Can't reach database server at `db:5432`"))
    const { res, json } = await body()
    expect(res.status).toBe(503)
    expect(json.status).toBe('down')
    expect(json.checks.database).toBe("down: Can't reach database server at `db:5432`")
  })

  it('is down (503) when the database query hangs past the probe timeout', async () => {
    route(healthy)
    dbQuery.mockReturnValue(new Promise(() => {}))
    const started = Date.now()
    const { res, json } = await body()
    expect(Date.now() - started).toBeLessThan(2500)
    expect(res.status).toBe(503)
    expect(json.checks.database).toBe('down: timeout')
  })

  it('is degraded (200) when the geo service is down', async () => {
    vi.stubEnv('GEO_SERVICE_URL', 'http://geo:8100')
    route({ ...healthy, 'http://geo:8100/health': refused })
    const { res, json } = await body()
    expect(res.status).toBe(200)
    expect(json.status).toBe('degraded')
    expect(json.checks.geo).toBe('down: fetch failed')
    expect(json.checks.database).toBe('ok')
  })

  it('is degraded (200) when the geo service answers 5xx', async () => {
    vi.stubEnv('GEO_SERVICE_URL', 'http://geo:8100')
    route({ ...healthy, 'http://geo:8100/health': () => Promise.resolve(status(503)) })
    const { res, json } = await body()
    expect(res.status).toBe(200)
    expect(json.status).toBe('degraded')
    expect(json.checks.geo).toBe('degraded: HTTP 503')
  })

  it('is degraded (200) when TiTiler times out', async () => {
    route({ ...healthy, 'https://titiler.xyz/healthz': timedOut })
    const { res, json } = await body()
    expect(res.status).toBe(200)
    expect(json.status).toBe('degraded')
    expect(json.checks.titiler).toBe('down: timeout')
  })

  it('is degraded (200) when an upstream data source is down, even if the others are', async () => {
    route({ ...healthy, 'https://earth-search.aws.element84.com/v1': refused, 'https://overpass-api.de/api/interpreter': refused })
    const { res, json } = await body()
    expect(res.status).toBe(200)
    expect(json.status).toBe('degraded')
    expect(json.checks).toMatchObject({ stac: 'down: fetch failed', overpass: 'down: fetch failed', database: 'ok' })
  })

  it('reports a dependency that is not configured as not configured, without degrading the status', async () => {
    route({ ...healthy })
    const { json } = await body()
    expect(json.checks.geo).toBe('not configured')
    expect(json.status).toBe('ok')
  })

  it('probes the database and the other dependencies in parallel', async () => {
    vi.stubEnv('GEO_SERVICE_URL', 'http://geo:8100')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    route({ ...healthy, 'http://geo:8100/health': async () => { await gate; return ok() } })
    dbQuery.mockReturnValue(new Promise((r) => setTimeout(() => r([{ '?column?': 1 }]), 0)))
    const pending = GET()
    // Every probe has started before any of them has answered (the geo one is still waiting).
    await new Promise((r) => setTimeout(r, 10))
    expect(dbQuery).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(expect.arrayContaining(['http://geo:8100/health', 'https://titiler.xyz/healthz']))
    release()
    expect((await pending).status).toBe(200)
  })
})
