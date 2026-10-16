/**
 * Q-15 — fetch_dem no longer probes the tile URL (a blocking 1.7 s HEAD, 45% of the call), and
 * its imagery lookup (STAC + SAS signing) overlaps the elevation call instead of following it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const ELEVATION_RESULTS = Array.from({ length: 100 }, (_, i) => ({ elevation: 500 + (i % 10) * 8 + Math.floor(i / 10) * 3 }))
const order: string[] = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

vi.mock('../../lib/cache', () => ({
  cachedFetchJson: vi.fn(async () => {
    order.push('elevation:start')
    await sleep(60)
    order.push('elevation:end')
    return { results: ELEVATION_RESULTS }
  }),
  fetchWithRetry: vi.fn(),
}))
vi.mock('../../lib/stac', () => ({
  searchPCStac: vi.fn(async () => {
    order.push('stac:start')
    await sleep(20)
    return { features: [{ id: 'cop-tile', bbox: [70, 30, 80, 40], assets: { data: { href: 'https://fake-pc/cop.tif' } } }] }
  }),
  signPCAsset: vi.fn(async (href: string) => { order.push('sign'); return `${href}?sig=x` }),
}))
vi.mock('../../lib/titiler', () => ({
  buildDemCogTileUrl: vi.fn((href: string) => `https://fake-titiler/color/{z}/{x}/{y}.png?url=${encodeURIComponent(href)}`),
  buildDemHillshadeTileUrl: vi.fn(() => 'https://fake-titiler/hillshade/{z}/{x}/{y}.png'),
}))

import type { ToolCtx } from '../../lib/types'
import { fetchDem } from '../terrain'

const BBOX: [number, number, number, number] = [74.30, 31.51, 74.34, 31.53]
const AOI = { type: 'Polygon', coordinates: [[[74.29, 31.5], [74.35, 31.5], [74.35, 31.54], [74.29, 31.54], [74.29, 31.5]]] }
const ctx: ToolCtx = { aoi: AOI, bbox: BBOX, centroid: { lat: 31.52, lng: 74.32 }, areaKm2: 12, runTool: async () => ({ summary: '' }) }

const netFetch = vi.fn()
beforeEach(() => {
  order.length = 0
  netFetch.mockReset().mockRejectedValue(new Error('no direct network call expected'))
  vi.stubGlobal('fetch', netFetch)
})

describe('fetch_dem', () => {
  it('returns the tile URLs without fetching a probe tile', async () => {
    const out = await fetchDem(ctx)
    expect(netFetch).not.toHaveBeenCalled()
    expect(out.layer?.tileUrl).toContain('fake-titiler/color')
    expect(out.layers?.[0]?.tileUrl).toContain('hillshade')
  })

  it('starts the imagery lookup while the elevation call is still running', async () => {
    // A bbox the first test did not use: the elevation grid is cached per bbox.
    await fetchDem({ ...ctx, bbox: [75.30, 32.51, 75.34, 32.53] })
    expect(order.indexOf('stac:start')).toBeLessThan(order.indexOf('elevation:end'))
    expect(order.indexOf('sign')).toBeGreaterThan(-1)
  })
})
