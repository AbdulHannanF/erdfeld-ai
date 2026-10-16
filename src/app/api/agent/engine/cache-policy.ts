/** When may a result be reused? (Q-47, ADR-0001 §6)
 *
 *  `inputs_hash` says what was asked; it says nothing about WHEN. The same arguments answered
 *  today and next month can read different scenes, so a cached result is only honest while the
 *  data it read cannot have changed. Three rules, all decided here and nowhere else:
 *
 *  1. Never cache what did not produce an answer: `failed` and `refused` results have no cache
 *     key. A flagged result IS cached (it ran; it keeps its flags).
 *  2. Time-dependent arguments are part of the key. An open-ended request ("latest", no `end`,
 *     "last 30 days") is resolved against today inside the operation, so its key carries the UTC
 *     day it was asked on and it is reused only within that day and its `liveMs`.
 *  3. Only a fully explicit, old-enough date window is `settled` and gets the long `settledMs`:
 *     every date is an absolute day, the window is closed (`end`/`date`/`date2`/`after` given),
 *     and it ended more than SETTLE_DAYS ago, so late-arriving scenes no longer change it.
 *
 *  Operations declare their own TTLs (`cacheTtl`); one that declares none is never cached.
 */

import { createHash } from 'node:crypto'

import type { GeoResult } from '@/lib/geo-result'

import { DAY, DATE_KEYS, type AnyOperation } from './operation'

/** Days after the last date of a window before it counts as settled: Sentinel scenes can arrive
 *  late and the operations pick the clearest scene within +-30 days of a target date. */
export const SETTLE_DAYS = 45

/** Arguments that are relative to the moment the operation runs. */
const RELATIVE_KEYS = ['days', 'months', 'months_back'] as const
/** A window is closed when one of these ends it; `start` alone runs up to today. */
const CLOSING_KEYS = ['end', 'date', 'date2', 'after'] as const

/** Signed asset URLs (Planetary Computer SAS tokens) live in a layer's `tileUrl` and expire in
 *  about an hour; a cached layer is served for less than that so its tiles still load. */
export const SIGNED_URL_MAX_MS = 10 * 60_000

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10)

const ABSOLUTE_DAY = /^\d{4}-\d{2}-\d{2}$/

export type CachePolicy =
  | { cacheable: false; reason: string }
  | { cacheable: true; settled: boolean; ttlMs: number; key: string }

/** Is every date in the arguments an explicit, closed, old-enough window? */
export function isSettled(args: Record<string, unknown>, now: number): boolean {
  if (RELATIVE_KEYS.some((k) => args[k] !== undefined)) return false
  const given = DATE_KEYS.filter((k) => typeof args[k] === 'string' && args[k] !== '')
  if (given.length === 0) return false
  if (!CLOSING_KEYS.some((k) => given.includes(k))) return false
  const times = given.map((k) => (ABSOLUTE_DAY.test(args[k] as string) ? Date.parse(`${args[k]}T00:00:00Z`) : NaN))
  if (times.some(Number.isNaN)) return false
  return Math.max(...times) <= now - SETTLE_DAYS * DAY
}

export function cachePolicy(op: AnyOperation, args: Record<string, unknown>, inputsHash: string, now: number): CachePolicy {
  const ttl = op.cacheTtl
  if (!ttl) return { cacheable: false, reason: `${op.name} declares no cacheTtl` }
  const settled = ttl.settledMs != null && isSettled(args, now)
  const ttlMs = settled ? ttl.settledMs! : ttl.liveMs
  if (!(ttlMs > 0)) return { cacheable: false, reason: `${op.name} is not cached for these arguments` }
  // A settled result is addressed by its arguments alone; anything else also by today's date.
  return { cacheable: true, settled, ttlMs, key: settled ? inputsHash : sha256(`${inputsHash}@${utcDay(now)}`) }
}

/** Only results that answered are reusable. */
export const isCacheableStatus = (status: GeoResult['status']): boolean => status === 'ok' || status === 'flagged'

/** True when a layer's tiles depend on a signed URL that will expire. */
export function hasSignedTiles(result: GeoResult): boolean {
  return result.layers.some((l) => {
    if (!l.tileUrl) return false
    let url = l.tileUrl
    try { url = decodeURIComponent(l.tileUrl) } catch { /* keep raw */ }
    return /[?&]sig=/.test(url)
  })
}

/** Epoch ms after which a stored result is no longer served as a cache hit. */
export function expiryFor(result: GeoResult, policy: Extract<CachePolicy, { cacheable: true }>, now: number): number {
  const ttl = hasSignedTiles(result) ? Math.min(policy.ttlMs, SIGNED_URL_MAX_MS) : policy.ttlMs
  return now + ttl
}
