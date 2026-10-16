/**
 * The scene catalogue: STAC pages read by year, folded to one scene a day, each with the tile URL that
 * draws it; one scene looked up by id. The STAC catalogues are replaced by a fake `fetch`, so nothing
 * here touches the network; the search, folding, URL building and refusals are the real code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _resetCache } from '../cache'
import { SCENE_ID_PATTERN, resolveSceneById, sceneTileUrl, searchSceneCatalogue } from '../scenes'
import { thin } from '../../tools/series'

const BBOX: [number, number, number, number] = [74.05, 31.12, 74.08, 31.15]

function s2(id: string, datetime: string, cloud: number, bbox = [73.9, 30.9, 75.0, 31.9]) {
  return {
    id, collection: 'sentinel-2-l2a', bbox,
    properties: { datetime, 'eo:cloud_cover': cloud, platform: 'sentinel-2a', 's2:processing_baseline': '05.11' },
    assets: Object.fromEntries(['red', 'green', 'blue', 'nir', 'scl', 'thumbnail'].map((k) => [k, { href: `https://sentinel-cogs.s3.us-west-2.amazonaws.com/${id}/${k}.tif` }])),
    links: [{ rel: 'self', href: `https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/${id}` }],
  }
}
function landsat(id: string, datetime: string, cloud: number) {
  return {
    id, collection: 'landsat-c2-l2', bbox: [73.0, 30.0, 76.0, 32.5],
    properties: { datetime, 'eo:cloud_cover': cloud, platform: 'landsat-8' },
    assets: Object.fromEntries(['red', 'green', 'blue', 'nir08', 'rendered_preview'].map((k) => [k, { href: `https://landsateuwest.blob.core.windows.net/${id}/${k}.tif` }])),
    links: [],
  }
}

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown } | null
function fakeFetch(handler: Handler) {
  const calls: { url: string; body: any }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, body })
    const out = handler(url, init)
    if (!out) throw new Error(`unexpected fetch ${url}`)
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}

beforeEach(() => _resetCache())
afterEach(() => vi.unstubAllGlobals())

describe('searchSceneCatalogue', () => {
  const NOW = Date.parse('2026-10-16T00:00:00Z')

  it('reads one search per calendar year and returns the scenes oldest first, one per day', async () => {
    const calls = fakeFetch((_url, init) => {
      const dt = JSON.parse(String(init!.body)).datetime as string
      const year = dt.slice(0, 4)
      if (year === '2017') return { body: { features: [s2('A_2017_a', '2017-03-01T05:40:00Z', 10), s2('A_2017_b', '2017-03-01T05:40:01Z', 3, [74.0, 31.0, 74.1, 31.2])], links: [] } }
      if (year === '2018') return { body: { features: [s2('A_2018', '2018-06-10T05:40:00Z', 50)], links: [] } }
      return { body: { features: [], links: [] } }
    })
    const r = await searchSceneCatalogue({ sensor: 'sentinel-2', bbox: BBOX, from: '2017-01-01', to: '2018-12-31', render: 'true_colour' }, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(calls.map((c) => c.body.datetime.slice(0, 4)).sort()).toEqual(['2017', '2018'])
    expect(calls[0].body.fields.include).toContain('properties.eo:cloud_cover')
    expect(r.scenes.map((s) => s.date)).toEqual(['2017-03-01', '2018-06-10'])
    // the same day folds to the item covering more of the area, and keeps the other id
    expect(r.scenes[0].id).toBe('A_2017_b')
    expect(r.scenes[0].itemIds).toEqual(['A_2017_b', 'A_2017_a'])
    expect(r.scenes[0].cloudBasis).toBe('scene')
    expect(r.scenes[0].coveragePct).toBe(100)
    expect(r.itemsRead).toBe(3)
    expect(r.truncated).toBe(false)
  })

  it('lists every item with group=scene and newest first with order=desc', async () => {
    fakeFetch(() => ({ body: { features: [s2('X1', '2020-01-01T05:00:00Z', 1), s2('X2', '2020-01-01T05:00:02Z', 2), s2('X3', '2020-01-06T05:00:00Z', 2)], links: [] } }))
    const r = await searchSceneCatalogue({ sensor: 'sentinel-2', bbox: BBOX, from: '2020-01-01', to: '2020-12-31', group: 'scene', order: 'desc' }, NOW)
    expect(r.ok && r.scenes.map((s) => s.id)).toEqual(['X3', 'X2', 'X1'])
  })

  it('follows a next link inside a year', async () => {
    let page = 0
    const calls = fakeFetch((_u, init) => {
      const b = JSON.parse(String(init!.body))
      if (!b.token) { page++; return { body: { features: [s2('P1', '2019-02-01T05:00:00Z', 5)], links: [{ rel: 'next', href: 'https://earth-search.aws.element84.com/v1/search', body: { token: 'next:1' }, method: 'POST', merge: true }] } } }
      page++
      return { body: { features: [s2('P2', '2019-03-01T05:00:00Z', 5)], links: [] } }
    })
    const r = await searchSceneCatalogue({ sensor: 'sentinel-2', bbox: BBOX, from: '2019-01-01', to: '2019-12-31' }, NOW)
    expect(page).toBe(2)
    expect(calls[1].body.collections).toEqual(['sentinel-2-l2a']) // merged with the first body
    expect(r.ok && r.scenes.map((s) => s.id)).toEqual(['P1', 'P2'])
  })

  it('asks the catalogue for a cloud ceiling, and none for radar', async () => {
    const calls = fakeFetch(() => ({ body: { features: [], links: [] } }))
    await searchSceneCatalogue({ sensor: 'sentinel-2', bbox: BBOX, from: '2022-01-01', to: '2022-02-01', maxCloud: 40 }, NOW)
    expect(calls[0].body.query).toEqual({ 'eo:cloud_cover': { lte: 40 } })
    calls.length = 0
    await searchSceneCatalogue({ sensor: 'sentinel-1', bbox: BBOX, from: '2022-01-01', to: '2022-02-01', maxCloud: 40 }, NOW)
    expect(calls[0].body.query).toBeUndefined()
  })

  it('says it could not look when the catalogue fails, rather than returning an empty list', async () => {
    fakeFetch(() => ({ status: 502, body: {} }))
    const r = await searchSceneCatalogue({ sensor: 'landsat', bbox: BBOX, from: '2024-01-01', to: '2024-06-01' }, NOW)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/Could not reach the Landsat/)
  })

  it('an empty answer is ok with no scenes', async () => {
    fakeFetch(() => ({ body: { features: [], links: [] } }))
    const r = await searchSceneCatalogue({ sensor: 'sentinel-2', bbox: BBOX, from: '2024-01-01', to: '2024-02-01' }, NOW)
    expect(r.ok && r.scenes).toEqual([])
  })

  it('serves a settled window from the cache and a recent one only briefly', async () => {
    const calls = fakeFetch(() => ({ body: { features: [s2('C1', '2021-05-05T05:00:00Z', 5)], links: [] } }))
    const q = { sensor: 'sentinel-2' as const, bbox: BBOX, from: '2021-01-01', to: '2021-12-31' }
    await searchSceneCatalogue(q, NOW)
    await searchSceneCatalogue(q, NOW)
    expect(calls.length).toBe(1)
  })

  it('folds Sentinel-1 slices of one pass and gives no cloud', async () => {
    const s1 = (id: string, dt: string, orbit: number) => ({ id, collection: 'sentinel-1-rtc', bbox: [73.0, 30.0, 76.0, 32.5], properties: { datetime: dt, platform: 'SENTINEL-1A', 'sat:orbit_state': 'ascending', 'sat:relative_orbit': orbit }, assets: { vv: { href: 'x' }, vh: { href: 'y' } }, links: [] })
    fakeFetch(() => ({ body: { features: [s1('S1a', '2023-04-01T01:00:00Z', 5), s1('S1b', '2023-04-01T01:00:25Z', 5), s1('S1c', '2023-04-13T01:00:00Z', 5)], links: [] } }))
    const r = await searchSceneCatalogue({ sensor: 'sentinel-1', bbox: BBOX, from: '2023-01-01', to: '2023-12-31' }, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scenes).toHaveLength(2)
    expect(r.scenes[0]).toMatchObject({ cloudPct: null, cloudBasis: 'none', orbit: 'ascending', relativeOrbit: 5 })
    expect(r.scenes[0].itemIds).toHaveLength(2)
    expect(r.scenes[0].tileUrl).toContain('sentinel-1-rtc')
    expect(r.scenes[0].tileUrl).toContain('10*log10')
  })
})

describe('sceneTileUrl', () => {
  it('Sentinel-2 true colour is a titiler STAC tile URL with a fixed reflectance window', () => {
    const u = sceneTileUrl('sentinel-2', 'true_colour', s2('S2A_43RDQ_20240101_0_L2A', '2024-01-01T05:40:00Z', 3))!
    expect(u).toContain('/stac/tiles/WebMercatorQuad/{z}/{x}/{y}.png')
    expect(u).toContain('url=https%3A%2F%2Fearth-search.aws.element84.com')
    expect(decodeURIComponent(u)).toContain('assets=red&assets=green&assets=blue')
    // Earth Search serves pixels without the baseline 04.00 offset (lib/reflectance.ts), so 0..0.3 reflectance is 0..3000 DN
    expect(u.match(/rescale=0%2C3000/g)).toHaveLength(3)
  })

  it('NDVI uses one fixed range and the reflectance-scaled expression', () => {
    const u = sceneTileUrl('sentinel-2', 'ndvi', s2('S2A_43RDQ_20240101_0_L2A', '2024-01-01T05:40:00Z', 3))!
    expect(u).toContain('rescale=-0.1%2C0.9')
    expect(u).toContain('colormap_name=rdylgn')
    expect(decodeURIComponent(u)).toContain('assets=nir&assets=red')
  })

  it('Landsat goes through the Planetary Computer data API with the surface-reflectance scaling', () => {
    const u = sceneTileUrl('landsat', 'ndvi', landsat('LC08_L2SP_150039_20240101_20240110_02_T1', '2024-01-01T05:40:00Z', 3))!
    expect(u).toContain('planetarycomputer.microsoft.com/api/data/v1/item/tiles')
    expect(u).toContain('item=LC08_L2SP_150039_20240101_20240110_02_T1')
    expect(decodeURIComponent(u)).toContain('0.0000275')
    const rgb = sceneTileUrl('landsat', 'true_colour', landsat('LC08_L2SP_150039_20240101_20240110_02_T1', '2024-01-01T05:40:00Z', 3))!
    expect(rgb.match(/rescale=7273%2C18182/g)).toHaveLength(3)
  })

  it('is null when the scene lacks the bands, never a guessed URL', () => {
    const item = s2('S2A_X', '2024-01-01T05:40:00Z', 3)
    delete (item.assets as Record<string, unknown>).nir
    expect(sceneTileUrl('sentinel-2', 'ndvi', item)).toBeNull()
  })
})

describe('resolveSceneById', () => {
  const ID = 'S2A_43RDQ_20240101_0_L2A'
  const item = s2(ID, '2024-01-01T05:40:00Z', 3)

  it('accepts the scene and returns its date', async () => {
    fakeFetch(() => ({ body: item }))
    const r = await resolveSceneById('sentinel-2', ID, BBOX, '2024-01-01')
    expect(r.ok && r.date).toBe('2024-01-01')
  })

  it('refuses an id that is not in the catalogue, naming it, and never substitutes', async () => {
    fakeFetch(() => ({ status: 404, body: {} }))
    const r = await resolveSceneById('sentinel-2', ID, BBOX)
    expect(r).toMatchObject({ ok: false })
    expect(!r.ok && r.message).toMatch(/is not in the Sentinel-2 L2A catalogue/)
    expect(!r.ok && r.failed).toBeUndefined()
  })

  it('tells an unreachable catalogue apart from a missing scene', async () => {
    fakeFetch(() => ({ status: 503, body: {} }))
    const r = await resolveSceneById('sentinel-2', ID, BBOX)
    expect(r).toMatchObject({ ok: false, failed: true })
  })

  it('refuses a scene that does not cover the area or has another date', async () => {
    fakeFetch(() => ({ body: s2(ID, '2024-01-01T05:40:00Z', 3, [10, 10, 11, 11]) }))
    expect(await resolveSceneById('sentinel-2', ID, BBOX)).toMatchObject({ ok: false, message: expect.stringMatching(/does not cover/) })
    _resetCache()
    fakeFetch(() => ({ body: item }))
    expect(await resolveSceneById('sentinel-2', ID, BBOX, '2024-02-02')).toMatchObject({ ok: false, message: expect.stringMatching(/acquired on 2024-01-01/) })
  })

  it('refuses a malformed id before any request', async () => {
    const calls = fakeFetch(() => ({ body: item }))
    expect(await resolveSceneById('sentinel-2', '../../etc/passwd', BBOX)).toMatchObject({ ok: false })
    expect(calls).toHaveLength(0)
    expect(SCENE_ID_PATTERN.test(ID)).toBe(true)
  })
})

describe('thin', () => {
  it('keeps the first and the last and spreads the rest evenly', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i)
    const t = thin(xs, 5)
    expect(t).toHaveLength(5)
    expect(t[0]).toBe(0)
    expect(t[4]).toBe(99)
    expect(thin([1, 2, 3], 5)).toEqual([1, 2, 3])
  })
})
