import { describe, expect, it } from 'vitest'

import { buildCsp, securityHeaders } from '../security-headers'

describe('security headers', () => {
  const csp = buildCsp({ NODE_ENV: 'production', TITILER_ENDPOINT: 'https://tiles.example.org/titiler/', CSP_CONNECT_EXTRA: 'https://a.test https://b.test' })
  it('has no eval in production, allows blob workers and forbids framing', () => {
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).toContain("worker-src 'self' blob:")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
  })
  it('lists the configured tile hosts', () => {
    expect(csp).toContain('https://tiles.example.org')
    expect(csp).toContain('https://a.test')
    expect(csp).toMatch(/connect-src[^;]*cartocdn\.com/)
    expect(csp).toMatch(/connect-src[^;]*planetarycomputer\.microsoft\.com/)
  })
  it('lets MapLibre read inline data: image sources (connect-src), which the map fetches', () => {
    expect(csp).toMatch(/connect-src[^;]*data:/)
  })
  it('allows eval only outside production', () => {
    expect(buildCsp({ NODE_ENV: 'development' })).toContain("'unsafe-eval'")
  })
  it('sends the hardening headers', () => {
    const keys = securityHeaders({ NODE_ENV: 'production' }).map((h) => h.key)
    expect(keys).toEqual(expect.arrayContaining(['Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy']))
  })
})
