/** Per-caller rate limiting: a token bucket behind a one-method interface.
 *
 *  Today the buckets live in this process's memory (one instance). `RateLimitStore` is the seam
 *  for a shared store (Redis) later: implement `take` there and pass it to `setRateLimitStore`.
 *
 *  The caller key is the signed-in account (`account:<id>`); everyone else is keyed by client IP,
 *  because the anonymous `x-owner-token` is chosen by the client and rotating it would reset a
 *  per-token bucket. The IP comes from the proxy headers only when `GEOAGENT_TRUST_PROXY` names
 *  the proxy in front (`1` = our nginx, `cloudrun`; see `clientIp`); otherwise all anonymous
 *  callers share one bucket, which is strict but cannot be spoofed.
 *
 *  Policies (requests per window, env-tunable): RATE_LIMIT_<NAME>_MAX / RATE_LIMIT_<NAME>_WINDOW_S,
 *  `RATE_LIMIT_DISABLED=1` turns limiting off.
 */

import { getRequestOwner } from './auth'
import { isAccountOwner } from './owner'

export interface RateDecision {
  allowed: boolean
  /** Seconds until one more request is allowed (0 when allowed). */
  retryAfterS: number
  remaining: number
}

export interface RateLimitStore {
  /** Take one token from `key`'s bucket (capacity `max`, refilled evenly over `windowS`). */
  take(key: string, max: number, windowS: number, now?: number): RateDecision | Promise<RateDecision>
}

export class MemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, { tokens: number; at: number }>()

  take(key: string, max: number, windowS: number, now = Date.now()): RateDecision {
    const perMs = max / (windowS * 1000)
    const b = this.buckets.get(key) ?? { tokens: max, at: now }
    b.tokens = Math.min(max, b.tokens + (now - b.at) * perMs)
    b.at = now
    let decision: RateDecision
    if (b.tokens >= 1) {
      b.tokens -= 1
      decision = { allowed: true, retryAfterS: 0, remaining: Math.floor(b.tokens) }
    } else {
      decision = { allowed: false, retryAfterS: Math.max(1, Math.ceil((1 - b.tokens) / perMs / 1000)), remaining: 0 }
    }
    this.buckets.set(key, b)
    if (this.buckets.size > 10_000) this.sweep(now, windowS)
    return decision
  }

  /** Drop buckets idle for a full window: they would be full again anyway. */
  private sweep(now: number, windowS: number) {
    for (const [k, b] of this.buckets) if (now - b.at > windowS * 1000) this.buckets.delete(k)
  }
}

let store: RateLimitStore = new MemoryRateLimitStore()
export function setRateLimitStore(s: RateLimitStore) { store = s }

export const RATE_POLICIES = {
  agent: { max: 20, windowS: 600 },
  quickLayer: { max: 60, windowS: 600 },
  upload: { max: 10, windowS: 600 },
  jobs: { max: 30, windowS: 600 },
  /** Listing a caller's own runs / batches (read-only, one indexed query). */
  lists: { max: 240, windowS: 600 },
  /** A case runs a recipe (seconds to a minute of upstream reads). */
  cases: { max: 20, windowS: 600 },
  /** A batch queues up to 500 cases; the cost is the plots, so few requests. */
  casesBatch: { max: 5, windowS: 600 },
} as const
export type RatePolicyName = keyof typeof RATE_POLICIES

function policy(name: RatePolicyName, env: Record<string, string | undefined>) {
  const key = name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()
  const num = (v: string | undefined, d: number) => (v && Number(v) > 0 ? Number(v) : d)
  return {
    max: num(env[`RATE_LIMIT_${key}_MAX`], RATE_POLICIES[name].max),
    windowS: num(env[`RATE_LIMIT_${key}_WINDOW_S`], RATE_POLICIES[name].windowS),
  }
}

/** Where the client address comes from, by `GEOAGENT_TRUST_PROXY`:
 *   - unset / anything else: nowhere. All anonymous callers share one bucket (strict, unspoofable).
 *   - `1` (or `true`, `nginx`): behind our nginx, which sets X-Real-IP from $remote_addr; without
 *     it, the right-most X-Forwarded-For hop.
 *   - `cloudrun`: Cloud Run's front end APPENDS the connecting address to X-Forwarded-For, so
 *     everything left of it is client-supplied and spoofable. The client is the right-most entry,
 *     or, with `GEOAGENT_TRUSTED_PROXY_HOPS=n` (n trusted proxies, e.g. a load balancer in front
 *     of Cloud Run, each appending its own address), the entry n places further left. X-Real-IP
 *     is ignored: nothing in front of Cloud Run sets it, so a client could. */
export function clientIp(req: Request, env: Record<string, string | undefined> = process.env): string {
  const mode = (env.GEOAGENT_TRUST_PROXY ?? '').trim().toLowerCase()
  const hops = (req.headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (mode === 'cloudrun') {
    const trusted = Number(env.GEOAGENT_TRUSTED_PROXY_HOPS)
    const skip = Number.isInteger(trusted) && trusted > 0 ? trusted : 0
    return hops[hops.length - 1 - skip] || 'shared'
  }
  if (mode !== '1' && mode !== 'true' && mode !== 'nginx') return 'shared'
  // X-Real-IP is set by our nginx from $remote_addr. X-Forwarded-For is appended to, so its first
  // entry is whatever the client sent; only the right-most hop was added by the trusted proxy.
  return req.headers.get('x-real-ip')?.trim() || hops[hops.length - 1] || 'shared'
}

/** Returns a 429 response when the caller is over the `name` policy, else null (proceed). */
export async function enforceRateLimit(req: Request, name: RatePolicyName, env: Record<string, string | undefined> = process.env): Promise<Response | null> {
  if (env.RATE_LIMIT_DISABLED === '1') return null
  const owner = await getRequestOwner(req)
  const who = isAccountOwner(owner) ? owner : `ip:${clientIp(req, env)}`
  const { max, windowS } = policy(name, env)
  const d = await store.take(`${name}:${who}`, max, windowS)
  if (d.allowed) return null
  return Response.json(
    { error: 'rate_limited', message: `Too many requests. Try again in ${d.retryAfterS} s.`, retry_after_s: d.retryAfterS },
    { status: 429, headers: { 'Retry-After': String(d.retryAfterS), 'Cache-Control': 'no-store' } },
  )
}
