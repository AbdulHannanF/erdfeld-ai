import { describe, it, expect, vi } from 'vitest'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) =>
    host === 'rebind.example.com' ? [{ address: '169.254.169.254' }] :
    host === 'nx.example.com' ? Promise.reject(new Error('ENOTFOUND')) :
    [{ address: '93.184.216.34' }]),
}))

import { assertSafeUrl, checkUrlSyntax, isNonPublicIp } from '../url-guard'

const dev = { NODE_ENV: 'development' }
const prod = { NODE_ENV: 'production' }

describe('isNonPublicIp', () => {
  it.each(['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '224.0.0.1'])(
    '%s is non-public', (ip) => expect(isNonPublicIp(ip)).toBe(true))
  it.each(['8.8.8.8', '172.32.0.1', '93.184.216.34', '2606:4700::1111'])('%s is public', (ip) => expect(isNonPublicIp(ip)).toBe(false))
})

describe('checkUrlSyntax', () => {
  it('blocks metadata and private literals in every environment', () => {
    for (const env of [dev, prod]) {
      for (const u of ['http://169.254.169.254/latest', 'http://metadata.google.internal/', 'http://10.1.2.3:8080', 'http://[::1]/', 'http://[fd00::1]/', 'http://db.internal/', 'http://printer.local/']) {
        const r = checkUrlSyntax(u, env)
        if (u.includes('[::1]')) expect(r.ok).toBe(env === dev)
        else expect(r.ok, u).toBe(false)
      }
    }
  })
  it('blocks non-http schemes and embedded credentials', () => {
    expect(checkUrlSyntax('file:///etc/passwd', dev).ok).toBe(false)
    expect(checkUrlSyntax('ftp://example.com', dev).ok).toBe(false)
    expect(checkUrlSyntax('https://user:pw@example.com', dev).ok).toBe(false)
    expect(checkUrlSyntax('nonsense', dev).ok).toBe(false)
  })
  it('allows localhost outside production only', () => {
    expect(checkUrlSyntax('http://localhost:11434', dev).ok).toBe(true)
    expect(checkUrlSyntax('http://127.0.0.1:11434', dev).ok).toBe(true)
    expect(checkUrlSyntax('http://localhost:11434', prod).ok).toBe(false)
    expect(checkUrlSyntax('http://127.0.0.1:11434', prod).ok).toBe(false)
  })
  it('allows public https hosts', () => {
    expect(checkUrlSyntax('https://api.example.com/v1', prod).ok).toBe(true)
  })
})

describe('assertSafeUrl', () => {
  it('rejects a public-looking name that resolves to the metadata address', async () => {
    await expect(assertSafeUrl('https://rebind.example.com', prod)).rejects.toThrow(/private or link-local/)
  })
  it('rejects an unresolvable host and accepts a public one', async () => {
    await expect(assertSafeUrl('https://nx.example.com', prod)).rejects.toThrow(/did not resolve/)
    await expect(assertSafeUrl('https://ok.example.com', prod)).resolves.toBeInstanceOf(URL)
  })
})
