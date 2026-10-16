import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetCache, _setMaxBytes, cachedFetchJson, getCacheBytes } from '../cache'

describe('L1 cache byte budget', () => {
  beforeEach(() => { _resetCache(); _setMaxBytes(1000) })
  afterEach(() => { _resetCache(); _setMaxBytes(64 * 1048576) })

  it('evicts least-recently-used entries once the held bytes pass the budget', async () => {
    const fetches: string[] = []
    const get = (k: string) => cachedFetchJson(k, 60_000, async () => { fetches.push(k); return 'x'.repeat(400) })
    await get('a'); await get('b')
    expect(getCacheBytes()).toBe(800)
    await get('c') // 1200 > 1000: evicts a
    expect(getCacheBytes()).toBeLessThanOrEqual(1000)
    await get('b') // still cached
    await get('a') // evicted, fetched again
    expect(fetches).toEqual(['a', 'b', 'c', 'a'])
  })

  it('counts typed arrays by byte length and never evicts the entry just stored', async () => {
    await cachedFetchJson('big', 60_000, async () => new Float32Array(1000)) // 4000 B, over the budget alone
    expect(getCacheBytes()).toBe(4000)
    await cachedFetchJson('next', 60_000, async () => 'y')
    expect(getCacheBytes()).toBe(1) // the big one made way
  })
})
