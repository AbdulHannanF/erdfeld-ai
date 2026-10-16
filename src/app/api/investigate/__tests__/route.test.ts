/** POST /api/investigate: validation, the shared rate limit, and the SSE transport. */

import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ db: new Proxy({}, { get: () => { throw new Error('db must not be touched') } }) }))
vi.mock('../../agent/engine/evidence-store', () => ({ defaultEvidenceStore: async () => { throw new Error('store must not be touched') } }))

import { InvestigateRequestSchema } from '@/lib/api-schemas'
import { POST } from '../route'

const RING = [[74.4, 30.95], [74.56, 30.95], [74.56, 31.08], [74.4, 31.08], [74.4, 30.95]]
const AOI = { type: 'Polygon', coordinates: [RING] }
const post = (body: unknown, raw = false, ip = '10.9.9.1') =>
  new NextRequest('http://localhost/api/investigate', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: raw ? (body as string) : JSON.stringify(body),
  })

describe('InvestigateRequestSchema', () => {
  it('accepts an area alone, or with a question, window and family', () => {
    expect(InvestigateRequestSchema.safeParse({ aoi: AOI }).success).toBe(true)
    const full = InvestigateRequestSchema.safeParse({ aoi: { type: 'Feature', properties: {}, geometry: AOI }, question: ' Why? ', window: { start: '2025-08', end: '2025-09-30' }, family: 'water' })
    expect(full.success).toBe(true)
    if (full.success) {
      expect(full.data.aoi.type).toBe('Polygon')
      expect(full.data.question).toBe('Why?')
    }
  })
  it.each([
    ['no area', {}],
    ['a point', { aoi: { type: 'Point', coordinates: [1, 2] } }],
    ['an unknown family', { aoi: AOI, family: 'volcano' }],
    ['a malformed date', { aoi: AOI, window: { start: 'August', end: '2025-09-30' } }],
    ['a window without an end', { aoi: AOI, window: { start: '2025-08-01' } }],
    ['an oversized question', { aoi: AOI, question: 'x'.repeat(5000) }],
  ])('refuses %s', (_n, body) => {
    expect(InvestigateRequestSchema.safeParse(body).success).toBe(false)
  })
})

describe('POST /api/investigate', () => {
  it('400s a bad body and non-JSON, 413s an oversized one', async () => {
    const bad = await POST(post({ aoi: AOI, family: 'volcano' }))
    expect(bad.status).toBe(400)
    const body = await bad.json()
    expect(body.error).toBe('invalid_request')
    expect(body.issues.map((i: { path: string }) => i.path)).toContain('family')
    expect((await POST(post('{nope', true))).status).toBe(400)
    expect((await POST(post(JSON.stringify({ aoi: AOI, pad: 'x'.repeat(2 * 1024 * 1024) }), true))).status).toBe(413)
  })

  it('streams an SSE error and done when no provider can be used', async () => {
    const saved = { ...process.env }
    delete process.env.GEMINI_API_KEY
    delete process.env.GEOAGENT_DEFAULT_PROVIDER
    delete process.env.AGENT_DEFAULT_PROVIDER
    try {
      const res = await POST(post({ aoi: AOI, question: 'q' }, false, '10.9.9.2'))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/event-stream')
      const text = await res.text()
      expect(text).toMatch(/event: error\ndata: \{"type":"error","message":"No AI provider is configured[^"]*","content":"No AI provider is configured/)
      expect(text).toMatch(/event: done\n/)
    } finally {
      process.env = saved
    }
  })

  it('shares the agent rate limit', async () => {
    process.env.GEOAGENT_TRUST_PROXY = '1'
    process.env.RATE_LIMIT_AGENT_MAX = '2'
    const ip = '10.9.9.3'
    expect((await POST(post({}, false, ip))).status).not.toBe(429)
    expect((await POST(post({}, false, ip))).status).not.toBe(429)
    const third = await POST(post({}, false, ip))
    expect(third.status).toBe(429)
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0)
  })
})
