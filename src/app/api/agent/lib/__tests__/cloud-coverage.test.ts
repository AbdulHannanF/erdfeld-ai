/**
 * ISS-125 for the Phase 0 tools — a scene must SHOW the polygon, not just be
 * clear over the sliver of it the scene happens to contain.
 *
 * Clear-sky percentages are computed over the pixels a scene RETURNED. A
 * Sentinel-2 tile clipping one corner of the AOI therefore scores "100% clear"
 * while observing 2% of it — measured 2026-08-11 at 5 184 of 262 144 px. Phase
 * 2.5 fixed this for `analyze_raster` and `inspect_imagery` by measuring
 * observed pixels against the polygon's own geodesic area; every Phase 0 tool
 * (`fetch_ndvi`, `compute_spectral_index`, `fetch_thermal`,
 * `classify_land_cover`, `detect_change`, `detect_deforestation`) still gated
 * on clarity alone and would happily report the sliver's mean as the AOI's.
 *
 * These tests pin the gate at the one place all of them go through:
 * `pickClearestScene` / `pickClearestLandsatScene`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PixelGrid } from '../pixels'

vi.mock('../pixels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pixels')>()
  return { ...actual, fetchFeatureGrid: vi.fn(), fetchCogFeatureGrid: vi.fn() }
})

import { fetchFeatureGrid, fetchCogFeatureGrid } from '../pixels'
import {
  gridCoveragePct,
  MIN_AOI_COVERAGE_PCT,
  pickClearestScene,
  pickClearestLandsatScene,
  sceneClarity,
  SCL,
} from '../cloud'

/** 0.1° square on the equator — ~123 km², so a 100×100 grid over its own bbox
 *  is ~111 m/px and 10 000 observed pixels is exactly full coverage. */
const AOI = {
  type: 'Polygon',
  coordinates: [[[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1], [0, 0]]],
}

const CLEAR_CLASS = SCL.VEGETATION
const CLOUD_CLASS = SCL.CLOUD_HIGH_PROB

/** Landsat C2 QA_PIXEL: bit6 clear, bit3 cloud (see LANDSAT_QA). */
const QA_CLEAR = 1 << 6
const QA_CLOUD = (1 << 3) | (1 << 6)

/**
 * A 100×100 grid in which `observed` pixels are inside the polygon and the
 * first `clear` of those are clear. Everything else is outside (mask 0), which
 * is exactly how a scene clipping the AOI comes back.
 */
function grid(observed: number, clear: number, clearValue: number, cloudValue: number): PixelGrid {
  const n = 100 * 100
  const values = new Float64Array(n)
  const mask = new Float64Array(n)
  for (let i = 0; i < observed; i++) {
    mask[i] = 255
    values[i] = i < clear ? clearValue : cloudValue
  }
  return { values, mask, width: 100, height: 100, bands: 2, raw: values }
}

function s2Item(id: string, date: string) {
  return {
    id,
    collection: 'sentinel-2-l2a',
    assets: { scl: { href: `https://example.invalid/${id}/SCL.tif` } },
    links: [{ rel: 'self', href: `https://example.invalid/items/${id}` }],
    properties: { datetime: `${date}T10:00:00Z`, 'eo:cloud_cover': 5 },
  }
}

function landsatItem(id: string, date: string) {
  return {
    id,
    assets: { qa_pixel: { href: `https://example.invalid/${id}/QA_PIXEL.TIF` } },
    properties: { datetime: `${date}T10:00:00Z`, 'eo:cloud_cover': 5 },
  }
}

/** Route each mocked fetch to the grid registered for that scene id. */
function serveGrids(byId: Record<string, PixelGrid>) {
  vi.mocked(fetchFeatureGrid).mockImplementation(async (req: any) => {
    const id = Object.keys(byId).find((k) => String(req.itemHref).includes(k))
    if (!id) throw new Error(`no grid registered for ${req.itemHref}`)
    return byId[id]
  })
  vi.mocked(fetchCogFeatureGrid).mockImplementation(async (req: any) => {
    const id = Object.keys(byId).find((k) => String(req.cogUrl).includes(k))
    if (!id) throw new Error(`no grid registered for ${req.cogUrl}`)
    return byId[id]
  })
}

beforeEach(() => {
  vi.mocked(fetchFeatureGrid).mockReset()
  vi.mocked(fetchCogFeatureGrid).mockReset()
})

describe('gridCoveragePct — observed pixels against the polygon it claims to describe', () => {
  it('reads ~100% when the grid fills the polygon', () => {
    expect(gridCoveragePct(AOI, 10_000, 100, 100)).toBeGreaterThan(95)
  })

  it('reads ~2% for the sliver that surfaced ISS-125', () => {
    const pct = gridCoveragePct(AOI, 200, 100, 100)
    expect(pct).toBeGreaterThan(1)
    expect(pct).toBeLessThan(5)
  })

  it('never exceeds 100% despite boundary discretisation', () => {
    expect(gridCoveragePct(AOI, 20_000, 100, 100)).toBe(100)
  })

  it('returns 0 rather than a guess for an unusable geometry', () => {
    expect(gridCoveragePct(null, 10_000, 100, 100)).toBe(0)
    expect(gridCoveragePct(AOI, 10_000, 0, 0)).toBe(0)
  })
})

describe('sceneClarity measures coverage, not just clarity', () => {
  it('reports the share of the polygon the scene actually observed', async () => {
    serveGrids({ sliver: grid(200, 200, CLEAR_CLASS, CLOUD_CLASS) })
    const c = await sceneClarity(s2Item('sliver', '2026-08-10'), AOI)
    expect(c).not.toBeNull()
    // 100% clear — over 2% of the AOI. Both numbers are true; only one is the answer.
    expect(c!.clearPct).toBe(100)
    expect(c!.coveragePct).not.toBeNull()
    expect(c!.coveragePct!).toBeLessThan(5)
  })
})

describe('GATE: pickClearestScene refuses a clear sliver in favour of a scene that sees the AOI', () => {
  it('does not pick a 100%-clear scene covering 2% over an 85%-clear scene covering all of it', async () => {
    serveGrids({
      sliver: grid(200, 200, CLEAR_CLASS, CLOUD_CLASS),      // 100% clear,  2% coverage
      full: grid(10_000, 8_500, CLEAR_CLASS, CLOUD_CLASS),   //  85% clear, 100% coverage
    })
    const choice = await pickClearestScene(
      [s2Item('sliver', '2026-08-14'), s2Item('full', '2026-08-09')],
      AOI,
    )
    expect(choice).not.toBeNull()
    expect(choice!.item.id).toBe('full')
    expect(choice!.clarity.coveragePct!).toBeGreaterThan(MIN_AOI_COVERAGE_PCT)
  })

  it('returns null when every clear candidate is a sliver — and says so per scene', async () => {
    serveGrids({
      slivera: grid(200, 200, CLEAR_CLASS, CLOUD_CLASS),
      sliverb: grid(300, 300, CLEAR_CLASS, CLOUD_CLASS),
    })
    const choice = await pickClearestScene(
      [s2Item('slivera', '2026-08-14'), s2Item('sliverb', '2026-08-09')],
      AOI,
    )
    expect(choice).toBeNull()
  })

  it('still refuses a scene that is both clouded and clipping', async () => {
    serveGrids({ bad: grid(200, 10, CLEAR_CLASS, CLOUD_CLASS) })
    expect(await pickClearestScene([s2Item('bad', '2026-08-14')], AOI)).toBeNull()
  })

  it('an explicit minCoveragePct of 0 opts out, for callers that want any scene', async () => {
    serveGrids({ sliver: grid(200, 200, CLEAR_CLASS, CLOUD_CLASS) })
    const choice = await pickClearestScene([s2Item('sliver', '2026-08-14')], AOI, {
      minCoveragePct: 0,
    })
    expect(choice).not.toBeNull()
    expect(choice!.item.id).toBe('sliver')
  })
})

describe('the same gate on the Landsat thermal path', () => {
  it('prefers the scene that observes the AOI', async () => {
    serveGrids({
      lsliver: grid(200, 200, QA_CLEAR, QA_CLOUD),
      lsfull: grid(10_000, 8_500, QA_CLEAR, QA_CLOUD),
    })
    const sign = async (h: string) => h
    const choice = await pickClearestLandsatScene(
      [landsatItem('lsliver', '2026-08-14'), landsatItem('lsfull', '2026-08-09')],
      AOI,
      sign,
    )
    expect(choice).not.toBeNull()
    expect(choice!.item.id).toBe('lsfull')
  })

  it('returns null when the only clear Landsat scene is a sliver', async () => {
    serveGrids({ lsliver: grid(200, 200, QA_CLEAR, QA_CLOUD) })
    const sign = async (h: string) => h
    expect(
      await pickClearestLandsatScene([landsatItem('lsliver', '2026-08-14')], AOI, sign),
    ).toBeNull()
  })
})

describe('the refusal names coverage, so a user can tell it from cloud', () => {
  it('carries per-scene coverage in `examined`', async () => {
    serveGrids({
      slivera: grid(200, 200, CLEAR_CLASS, CLOUD_CLASS),
      sliverb: grid(300, 300, CLEAR_CLASS, CLOUD_CLASS),
    })
    // The picker returns null, so coverage has to reach the caller another way:
    // `examinedScenes` scores without gating, for the refusal message.
    const { examinedScenes } = await import('../cloud')
    const rows = await examinedScenes(
      [s2Item('slivera', '2026-08-14'), s2Item('sliverb', '2026-08-09')],
      AOI,
    )
    expect(rows).toHaveLength(2)
    expect(rows[0].aoiClearPct).toBe(100)
    expect(rows[0].aoiCoveragePct).toBeLessThan(5)
  })
})
