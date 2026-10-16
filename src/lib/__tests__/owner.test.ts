/**
 * Unit tests for C1 — account-scoped project ownership.
 *
 * Covers the pure ownership-key resolution + the access-control matrix that makes a
 * signed-in user's projects private to their account while keeping anonymous use
 * working. (Live sign-in is owner-verified with GitHub creds — see auth.ts.)
 */

import { describe, it, expect } from 'vitest'
import { accountOwnerKey, isAccountOwner, resolveOwnerKey } from '../owner'
import { canAccessProject } from '../projects'

describe('accountOwnerKey / isAccountOwner', () => {
  it('namespaces an account id', () => {
    expect(accountOwnerKey('github:42')).toBe('account:github:42')
  })
  it('recognizes account keys vs anonymous UUIDs', () => {
    expect(isAccountOwner('account:github:42')).toBe(true)
    expect(isAccountOwner('b3f1c0de-1234-5678-9abc-def012345678')).toBe(false)
    expect(isAccountOwner(null)).toBe(false)
    expect(isAccountOwner('')).toBe(false)
  })
})

describe('resolveOwnerKey (signed-in account wins over anon token)', () => {
  it('returns account:<id> when signed in', () => {
    expect(resolveOwnerKey({ accountId: 'github:42', anonToken: 'uuid-abc' })).toBe('account:github:42')
  })
  it('falls back to the anon token when not signed in', () => {
    expect(resolveOwnerKey({ accountId: null, anonToken: 'uuid-abc' })).toBe('uuid-abc')
  })
  it('returns empty when neither present (owns/lists nothing)', () => {
    expect(resolveOwnerKey({})).toBe('')
    expect(resolveOwnerKey({ accountId: '', anonToken: '' })).toBe('')
  })
  it('caps an overlong anon token', () => {
    const long = 'x'.repeat(500)
    expect(resolveOwnerKey({ anonToken: long }).length).toBe(128)
  })
})

describe('canAccessProject — account scoping matrix (C1 acceptance)', () => {
  const alice = accountOwnerKey('github:alice')
  const bob = accountOwnerKey('github:bob')
  const anonA = 'uuid-aaaa'
  const anonB = 'uuid-bbbb'

  it('an account owner can access their own project', () => {
    expect(canAccessProject(alice, alice)).toBe(true)
  })
  it("another account CANNOT access Alice's project (private)", () => {
    expect(canAccessProject(alice, bob)).toBe(false)
  })
  it('an anonymous request CANNOT access an account project', () => {
    expect(canAccessProject(alice, anonA)).toBe(false)
  })
  it('an account request CANNOT access a different anonymous project', () => {
    expect(canAccessProject(anonA, alice)).toBe(false)
  })
  it('the same anonymous browser still accesses its own project', () => {
    expect(canAccessProject(anonA, anonA)).toBe(true)
  })
  it('a different anonymous browser cannot access it', () => {
    expect(canAccessProject(anonA, anonB)).toBe(false)
  })
  it('legacy null-token projects stay open (no orphaning)', () => {
    expect(canAccessProject(null, alice)).toBe(true)
    expect(canAccessProject(null, anonA)).toBe(true)
    expect(canAccessProject(null, '')).toBe(true)
  })

  it('end-to-end: sign-in upgrades the request owner so account projects are private', () => {
    // Alice saves a project while signed in → stored token is her account key.
    const stored = resolveOwnerKey({ accountId: 'github:alice', anonToken: anonA })
    expect(stored).toBe(alice)
    // A later request from Alice (signed in) matches.
    expect(canAccessProject(stored, resolveOwnerKey({ accountId: 'github:alice', anonToken: anonB }))).toBe(true)
    // The same browser after signing OUT (anon only) no longer matches → account-private.
    expect(canAccessProject(stored, resolveOwnerKey({ accountId: null, anonToken: anonA }))).toBe(false)
  })
})
