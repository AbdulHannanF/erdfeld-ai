/** `find_dataset` end to end: registry first, live STAC only as the fallback. */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const gather = vi.hoisted(() => vi.fn())
vi.mock('../../discovery/catalogs', async (orig) => ({ ...(await orig<typeof import('../../discovery/catalogs')>()), gatherCandidates: gather }))

import { executeTool } from '../../../tools'
import { getRegistryIndex } from '..'

const LAHORE = { type: 'Polygon', coordinates: [[[74.30, 31.51], [74.34, 31.51], [74.34, 31.53], [74.30, 31.53], [74.30, 31.51]]] }
const CALIFORNIA = { type: 'Polygon', coordinates: [[[-117.2, 33.5], [-116.8, 33.5], [-116.8, 33.9], [-117.2, 33.9], [-117.2, 33.5]]] }

// Loading the 8 MB snapshot through vite's JSON transform is a one-time multi-second cost in tests.
beforeAll(async () => { await getRegistryIndex() }, 120_000)

beforeEach(() => {
  gather.mockReset()
  gather.mockResolvedValue({ candidates: [], catalogsSearched: 3, catalogsUnreachable: 0, collectionsSeen: 0 })
})

describe('find_dataset (registry path)', () => {
  it('answers from the offline registry without touching the network', async () => {
    const res = await executeTool('find_dataset', LAHORE, { query: 'land cover' })
    expect(gather).not.toHaveBeenCalled()
    expect(res.stats?.source).toBe('registry')
    const n = Number(res.stats?.matches)
    expect(n).toBeGreaterThanOrEqual(5)
    expect(n).toBeLessThanOrEqual(8)
    // Each hit carries the fields the agent needs to choose.
    expect(res.summary).toMatch(/themes: .*land-cover/)
    expect(res.summary).toMatch(/licence: /)
    expect(res.summary).toMatch(/access: /)
    expect(res.summary).toMatch(/no auth needed|needs /)
    expect(res.summary).toMatch(/global coverage|declared extent/)
    expect(res.summary).toMatch(/to read it now: `use_dataset\(\{dataset_id: "[a-z0-9-]+:[^"]+"\}\)`/)
    expect(Number(res.stats?.unwired_matches)).toBeGreaterThan(0)
  })

  it('says plainly what use_dataset will do with a point cloud instead of faking a read', async () => {
    const res = await executeTool('find_dataset', CALIFORNIA, { query: 'lidar point cloud 3DEP' })
    expect(res.stats?.source).toBe('registry')
    expect(res.summary).toMatch(/point cloud: returns real metadata and coverage only/)
    expect(res.summary).not.toMatch(/to read it now: `use_dataset\(\{dataset_id: "usgs-3dep:lidar-ept/)
  })

  it('names the reason a hit cannot be read in-app (Zarr needs the Python service)', async () => {
    const res = await executeTool('find_dataset', LAHORE, { query: 'CIL GDPCIR downscaled CMIP6 climate projections zarr' })
    expect(res.summary).toMatch(/not readable by `use_dataset` in-app yet: Zarr store: needs the Python geo service \(queue Q-22\)/)
  })

  it('applies the AOI filter: US-only lidar is not offered for Lahore, is for California', async () => {
    const lahore = await executeTool('find_dataset', LAHORE, { query: 'lidar point cloud 3DEP' })
    expect(lahore.summary).not.toContain('usgs-3dep:lidar-ept')
    const ca = await executeTool('find_dataset', CALIFORNIA, { query: 'lidar point cloud 3DEP' })
    expect(ca.summary).toContain('usgs-3dep:lidar-ept')
  })

  it('flags credentials the deployment does not have, without hiding the dataset', async () => {
    const res = await executeTool('find_dataset', LAHORE, { query: 'soil moisture satellite SMAP' })
    expect(res.summary).toMatch(/needs NASA Earthdata login \(NOT configured here\)/)
    expect(res.summary).toMatch(/NSIDC_CPRD\/SPL3SMP/)
  })

  it('honours theme, resolution, time and licence filters', async () => {
    const res = await executeTool('find_dataset', LAHORE, {
      query: 'elevation', themes: ['elevation'], max_resolution_m: 30, start: '2020', license: 'open',
    })
    expect(res.stats?.source).toBe('registry')
    for (const m of res.summary.matchAll(/~(\d+) (m|km)/g)) {
      const metres = m[2] === 'km' ? Number(m[1]) * 1000 : Number(m[1])
      expect(metres).toBeLessThanOrEqual(30)
    }
    expect(res.summary).not.toMatch(/licence: proprietary/)
  })

  it('ignores unknown theme names instead of failing', async () => {
    const res = await executeTool('find_dataset', LAHORE, { query: 'elevation model', themes: ['not-a-theme'] })
    expect(res.stats?.source).toBe('registry')
  })

  it('requires a query', async () => {
    const res = await executeTool('find_dataset', LAHORE, {})
    expect(res.status).toBe('refused')
    expect(res.summary).toMatch(/query: .*expected string/)
  })
})

describe('find_dataset (live fallback)', () => {
  it('falls back to live STAC when the registry has no good hit, and says why', async () => {
    const res = await executeTool('find_dataset', LAHORE, { query: 'quokka enclosure census' })
    expect(gather).toHaveBeenCalledTimes(1)
    expect(res.summary).toMatch(/Dataset search failed|No dataset matched/)
  })

  it('returns NOTHING (not a weak guess) when neither source matches', async () => {
    gather.mockResolvedValue({
      candidates: [{ catalog: { id: 'planetary-computer', name: 'PC', url: 'u' }, collection: { id: 'naip', title: 'NAIP', extent: { spatial: { bbox: [[-180, -90, 180, 90]] } } } }],
      catalogsSearched: 3, catalogsUnreachable: 0, collectionsSeen: 1,
    })
    const res = await executeTool('find_dataset', LAHORE, { query: 'unicorn habitat census' })
    expect(Number(res.stats?.matches)).toBe(0)
    expect(res.summary).toMatch(/no dataset matched/i)
    expect(res.summary).toMatch(/offline registry/i)
  })

  it('uses the live path when asked explicitly', async () => {
    await executeTool('find_dataset', LAHORE, { query: 'land cover', live: true })
    expect(gather).toHaveBeenCalledTimes(1)
  })
})
