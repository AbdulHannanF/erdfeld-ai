/** Tiered cache for read-only, idempotent external fetches (P5.1).
 *
 *  Scope: STAC search, titiler stats, Overpass, opentopodata DEM, Open-Meteo,
 *  SoilGrids, WorldPop, etc. Out of scope: live data (OpenSky), authenticated/paid
 *  endpoints, model inference.
 *
 *  Layers:
 *    L1 — in-process Map with TTL + LRU eviction (default 200 entries).
 *    L2 — optional file-backed disk cache behind the `AGENT_CACHE_DIR` env, keyed by
 *         SHA-256, opted into per-call via `{ persist: true }` for deterministic results
 *         (SoilGrids points, signed asset URLs). Survives a process restart.
 *
 *  In-flight de-dup: concurrent callers with the same key share one network hit.
 *  Per-source TTLs live in `PROVIDER_TTL_MAP` so call sites stop carrying magic numbers.
 *  Rate-limit handling: `fetchWithRetry` honors `Retry-After` on 429/503 (one retry, ≤30 s).
 *
 *  A cache hit NEVER alters the data a tool sees — provenance on a layer always reflects
 *  the original network response, not the cache.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { debugLog } from './debug'

type Entry = { value: unknown; expiry: number; bytes?: number }

function sizeOf(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (ArrayBuffer.isView(value)) return value.byteLength
  if (value instanceof ArrayBuffer) return value.byteLength
  return OTHER_ENTRY_BYTES
}

// Insertion order in `store` doubles as LRU order: a get re-inserts the key at the tail,
// so the head is always the least-recently-used entry to evict.
const store = new Map<string, Entry>()
const inflight = new Map<string, Promise<unknown>>()

let maxEntries = Number(process.env.AGENT_CACHE_MAX_ENTRIES) || 200
/** L1 byte budget. An entry count alone is not a memory bound: a base64 titiler grid is 5 MB, so 200 of them
 *  held 1 GB across requests. Strings and binary values are counted exactly; any other value is charged
 *  OTHER_ENTRY_BYTES (JSON bodies are small next to the pixel grids this guards against). */
let maxBytes = (Number(process.env.AGENT_CACHE_MAX_MB) || 64) * 1048576
const OTHER_ENTRY_BYTES = 4096
let storeBytes = 0
let diskDir = process.env.AGENT_CACHE_DIR || ''

let hits = 0
let misses = 0

// P7.2 — per-source breakdown for `/api/metrics`. Keyed by the `source` label
// (e.g. 'overpass', 'stac'); calls without a source bucket under '(unlabeled)'.
const hitsBySource = new Map<string, number>()
const missesBySource = new Map<string, number>()

function bump(map: Map<string, number>, source?: string): void {
  const key = source || '(unlabeled)'
  map.set(key, (map.get(key) ?? 0) + 1)
}

// --- Per-request telemetry context (correct under concurrency) --------------
// The cache is a process-global shared resource, so a module-level "current request"
// listener would cross-contaminate concurrent SSE streams. AsyncLocalStorage scopes the
// cache-hit callback to the request that opened it.
interface CacheContext {
  onCacheHit?: (key: string, source?: string) => void
  /** P7.3 — request-scoped client-abort signal. When the SSE client disconnects,
   *  `route.ts` aborts this so `fetchWithRetry` cancels every in-flight upstream
   *  request instead of letting the agent loop keep hitting free APIs for a reader
   *  that has gone away. */
  abortSignal?: AbortSignal
}
const als = new AsyncLocalStorage<CacheContext>()

/** Run `fn` so any cache hits during it invoke `ctx.onCacheHit` (used by route.ts to emit
 *  the info-only `cache_hit` SSE event under DEBUG_AGENT) and so `fetchWithRetry` picks up
 *  the request-scoped `abortSignal` (P7.3 client-abort propagation). */
export function runWithCacheContext<T>(ctx: CacheContext, fn: () => T): T {
  return als.run(ctx, fn)
}

/** Run `fn` with `signal` as the request-scoped abort signal, keeping the rest of the context.
 *  The executor narrows it to one operation's deadline so that operation's `fetchWithRetry` calls
 *  stop with it. */
export function withRequestAbortSignal<T>(signal: AbortSignal, fn: () => T): T {
  return als.run({ ...als.getStore(), abortSignal: signal }, fn)
}

/** The current request's client-abort signal, if `runWithCacheContext` set one (P7.3). */
export function getRequestAbortSignal(): AbortSignal | undefined {
  try {
    return als.getStore()?.abortSignal
  } catch {
    return undefined
  }
}

/** Default TTL per data source (ms). Override per-call with `{ ttlMs }` when a specific
 *  endpoint needs a different window (e.g. Valhalla route vs. isochrone). */
export const PROVIDER_TTL_MAP: Record<string, number> = {
  overpass: 5 * 60_000,
  stac: 10 * 60_000,
  'pc-stac': 60 * 60_000,
  'pc-sign': 45 * 60_000,
  titiler: 10 * 60_000,
  'open-meteo': 10 * 60_000,
  dem: 60 * 60_000,
  firms: 15 * 60_000,
  soilgrids: 24 * 60 * 60_000,
  valhalla: 30 * 60_000,
  worldpop: 24 * 60 * 60_000,
  worldcover: 60 * 60_000,
  gibs: 30 * 60_000,
  'cv-tile': 24 * 60 * 60_000,
  inference: 60 * 60_000,  // 1 h — foundation-model results are expensive; same AOI+prompt is deterministic
}

const DEFAULT_TTL = 10 * 60_000

export interface CacheOpts {
  /** Data source — supplies a default TTL from `PROVIDER_TTL_MAP`. */
  source?: string
  /** Explicit TTL (ms). Takes precedence over the source default. */
  ttlMs?: number
  /** Persist to the L2 disk cache (only when `AGENT_CACHE_DIR` is set). Use only for
   *  JSON-serializable, deterministic results — never for ArrayBuffer/binary payloads. */
  persist?: boolean
}

function resolveTtl(o: number | CacheOpts): number {
  if (typeof o === 'number') return o
  if (o.ttlMs != null) return o.ttlMs
  if (o.source && PROVIDER_TTL_MAP[o.source] != null) return PROVIDER_TTL_MAP[o.source]
  return DEFAULT_TTL
}

function fireHit(key: string, source?: string): void {
  hits++
  bump(hitsBySource, source)
  debugLog('cache hit:', source ?? '', key.slice(0, 100))
  try {
    als.getStore()?.onCacheHit?.(key, source)
  } catch {
    // telemetry must never break a fetch
  }
}

/** Insert with LRU semantics: re-key to the tail, then evict from the head past the cap. */
function lruSet(key: string, entry: Entry): void {
  const prev = store.get(key)
  if (prev) { storeBytes -= prev.bytes ?? 0; store.delete(key) }
  entry.bytes = sizeOf(entry.value)
  store.set(key, entry)
  storeBytes += entry.bytes
  // Evict from the head (least recently used) past either cap, but never the entry just stored.
  while (store.size > 1 && (store.size > maxEntries || storeBytes > maxBytes)) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    storeBytes -= store.get(oldest)?.bytes ?? 0
    store.delete(oldest)
  }
}

function diskPathFor(key: string): string {
  const h = createHash('sha256').update(key).digest('hex')
  // turbopackIgnore: diskDir is a runtime env path, not a project file — without this
  // Next traces the whole project into the standalone bundle.
  return path.join(/*turbopackIgnore: true*/ diskDir, `${h}.json`)
}

async function diskRead(key: string, now: number): Promise<{ value: unknown } | null> {
  if (!diskDir) return null
  try {
    const raw = await fs.readFile(diskPathFor(key), 'utf8')
    const parsed = JSON.parse(raw) as { expiry: number; value: unknown }
    if (parsed.expiry > now) return { value: parsed.value }
  } catch {
    // miss / unreadable / expired — fall through to network
  }
  return null
}

async function diskWrite(key: string, entry: Entry): Promise<void> {
  if (!diskDir) return
  try {
    await fs.mkdir(diskDir, { recursive: true })
    await fs.writeFile(
      diskPathFor(key),
      JSON.stringify({ expiry: entry.expiry, value: entry.value }),
      'utf8',
    )
  } catch (err) {
    debugLog('cache disk write failed:', (err as Error)?.message)
  }
}

/** Resolve fetcher() once per key inside the TTL. Concurrent callers with the same key
 *  share a single in-flight promise (request de-dup). Supports the legacy positional TTL
 *  form and the P5.1 options form. */
export function cachedFetchJson<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T>
export function cachedFetchJson<T>(key: string, opts: CacheOpts, fetcher: () => Promise<T>): Promise<T>
export function cachedFetchJson<T>(
  key: string,
  ttlOrOpts: number | CacheOpts,
  fetcher: () => Promise<T>,
): Promise<T> {
  const now = Date.now()
  const ttlMs = resolveTtl(ttlOrOpts)
  const source = typeof ttlOrOpts === 'object' ? ttlOrOpts.source : undefined
  const persist = typeof ttlOrOpts === 'object' ? !!ttlOrOpts.persist : false

  const hit = store.get(key)
  if (hit && hit.expiry > now) {
    // LRU touch — move to tail.
    store.delete(key)
    store.set(key, hit)
    fireHit(key, source)
    return Promise.resolve(hit.value as T)
  }

  const pending = inflight.get(key)
  if (pending) return pending as Promise<T>

  const promise = (async () => {
    try {
      if (persist) {
        const disk = await diskRead(key, Date.now())
        if (disk) {
          lruSet(key, { value: disk.value, expiry: Date.now() + ttlMs })
          fireHit(key, source)
          return disk.value as T
        }
      }
      misses++
      bump(missesBySource, source)
      const value = await fetcher()
      const entry: Entry = { value, expiry: Date.now() + ttlMs }
      lruSet(key, entry)
      if (persist) await diskWrite(key, entry)
      return value
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, promise)
  return promise
}

/** Parse an HTTP `Retry-After` header (delta-seconds OR an HTTP-date) to a wait in ms,
 *  clamped to [0, maxWaitMs]. Falls back to 1 s when the header is absent/unparseable. */
export function parseRetryAfter(header: string | null, maxWaitMs: number): number {
  const FALLBACK = 1000
  if (!header) return Math.min(FALLBACK, maxWaitMs)
  const secs = Number(header)
  if (Number.isFinite(secs)) return Math.min(Math.max(0, secs * 1000), maxWaitMs)
  const when = Date.parse(header)
  if (!Number.isNaN(when)) return Math.min(Math.max(0, when - Date.now()), maxWaitMs)
  return Math.min(FALLBACK, maxWaitMs)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** P7.3 — default upstream timeout when a caller doesn't pass its own signal. Keeps
 *  every `fetchWithRetry` path bounded even if a call site forgets a timeout. */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000

/** Compose a per-attempt abort signal from: a fresh timeout (so the Retry-After wait
 *  never eats into the retry's own budget), the caller's `init.signal` (if any), and the
 *  request-scoped client-abort signal (P7.3). Whichever fires first aborts the fetch. */
function buildFetchSignal(initSignal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const sigs: AbortSignal[] = []
  if (timeoutMs > 0) sigs.push(AbortSignal.timeout(timeoutMs))
  if (initSignal) sigs.push(initSignal)
  const ctxSignal = getRequestAbortSignal()
  if (ctxSignal) sigs.push(ctxSignal)
  if (sigs.length === 1) return sigs[0]
  return AbortSignal.any(sigs)
}

/** `fetch` with rate-limit-aware retry. On a 429/503 carrying a `Retry-After`, sleeps the
 *  indicated time (capped at `maxWaitMs`, default 30 s) and retries exactly once. The
 *  caller still inspects `res.ok`; a second 429/503 returns the failed Response so the
 *  caller surfaces a clean error rather than fabricating data.
 *
 *  Every attempt carries an abort signal (caller signal + request-scoped client-abort +
 *  a `timeoutMs` default, P7.3) so no upstream request can hang or outlive its reader. */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  opts: { retryOn429?: boolean; maxWaitMs?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const { retryOn429 = true, maxWaitMs = 30_000, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = opts
  let res = await fetch(url, { ...init, signal: buildFetchSignal(init?.signal, timeoutMs) })
  if (retryOn429 && (res.status === 429 || res.status === 503)) {
    const waitMs = parseRetryAfter(res.headers.get('retry-after'), maxWaitMs)
    debugLog(`rate-limited (${res.status}) on ${url.slice(0, 80)} — retrying in ${waitMs}ms`)
    await sleep(waitMs)
    res = await fetch(url, { ...init, signal: buildFetchSignal(init?.signal, timeoutMs) })
  }
  return res
}

/** Number of distinct keys currently being fetched (read by P7.2 metrics). */
export function getInflightCount(): number {
  return inflight.size
}

/** Cache telemetry snapshot (read by P7.2 metrics). */
export function getCacheStats(): {
  size: number
  hits: number
  misses: number
  inflight: number
  maxEntries: number
  diskEnabled: boolean
} {
  return { size: store.size, hits, misses, inflight: inflight.size, maxEntries, diskEnabled: !!diskDir }
}

/** Per-source cache hit/miss breakdown (read by P7.2 `/api/metrics`). */
export function getCacheStatsBySource(): { hits: Record<string, number>; misses: Record<string, number> } {
  return { hits: Object.fromEntries(hitsBySource), misses: Object.fromEntries(missesBySource) }
}

/** Test helper — flush the in-process cache + counters (does NOT clear the disk cache). */
export function _resetCache(): void {
  store.clear()
  storeBytes = 0
  inflight.clear()
  hits = 0
  misses = 0
  hitsBySource.clear()
  missesBySource.clear()
}

/** Test helper — override the LRU cap (default 200 / `AGENT_CACHE_MAX_ENTRIES`). */
export function _setMaxEntries(n: number): void {
  maxEntries = n
}

/** Test helper — override the L1 byte budget (default 64 MB / `AGENT_CACHE_MAX_MB`). */
export function _setMaxBytes(n: number): void {
  maxBytes = n
}

/** Bytes currently held by L1 (strings and binary exact, other values estimated). */
export function getCacheBytes(): number {
  return storeBytes
}

/** Test helper — point the L2 disk cache at a directory (default `AGENT_CACHE_DIR`). */
export function _setDiskDir(dir: string): void {
  diskDir = dir
}
