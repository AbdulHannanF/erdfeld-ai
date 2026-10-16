/**
 * C1 — getRequestOwner degrade test.
 *
 * With no auth provider configured (the default) + no session cookie,
 * `getServerSession` yields no account, so a request must resolve to its anonymous
 * `x-owner-token` — i.e. the no-account "draw + ask + save locally" flow is unchanged.
 * This is the acceptance clause that auth is additive, never a gate on anonymous use.
 */

import { describe, it, expect } from 'vitest'
import { getRequestOwner, authEnabled } from '../auth'

describe('getRequestOwner (anonymous fallback, auth unconfigured)', () => {
  it('falls back to the x-owner-token header when there is no session', async () => {
    const req = new Request('http://localhost/api/projects', {
      headers: { 'x-owner-token': 'uuid-anon-123' },
    })
    expect(await getRequestOwner(req)).toBe('uuid-anon-123')
  })

  it('returns empty when no session and no token (owns/lists nothing)', async () => {
    const req = new Request('http://localhost/api/projects')
    expect(await getRequestOwner(req)).toBe('')
  })
})

describe('authEnabled', () => {
  it('is false when no provider credentials are configured (default)', () => {
    const saved = { id: process.env.GITHUB_ID, secret: process.env.GITHUB_SECRET }
    delete process.env.GITHUB_ID
    delete process.env.GITHUB_SECRET
    try {
      expect(authEnabled()).toBe(false)
    } finally {
      if (saved.id !== undefined) process.env.GITHUB_ID = saved.id
      if (saved.secret !== undefined) process.env.GITHUB_SECRET = saved.secret
    }
  })
})
