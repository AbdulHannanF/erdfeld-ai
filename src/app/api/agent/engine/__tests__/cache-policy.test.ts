import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { GeoResult } from '@/lib/geo-result'

import { SETTLE_DAYS, SIGNED_URL_MAX_MS, cachePolicy, expiryFor, hasSignedTiles, isCacheableStatus, isSettled } from '../cache-policy'
import { DAY, HOUR, defineOperation, type AnyOperation, type CacheTtl } from '../operation'

const NOW = Date.parse('2026-10-12T12:00:00Z')
const day = (offset: number) => new Date(NOW - offset * DAY).toISOString().slice(0, 10)

const op = (cacheTtl?: CacheTtl): AnyOperation => defineOperation({
  name: 'fake', label: 'x', version: '1.0.0', description: 'x', params: z.object({}).passthrough(),
  output: 'raster', cost: { typicalSeconds: 1 }, limitations: [], confidence: 'x', cacheTtl, run: async () => ({ summary: '' }),
})

const H = 'a'.repeat(64)
const key = (o: AnyOperation, args: Record<string, unknown>, now = NOW) => {
  const p = cachePolicy(o, args, H, now)
  if (!p.cacheable) throw new Error(p.reason)
  return p
}

describe('cachePolicy', () => {
  it('never caches an operation that declares no cacheTtl, or a zero ttl', () => {
    expect(cachePolicy(op(), {}, H, NOW).cacheable).toBe(false)
    expect(cachePolicy(op({ liveMs: 0 }), {}, H, NOW).cacheable).toBe(false)
  })

  it('keys an open-ended request by the day it was asked: reusable today, not tomorrow', () => {
    const o = op({ liveMs: 6 * HOUR, settledMs: 30 * DAY })
    const today = key(o, { band: 'B08' })
    expect(today.settled).toBe(false)
    expect(today.ttlMs).toBe(6 * HOUR)
    expect(key(o, { band: 'B08' }, NOW + HOUR).key).toBe(today.key)
    expect(key(o, { band: 'B08' }, NOW + DAY).key).not.toBe(today.key)
    expect(today.key).not.toBe(H)
  })

  it('treats a closed, explicit window that ended long ago as settled: key is the inputs hash, long ttl', () => {
    const o = op({ liveMs: 6 * HOUR, settledMs: 30 * DAY })
    const p = key(o, { start: day(100), end: day(SETTLE_DAYS + 1) })
    expect(p.settled).toBe(true)
    expect(p.key).toBe(H)
    expect(p.ttlMs).toBe(30 * DAY)
    expect(key(o, { start: day(100), end: day(SETTLE_DAYS + 1) }, NOW + 90 * DAY).key).toBe(H)
  })

  it('does not settle a window that is recent, open, relative or not an absolute day', () => {
    expect(isSettled({ start: '2026-09-01', end: '2026-09-30' }, NOW)).toBe(false) // 12 days ago
    expect(isSettled({ start: day(200) }, NOW)).toBe(false) // runs up to today
    expect(isSettled({ end: day(200), days: 7 }, NOW)).toBe(false)
    expect(isSettled({ end: day(200), months_back: 6 }, NOW)).toBe(false)
    expect(isSettled({ end: '2025' }, NOW)).toBe(false)
    expect(isSettled({}, NOW)).toBe(false)
    expect(isSettled({ date: day(200) }, NOW)).toBe(true)
  })

  it('uses the live ttl for dated arguments when the operation declares no settled one', () => {
    const p = key(op({ liveMs: HOUR }), { end: day(300) })
    expect(p.settled).toBe(false)
    expect(p.ttlMs).toBe(HOUR)
  })
})

describe('what is stored as a hit', () => {
  const result = (status: GeoResult['status'], tileUrl?: string) => ({ status, layers: tileUrl ? [{ id: 'l', type: 'raster', tileUrl }] : [] }) as unknown as GeoResult

  it('serves only answers: failed and refused are never reusable, flagged are', () => {
    expect(isCacheableStatus('ok')).toBe(true)
    expect(isCacheableStatus('flagged')).toBe(true)
    expect(isCacheableStatus('failed')).toBe(false)
    expect(isCacheableStatus('refused')).toBe(false)
  })

  it('caps the ttl of a result whose tiles carry a signed URL', () => {
    const signed = result('ok', `https://t/{z}/{x}/{y}.png?url=${encodeURIComponent('https://sa.blob/x.tif?se=2026&sig=abc')}`)
    const policy = key(op({ liveMs: 6 * HOUR }), {})
    expect(hasSignedTiles(signed)).toBe(true)
    expect(expiryFor(signed, policy, NOW)).toBe(NOW + SIGNED_URL_MAX_MS)
    expect(expiryFor(result('ok', 'https://t/{z}/{x}/{y}.png'), policy, NOW)).toBe(NOW + 6 * HOUR)
  })
})
