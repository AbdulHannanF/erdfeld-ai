/** map_flood with a mocked STAC catalogue, mocked titiler pixel reads and mocked Overture rows.
 *  The synthetic world is known exactly, so areas, polygon counts and building counts are asserted exactly. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PixelGrid } from '../../lib/pixels'

vi.mock('../../lib/pixels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pixels')>()
  return { ...actual, fetchCogFeatureGrid: vi.fn() }
})
vi.mock('../../lib/stac', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stac')>()
  return { ...actual, signPCAsset: vi.fn(async (href: string) => `${href}?sig=test`) }
})
vi.mock('../../lib/registry/readers/overture', () => ({ readOvertureTheme: vi.fn() }))

import { fetchCogFeatureGrid } from '../../lib/pixels'
import { readOvertureTheme } from '../../lib/registry/readers/overture'
import { _resetCache } from '../../lib/cache'
import { validateVegaLite } from '../../lib/chart-data'
import { makeGeoref } from '../../lib/vectorize'
import { executeTool } from '../index'
import { scanMaxSize } from '../flood'

const SIZE = 100
const BBOX: [number, number, number, number] = [74.0, 31.0, 74.01, 31.01]
const AOI = { type: 'Polygon', coordinates: [[[BBOX[0], BBOX[1]], [BBOX[2], BBOX[1]], [BBOX[2], BBOX[3]], [BBOX[0], BBOX[3]], [BBOX[0], BBOX[1]]]] }
const geo = makeGeoref(BBOX, SIZE, SIZE)

type Rect = [number, number, number, number] // x0, y0, x1, y1 (exclusive)
const RIVER: Rect = [10, 0, 20, 100] // permanent, every scene
const POND: Rect = [80, 80, 85, 85] // only on 2025-07-25 (before)
const FLOOD_A: Rect = [40, 40, 60, 60]
const ISLAND: Rect = [47, 47, 53, 53] // dry 6x6 island inside flood A -> a hole
const FLOOD_B: Rect = [70, 10, 76, 16]
const EARLY: Rect = [40, 40, 60, 50] // 200 px: the early part of the rise (not "dry")
const REMNANT: Rect = [40, 40, 50, 50]

/** The 3x3 median rounds every rectangle at its four corners: a w x h block (w, h >= 3) keeps w*h - 4 pixels, and the
 *  corners of a dry island inside water turn to water, so a 6x6 island leaves a 32-pixel hole. Everything else survives. */
const ROUND = (r: Rect) => (r[2] - r[0]) * (r[3] - r[1]) - 4
const FLOOD_A_PX = ROUND(FLOOD_A) - ROUND(ISLAND) // 396 - 32 = 364 (shell 396, hole 32)
const FLOOD_B_PX = ROUND(FLOOD_B) // 32
const POND_PX = ROUND(POND) // 21

const inR = (r: Rect, x: number, y: number) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3]

/** date -> water predicate */
const WORLD: Record<string, { rel: number; orbit: 'ascending' | 'descending'; water: (x: number, y: number) => boolean }> = {
  '2025-07-01': { rel: 100, orbit: 'ascending', water: (x, y) => inR(RIVER, x, y) },
  '2025-07-07': { rel: 107, orbit: 'descending', water: (x, y) => inR(RIVER, x, y) },
  '2025-07-13': { rel: 100, orbit: 'ascending', water: (x, y) => inR(RIVER, x, y) },
  '2025-07-24': { rel: 107, orbit: 'descending', water: (x, y) => inR(RIVER, x, y) },
  '2025-07-25': { rel: 100, orbit: 'ascending', water: (x, y) => inR(RIVER, x, y) || inR(POND, x, y) },
  '2025-08-06': { rel: 100, orbit: 'ascending', water: (x, y) => inR(RIVER, x, y) || inR(EARLY, x, y) },
  '2025-08-10': { rel: 107, orbit: 'descending', water: (x, y) => inR(RIVER, x, y) || inR(REMNANT, x, y) },
  '2025-08-18': {
    rel: 100, orbit: 'ascending',
    water: (x, y) => inR(RIVER, x, y) || (inR(FLOOD_A, x, y) && !inR(ISLAND, x, y)) || inR(FLOOD_B, x, y),
  },
  '2025-08-30': { rel: 100, orbit: 'ascending', water: (x, y) => inR(RIVER, x, y) || inR(REMNANT, x, y) },
}
const PEAK = '2025-08-18'

function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const itemId = (date: string) => `S1A_IW_GRDH_1SDV_${date.replace(/-/g, '')}_rtc`
function stacItem(date: string) {
  const w = WORLD[date]
  return {
    id: itemId(date),
    bbox: [73.5, 30.5, 74.5, 31.5],
    ...(footprints[date] ? { geometry: footprints[date] } : {}),
    properties: { datetime: `${date}T01:08:22Z`, 'sat:relative_orbit': w.rel, 'sat:orbit_state': w.orbit, platform: 'sentinel-1a' },
    assets: { vv: { href: `https://sentinel1euwestrtc.blob.core.windows.net/grd/${itemId(date)}/iw-vv.rtc.tiff` }, vh: { href: `https://sentinel1euwestrtc.blob.core.windows.net/grd/${itemId(date)}/iw-vh.rtc.tiff` } },
  }
}

/** date -> STAC item footprint (absent: the item carries no geometry) */
let footprints: Record<string, any> = {}
const rectGeom = (x0: number, x1: number) => ({ type: 'Polygon', coordinates: [[[x0, 30.5], [x1, 30.5], [x1, 31.5], [x0, 31.5], [x0, 30.5]]] })
let world: 'flood' | 'land-only' = 'flood'
let stacStatus = 200
let stacDates: string[] | null = null

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: any) => {
    if (stacStatus !== 200) return { ok: false, status: stacStatus, headers: new Headers(), json: async () => ({}) }
    const body = JSON.parse(init?.body ?? '{}')
    const [lo, hi] = String(body.datetime).split('/').map((s: string) => s.slice(0, 10))
    const dates = (stacDates ?? Object.keys(WORLD)).filter((d) => d >= lo && d <= hi)
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ features: dates.map(stacItem), links: [] }) }
  }))
}

function mockReads() {
  vi.mocked(fetchCogFeatureGrid).mockImplementation(async (req: any) => {
    const m = String(req.cogUrl).match(/_(\d{8})_rtc/)!
    const date = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`
    const w = WORLD[date]
    const r = mulberry(Number(m[1]))
    const values = new Float64Array(SIZE * SIZE)
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const wet = world === 'flood' && w.water(x, y)
        const db = (wet ? -22 : -10) + (r() - 0.5) * 3 // +/- 1.5 dB of noise: water -23.5..-20.5, land -11.5..-8.5
        values[y * SIZE + x] = 10 ** (db / 10)
      }
    }
    const mask = new Float64Array(SIZE * SIZE).fill(255)
    return { values, mask, width: SIZE, height: SIZE, bands: 2, raw: values } satisfies PixelGrid
  })
}

/** Footprint: a 1-pixel square centred on lattice point (cx, cy). */
function footprint(id: string, cx: number, cy: number, half = 0.5) {
  const ring = [[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half], [cx - half, cy - half]].map(([x, y]) => geo.toLonLat(x, y))
  return { id, geometry: { type: 'Polygon', coordinates: [ring] } }
}
const BUILDINGS = [
  footprint('A1', 41.5, 41.5), footprint('A2', 58.5, 58.5), footprint('A3', 45.5, 55.5), // inside flood A
  footprint('island', 50, 50), // inside the hole (dry island)
  footprint('B1', 72.5, 12.5), // inside flood B
  footprint('river', 14.5, 50.5), // in permanent water, not flood
  footprint('edge', 60.8, 50.5), // overlaps A's edge but the centroid is outside
  footprint('far1', 30.5, 30.5), footprint('far2', 90.5, 90.5),
]
const ROADS = [
  { id: 'r1', subtype: 'road', geometry: { type: 'LineString', coordinates: [geo.toLonLat(30, 45.5), geo.toLonLat(70, 45.5)] } }, // crosses A for 20 px
  { id: 'r2', subtype: 'road', geometry: { type: 'LineString', coordinates: [geo.toLonLat(25, 90), geo.toLonLat(35, 90)] } },
  { id: 'rail', subtype: 'rail', geometry: { type: 'LineString', coordinates: [geo.toLonLat(30, 52), geo.toLonLat(70, 52)] } }, // not a road
]
let overtureFails = false

function run(args: Record<string, any> = {}, aoi: any = AOI) {
  return executeTool('map_flood', aoi, args)
}
const sd = (r: any, k: string) => r.stats?.[k]

beforeEach(() => {
  _resetCache()
  vi.mocked(readOvertureTheme).mockReset()
  world = 'flood'
  stacStatus = 200
  stacDates = null
  footprints = {}
  overtureFails = false
  stubFetch()
  mockReads()
  vi.mocked(readOvertureTheme).mockImplementation(async (theme: string, _bbox: number[], opts: any = {}) => {
    if (overtureFails) throw new Error('Overture STAC answered HTTP 503')
    const all: any[] = theme === 'buildings' ? BUILDINGS : ROADS
    // Like the real reader: `select` reduces the box-matching rows; `scanned` counts them first.
    return { rows: opts.select ? opts.select(all) : all, scanned: all.length, files: 1, rowGroupsScanned: 1, release: '2026-09-23.1' } as any
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(fetchCogFeatureGrid).mockReset()
})

describe('map_flood — window scan', () => {
  it('picks the peak and the nearest dry scene on the same orbit, with exact areas and counts', async () => {
    const r = await run({ start: '2025-06-15', end: '2025-09-15' })
    expect(r.summary).not.toMatch(/^Real data unavailable/)

    // selection
    expect(sd(r, 'after_date')).toBe(PEAK)
    expect(sd(r, 'after_relative_orbit')).toBe(100)
    expect(sd(r, 'before_date')).toBe('2025-07-25') // 08-06 already carries 200 px of early flood, so it is not "dry"
    expect(sd(r, 'before_relative_orbit')).toBe(100)
    expect(sd(r, 'orbit_match')).toBe('orbit')
    expect(sd(r, 'scenes_scanned')).toBe(Object.keys(WORLD).length)
    expect(r.summary).toMatch(/peak-water scene/)
    expect(r.summary).toMatch(/same relative orbit 100/)

    // threshold: Otsu inside the range, not the fallback
    expect(sd(r, 'threshold_method')).toBe('otsu')
    expect(sd(r, 'threshold_db')).toBeGreaterThanOrEqual(-23)
    expect(sd(r, 'threshold_db')).toBeLessThanOrEqual(-15)

    // exact geometry: flood A (20x20 with a 6x6 island hole) + flood B (6x6), after the 3x3 median's corner rounding
    const pxKm2 = (geo.pixelAreaM2) / 1e6
    expect(sd(r, 'flood_polygon_count')).toBe(2)
    expect(sd(r, 'flood_area_km2')).toBeCloseTo((FLOOD_A_PX + FLOOD_B_PX) * pxKm2, 4)
    expect(sd(r, 'permanent_polygon_count')).toBe(1)
    expect(sd(r, 'permanent_water_km2')).toBeCloseTo(1000 * pxKm2, 3)
    expect(sd(r, 'receded_area_km2')).toBeCloseTo(POND_PX * pxKm2, 4) // the pond that was only in the before scene
    expect(sd(r, 'after_water_pct')).toBeCloseTo((1000 + FLOOD_A_PX + FLOOD_B_PX) / 100, 2)
    expect(sd(r, 'before_water_pct')).toBeCloseTo((1000 + POND_PX) / 100, 2)

    // impact: A1, A2, A3 and B1 only
    expect(sd(r, 'affected_buildings')).toBe(4)
    expect(sd(r, 'buildings_scanned')).toBe(BUILDINGS.length)
    expect(sd(r, 'buildings_read_capped')).toBe('no')
    // roads: 20 px of r1 inside flood A; the rail line is ignored
    expect(sd(r, 'flooded_road_km')).toBeGreaterThan(0.9 * 20 * geo.cellXm / 1000)
    expect(sd(r, 'flooded_road_km')).toBeLessThan(1.1 * 20 * geo.cellXm / 1000)
    expect(sd(r, 'road_segments_touched')).toBe(1)

    // series: one value per scene, as % water
    const series = sd(r, 'water_fraction_series_pct') as Array<{ label: string; value: number }>
    expect(series).toHaveLength(Object.keys(WORLD).length)
    expect(Math.max(...series.map((s) => s.value))).toBeCloseTo((1000 + FLOOD_A_PX + FLOOD_B_PX) / 100, 2)
    expect(sd(r, 'flood_area_km2_by_threshold')).toHaveLength(3)

    // honest caveats
    expect(r.summary).toMatch(/urban flooding is under-detected/)
    expect(r.summary).toMatch(/Wind-roughened/)
    expect(r.summary).toMatch(/no terrain \(DEM\/HAND\) mask/)
  })

  it('scans every scene coarsely but reads only the chosen pair at the full grid', async () => {
    await run({ start: '2025-06-15', end: '2025-09-15' })
    const sizes = vi.mocked(fetchCogFeatureGrid).mock.calls.map((c) => (c[0] as any).maxSize as number)
    expect(sizes).toHaveLength(Object.keys(WORLD).length + 2) // one scan read per scene, then before and after
    const full = Math.max(...sizes)
    expect(sizes.filter((n) => n === full).length).toBeGreaterThanOrEqual(2)
  })

  it('explicit dates skip a pass whose swath edge clips the AOI when another pass covers it fully', async () => {
    // The AOI spans lng 74.0-74.01. 08-18 (nearest to the requested day) only reaches lng 74.005; 08-10 covers it.
    footprints = { '2025-08-18': rectGeom(73.5, 74.005), '2025-08-10': rectGeom(73.5, 74.5) }
    const r = await run({ before: '2025-07-24', after: '2025-08-17' })
    expect(sd(r, 'after_date')).toBe('2025-08-10')
    expect(r.summary).not.toMatch(/^Real data unavailable/)
  })

  it('says how much of the AOI the best footprint covers when no pass covers it', async () => {
    footprints = Object.fromEntries(Object.keys(WORLD).map((d) => [d, rectGeom(73.5, 74.005)]))
    const r = await run({ before: '2025-07-24', after: '2025-08-17' })
    expect(r.summary).toMatch(/best footprint covers 50% of it/)
  })

  it('sizes the scan grid so the kept dB grids stay inside a fixed budget, whatever the scene count', () => {
    expect(scanMaxSize(1000, 2)).toBe(1000)
    expect(scanMaxSize(1000, 60)).toBeLessThan(400)
    for (const n of [1, 10, 60, 500]) {
      const edge = scanMaxSize(1000, n)
      // n grids of edge^2 Float32 values never exceed the 24 MB budget (except at the 64 px floor)
      expect(edge === 64 || n * edge * edge * 4 <= 24 * 1024 * 1024).toBe(true)
    }
    expect(scanMaxSize(40, 60)).toBe(40) // a small AOI is never scanned coarser than it is read
  })

  it('returns the four layers: SAR after, SAR before (hidden), flood polygons, affected buildings', async () => {
    const r = await run({ start: '2025-06-15', end: '2025-09-15' })
    const layers = r.layers
    expect(layers).toHaveLength(4)
    const [after, before, flood, bld] = layers

    expect(after.type).toBe('raster')
    expect(after.aoiMask).toBe(true)
    expect(after.defaultVisible).toBeUndefined()
    expect(after.tileUrl).toContain('planetarycomputer.microsoft.com/api/data/v1/item/tiles')
    expect(after.tileUrl).toContain(`item=${itemId(PEAK)}`)
    expect(decodeURIComponent(after.tileUrl!)).toContain('expression=10*log10(vv)') // dB, not linear
    expect(after.tileUrl).toContain('colormap_name=greys_r')
    expect(after.raster).toMatchObject({ kind: 'continuous', units: 'dB', datetime: PEAK, colormap: 'greys_r' })

    expect(before.type).toBe('raster')
    expect(before.defaultVisible).toBe(false)
    expect(before.tileUrl).toContain(`item=${itemId('2025-07-25')}`)

    expect(flood.type).toBe('geojson')
    expect(flood.vectorStyle).toMatchObject({ property: 'kind', kind: 'categorical' })
    expect(flood.vectorStyle!.classes!.map((c) => c.value)).toEqual(['New flood', 'Permanent water'])
    const feats = flood.geojson.features as any[]
    expect(feats.filter((f) => f.properties.kind === 'New flood')).toHaveLength(2)
    expect(feats.filter((f) => f.properties.kind === 'Permanent water')).toHaveLength(1)
    // the island is kept as a hole in flood A
    const withHole = feats.find((f) => f.properties.kind === 'New flood' && f.geometry.coordinates.length === 2)
    expect(withHole).toBeTruthy()
    // coordinates are rounded to 5 dp
    for (const [x] of feats[0].geometry.coordinates[0]) expect(Math.abs(x * 1e5 - Math.round(x * 1e5))).toBeLessThan(1e-6)

    expect(bld.type).toBe('geojson')
    expect(bld.geojson.features).toHaveLength(4)
    expect(bld.geojson.features.map((f: any) => f.properties.id).sort()).toEqual(['A1', 'A2', 'A3', 'B1'])
    expect(bld.vectorStyle).toMatchObject({ property: 'status', kind: 'categorical' })
    expect(bld.provenance?.source).toMatch(/Overture/)
  })

  it('draws a Vega-Lite series chart with before and after marked', async () => {
    const r = await run({ start: '2025-06-15', end: '2025-09-15' })
    expect(r.charts).toHaveLength(1)
    const spec = r.charts![0].spec
    expect(validateVegaLite(spec).ok).toBe(true)
    const rows = spec.data.values as Array<{ date: string; role: string; water_pct: number }>
    expect(rows).toHaveLength(Object.keys(WORLD).length)
    expect(rows.filter((x) => x.role === 'After (flood peak)').map((x) => x.date)).toEqual([PEAK])
    expect(rows.filter((x) => x.role === 'Before (dry)').map((x) => x.date)).toEqual(['2025-07-25'])
  })

  it('min_area_m2 drops small flood polygons and reports it', async () => {
    const r = await run({ start: '2025-06-15', end: '2025-09-15', min_area_m2: 20_000 }) // flood B is ~3 400 m²
    expect(sd(r, 'flood_polygon_count')).toBe(1)
    // holes under the minimum area are filled too, so flood A counts as its full 396-pixel shell
    expect(sd(r, 'flood_area_km2')).toBeCloseTo((ROUND(FLOOD_A) * geo.pixelAreaM2) / 1e6, 4)
    expect(sd(r, 'affected_buildings')).toBe(4) // B1 lost with its polygon; the island building now counts because its hole was filled
    expect(Number(sd(r, 'dropped_small_groups'))).toBeGreaterThanOrEqual(1)
  })

  it('degrades honestly when Overture is down: flood figures stay, building count is absent', async () => {
    overtureFails = true
    const r = await run({ start: '2025-06-15', end: '2025-09-15' })
    expect(sd(r, 'flood_polygon_count')).toBe(2)
    expect(r.stats).not.toHaveProperty('affected_buildings')
    expect(r.summary).toMatch(/could not be counted/)
    expect(r.layers!.some((l) => /Flooded buildings/.test(l.name))).toBe(false)
  })

  it('weak bimodality: land-only scenes use the -18 dB fallback, say so, and find no flood', async () => {
    world = 'land-only'
    const r = await run({ start: '2025-06-15', end: '2025-09-15' })
    expect(sd(r, 'threshold_method')).toBe('fallback')
    expect(sd(r, 'threshold_db')).toBe(-18)
    expect(r.summary).toMatch(/not bimodal/)
    expect(sd(r, 'flood_polygon_count')).toBe(0)
    expect(r.summary).toMatch(/No new flooding found/)
    expect(r.summary).toMatch(/measured absence/)
    expect(readOvertureTheme).not.toHaveBeenCalled()
    expect(r.layers!.some((l) => l.type === 'geojson')).toBe(false) // nothing to draw
  })
})

describe('map_flood — explicit dates', () => {
  it('uses the scene nearest each date and prefers the same relative orbit for before', async () => {
    // 2025-07-24 has an exact-date scene on orbit 107; the orbit-100 scene (07-25) is used so the pair compares like with like.
    const r = await run({ before: '2025-07-24', after: '2025-08-17' })
    expect(sd(r, 'after_date')).toBe(PEAK)
    expect(sd(r, 'before_date')).toBe('2025-07-25')
    expect(sd(r, 'before_relative_orbit')).toBe(100)
    expect(sd(r, 'orbit_match')).toBe('orbit')
    expect(sd(r, 'scenes_scanned')).toBe(2)
    expect(sd(r, 'flood_polygon_count')).toBe(2)
    expect(sd(r, 'affected_buildings')).toBe(4)
    expect(r.stats).not.toHaveProperty('water_fraction_series_pct') // not a scan
    expect(r.summary).toMatch(/explicit dates/)
    expect(vi.mocked(fetchCogFeatureGrid)).toHaveBeenCalledTimes(2)
  })

  it('reports a mixed geometry when no same-orbit scene is near the before date', async () => {
    stacDates = ['2025-07-24', PEAK] // only an orbit-107 scene near the before date
    const r = await run({ before: '2025-07-24', after: PEAK })
    expect(sd(r, 'before_relative_orbit')).toBe(107)
    expect(sd(r, 'orbit_match')).toBe('any')
    expect(r.summary).toMatch(/different orbit geometry/)
  })

  it('rejects bad input without calling the network', async () => {
    const refused = async (args: Record<string, any>, pattern: RegExp) => {
      const r = await run(args)
      expect(r.status).toBe('refused')
      expect(r.summary).toMatch(pattern)
    }
    await refused({ before: '2025-08-18', after: '2025-07-25' }, /`before` \(2025-08-18\) must be earlier than `after`/)
    await refused({ before: '2025-07-25', after: '2025-07-25' }, /must be earlier than `after`/)
    await refused({ before: 'yesterday', after: PEAK }, /YYYY-MM-DD/)
    await refused({ polarization: 'HH', start: '2025-06-01', end: '2025-09-01' }, /VV/)
    await refused({ before: '2025-07-25' }, /`before` and `after` together/)
    expect(vi.mocked(fetchCogFeatureGrid)).not.toHaveBeenCalled()
  })
})

describe('map_flood — failures are honest', () => {
  it('reports a catalogue failure as unavailable, not as "no flood"', async () => {
    stacStatus = 500
    const r = await run({ start: '2025-06-15', end: '2025-09-15' })
    expect(r.summary).toMatch(/^Real data unavailable/)
    expect(r.status).toBe('failed') // a catalogue outage is a failure, not "no flood"
    expect(r.layers).toHaveLength(0)
  })

  it('says so when no scene covers the window or only one does', async () => {
    stacDates = []
    expect((await run({ start: '2025-06-15', end: '2025-09-15' })).summary).toMatch(/no Sentinel-1 RTC scene covers/)
    _resetCache()
    stacDates = [PEAK]
    expect((await run({ start: '2025-06-15', end: '2025-09-15' })).summary).toMatch(/only one Sentinel-1 RTC scene/)
  })

  it('reports a pixel-read failure as unavailable', async () => {
    vi.mocked(fetchCogFeatureGrid).mockRejectedValue(new Error('titiler cog/feature.npy HTTP 429'))
    const r = await run({ start: '2025-06-15', end: '2025-09-15' })
    expect(r.summary).toMatch(/^Real data unavailable/)
    expect(r.summary).toMatch(/429/)
  })

  it('refuses an AOI too large for a sharp boundary', async () => {
    const big = { type: 'Polygon', coordinates: [[[74, 31], [75, 31], [75, 32], [74, 32], [74, 31]]] }
    const r = await run({ start: '2025-06-15', end: '2025-09-15' }, big)
    expect(r.summary).toMatch(/Draw a smaller area/)
  })

  it('needs a polygon AOI', async () => {
    const r = await run({}, { type: 'Point', coordinates: [74, 31] })
    expect(r.status).toBe('refused')
    expect(r.summary).toMatch(/no measurable area/)
  })
})

describe('routing', () => {
  it('digitize_features routes "flooded area" to map_flood (dates belong to map_flood itself)', async () => {
    const r = await executeTool('digitize_features', AOI, { feature: 'flooded area' })
    expect(r.op.name).toBe('digitize_features')
    expect(r.summary).toMatch(/Sentinel-1 RTC scene/) // map_flood's own wording: the default window has no scene in this fixture
  })
})
