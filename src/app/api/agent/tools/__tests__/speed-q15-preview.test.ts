/**
 * Q-15 — fetch_ndvi draws its layer as soon as the scene is chosen, then finishes the statistics.
 *
 * Real tool, real scene picker and index statistics, on the grids recorded for Q-60; only the
 * network edges are mocked (STAC search, titiler grid reads), with the statistics band read made
 * slower than the scene checks so "preview before the statistics are done" is a fact of the run.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import fixture from '../../lib/__tests__/__fixtures__/kasur-2026-09.json'
import type { PixelGrid } from '../../lib/pixels'

vi.mock('../../lib/pixels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pixels')>()
  return { ...actual, fetchFeatureGrid: vi.fn(), fetchCogFeatureGrid: vi.fn() }
})

import { _resetCache } from '../../lib/cache'
import { fetchFeatureGrid } from '../../lib/pixels'
import { withTimings } from '../../lib/timings'
import type { ToolCtx } from '../../lib/types'
import { ndviOrImagery } from '../satellite'

const scenes = fixture.scenes as any[]
const items = scenes.map((s) => ({
  id: s.id,
  collection: 'sentinel-2-l2a',
  assets: Object.fromEntries(['scl', 'blue', 'red', 'nir'].map((k) => [k, { href: `https://example.invalid/${s.id}/${k}.tif` }])),
  links: [{ rel: 'self', href: `https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/${s.id}` }],
  properties: { datetime: s.datetime, 'eo:cloud_cover': s.cloud, platform: 'sentinel-2c' },
}))

const AOI = fixture.aoi as any
const BBOX: [number, number, number, number] = [74.05, 31.12, 74.08, 31.15]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function toGrid(g: { w: number; h: number; bands: number; raw: number[] }): PixelGrid {
  const raw = Float64Array.from(g.raw)
  const px = g.w * g.h
  return { values: raw.subarray(0, px), mask: raw.subarray((g.bands - 1) * px, g.bands * px), width: g.w, height: g.h, bands: g.bands, raw }
}

let statsBandsDone = false
beforeEach(() => {
  _resetCache()
  statsBandsDone = false
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: items }), { status: 200 })))
  vi.mocked(fetchFeatureGrid).mockReset()
  vi.mocked(fetchFeatureGrid).mockImplementation(async (req) => {
    const s = scenes.find((x) => x.id === req.itemHref.split('/').pop())!
    if (req.assets[0] === 'scl') return toGrid(s.scl)
    if (String(req.cacheTag).startsWith('idx-bands')) {
      await sleep(120) // the statistics read: the slow one
      statsBandsDone = true
    }
    return toGrid(s.bands)
  })
})

function ctxWith(emit: (e: string, d: any) => void): ToolCtx {
  return { aoi: AOI, bbox: BBOX, centroid: { lat: 31.135, lng: 74.065 }, areaKm2: 9.5, emit, runTool: async () => ({ summary: '' }) }
}

describe('fetch_ndvi early layer', () => {
  it('emits exactly one preview, before the statistics finish, with the id the final layer reuses', async () => {
    const events: Array<{ event: string; doneAtEmit: boolean; data: any }> = []
    const out = await ndviOrImagery(ctxWith((event, data) => events.push({ event, doneAtEmit: statsBandsDone, data })), 'fetch_ndvi')

    const previews = events.filter((e) => e.event === 'layer_preview')
    expect(previews).toHaveLength(1)
    expect(previews[0].doneAtEmit).toBe(false) // drawn while the statistics read was still in flight
    const preview = previews[0].data.layer
    expect(preview.raster.stretch).toBe('fixed')
    expect(preview.confidence).toBe('low')
    expect(preview.name).toMatch(/statistics computing/)
    expect(preview.provenance.method).toMatch(/Preview/)

    // The final layer is authoritative: same id (one layer on the map), measured stretch, no preview wording.
    expect(out.layer?.id).toBe(preview.id)
    expect(out.layer?.raster?.stretch).toBe('p2-p98')
    expect(out.layer?.name).not.toMatch(/computing/)
    expect(out.summary_data?.mean).toBeTypeOf('number')
    // Same scene in both: the preview never shows a scene the result does not report.
    expect(out.layer?.raster?.sceneId).toBe(preview.raster.sceneId)
  })

  it('emits no preview when every scene is clouded (nothing to draw), and no layer is produced', async () => {
    vi.mocked(fetchFeatureGrid).mockImplementation(async (req) => {
      const s = scenes.find((x) => x.id === req.itemHref.split('/').pop())!
      const g = toGrid(s.scl)
      g.values.fill(9) // cloud high probability
      g.raw.fill(9, 0, g.width * g.height)
      return req.assets[0] === 'scl' ? g : toGrid(s.bands)
    })
    const events: string[] = []
    const out = await ndviOrImagery(ctxWith((e) => events.push(e)), 'fetch_ndvi')
    expect(events).not.toContain('layer_preview')
    expect(out.layer).toBeUndefined()
    expect(out.summary).toMatch(/No usable Sentinel-2 scene/)
  })

  it('reports per-stage timings, with first_layer ahead of the whole call', async () => {
    const { value, timings } = await withTimings(async () => {
      const t0 = Date.now()
      await ndviOrImagery(ctxWith(() => {}), 'fetch_ndvi')
      return Date.now() - t0
    })
    for (const stage of ['stac_search', 'scene_scoring', 'stats', 'first_layer'] as const) expect(timings[stage], stage).toBeTypeOf('number')
    expect(timings.first_layer!).toBeLessThan(value)
    expect(timings.stats!).toBeGreaterThanOrEqual(100) // the 120 ms band read
  })

  it('works without an emitter (quick layers, tests)', async () => {
    const out = await ndviOrImagery({ ...ctxWith(() => {}), emit: undefined }, 'fetch_ndvi')
    expect(out.layer?.id).toBe('ndvi-active')
  })
})
