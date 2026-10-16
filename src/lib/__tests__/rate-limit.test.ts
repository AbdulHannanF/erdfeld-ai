import { describe, expect, it, vi } from 'vitest'

vi.mock('../auth', () => ({ getRequestOwner: async (req: Request) => req.headers.get('x-test-owner') ?? '' }))

import { MemoryRateLimitStore, clientIp, enforceRateLimit } from '../rate-limit'

describe('MemoryRateLimitStore', () => {
  it('allows the burst, refuses the next with a Retry-After, and refills over the window', () => {
    const s = new MemoryRateLimitStore()
    for (let i = 0; i < 3; i++) expect(s.take('k', 3, 30, 0).allowed).toBe(true)
    const d = s.take('k', 3, 30, 0)
    expect(d).toMatchObject({ allowed: false, retryAfterS: 10 })
    expect(s.take('k', 3, 30, 5_000).allowed).toBe(false)
    expect(s.take('k', 3, 30, 10_000).allowed).toBe(true)
  })
  it('keeps keys apart', () => {
    const s = new MemoryRateLimitStore()
    expect(s.take('a', 1, 60, 0).allowed).toBe(true)
    expect(s.take('a', 1, 60, 0).allowed).toBe(false)
    expect(s.take('b', 1, 60, 0).allowed).toBe(true)
  })
})

describe('clientIp', () => {
  const req = (h: Record<string, string>) => new Request('http://x/api', { headers: h })
  const xff = { 'x-forwarded-for': '10.9.9.9, 198.51.100.4' }

  it('is one shared bucket unless a proxy is trusted', () => {
    expect(clientIp(req(xff), {})).toBe('shared')
    expect(clientIp(req(xff), { GEOAGENT_TRUST_PROXY: '0' })).toBe('shared')
  })
  it('nginx mode prefers X-Real-IP, else the right-most hop', () => {
    expect(clientIp(req({ ...xff, 'x-real-ip': '203.0.113.5' }), { GEOAGENT_TRUST_PROXY: '1' })).toBe('203.0.113.5')
    expect(clientIp(req(xff), { GEOAGENT_TRUST_PROXY: '1' })).toBe('198.51.100.4')
  })
  it('cloudrun mode takes the right-most hop and ignores a spoofed X-Real-IP', () => {
    const env = { GEOAGENT_TRUST_PROXY: 'cloudrun' }
    expect(clientIp(req({ ...xff, 'x-real-ip': '6.6.6.6' }), env)).toBe('198.51.100.4')
    expect(clientIp(req({ 'x-forwarded-for': '198.51.100.4' }), env)).toBe('198.51.100.4')
    expect(clientIp(req({}), env)).toBe('shared')
  })
  it('cloudrun mode skips GEOAGENT_TRUSTED_PROXY_HOPS trusted proxies from the right', () => {
    const h = req({ 'x-forwarded-for': '10.9.9.9, 198.51.100.4, 34.120.0.1' })
    expect(clientIp(h, { GEOAGENT_TRUST_PROXY: 'cloudrun', GEOAGENT_TRUSTED_PROXY_HOPS: '1' })).toBe('198.51.100.4')
    // more hops than entries: cannot tell, so do not guess
    expect(clientIp(h, { GEOAGENT_TRUST_PROXY: 'cloudrun', GEOAGENT_TRUSTED_PROXY_HOPS: '9' })).toBe('shared')
  })
})

describe('enforceRateLimit', () => {
  const req = (h: Record<string, string> = {}) => new Request('http://x/api', { headers: h })
  const env = { RATE_LIMIT_UPLOAD_MAX: '2', RATE_LIMIT_UPLOAD_WINDOW_S: '600', GEOAGENT_TRUST_PROXY: '1' }

  it('answers 429 with Retry-After once an IP is over its policy, other IPs unaffected', async () => {
    const a = { 'x-forwarded-for': '203.0.113.1' }
    expect(await enforceRateLimit(req(a), 'upload', env)).toBeNull()
    expect(await enforceRateLimit(req(a), 'upload', env)).toBeNull()
    const res = await enforceRateLimit(req(a), 'upload', env)
    expect(res?.status).toBe(429)
    expect(Number(res?.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await res!.json()).error).toBe('rate_limited')
    expect(await enforceRateLimit(req({ 'x-forwarded-for': '203.0.113.2' }), 'upload', env)).toBeNull()
  })
  it('limits signed-in accounts per account, and ignores the spoofable anonymous token', async () => {
    const acct = { 'x-test-owner': 'account:github:1', 'x-forwarded-for': '198.51.100.9' }
    await enforceRateLimit(req(acct), 'upload', env)
    await enforceRateLimit(req(acct), 'upload', env)
    expect((await enforceRateLimit(req({ ...acct, 'x-forwarded-for': '198.51.100.10' }), 'upload', env))?.status).toBe(429)
    const ip = '192.0.2.7'
    await enforceRateLimit(req({ 'x-test-owner': 't1', 'x-forwarded-for': ip }), 'upload', env)
    await enforceRateLimit(req({ 'x-test-owner': 't2', 'x-forwarded-for': ip }), 'upload', env)
    expect((await enforceRateLimit(req({ 'x-test-owner': 't3', 'x-forwarded-for': ip }), 'upload', env))?.status).toBe(429)
  })
  it('keys on the proxy-set address, so a client-sent X-Forwarded-For cannot dodge the limit', async () => {
    const via = (spoof: string) => req({ 'x-forwarded-for': `${spoof}, 203.0.113.50`, 'x-real-ip': '203.0.113.50' })
    await enforceRateLimit(via('10.0.0.1'), 'upload', env)
    await enforceRateLimit(via('10.0.0.2'), 'upload', env)
    expect((await enforceRateLimit(via('10.0.0.3'), 'upload', env))?.status).toBe(429)
    // without X-Real-IP, the right-most hop (added by the trusted proxy) is used, not the first
    const hop = (spoof: string) => req({ 'x-forwarded-for': `${spoof}, 198.51.100.77` })
    await enforceRateLimit(hop('10.1.0.1'), 'upload', env)
    await enforceRateLimit(hop('10.1.0.2'), 'upload', env)
    expect((await enforceRateLimit(hop('10.1.0.3'), 'upload', env))?.status).toBe(429)
  })
  it('can be switched off', async () => {
    for (let i = 0; i < 5; i++) expect(await enforceRateLimit(req({ 'x-forwarded-for': '1.1.1.1' }), 'upload', { ...env, RATE_LIMIT_DISABLED: '1' })).toBeNull()
  })
})
