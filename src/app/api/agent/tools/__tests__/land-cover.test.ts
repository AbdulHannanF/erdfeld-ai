/** classify_land_cover: per-class shares measured from ESA WorldCover 2021 over the AOI polygon, a
 *  categorical tile layer in the official colours with a legend, and `failed` when WorldCover cannot
 *  be read. It replaces an NDVI-mean + OSM heuristic that called a cropland delta "Urban / Built-up". */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/worldcover', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/worldcover')>()
  return { ...actual, fetchWorldCoverClasses: vi.fn() }
})

import { WORLDCOVER_LABELS, classSharesFromCounts, fetchWorldCoverClasses } from '../../lib/worldcover'
import { classifyLandCover } from '../derived'

const AOI = { type: 'Polygon', coordinates: [[[30.916, 31.1277], [31.084, 31.1277], [31.084, 31.2723], [30.916, 31.2723], [30.916, 31.1277]]] }
const ctx = (): any => ({ aoi: AOI, bbox: [30.916, 31.1277, 31.084, 31.2723], centroid: { lat: 31.2, lng: 31 }, areaKm2: 257.1, emit: vi.fn(), runTool: vi.fn() })

/** The Nile delta AOI of the failing run: 84.8% cropland, built-up and water the rest. */
function deltaCover(coveragePct = 100) {
  const { shares, classified } = classSharesFromCounts(new Map([[40, 848], [50, 89], [80, 40], [10, 3], [30, 20]]))
  return {
    ok: true as const,
    cover: { shares, classifiedPixels: classified, coveragePct, gsdM: 12.4, tiles: [{ itemId: 'ESA_WorldCover_10m_2021_v200_N30E030', tileUrl: 'https://pc/data/item/tiles/{z}/{x}/{y}.png?colormap=x' }] },
  }
}

beforeEach(() => vi.mocked(fetchWorldCoverClasses).mockReset())

describe('classify_land_cover', () => {
  it('reports the measured dominant class and per-class fractions (cropland, not built-up, for the Nile delta)', async () => {
    vi.mocked(fetchWorldCoverClasses).mockResolvedValue(deltaCover())
    const res = await classifyLandCover(ctx())
    expect(res.summary_data).toMatchObject({ dominant_class: 'Cropland', dominant_pct: 84.8, product_year: 2021, aoi_coverage_pct: 100 })
    const lc = res.summary_data!.land_cover as Array<{ label: string; value: number }>
    expect(lc.map((c) => c.label)).toEqual(['Cropland', 'Built-up', 'Permanent Water', 'Grassland', 'Tree Cover'])
    expect(lc.reduce((a, c) => a + c.value, 0)).toBeCloseTo(100, 0)
    expect(res.summary).toMatch(/\*\*Dominant class:\*\* \*\*Cropland\*\* \(84.8%\)/)
    expect(res.summary).toMatch(/ESA WorldCover 2021/)
    expect(res.summary).not.toMatch(/measured fractions|NDVI mean|OSM/i)
    expect(res.failed).toBeUndefined()
  })

  it('returns a categorical tile layer in the official colours with a legend of the classes that occur', async () => {
    vi.mocked(fetchWorldCoverClasses).mockResolvedValue(deltaCover())
    const layer = (await classifyLandCover(ctx())).layer!
    expect(layer).toMatchObject({ type: 'raster', aoiMask: true, confidence: 'high' })
    expect(layer.tileUrl).toContain('{z}/{x}/{y}')
    expect(layer.raster).toMatchObject({ kind: 'categorical', sensor: 'esa-worldcover', datetime: '2021' })
    const classes = layer.raster!.classes!
    expect(classes.map((c) => c.value)).toEqual([40, 50, 80, 30, 10])
    for (const c of classes) expect(c.color).toBe(WORLDCOVER_LABELS[c.value].color)
    expect(classes[0].label).toBe('Cropland 84.8%')
    expect(layer.provenance).toMatchObject({ date: '2021', clip: 'polygon' })
    expect(layer.provenance!.method).not.toMatch(/NDVI|OSM/)
  })

  it('says when part of the polygon is unclassified, and lowers confidence', async () => {
    vi.mocked(fetchWorldCoverClasses).mockResolvedValue(deltaCover(62))
    const res = await classifyLandCover(ctx())
    expect(res.layer!.confidence).toBe('medium')
    expect(res.summary).toMatch(/Only 62% of the polygon holds a WorldCover class/)
  })

  it('never substitutes a heuristic: an unreadable WorldCover is failed, with no layer and no fractions', async () => {
    vi.mocked(fetchWorldCoverClasses).mockResolvedValue({ ok: false, reason: 'fetch_failed', message: 'titiler could not read the WorldCover class grid (HTTP 429).' })
    const res = await classifyLandCover(ctx())
    expect(res.failed).toBe(true)
    expect(res.layer).toBeUndefined()
    expect(res.layers).toBeUndefined()
    expect(res.summary_data!.land_cover).toBeUndefined()
    expect(res.summary_data!.status).toBe('fetch_failed')
    expect(res.summary).toMatch(/could not be determined[\s\S]*HTTP 429[\s\S]*no substitute/)
  })

  it('no classified pixel (open sea) is "no data", which is not a failure', async () => {
    vi.mocked(fetchWorldCoverClasses).mockResolvedValue({ ok: false, reason: 'no_data', message: 'WorldCover holds no classified pixel inside this polygon.' })
    const res = await classifyLandCover(ctx())
    expect(res.failed).toBeUndefined()
    expect(res.layer).toBeUndefined()
    expect(res.summary_data!.status).toBe('no_data')
  })

  it('a point or line AOI is refused', async () => {
    vi.mocked(fetchWorldCoverClasses).mockResolvedValue({ ok: false, reason: 'no_polygon', message: 'A polygon AOI is required.' })
    expect((await classifyLandCover(ctx())).refused).toBe(true)
  })
})
