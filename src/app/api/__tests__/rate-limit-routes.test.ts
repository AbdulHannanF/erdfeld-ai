import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'

import { POST as agent } from '../agent/route'
import { POST as quick } from '../quick-layer/route'
import { POST as upload } from '../upload/route'

const req = (url: string, ip: string) =>
  new NextRequest(`http://localhost${url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: '{}' })

describe('rate limits on the expensive routes', () => {
  it('429 with Retry-After after the policy is used up (per IP)', async () => {
    process.env.GEOAGENT_TRUST_PROXY = '1'
    process.env.RATE_LIMIT_AGENT_MAX = '2'
    process.env.RATE_LIMIT_QUICK_LAYER_MAX = '2'
    process.env.RATE_LIMIT_UPLOAD_MAX = '2'
    for (const [route, url] of [[agent, '/api/agent'], [quick, '/api/quick-layer'], [upload, '/api/upload']] as const) {
      const ip = `10.0.0.${url.length}`
      // the first two reach validation (400) or the feature gate (503); the third is refused first
      expect((await route(req(url, ip))).status).not.toBe(429)
      expect((await route(req(url, ip))).status).not.toBe(429)
      const third = await route(req(url, ip))
      expect(third.status, url).toBe(429)
      expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0)
    }
  })
})
