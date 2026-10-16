/** Every raster layer carries a legend: change and deforestation (the "after" NDVI tile) and the
 *  WorldCover layer of classify_vegetation describe their colours with a raster descriptor, the same
 *  shape every other raster layer uses. They are also hidden outside the polygon, like the index layers. */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/stac', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stac')>()
  return { ...actual, searchPlanetaryComputer: vi.fn() }
})
vi.mock('../../lib/cloud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/cloud')>()
  return { ...actual, pickClearestScene: vi.fn() }
})
vi.mock('../../lib/index-stats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/index-stats')>()
  return { ...actual, maskedIndexStats: vi.fn() }
})
vi.mock('../../lib/worldcover', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/worldcover')>()
  return { ...actual, fetchWorldCoverData: vi.fn() }
})

import { readTileStyle } from '@/lib/raster-style'
import { pickClearestScene } from '../../lib/cloud'
import { maskedIndexStats } from '../../lib/index-stats'
import { searchPlanetaryComputer } from '../../lib/stac'
import { classSharesFromCounts, fetchWorldCoverData } from '../../lib/worldcover'
import { detectChange, detectDeforestation } from '../derived'
import { classifyVegetation } from '../inference'

const scene = (id: string, date: string) => ({
  id, bbox: [10, 10, 10.2, 10.2],
  properties: { datetime: `${date}T08:00:00Z`, 'eo:cloud_cover': 5 },
  links: [{ rel: 'self', href: `https://earth-search/items/${id}` }],
  assets: { nir: { href: 'n' }, red: { href: 'r' } },
})
const BEFORE = scene('S2_BEFORE', '2025-03-01')
const AFTER = scene('S2_AFTER', '2026-08-20')
const clarity: any = { kind: 'scl', clearPct: 95, cloudPct: 5, snowPct: 0, waterPct: 0, totalPx: 100, clearPx: 95, coveragePct: 100, breakdown: [{ label: 'Vegetation', pct: 90 }], grid: {} }
const stats = (mean: number) => ({ ok: true as const, stats: { mean, median: mean, std: 0.1, min: 0, max: 1, count: 100, insidePolygon: 100, index: 'NDVI', sceneId: 'x', sceneDate: '2026-08-20', sceneCloudPct: 5, clearPct: 95, clip: 'polygon' as const, clarity, reflectanceNote: '', p2: 0.1, p98: 0.8 } })

const AOI = { type: 'Polygon', coordinates: [[[10, 10], [10.2, 10], [10.2, 10.2], [10, 10.2], [10, 10]]] }
const ctx = (): any => ({ aoi: AOI, bbox: [10, 10, 10.2, 10.2], centroid: { lat: 10.1, lng: 10.1 }, areaKm2: 480, emit: vi.fn(), runTool: vi.fn() })

beforeEach(() => {
  vi.mocked(searchPlanetaryComputer).mockReset().mockImplementation(async (_b, _c, _cc, start) => ({ features: [String(start) < '2026' ? BEFORE : AFTER] }))
  vi.mocked(pickClearestScene).mockReset().mockImplementation(async (items) => ({ item: items[0], clarity, examined: [], rejected: [] }))
  vi.mocked(maskedIndexStats).mockReset().mockImplementation(async (item: any) => stats(item.id === 'S2_BEFORE' ? 0.7 : 0.35))
})

const ndviLegend = { kind: 'continuous', index: 'NDVI', units: 'NDVI', colormap: 'rdylgn', stretch: 'fixed', rescale: [[-1, 1]], bands: ['B08', 'B04'] }

describe('legends on the layers that had none', () => {
  it('detect_change: the "after" NDVI tile has an NDVI legend that matches its tile URL, and an AOI mask', async () => {
    const res = await detectChange(ctx(), {})
    const layer = res.layer!
    expect(layer.raster).toMatchObject({ ...ndviLegend, sceneId: 'S2_AFTER', datetime: '2026-08-20' })
    expect(layer.aoiMask).toBe(true)
    // the legend says what the URL does: same colormap and range
    expect(readTileStyle(layer.tileUrl!)).toEqual({ colormap: 'rdylgn', rescale: [[-1, 1]] })
  })

  it('detect_deforestation: the same', async () => {
    const res = await detectDeforestation(ctx(), {})
    const layer = res.layer!
    expect(layer.raster).toMatchObject({ ...ndviLegend, sceneId: 'S2_AFTER' })
    expect(layer.aoiMask).toBe(true)
    expect(readTileStyle(layer.tileUrl!)).toEqual({ colormap: 'rdylgn', rescale: [[-1, 1]] })
  })

  it('classify_vegetation: a categorical WorldCover legend of the classes found, with the official colours', async () => {
    const { shares } = classSharesFromCounts(new Map([[40, 848], [50, 89], [80, 40]]))
    vi.mocked(fetchWorldCoverData).mockResolvedValue({
      stats: { builtUpPct: 9, treeCoverPct: 0, croplandPct: 85, grasslandPct: 0, waterPct: 4, dominantClass: 'Cropland', totalPixels: 977, classes: shares, year: 2021 },
      tileUrl: 'https://titiler/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=x', unsignedHref: 'u', clip: 'polygon',
    })
    const res = await classifyVegetation(ctx(), {})
    const layer = res.layer!
    expect(layer.aoiMask).toBe(true)
    expect(layer.raster).toMatchObject({ kind: 'categorical', sensor: 'esa-worldcover', datetime: '2021' })
    expect(layer.raster!.classes!.map((c) => c.label)).toEqual([`Cropland ${shares[0].pct}%`, `Built-up ${shares[1].pct}%`, `Permanent Water ${shares[2].pct}%`])
    expect(layer.raster!.classes![0].color).toBe('#f096ff')
  })
})
