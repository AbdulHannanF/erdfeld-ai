/**
 * Unit tests for the RENDER-004 fix — titiler server-side polygon cutline helpers.
 *
 * Mocks global fetch to assert the request shape (POST /feature.png + GeoJSON body +
 * positional expression) and the base64 round-trip, plus the honest null-degrade paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildStacIndexClipPng, buildNdviClipPng, fetchCogClipPng } from '../titiler'
import { _resetCache } from '../cache'

const POLY = {
  type: 'Polygon',
  coordinates: [[[36.80, -1.30], [36.82, -1.30], [36.82, -1.28], [36.80, -1.28], [36.80, -1.30]]],
}

/** A Sentinel-2 STAC item with a self link + band assets. */
function s2Item() {
  return {
    links: [{ rel: 'self', href: 'https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/S2X' }],
    assets: {
      nir: { href: 'http://cog/nir.tif' },
      red: { href: 'http://cog/red.tif' },
      green: { href: 'http://cog/green.tif' },
      blue: { href: 'http://cog/blue.tif' },
      swir16: { href: 'http://cog/swir16.tif' },
      swir22: { href: 'http://cog/swir22.tif' },
    },
  }
}

/** Minimal valid-looking PNG buffer (> 200 bytes so the size guard passes). */
function fakePngBytes(): ArrayBuffer {
  const u = new Uint8Array(512)
  u[0] = 0x89; u[1] = 0x50; u[2] = 0x4e; u[3] = 0x47  // PNG signature
  return u.buffer
}

beforeEach(() => {
  _resetCache()
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('buildStacIndexClipPng (RENDER-004 STAC cutline)', () => {
  it('POSTs the polygon to /stac/feature.png with positional expression + assets, returns base64', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200,
      arrayBuffer: async () => fakePngBytes(),
      headers: { get: () => null },
    } as any)

    const b64 = await buildStacIndexClipPng(s2Item(), 'NDVI', POLY)
    expect(typeof b64).toBe('string')
    expect(b64!.length).toBeGreaterThan(0)

    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/stac/feature.png')
    expect(String(url)).toContain('expression=')
    expect(decodeURIComponent(String(url))).toContain('(b1-b2)/(b1+b2)')  // positional, not asset names
    expect(String(url)).toContain('assets=nir')
    expect(String(url)).toContain('assets=red')
    expect(init!.method).toBe('POST')
    const body = JSON.parse(init!.body as string)
    expect(body.type).toBe('Feature')
    expect(body.geometry.type).toBe('Polygon')
  })

  it('NDWI uses green+nir bands', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => fakePngBytes(), headers: { get: () => null } } as any)
    await buildStacIndexClipPng(s2Item(), 'NDWI', POLY)
    const url = String(vi.mocked(fetch).mock.calls[0][0])
    expect(url).toContain('assets=green')
    expect(url).toContain('assets=nir')
  })

  it('EVI sends nir, red and blue, reflectance-scaled (its +1 is a reflectance constant)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => fakePngBytes(), headers: { get: () => null } } as any)
    await buildStacIndexClipPng(s2Item(), 'EVI', POLY)
    const u = new URL(String(vi.mocked(fetch).mock.calls[0][0]))
    expect(u.searchParams.getAll('assets')).toEqual(['nir', 'red', 'blue'])
    const expr = u.searchParams.get('expression')!
    expect(expr).toContain('2.5*((b1*0.0001')
    expect(expr).toMatch(/7\.5\*\(b3\*0\.0001/)
    expect(expr).toMatch(/\+1\)$/)
  })

  it('buildNdviClipPng is the NDVI convenience wrapper', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => fakePngBytes(), headers: { get: () => null } } as any)
    const b64 = await buildNdviClipPng(s2Item(), POLY)
    expect(typeof b64).toBe('string')
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('colormap_name=rdylgn')
  })

  it('returns null (no fabrication) on titiler HTTP error → caller falls back to XYZ tiles', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } } as any)
    expect(await buildStacIndexClipPng(s2Item(), 'NDVI', POLY)).toBeNull()
  })

  it('returns null for an unknown index', async () => {
    expect(await buildStacIndexClipPng(s2Item(), 'BOGUS', POLY)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns null for non-polygon geometry', async () => {
    expect(await buildStacIndexClipPng(s2Item(), 'NDVI', { type: 'Point', coordinates: [1, 2] })).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns null when a required band asset is missing', async () => {
    const noNir = { links: [{ rel: 'self', href: 'http://x' }], assets: { red: { href: 'http://cog/red.tif' } } }
    expect(await buildStacIndexClipPng(noNir, 'NDVI', POLY)).toBeNull()
  })

  it('rejects a tiny/empty image body (treats as failure → null)', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(10), headers: { get: () => null } } as any)
    expect(await buildStacIndexClipPng(s2Item(), 'NDVI', POLY)).toBeNull()
  })
})

describe('fetchCogClipPng (RENDER-004 single-COG cutline)', () => {
  it('POSTs the polygon to /cog/feature.png with rescale/colormap/nodata', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => fakePngBytes(), headers: { get: () => null } } as any)
    const b64 = await fetchCogClipPng('http://cog/occ.tif', { rescale: '0,100', colormap: 'blues', nodata: '255' }, POLY)
    expect(typeof b64).toBe('string')
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/cog/feature.png')
    expect(String(url)).toContain('rescale=0%2C100')
    expect(String(url)).toContain('colormap_name=blues')
    expect(String(url)).toContain('nodata=255')
    expect(init!.method).toBe('POST')
  })

  it('returns null on error (caller keeps XYZ tile fallback)', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 422, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } } as any)
    expect(await fetchCogClipPng('http://cog/x.tif', { rescale: '0,100' }, POLY)).toBeNull()
  })

  it('returns null for non-polygon geometry (no request)', async () => {
    expect(await fetchCogClipPng('http://cog/x.tif', {}, null)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
})
