/**
 * DEFECT 4 (2026-08-17) — `fetch_dem` credited two different elevation
 * sources in one answer: the human summary said the statistics came from
 * "SRTM 90m via opentopodata.org" while the SAME layer's `provenance.source`
 * said "Copernicus DEM 30m (PC STAC) + titiler · stats from opentopodata.org"
 * — a string that opens by naming the 30 m tile dataset and never names the
 * dataset (or resolution) actually behind the statistics at all. Both are
 * real sources (real per-pixel Copernicus DEM 30 m tiles for the map layer;
 * the coarser OPEN_ELEVATION_ENDPOINT-configured grid for the numbers), but
 * a citation pointing at a statistic would read as if it came from Copernicus.
 *
 * These tests mock every network dependency of `fetchDem` (opentopodata via
 * `lib/cache`, Planetary Computer STAC + signing, titiler tile URLs) so the
 * "real Copernicus tiles" branch runs deterministically, then assert the
 * summary and the layer's `provenance.source` each name ONE dataset per
 * measurement rather than blending two into one string.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 100-point (10x10) opentopodata-shaped response — matches the grid `getDemGrid`
// builds internally. Values vary so min/max/mean/relief are non-degenerate.
const ELEVATION_RESULTS = Array.from({ length: 100 }, (_, i) => ({
  elevation: 500 + (i % 10) * 8 + Math.floor(i / 10) * 3,
}))

vi.mock('../../lib/cache', () => ({
  cachedFetchJson: vi.fn(async () => ({ results: ELEVATION_RESULTS })),
  fetchWithRetry: vi.fn(async () => {
    throw new Error('fetchWithRetry should not be reached — cachedFetchJson is mocked directly')
  }),
}))

vi.mock('../../lib/stac', () => ({
  // Two 1-degree DEM tiles meet at lng 74.32, inside the test AOI.
  searchPCStac: vi.fn(async () => ({
    features: [
      { id: 'tile-west', bbox: [74, 31, 74.32, 32], assets: { data: { href: 'https://fake-pc/cop-dem-glo-30/west.tif' } } },
      { id: 'tile-east', bbox: [74.32, 31, 75, 32], assets: { data: { href: 'https://fake-pc/cop-dem-glo-30/east.tif' } } },
    ],
  })),
  signPCAsset: vi.fn(async (href: string) => `${href}?sig=fake-token`),
}))

vi.mock('../../lib/titiler', () => ({
  buildDemCogTileUrl: vi.fn(() => 'https://fake-titiler/color/{z}/{x}/{y}.png'),
  buildDemHillshadeTileUrl: vi.fn(() => 'https://fake-titiler/hillshade/{z}/{x}/{y}.png'),
  // Simulate a successful tile-availability check by returning the template unchanged.
  verifyTileUrl: vi.fn(async (template: string | null) => template),
}))

vi.mock('../../lib/pixels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pixels')>()
  return { ...actual, fetchCogFeatureGrid: vi.fn() }
})

import { fetchCogFeatureGrid } from '../../lib/pixels'
import type { ToolCtx } from '../../lib/types'

const W = 20
const H = 10
/** A 20 x 10 DEM read: the west tile has data in the left half, the east tile in the right half, the summit is in the east. */
function demRead(href: string) {
  const east = /east/.test(href)
  const values = new Float64Array(W * H)
  const mask = new Float64Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const mine = east ? x >= W / 2 : x < W / 2
      mask[y * W + x] = mine ? 255 : 0
      values[y * W + x] = mine ? 1000 + x * 10 + y : -32768
    }
  }
  if (east) values[3 * W + 15] = 4478 // the summit, one pixel
  return { values, mask, width: W, height: H, bands: 2, raw: values }
}

const BBOX: [number, number, number, number] = [74.30, 31.51, 74.34, 31.53]
const AOI = {
  type: 'Polygon',
  coordinates: [[
    [BBOX[0] - 0.01, BBOX[1] - 0.01],
    [BBOX[2] + 0.01, BBOX[1] - 0.01],
    [BBOX[2] + 0.01, BBOX[3] + 0.01],
    [BBOX[0] - 0.01, BBOX[3] + 0.01],
    [BBOX[0] - 0.01, BBOX[1] - 0.01],
  ]],
}

function makeCtx(): ToolCtx {
  return {
    aoi: AOI,
    bbox: BBOX,
    centroid: { lat: (BBOX[1] + BBOX[3]) / 2, lng: (BBOX[0] + BBOX[2]) / 2 },
    areaKm2: 12.3,
    runTool: async () => ({ summary: '' }),
  }
}

const ORIGINAL_ENDPOINT = process.env.OPEN_ELEVATION_ENDPOINT
const ORIGINAL_GEE_PREFERRED = process.env.GEE_PREFERRED

afterEach(() => {
  if (ORIGINAL_ENDPOINT === undefined) delete process.env.OPEN_ELEVATION_ENDPOINT
  else process.env.OPEN_ELEVATION_ENDPOINT = ORIGINAL_ENDPOINT
  if (ORIGINAL_GEE_PREFERRED === undefined) delete process.env.GEE_PREFERRED
  else process.env.GEE_PREFERRED = ORIGINAL_GEE_PREFERRED
})

describe('DEM_DATASET_LABEL tracks the configured endpoint (ISS-109)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('labels srtm90m correctly — the exact .env this repo currently ships', async () => {
    process.env.OPEN_ELEVATION_ENDPOINT = 'https://api.opentopodata.org/v1/srtm90m'
    const { DEM_DATASET_LABEL } = await import('../terrain')
    expect(DEM_DATASET_LABEL).toBe('SRTM 90m')
  })

  it('labels mapzen correctly — the .env.example default', async () => {
    process.env.OPEN_ELEVATION_ENDPOINT = 'https://api.opentopodata.org/v1/mapzen'
    const { DEM_DATASET_LABEL } = await import('../terrain')
    expect(DEM_DATASET_LABEL).toBe('Mapzen ~30m (global merged)')
  })
})

describe('fetch_dem takes area statistics from the DEM raster, never from point samples', () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env.GEE_PREFERRED // force the PC + titiler tile path, not GEE
    process.env.OPEN_ELEVATION_ENDPOINT = 'https://api.opentopodata.org/v1/srtm90m'
    vi.mocked(fetchCogFeatureGrid).mockReset()
    vi.mocked(fetchCogFeatureGrid).mockImplementation(async (req: any) => demRead(String(req.cogUrl)))
  })

  it('reports the highest pixel of the raster, merged across the tile edge, with its source', async () => {
    const { fetchDem } = await import('../terrain')
    const result = await fetchDem(makeCtx())
    const sd = result.summary_data!
    // The 100 point samples top out at 500 + 72 + 27 = 599 m; the raster has a 4478 m pixel the points cannot see.
    expect(sd.max_elevation_m).toBe(4478)
    expect(sd.min_elevation_m).toBe(1000)
    expect(sd.dem_pixels).toBe(W * H) // the two tiles' valid halves add up to the whole grid
    expect(String(sd.elevation_stats_source)).toMatch(/Copernicus DEM GLO-30 raster/)
    expect(result.summary).toMatch(/Highest pixel: \*\*4478 m\*\*/)
    expect(result.summary).not.toMatch(/SAMPLED at/)
    expect(sd.sampled_highest_elevation_m).toBeUndefined()
  })

  it('draws one colour and one hillshade layer per DEM tile, each bounded to its own tile (no hole at the edge)', async () => {
    const { fetchDem } = await import('../terrain')
    const result = await fetchDem(makeCtx())
    const layers = [result.layer!, ...(result.layers ?? [])]
    const colour = layers.filter((l) => /^dem-active/.test(l.id))
    const shade = layers.filter((l) => /^dem-hillshade-active/.test(l.id))
    expect(colour).toHaveLength(2)
    expect(shade).toHaveLength(2)
    const edges = colour.map((l) => l.bounds as number[]).sort((a, b) => a[0] - b[0])
    expect(edges[0][2]).toBeCloseTo(74.32) // the west layer stops at the tile edge ...
    expect(edges[1][0]).toBeCloseTo(74.32) // ... where the east layer starts
    expect(edges[0][0]).toBeCloseTo(BBOX[0])
    expect(edges[1][2]).toBeCloseTo(BBOX[2])
  })

  it('without the raster, the point grid is labelled as sampled and is never called the maximum', async () => {
    vi.mocked(fetchCogFeatureGrid).mockRejectedValue(new Error('titiler cog/feature.npy HTTP 503'))
    const { fetchDem } = await import('../terrain')
    const result = await fetchDem(makeCtx())
    const sd = result.summary_data!
    expect(sd.max_elevation_m).toBeUndefined()
    expect(sd.min_elevation_m).toBeUndefined()
    expect(sd.sampled_highest_elevation_m).toBe(599)
    expect(sd.sampled_points).toBe(100)
    expect(result.summary).toMatch(/SAMPLED at 100 points/)
    expect(result.summary).toMatch(/not the area's minimum or maximum/)
    expect(result.summary).not.toMatch(/Highest pixel/)
  })
})
