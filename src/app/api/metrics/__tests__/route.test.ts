import { afterEach, describe, expect, it, vi } from 'vitest'

import { GET } from '../route'

const req = (auth?: string) => new Request('http://x/api/metrics', { headers: auth ? { authorization: auth } : {} })

afterEach(() => vi.unstubAllEnvs())

describe('GET /api/metrics', () => {
  it('is open when METRICS_TOKEN is unset', async () => {
    const res = GET(req())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
  })

  it('requires the bearer token once METRICS_TOKEN is set', async () => {
    vi.stubEnv('METRICS_TOKEN', 's3cret')
    expect(GET(req()).status).toBe(401)
    expect(GET(req('Bearer wrong!')).status).toBe(401)
    expect(GET(req('Bearer s3cre')).status).toBe(401)
    expect(GET(req('Basic s3cret')).status).toBe(401)
    expect(GET(req('Bearer s3cret')).status).toBe(200)
  })
})
