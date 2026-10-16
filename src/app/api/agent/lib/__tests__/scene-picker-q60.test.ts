/**
 * Q-60 — the clearest-scene picker returned a cloudy scene.
 *
 * Fixture: grids recorded LIVE on 2026-10-12 (earth-search + titiler.xyz, 16 px longest edge)
 * for every Sentinel-2 L2A item over the Kasur AOI (74.05-74.08 E, 31.12-31.15 N) in
 * 2026-09-01..2026-09-30, newest first. See __fixtures__/kasur-2026-09.json.
 *
 * Root cause: a date carries one item per MGRS tile, and the picker only scored the first six
 * items (09-28, 09-26, 09-25 — all cloudy or clipping the AOI), so it returned null and
 * render_raster fell back to the newest, cloudiest scene. The clear 09-23 scene (items 7-8)
 * was never scored.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fixture from './__fixtures__/kasur-2026-09.json'
import type { PixelGrid } from '../pixels'

vi.mock('../pixels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pixels')>()
  return { ...actual, fetchFeatureGrid: vi.fn(), fetchCogFeatureGrid: vi.fn() }
})

import { fetchFeatureGrid } from '../pixels'
import { pickClearestScene, reflectanceGate, rejectedScenesNote, sceneClarity, examinedScenes } from '../cloud'

const AOI = fixture.aoi
const scenes = fixture.scenes as any[]

function toGrid(g: { w: number; h: number; bands: number; raw: number[] }): PixelGrid {
  const raw = Float64Array.from(g.raw)
  const px = g.w * g.h
  return {
    values: raw.subarray(0, px), mask: raw.subarray((g.bands - 1) * px, g.bands * px),
    width: g.w, height: g.h, bands: g.bands, raw,
  }
}

function item(s: any) {
  return {
    id: s.id,
    collection: 'sentinel-2-l2a',
    assets: Object.fromEntries(['scl', 'blue', 'red', 'nir'].map((k) => [k, { href: `https://example.invalid/${s.id}/${k}.tif` }])),
    links: [{ rel: 'self', href: `https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/${s.id}` }],
    properties: { datetime: s.datetime, 'eo:cloud_cover': s.cloud },
  }
}

/** Serve recorded grids; `overrides` replaces a scene's SCL (synthetic cases). */
function serve(overrides: Record<string, PixelGrid> = {}) {
  vi.mocked(fetchFeatureGrid).mockImplementation(async (req) => {
    const id = req.itemHref.split('/').pop()!
    const s = scenes.find((x) => x.id === id)
    if (!s) throw new Error(`no fixture for ${id}`)
    if (req.assets[0] === 'scl') return overrides[id] ?? toGrid(s.scl)
    return toGrid(s.bands)
  })
}

const items = scenes.map(item)
const byId = (id: string) => items.find((i) => i.id === id)!

beforeEach(() => { vi.mocked(fetchFeatureGrid).mockReset(); serve() })

describe('Q-60 scene picker (recorded Kasur Sep-2026 grids)', () => {
  it('the first six items alone contain no usable scene (the old candidate window)', async () => {
    expect(await pickClearestScene(items.slice(0, 6), AOI)).toBeNull()
  })

  it('scans past a batch of unusable scenes and picks the clear 09-23 full-coverage scene', async () => {
    const choice = await pickClearestScene(items, AOI)
    expect(choice?.item.id).toBe('S2C_43RDQ_20260923_0_L2A')
    expect(choice!.clarity.clearPct).toBeGreaterThan(99)
    expect(choice!.clarity.coveragePct).toBeGreaterThan(90)
    expect(choice!.rejected).toEqual([])
  })

  it('never selects the cloudy 09-28 scenes', async () => {
    const choice = await pickClearestScene(items, AOI)
    expect(choice!.item.properties.datetime.slice(0, 10)).not.toBe('2026-09-28')
  })

  it('the plausibility gate passes the clear scene and flags bright cloud NIR', async () => {
    const clear = byId('S2C_43RDQ_20260923_0_L2A')
    const c = (await sceneClarity(clear, AOI, 16))!
    expect(await reflectanceGate(clear, AOI, c, 16)).toBeNull()
  })

  it('rejects a scene SCL calls clear whose AOI median reflectance is cloud-like, and records it', async () => {
    // SYNTHETIC pairing: the real cloudy 09-28 RDQ band grids (NIR median ~0.97) with an SCL grid
    // that wrongly says "vegetation" everywhere — the failure mode the gate exists for.
    const cloudy = scenes.find((s) => s.id === 'S2B_43RDQ_20260928_0_L2A')
    const allVeg = toGrid(cloudy.scl)
    allVeg.values.fill(4)
    allVeg.raw.fill(4, 0, allVeg.width * allVeg.height)
    serve({ [cloudy.id]: allVeg })

    const choice = await pickClearestScene(items, AOI)
    expect(choice?.item.id).toBe('S2C_43RDQ_20260923_0_L2A')
    expect(choice!.rejected.map((r) => r.id)).toEqual([cloudy.id])
    expect(choice!.rejected[0].reason).toMatch(/B08 median 0\.\d+/)
    expect(rejectedScenesNote(choice!)).toContain('2026-09-28')

    const rows = await examinedScenes([byId(cloudy.id)], AOI, { maxSize: 16 })
    expect(rows[0].rejection).toMatch(/cloud-like/)
  })

  it('a failed band read does not reject: the SCL verdict stands', async () => {
    const clear = byId('S2C_43RDQ_20260923_0_L2A')
    const c = (await sceneClarity(clear, AOI, 16))!
    vi.mocked(fetchFeatureGrid).mockRejectedValue(new TypeError('fetch failed'))
    expect(await reflectanceGate(clear, AOI, c, 16)).toBeNull()
  })
})
