/**
 * Unit tests for the polygon-clipped statistics path.
 *
 * Covers:
 *  - fetchCogPolygonStats: POST feature body, extraParams (nodata), geometry input
 *    forms (raw / Feature / AOI-with-geometry), count surfaced, null on failure.
 *  - fetchCogBandStats: ISS-102 — a bbox must be sent as a rectangle CUTLINE, never
 *    as `?bbox=`, which titiler ignores in favour of whole-COG statistics.
 *
 * `getSpectralIndexMeanFromScene` / `getNDVIMeanFromScene` were deleted in Phase 0
 * (index-of-the-means + bbox fallback); their replacement `maskedIndexStats` is
 * covered by index-stats tests and the live cloud suite.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchCogPolygonStats,
  fetchCogBandStats,
} from '../titiler'
import { _resetCache } from '../cache'

const POLY = {
  type: 'Polygon',
  coordinates: [[[36.80, -1.30], [36.82, -1.30], [36.82, -1.28], [36.80, -1.28], [36.80, -1.30]]],
}
const BBOX = [36.80, -1.30, 36.82, -1.28]

beforeEach(() => {
  _resetCache()
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// fetchCogPolygonStats
// ---------------------------------------------------------------------------

describe('fetchCogPolygonStats (HONESTY-001 polygon clip)', () => {
  it('POSTs a GeoJSON Feature and returns the b1 stats (with count)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ b1: { mean: 42.5, min: 0, max: 100, count: 123 } }),
    } as any)

    const stats = await fetchCogPolygonStats('http://cog/occurrence.tif', POLY)
    expect(stats?.mean).toBe(42.5)
    expect(stats?.count).toBe(123)

    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(init!.method).toBe('POST')
    const body = JSON.parse(init!.body as string)
    expect(body.type).toBe('Feature')
    expect(body.geometry.type).toBe('Polygon')
    expect(String(url)).toContain('/cog/statistics')
  })

  it('appends extraParams (e.g. nodata) to the query string', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ b1: { mean: 10 } }),
    } as any)

    await fetchCogPolygonStats('http://cog/x.tif', POLY, { nodata: '255' })
    const url = String(vi.mocked(fetch).mock.calls[0][0])
    expect(url).toContain('nodata=255')
  })

  it('accepts a Feature wrapping the geometry', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ b1: { mean: 5 } }),
    } as any)
    const feature = { type: 'Feature', properties: {}, geometry: POLY }
    const stats = await fetchCogPolygonStats('http://cog/x.tif', feature)
    expect(stats?.mean).toBe(5)
  })

  it('accepts an AOI object holding .geometry', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ b1: { mean: 7 } }),
    } as any)
    const aoiObj = { geometry: POLY }
    const stats = await fetchCogPolygonStats('http://cog/x.tif', aoiObj)
    expect(stats?.mean).toBe(7)
  })

  it('returns null for non-polygon geometry (no fabrication)', async () => {
    const point = { type: 'Point', coordinates: [36.8, -1.29] }
    const stats = await fetchCogPolygonStats('http://cog/x.tif', point)
    expect(stats).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns null on a titiler HTTP error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as any)
    const stats = await fetchCogPolygonStats('http://cog/x.tif', POLY)
    expect(stats).toBeNull()
  })

  it('reads stats from properties.statistics.b1 shape too', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ properties: { statistics: { b1: { mean: 33 } } } }),
    } as any)
    const stats = await fetchCogPolygonStats('http://cog/x.tif', POLY)
    expect(stats?.mean).toBe(33)
  })
})

// ---------------------------------------------------------------------------
// fetchCogBandStats (bbox) — ISS-102
//
// titiler's GET /cog/statistics IGNORES `bbox` and returns whole-COG statistics
// (verified live 2026-08-10 against titiler.xyz: identical mean 2678.755 and
// identical count 1 048 576 for the AOI bbox and for a bbox 400 km away). This
// function must therefore POST a bbox-DERIVED POLYGON, never send `bbox=`.
// ---------------------------------------------------------------------------

describe('fetchCogBandStats (bbox rectangle) — ISS-102 polygon POST', () => {
  it('appends extraParams and returns count', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ b1: { mean: 80, count: 456 } }),
    } as any)
    const stats = await fetchCogBandStats('http://cog/x.tif', BBOX, { nodata: '255' })
    expect(stats?.mean).toBe(80)
    expect(stats?.count).toBe(456)
    const url = String(vi.mocked(fetch).mock.calls[0][0])
    expect(url).toContain('nodata=255')
  })

  it('POSTs a bbox-derived rectangle polygon and never sends bbox= (ISS-102)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ properties: { statistics: { b1: { mean: 12, count: 9 } } } }),
    } as any)

    const stats = await fetchCogBandStats('http://cog/x.tif', BBOX)
    expect(stats?.mean).toBe(12)

    const [url, init] = vi.mocked(fetch).mock.calls[0]
    // The GET-with-bbox path returns whole-COG stats — it must be gone entirely.
    expect(String(url)).not.toContain('bbox=')
    expect(init!.method).toBe('POST')

    const body = JSON.parse(init!.body as string)
    expect(body.type).toBe('Feature')
    expect(body.geometry.type).toBe('Polygon')
    // A closed rectangle covering exactly the requested bbox.
    const ring = body.geometry.coordinates[0]
    expect(ring).toHaveLength(5)
    expect(ring[0]).toEqual([BBOX[0], BBOX[1]])
    expect(ring[4]).toEqual(ring[0])
    const lngs = ring.map((c: number[]) => c[0])
    const lats = ring.map((c: number[]) => c[1])
    expect(Math.min(...lngs)).toBe(BBOX[0])
    expect(Math.min(...lats)).toBe(BBOX[1])
    expect(Math.max(...lngs)).toBe(BBOX[2])
    expect(Math.max(...lats)).toBe(BBOX[3])
  })

  it('returns null for a malformed bbox rather than a whole-scene number', async () => {
    expect(await fetchCogBandStats('http://cog/x.tif', [1, 2, 3])).toBeNull()
    expect(await fetchCogBandStats('http://cog/x.tif', [])).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
})
