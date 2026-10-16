/**
 * Q-15 — the reads that follow a chosen scene run together, and never change which scene wins.
 *
 * Fixture: the grids recorded live for Q-60 (Kasur, Sep 2026). `fetchFeatureGrid` is mocked with a
 * per-kind delay and an in-flight counter, so overlap is proven by concurrency, not by a stopwatch.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import fixture from './__fixtures__/kasur-2026-09.json'
import type { PixelGrid } from '../pixels'

vi.mock('../pixels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pixels')>()
  return { ...actual, fetchFeatureGrid: vi.fn(), fetchCogFeatureGrid: vi.fn() }
})

import { pickClearestScene } from '../cloud'
import { maskedIndexStats } from '../index-stats'
import { fetchFeatureGrid } from '../pixels'

const AOI = fixture.aoi
const scenes = fixture.scenes as any[]
const CLEAR = 'S2C_43RDQ_20260923_0_L2A'

function toGrid(g: { w: number; h: number; bands: number; raw: number[] }): PixelGrid {
  const raw = Float64Array.from(g.raw)
  const px = g.w * g.h
  return { values: raw.subarray(0, px), mask: raw.subarray((g.bands - 1) * px, g.bands * px), width: g.w, height: g.h, bands: g.bands, raw }
}

const item = (s: any) => ({
  id: s.id,
  collection: 'sentinel-2-l2a',
  assets: Object.fromEntries(['scl', 'blue', 'red', 'nir'].map((k) => [k, { href: `https://example.invalid/${s.id}/${k}.tif` }])),
  links: [{ rel: 'self', href: `https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/${s.id}` }],
  properties: { datetime: s.datetime, 'eo:cloud_cover': s.cloud },
})
const items = scenes.map(item)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Serve recorded grids after `delayMs`, tracking how many reads are in flight at once. */
function serve(delayMs: number, overrides: { fail?: (kind: string) => boolean } = {}) {
  const log = { inFlight: 0, maxInFlight: 0, started: [] as string[] }
  vi.mocked(fetchFeatureGrid).mockImplementation(async (req) => {
    const kind = req.assets[0] === 'scl' ? 'scl' : String(req.cacheTag ?? 'bands')
    log.started.push(kind)
    log.inFlight++
    log.maxInFlight = Math.max(log.maxInFlight, log.inFlight)
    try {
      await sleep(delayMs)
      if (overrides.fail?.(kind)) throw new TypeError('fetch failed')
      const s = scenes.find((x) => x.id === req.itemHref.split('/').pop())!
      return req.assets[0] === 'scl' ? toGrid(s.scl) : toGrid(s.bands)
    } finally {
      log.inFlight--
    }
  })
  return log
}

beforeEach(() => { vi.mocked(fetchFeatureGrid).mockReset() })

describe('maskedIndexStats: SCL and band reads overlap', () => {
  const scene = items.find((i) => i.id === CLEAR)!

  it('issues both reads at once when no clarity is supplied', async () => {
    const log = serve(40)
    const out = await maskedIndexStats(scene, 'NDVI', AOI, { maxSize: 16 })
    expect(out.ok).toBe(true)
    expect(log.maxInFlight).toBe(2)
  })

  it('gives the same statistics as the sequential form (clarity supplied up front)', async () => {
    serve(0)
    const together = await maskedIndexStats(scene, 'NDVI', AOI, { maxSize: 16 })
    const { sceneClarity } = await import('../cloud')
    const clarity = (await sceneClarity(scene, AOI, 16))!
    const sequential = await maskedIndexStats(scene, 'NDVI', AOI, { maxSize: 16, clarity })
    expect(together.ok && sequential.ok).toBe(true)
    if (together.ok && sequential.ok) {
      expect(together.stats.mean).toBe(sequential.stats.mean)
      expect(together.stats.count).toBe(sequential.stats.count)
      expect(together.stats.p2).toBe(sequential.stats.p2)
    }
  })

  it('a failed SCL read is still "cannot exclude cloud", and the abandoned band read raises nothing', async () => {
    serve(10, { fail: (k) => k === 'scl' })
    const out = await maskedIndexStats(scene, 'NDVI', AOI, { maxSize: 16 })
    expect(!out.ok && out.failure.reason).toBe('fetch_failed')
    await sleep(30) // let the abandoned read settle; an unhandled rejection would fail the run
  })

  it('a failed band read is reported as a fetch failure, not as no data', async () => {
    serve(10, { fail: (k) => k.startsWith('idx-bands') })
    const out = await maskedIndexStats(scene, 'NDVI', AOI, { maxSize: 16 })
    expect(!out.ok && out.failure.reason).toBe('fetch_failed')
    expect(!out.ok && out.failure.message).toMatch(/could not return/)
  })
})

describe('pickClearestScene speculation (Q-60 semantics preserved)', () => {
  it('starts the speculative read before the gate finishes and returns the winner\'s promise', async () => {
    const log = serve(30)
    const speculate = vi.fn(async (it: any) => `stats:${it.id}`)
    const choice = await pickClearestScene(items, AOI, { speculate })
    expect(choice?.item.id).toBe(CLEAR)
    expect(speculate).toHaveBeenCalledTimes(1)
    expect(await choice!.speculative).toBe(`stats:${CLEAR}`)
    expect(log.started).toContain('plaus')
  })

  it('picks the same scene with and without speculation, on the Q-60 fixture', async () => {
    serve(0)
    const plain = await pickClearestScene(items, AOI)
    const speculating = await pickClearestScene(items, AOI, { speculate: async () => 1 })
    expect(speculating?.item.id).toBe(plain?.item.id)
    expect(speculating?.rejected).toEqual(plain?.rejected)
  })

  it('abandons the speculation of a gate-rejected candidate without an unhandled rejection', async () => {
    // Synthetic: the cloudy 09-28 scene's SCL says "vegetation" everywhere, the gate must reject it.
    const cloudy = scenes.find((s) => s.id === 'S2B_43RDQ_20260928_0_L2A')
    const allVeg = toGrid(cloudy.scl)
    allVeg.values.fill(4)
    allVeg.raw.fill(4, 0, allVeg.width * allVeg.height)
    vi.mocked(fetchFeatureGrid).mockImplementation(async (req) => {
      const id = req.itemHref.split('/').pop()!
      const s = scenes.find((x) => x.id === id)!
      if (req.assets[0] === 'scl') return id === cloudy.id ? allVeg : toGrid(s.scl)
      return toGrid(s.bands)
    })
    const speculate = vi.fn(async (it: any) => { if (it.id === cloudy.id) throw new Error('boom'); return it.id })
    const choice = await pickClearestScene(items, AOI, { speculate })
    expect(choice?.item.id).toBe(CLEAR)
    expect(choice!.rejected.map((r) => r.id)).toEqual([cloudy.id])
    expect(speculate.mock.calls.map((c) => c[0].id)).toEqual([cloudy.id, CLEAR])
    expect(await choice!.speculative).toBe(CLEAR)
    await sleep(10)
  })
})
