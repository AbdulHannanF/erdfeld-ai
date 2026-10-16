import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../stac', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stac')>()
  return { ...actual, searchPCStac: vi.fn(), signPCAsset: vi.fn(async (h: string) => `${h}?sig=1`) }
})

import { _resetCache } from '../cache'
import { searchPCStac } from '../stac'
import {
  WORLDCOVER_LABELS,
  classSharesFromCounts,
  fetchWorldCoverClasses,
  parseWorldCoverStats,
  pickWorldCover2021,
  worldCoverDescriptor,
  worldCoverItemTileUrl,
  worldCoverLegendDescriptor,
} from '../worldcover'

const item = (id: string) => ({ id, assets: { map: { href: `https://blob/${id}.tif` } } })
const AOI = { type: 'Polygon', coordinates: [[[31.0, 31.0], [31.02, 31.0], [31.02, 31.02], [31.0, 31.02], [31.0, 31.0]]] }
const BBOX = [31.0, 31.0, 31.02, 31.02]
beforeEach(() => {
  vi.mocked(searchPCStac).mockReset()
  })

describe('pickWorldCover2021', () => {
  it('keeps the 2021 product and drops the 2020 one served for the same tile', () => {
    const picked = pickWorldCover2021([item('ESA_WorldCover_10m_2020_v100_N30E030'), item('ESA_WorldCover_10m_2021_v200_N30E030')])
    expect(picked.map((f) => f.id)).toEqual(['ESA_WorldCover_10m_2021_v200_N30E030'])
  })
  it('returns nothing when only 2020 exists, rather than labelling 2020 as 2021', () => {
    expect(pickWorldCover2021([item('ESA_WorldCover_10m_2020_v100_N30E030')])).toEqual([])
  })
  it('keeps an item with no year in its id (a custom catalogue)', () => {
    expect(pickWorldCover2021([item('wc')])).toHaveLength(1)
  })
})

describe('classSharesFromCounts', () => {
  it('lists the classes that occur, largest first, with shares of the classified pixels', () => {
    const { shares, classified } = classSharesFromCounts(new Map([[40, 848], [50, 89], [80, 40], [10, 0], [255, 30]]))
    expect(classified).toBe(977)
    expect(shares.map((s) => s.label)).toEqual(['Cropland', 'Built-up', 'Permanent Water'])
    expect(shares[0]).toMatchObject({ value: 40, color: '#f096ff', pixels: 848 })
    expect(shares[0].pct).toBeCloseTo(86.8, 1)
    expect(shares.reduce((a, s) => a + s.pct, 0)).toBeCloseTo(100, 0)
  })
  it('an empty or unknown-only histogram has no shares', () => {
    expect(classSharesFromCounts(new Map()).shares).toEqual([])
    expect(classSharesFromCounts(new Map([[255, 10]])).classified).toBe(0)
  })
})

describe('parseWorldCoverStats classes', () => {
  it('carries the full class breakdown, not only the five headline shares', () => {
    const stats = parseWorldCoverStats({ b1: { histogram: [[20159, 151, 2923, 4488, 135980, 617, 34], [10, 20, 30, 40, 50, 60, 80]] } })!
    expect(stats.classes.map((c) => c.value)).toEqual([50, 10, 40, 30, 60, 20, 80])
  })
})

describe('tile URL and descriptors', () => {
  it('uses the Planetary Computer data API with every official colour, so it never expires', () => {
    const url = worldCoverItemTileUrl('ESA_WorldCover_10m_2021_v200_N30E030')
    expect(url).toContain('planetarycomputer.microsoft.com/api/data/v1/item/tiles/WebMercatorQuad/{z}/{x}/{y}.png')
    const q = new URL(url.replace('{z}/{x}/{y}', '0/0/0')).searchParams
    expect(q.get('collection')).toBe('esa-worldcover')
    expect(q.get('assets')).toBe('map')
    const cm = JSON.parse(q.get('colormap')!)
    expect(Object.keys(cm).map(Number).sort((a, b) => a - b)).toEqual(Object.keys(WORLDCOVER_LABELS).map(Number).sort((a, b) => a - b))
    expect(cm['40']).toEqual([240, 150, 255, 255])
    expect(cm['50']).toEqual([250, 0, 0, 255])
    expect(url).not.toMatch(/sig=/)
  })
  it('the legend descriptor lists all 11 classes; the AOI one only those present, with shares', () => {
    expect(worldCoverLegendDescriptor().classes).toHaveLength(11)
    const d = worldCoverDescriptor(classSharesFromCounts(new Map([[40, 3], [50, 1]])).shares, 'item')
    expect(d).toMatchObject({ kind: 'categorical', sceneId: 'item', classes: [{ value: 40, label: 'Cropland 75%' }, { value: 50, label: 'Built-up 25%' }] })
  })
})

describe('fetchWorldCoverClasses', () => {
  const stats = (hist: Array<[number, number]>, extra: Record<string, number> = {}) => ({ properties: { statistics: { b1: { histogram: [hist.map((h) => h[1]), hist.map((h) => h[0])], ...extra } } } })
  const stub = (by: (url: string) => Response | Promise<Response>) => vi.stubGlobal('fetch', vi.fn(async (url: any) => by(String(url))))
  const calls = () => vi.mocked(fetch as any).mock.calls.map((c: any[]) => String(c[0]))

  it('counts class codes from the categorical statistics (bidx 1: the palette COG would otherwise give RGBA) and reports a tile per tile with pixels', async () => {
    _resetCache()
    vi.mocked(searchPCStac).mockResolvedValue({ features: [item('ESA_WorldCover_10m_2020_v100_N30E030'), item('ESA_WorldCover_10m_2021_v200_N30E030')] })
    // 1000 classified pixels of the 1250 inside the polygon: 250 of them were masked as no data
    stub(() => Response.json(stats([[40, 750], [50, 250]], { valid_pixels: 1000, masked_pixels: 250 })))
    const out = await fetchWorldCoverClasses(AOI, BBOX, 4.9)
    if (!out.ok) throw new Error(out.message)
    expect(out.cover.coveragePct).toBeCloseTo(80, 5)
    expect(out.cover.gsdM).toBeCloseTo(Math.sqrt(4.9e6 / 1250), 5)
    expect(out.cover.shares.map((x) => [x.label, x.pct])).toEqual([['Cropland', 75], ['Built-up', 25]])
    expect(out.cover.classifiedPixels).toBe(1000)
    expect(out.cover.tiles.map((t) => t.itemId)).toEqual(['ESA_WorldCover_10m_2021_v200_N30E030'])
    expect(calls()).toHaveLength(1) // the 2020 item was not read
    const q = new URL(calls()[0]).searchParams
    expect(q.get('categorical')).toBe('true')
    expect(q.get('bidx')).toBe('1')
    vi.unstubAllGlobals()
  })

  it('adds up the tiles of an AOI that straddles a WorldCover boundary', async () => {
    _resetCache()
    vi.mocked(searchPCStac).mockResolvedValue({ features: [item('ESA_WorldCover_10m_2021_v200_N30E030'), item('ESA_WorldCover_10m_2021_v200_N30E033')] })
    stub((url) => Response.json(url.includes('/cog/statistics') && calls().length === 1 ? stats([[40, 500]]) : stats([[80, 500]])))
    const out = await fetchWorldCoverClasses(AOI, BBOX, 4.9)
    if (!out.ok) throw new Error(out.message)
    expect(out.cover.shares.map((x) => [x.label, x.pct])).toEqual([['Cropland', 50], ['Permanent Water', 50]])
    expect(out.cover.tiles).toHaveLength(2)
    vi.unstubAllGlobals()
  })

  it('distinguishes a failed read from an AOI with nothing classified, and from no tile at all', async () => {
    _resetCache()
    vi.mocked(searchPCStac).mockResolvedValue({ features: [item('ESA_WorldCover_10m_2021_v200_N30E030')] })
    stub(() => new Response('slow down', { status: 429 }))
    expect(await fetchWorldCoverClasses(AOI, BBOX, 4.9)).toMatchObject({ ok: false, reason: 'fetch_failed', message: expect.stringContaining('HTTP 429') })

    _resetCache()
    stub(() => Response.json(stats([[0, 900]])))
    expect(await fetchWorldCoverClasses(AOI, BBOX, 4.9)).toMatchObject({ ok: false, reason: 'no_data' })
    vi.unstubAllGlobals()

    vi.mocked(searchPCStac).mockResolvedValue({ features: [] })
    expect(await fetchWorldCoverClasses(AOI, BBOX, 4.9)).toMatchObject({ ok: false, reason: 'no_data' })

    vi.mocked(searchPCStac).mockRejectedValue(new Error('PC STAC HTTP 500'))
    expect(await fetchWorldCoverClasses(AOI, BBOX, 4.9)).toMatchObject({ ok: false, reason: 'fetch_failed' })
  })

  it('needs a polygon', async () => {
    expect(await fetchWorldCoverClasses({ type: 'Point', coordinates: [0, 0] }, [0, 0, 0, 0], 1)).toMatchObject({ ok: false, reason: 'no_polygon' })
  })
})
