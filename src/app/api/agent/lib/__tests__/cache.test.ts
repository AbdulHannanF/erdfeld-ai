import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetCache,
  _setDiskDir,
  _setMaxEntries,
  cachedFetchJson,
  fetchWithRetry,
  getCacheStats,
  getInflightCount,
  parseRetryAfter,
  PROVIDER_TTL_MAP,
  runWithCacheContext,
} from '../cache'

afterEach(() => {
  _resetCache()
  _setDiskDir('')
  _setMaxEntries(200)
  vi.restoreAllMocks()
})

describe('cachedFetchJson — core (legacy positional form)', () => {
  it('returns the fetcher result on the first call', async () => {
    const fetcher = vi.fn().mockResolvedValue({ x: 1 })
    const v = await cachedFetchJson('a', 1000, fetcher)
    expect(v).toEqual({ x: 1 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not call the fetcher again within TTL', async () => {
    const fetcher = vi.fn().mockResolvedValue({ x: 2 })
    await cachedFetchJson('b', 60_000, fetcher)
    const v2 = await cachedFetchJson('b', 60_000, fetcher)
    expect(v2).toEqual({ x: 2 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('de-dups concurrent in-flight calls', async () => {
    let calls = 0
    const fetcher = () => new Promise<{ n: number }>((resolve) => {
      calls++
      setTimeout(() => resolve({ n: calls }), 20)
    })
    const [a, b, c] = await Promise.all([
      cachedFetchJson('c', 1000, fetcher),
      cachedFetchJson('c', 1000, fetcher),
      cachedFetchJson('c', 1000, fetcher),
    ])
    expect(a).toEqual({ n: 1 })
    expect(b).toEqual({ n: 1 })
    expect(c).toEqual({ n: 1 })
    expect(calls).toBe(1)
  })

  it('does not cache rejections — next call retries', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ ok: true })
    await expect(cachedFetchJson('d', 60_000, fetcher)).rejects.toThrow('boom')
    const v = await cachedFetchJson('d', 60_000, fetcher)
    expect(v).toEqual({ ok: true })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('keys are independent — different keys cache separately', async () => {
    const fetcherA = vi.fn().mockResolvedValue({ k: 'a' })
    const fetcherB = vi.fn().mockResolvedValue({ k: 'b' })
    await cachedFetchJson('keyA', 60_000, fetcherA)
    await cachedFetchJson('keyB', 60_000, fetcherB)
    expect(fetcherA).toHaveBeenCalledTimes(1)
    expect(fetcherB).toHaveBeenCalledTimes(1)
  })

  it('re-fetches once the TTL has elapsed', async () => {
    vi.useFakeTimers()
    try {
      const fetcher = vi.fn().mockResolvedValue({ v: 1 })
      await cachedFetchJson('ttl', 1000, fetcher)
      vi.advanceTimersByTime(1500)
      await cachedFetchJson('ttl', 1000, fetcher)
      expect(fetcher).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('cachedFetchJson — options form + per-source TTL', () => {
  it('resolves the TTL from PROVIDER_TTL_MAP via { source }', async () => {
    // overpass default is 5 minutes; a repeated call within that window is a single hit.
    const fetcher = vi.fn().mockResolvedValue({ elements: [] })
    await cachedFetchJson('overpass:q', { source: 'overpass' }, fetcher)
    await cachedFetchJson('overpass:q', { source: 'overpass' }, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(PROVIDER_TTL_MAP.overpass).toBe(5 * 60_000)
  })

  it('explicit ttlMs overrides the source default', async () => {
    vi.useFakeTimers()
    try {
      const fetcher = vi.fn().mockResolvedValue({ v: 1 })
      await cachedFetchJson('s', { source: 'overpass', ttlMs: 500 }, fetcher)
      vi.advanceTimersByTime(800)
      await cachedFetchJson('s', { source: 'overpass', ttlMs: 500 }, fetcher)
      expect(fetcher).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('cachedFetchJson — LRU eviction', () => {
  it('evicts the least-recently-used entry past maxEntries', async () => {
    _setMaxEntries(2)
    const f = (val: string) => vi.fn().mockResolvedValue({ val })
    const fa = f('a'), fb = f('b'), fc = f('c')

    await cachedFetchJson('A', 60_000, fa)   // [A]
    await cachedFetchJson('B', 60_000, fb)   // [A,B]
    await cachedFetchJson('A', 60_000, fa)   // touch A → [B,A]
    await cachedFetchJson('C', 60_000, fc)   // insert C, evict B → [A,C]

    expect(getCacheStats().size).toBe(2)

    // A is still cached (touched), so no second fetch.
    await cachedFetchJson('A', 60_000, fa)
    expect(fa).toHaveBeenCalledTimes(1)

    // B was evicted → its fetcher runs again.
    await cachedFetchJson('B', 60_000, fb)
    expect(fb).toHaveBeenCalledTimes(2)
  })
})

describe('cachedFetchJson — L2 disk cache', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'geoagent-cache-'))
    _setDiskDir(dir)
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('serves a persisted entry after the in-process cache is cleared (simulates a restart)', async () => {
    const fetcher = vi.fn().mockResolvedValue({ soc: 12 })
    await cachedFetchJson('disk-key', { source: 'soilgrids', persist: true }, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)

    // Simulate a fresh process: wipe L1 (disk untouched), then re-request.
    _resetCache()
    const again = await cachedFetchJson('disk-key', { source: 'soilgrids', persist: true }, fetcher)
    expect(again).toEqual({ soc: 12 })
    expect(fetcher).toHaveBeenCalledTimes(1) // served from disk, not re-fetched
  })

  it('does not write to disk when persist is not set', async () => {
    const fetcher = vi.fn().mockResolvedValue({ v: 1 })
    await cachedFetchJson('no-persist', { source: 'stac' }, fetcher)
    const files = await fs.readdir(dir)
    expect(files.length).toBe(0)
  })
})

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfter('5', 30_000)).toBe(5000)
  })
  it('clamps to maxWaitMs', () => {
    expect(parseRetryAfter('120', 30_000)).toBe(30_000)
  })
  it('falls back to 1s when absent', () => {
    expect(parseRetryAfter(null, 30_000)).toBe(1000)
  })
  it('parses an HTTP-date in the future', () => {
    const future = new Date(Date.now() + 4000).toUTCString()
    const ms = parseRetryAfter(future, 30_000)
    expect(ms).toBeGreaterThan(2000)
    expect(ms).toBeLessThanOrEqual(5000)
  })
  it('treats a past HTTP-date as zero wait', () => {
    const past = new Date(Date.now() - 10_000).toUTCString()
    expect(parseRetryAfter(past, 30_000)).toBe(0)
  })
})

describe('fetchWithRetry', () => {
  const resp = (status: number, headers: Record<string, string> = {}) =>
    new Response(status === 200 ? '{"ok":true}' : 'rate limited', {
      status,
      headers,
    })

  it('returns immediately on a 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp(200))
    vi.stubGlobal('fetch', fetchMock)
    const r = await fetchWithRetry('https://x.test')
    expect(r.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries once on a 429 then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(resp(429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(resp(200))
    vi.stubGlobal('fetch', fetchMock)
    const r = await fetchWithRetry('https://x.test', undefined, { maxWaitMs: 50 })
    expect(r.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('surfaces a second 429 as a failed Response (no third try)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp(429, { 'retry-after': '0' }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await fetchWithRetry('https://x.test', undefined, { maxWaitMs: 50 })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(429)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries on a 503 too', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(resp(503, { 'retry-after': '0' }))
      .mockResolvedValueOnce(resp(200))
    vi.stubGlobal('fetch', fetchMock)
    const r = await fetchWithRetry('https://x.test', undefined, { maxWaitMs: 50 })
    expect(r.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry when retryOn429 is false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp(429, { 'retry-after': '0' }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await fetchWithRetry('https://x.test', undefined, { retryOn429: false })
    expect(r.status).toBe(429)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // P7.3 — every attempt carries an abort signal (timeout + caller + request-scoped).
  it('always passes an AbortSignal to fetch, even with no caller signal', async () => {
    let captured: AbortSignal | undefined
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      captured = init?.signal ?? undefined
      return Promise.resolve(resp(200))
    })
    vi.stubGlobal('fetch', fetchMock)
    await fetchWithRetry('https://x.test')
    expect(captured).toBeInstanceOf(AbortSignal)
    expect(captured?.aborted).toBe(false)
  })

  it('aborts the in-flight fetch when the request-scoped client-abort signal fires', async () => {
    const client = new AbortController()
    let captured: AbortSignal | undefined
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          captured = init?.signal ?? undefined
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          )
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    // timeoutMs: 0 isolates the request-scoped abort as the only trigger.
    const p = runWithCacheContext({ abortSignal: client.signal }, () =>
      fetchWithRetry('https://slow.test', undefined, { timeoutMs: 0 }),
    )
    client.abort()
    await expect(p).rejects.toThrow()
    expect(captured?.aborted).toBe(true)
  })
})

describe('telemetry', () => {
  it('counts hits and misses; getInflightCount reflects pending work', async () => {
    const fetcher = () => new Promise<{ v: number }>((r) => setTimeout(() => r({ v: 1 }), 20))
    const p = cachedFetchJson('t', 60_000, fetcher)
    expect(getInflightCount()).toBe(1)
    await p
    expect(getInflightCount()).toBe(0)

    await cachedFetchJson('t', 60_000, fetcher) // hit
    const stats = getCacheStats()
    expect(stats.misses).toBe(1)
    expect(stats.hits).toBe(1)
  })

  it('invokes the request-scoped onCacheHit callback on a hit', async () => {
    const fetcher = vi.fn().mockResolvedValue({ v: 1 })
    const onCacheHit = vi.fn()
    await runWithCacheContext({ onCacheHit }, async () => {
      await cachedFetchJson('ctx', { source: 'dem' }, fetcher) // miss
      await cachedFetchJson('ctx', { source: 'dem' }, fetcher) // hit
    })
    expect(onCacheHit).toHaveBeenCalledTimes(1)
    expect(onCacheHit).toHaveBeenCalledWith('ctx', 'dem')
  })
})
