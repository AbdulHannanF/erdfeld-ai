/**
 * LIVE Phase 3 gate (opt-in: DISCOVERY_LIVE=1).
 *
 *   DISCOVERY_LIVE=1 npx vitest run discovery-live
 *
 * Gate: **"agent locates and uses an unwired dataset."** Both halves are checked,
 * against real catalogs and real rasters, through the real tool dispatcher.
 *
 * The negative cases matter as much as the positive one. A discovery tool that
 * returns something for every query would look like it works while being useless
 * — the same shape as ISS-107 — so this asserts that a nonsense query returns
 * nothing, and that a dataset with no data over the AOI says so instead of
 * producing a number.
 */

import { describe, expect, beforeAll, it } from 'vitest'
import { executeTool } from '../../../tools'
import { gatherCandidates } from '../catalogs'
import { rankCollections } from '../find-dataset'

const LIVE = !!process.env.DISCOVERY_LIVE
const suite = LIVE ? describe : describe.skip

/** The audit AOI: central Lahore, 16.9 km². */
const LAHORE = {
  type: 'Polygon',
  coordinates: [[[74.30, 31.51], [74.34, 31.51], [74.34, 31.53], [74.30, 31.53], [74.30, 31.51]]],
}
const LAHORE_BBOX: [number, number, number, number] = [74.30, 31.51, 74.34, 31.53]

suite('LIVE — STAC federation is real', () => {
  let gathered: Awaited<ReturnType<typeof gatherCandidates>>

  beforeAll(async () => {
    gathered = await gatherCandidates({ breadth: false })
  }, 300_000)

  it('reaches the known catalogs and sees a serious number of collections', () => {
    console.log(`   → ${gathered.catalogsSearched} catalogs, ${gathered.collectionsSeen} collections, ${gathered.catalogsUnreachable} unreachable`)
    expect(gathered.catalogsSearched).toBeGreaterThanOrEqual(3)
    // Planetary Computer alone had 135 on 2026-08-10.
    expect(gathered.collectionsSeen).toBeGreaterThan(100)
  })

  it('finds far more unwired data than GeoAgent has tools for', () => {
    const covering = gathered.candidates.filter((c) => {
      const b = c.collection.extent?.spatial?.bbox?.[0]
      return b && Number(b[0]) <= 74.32 && Number(b[2]) >= 74.32 && Number(b[1]) <= 31.52 && Number(b[3]) >= 31.52
    })
    console.log(`   → ${covering.length} collections declare coverage of Lahore`)
    // Measured 2026-08-10: 72 on Planetary Computer alone.
    expect(covering.length).toBeGreaterThan(50)
  })

  it('ranks a real query and returns nothing for a nonsense one', () => {
    const hits = rankCollections(gathered.candidates, 'land cover', LAHORE_BBOX)
    console.log(`   → "land cover": ${hits.map((h) => h.collection.id).slice(0, 5).join(', ')}`)
    expect(hits.length).toBeGreaterThan(0)

    const nothing = rankCollections(gathered.candidates, 'quokka enclosure census', LAHORE_BBOX)
    expect(nothing).toEqual([])
  })
})

suite('LIVE GATE — locate and USE an unwired dataset', () => {
  it('find_dataset locates land-cover datasets over the AOI', async () => {
    const res = await executeTool('find_dataset', LAHORE, { query: 'land cover', breadth: false })
    console.log(`\n--- find_dataset ---\n${res.summary.slice(0, 1400)}\n`)

    expect(Number(res.stats?.matches)).toBeGreaterThan(0)
    // The point of discovery: at least one hit must be data we have no tool for.
    expect(Number(res.stats?.unwired_matches)).toBeGreaterThan(0)
    expect(res.summary).toMatch(/use_dataset/)
  }, 300_000)

  it('find_dataset returns NOTHING for a query nothing matches', async () => {
    const res = await executeTool('find_dataset', LAHORE, { query: 'quokka enclosure census', breadth: false })
    expect(Number(res.stats?.matches)).toBe(0)
    expect(res.summary).toMatch(/no dataset matched/i)
  }, 300_000)

  it('use_dataset reads a CATEGORICAL unwired dataset and names its classes', async () => {
    const res = await executeTool('use_dataset', LAHORE, {
      catalog: 'planetary-computer',
      collection: 'io-lulc-annual-v02',
    })
    console.log(`\n--- use_dataset io-lulc-annual-v02 ---\n${res.summary}\n`)

    expect(res.stats?.read).toBe('ok')
    // Central Lahore is built-up; measured 2026-08-10 as 99.3% class 7.
    expect(String(res.stats?.dominant_class)).toMatch(/built/i)
    expect(Number(res.stats?.dominant_pct)).toBeGreaterThan(80)
    // Class names must come from the collection metadata, not a hardcoded table.
    expect(res.summary).not.toMatch(/class \d+/)
    expect(res.layers.length).toBeGreaterThan(0)
  }, 300_000)

  it('use_dataset reads a CONTINUOUS unwired dataset and returns a real mean', async () => {
    const res = await executeTool('use_dataset', LAHORE, {
      catalog: 'planetary-computer',
      collection: 'cop-dem-glo-30',
    })
    console.log(`\n--- use_dataset cop-dem-glo-30 ---\n${res.summary}\n`)

    expect(res.stats?.read).toBe('ok')
    const mean = Number(res.stats?.mean)
    // Lahore sits at ~210–220 m. Measured 2026-08-10: 216.79 m.
    expect(mean).toBeGreaterThan(190)
    expect(mean).toBeLessThan(250)
    // Polygon-clipped, so the pixel count must match the AOI, not a whole COG.
    expect(Number(res.stats?.pixel_count)).toBeGreaterThan(1000)
    expect(Number(res.stats?.pixel_count)).toBeLessThan(100_000)
  }, 300_000)

  it('the discovered land cover independently corroborates the wired WorldCover tool', async () => {
    // Different sensor, different vendor, different catalog path — a real second
    // opinion, which is what discovery is for. Phase 0 measured WorldCover at
    // 84.6% built over this AOI.
    const [discovered, wired] = await Promise.all([
      executeTool('use_dataset', LAHORE, { catalog: 'planetary-computer', collection: 'io-lulc-annual-v02' }),
      executeTool('fetch_built_surface', LAHORE, {}),
    ])
    const ioPct = Number(discovered.stats?.dominant_pct)
    console.log(`   → Impact Observatory: ${ioPct}% ${discovered.stats?.dominant_class}`)
    console.log(`   → WorldCover tool: ${wired.stats?.built_up_pct ?? '(n/a)'}% built`)
    expect(ioPct).toBeGreaterThan(70)
    expect(String(wired.summary).toLowerCase()).toMatch(/built/)
  }, 600_000)

  it('a dataset with no data here says so, instead of returning a number', async () => {
    // 3dep-seamless is US-only but declares the bbox [-174,-15,164,72], so it
    // passes the extent filter. Only an item search settles it — and it must be
    // reported as absent coverage, never as a statistic.
    const res = await executeTool('use_dataset', LAHORE, {
      catalog: 'planetary-computer',
      collection: '3dep-seamless',
    })
    console.log(`\n--- use_dataset 3dep-seamless (expected: no coverage) ---\n${res.summary}\n`)

    expect(res.stats?.read).toBe('failed')
    expect(res.summary).toMatch(/no items|declared extent is not coverage/i)
    expect(res.layers).toHaveLength(0)
    expect(res.stats?.mean).toBeUndefined()
  }, 300_000)

  it('an unknown collection is refused rather than silently substituted', async () => {
    const res = await executeTool('use_dataset', LAHORE, {
      catalog: 'planetary-computer',
      collection: 'no-such-collection-xyz',
    })
    expect(res.summary).toMatch(/does not list a collection/i)
    expect(res.layers).toHaveLength(0)
  }, 300_000)
})

suite('LIVE — search_web names its actual source', () => {
  it('answers from Wikipedia and says so rather than implying a web search', async () => {
    const res = await executeTool('search_web', LAHORE, { query: 'Ravi River Lahore' })
    console.log(`\n--- search_web ---\n${res.summary.slice(0, 600)}\n`)
    expect(res.stats?.source).toBe('wikipedia')
    expect(Number(res.stats?.results)).toBeGreaterThan(0)
    expect(res.summary).toMatch(/wikipedia/i)
    expect(res.summary).toMatch(/not a general web search|not current web results/i)
  }, 120_000)
})
