import { afterEach, describe, expect, it, vi } from 'vitest'

import { dayLabel, fetchSceneList, geometryBbox, nearestSceneIndex, prefetchTiles, tilesFor } from '../scenes-client'

describe('scenes-client helpers', () => {
  it('geometryBbox reads a polygon, a multipolygon, and refuses nothing it cannot box', () => {
    const poly: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]]] }
    expect(geometryBbox(poly)).toEqual([74.05, 31.12, 74.08, 31.15])
    expect(geometryBbox({ type: 'MultiPolygon', coordinates: [poly.coordinates, [[[75, 32], [75.1, 32], [75.1, 32.1], [75, 32]]]] })).toEqual([74.05, 31.12, 75.1, 32.1])
    expect(geometryBbox(null)).toBeNull()
    expect(geometryBbox({ type: 'Point', coordinates: [1, 2] })).toBeNull()
  })

  it('dayLabel does not drift with the time zone', () => {
    expect(dayLabel('2017-01-04')).toBe('4 Jan 2017')
    expect(dayLabel('2026-10-12T05:00:00Z')).toBe('12 Oct 2026')
  })

  it('nearestSceneIndex finds the closest day, either side', () => {
    const list = [{ date: '2019-01-01' }, { date: '2019-03-01' }, { date: '2020-01-01' }]
    expect(nearestSceneIndex(list, '2019-02-10')).toBe(1)
    expect(nearestSceneIndex(list, '2030-01-01')).toBe(2)
    expect(nearestSceneIndex([], '2019-01-01')).toBe(-1)
  })

  it('tilesFor lists the tiles over an area and caps them', () => {
    const t = tilesFor({ west: 74.05, south: 31.12, east: 74.08, north: 31.15 }, 12)
    expect(t.length).toBeGreaterThan(0)
    expect(t.every(([z]) => z === 12)).toBe(true)
    expect(tilesFor({ west: -10, south: -10, east: 10, north: 10 }, 8, 5)).toHaveLength(5)
  })
})

describe('fetchSceneList', () => {
  afterEach(() => vi.unstubAllGlobals())
  const page = (ids: string[], next: string | null, total: number) => new Response(JSON.stringify({ scenes: ids.map((id) => ({ id, date: '2020-01-01' })), next, total, first: '2020-01-01', last: '2020-01-01', truncated: false, render: { mode: 'true_colour' }, provider: 'p', label: 'l' }), { status: 200 })

  it('reads every page, passes the choices, and reports progress', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      urls.push(u)
      return u.includes('cursor=0') ? page(['a', 'b'], '2', 3) : page(['c'], null, 3)
    }))
    const seen: number[] = []
    const out = await fetchSceneList({ bbox: [74.05, 31.12, 74.08, 31.15], sensor: 'landsat', render: 'ndvi', from: '2000-01-01', maxCloud: 40 }, { onProgress: (n) => seen.push(n) })
    expect(out.scenes.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(seen).toEqual([2, 3])
    expect(urls[0]).toContain('bbox=74.05%2C31.12%2C74.08%2C31.15')
    expect(urls[0]).toContain('sensor=landsat')
    expect(urls[0]).toContain('maxCloud=40')
    expect(urls[0]).toContain('from=2000-01-01')
    expect(urls[0]).not.toContain('to=')
  })

  it('throws the server message when the catalogue is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'catalogue_unavailable', message: 'Could not reach the catalogue' }), { status: 502 })))
    await expect(fetchSceneList({ bbox: [1, 2, 3, 4], sensor: 'sentinel-2', render: 'true_colour', maxCloud: 100 })).rejects.toThrow('Could not reach the catalogue')
  })

  it('prefetchTiles requests each tile once with the template filled in', () => {
    const srcs: string[] = []
    vi.stubGlobal('Image', class { decoding = ''; set src(v: string) { srcs.push(v) } })
    prefetchTiles('https://t/{z}/{x}/{y}.png?a=1', [[12, 3, 4], [12, 3, 5]])
    expect(srcs).toEqual(['https://t/12/3/4.png?a=1', 'https://t/12/3/5.png?a=1'])
  })
})
