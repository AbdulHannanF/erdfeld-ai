/** `use_dataset({dataset_id})`: id resolution, argument passing and result mapping. The readers are mocked
 *  (they have their own tests); the registry snapshot is real. */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const readers = vi.hoisted(() => ({ readDataset: vi.fn() }))
vi.mock('../readers', async (orig) => ({ ...(await orig<typeof import('../readers')>()), readDataset: readers.readDataset }))

import { executeTool } from '../../../tools'
import { getRegistryIndex } from '..'
import type { ReadResult } from '../readers'

const LAHORE = { type: 'Polygon', coordinates: [[[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]]] }

const ok = (over: Partial<ReadResult> = {}): ReadResult => ({
  status: 'ok', summary: 'READ SUMMARY', stats: { kind: 'continuous', mean: 5 },
  summary_data: { read: 'ok', mean: 5 }, provenance: null, coverage: { verdict: 'covered', declared: 'x', found: 'y' }, ...over,
})

beforeAll(async () => { await getRegistryIndex() }, 120_000)
beforeEach(() => { readers.readDataset.mockReset(); readers.readDataset.mockResolvedValue(ok()) })

describe('use_dataset with a registry dataset_id', () => {
  it('reads the entry over the AOI with the requested options and returns summary, data and layers', async () => {
    const layer = { id: 'a', name: 'A', type: 'raster' as const }
    const hill = { id: 'b', name: 'B', type: 'raster' as const }
    readers.readDataset.mockResolvedValue(ok({ layer, layers: [hill] }))
    const res = await executeTool('use_dataset', LAHORE, {
      dataset_id: 'planetary-computer:sentinel-1-rtc', variable: 'vv', date: '2026-10-01', start: '2026-09-01', end: '2026-10-10', render: false, hillshade: true,
    })
    const [entry, aoi, opts] = readers.readDataset.mock.calls[0]
    expect(entry.id).toBe('planetary-computer:sentinel-1-rtc')
    expect(aoi.aoi).toEqual(LAHORE)
    expect(aoi.bbox).toEqual([74.05, 31.12, 74.08, 31.15])
    expect(aoi.areaKm2).toBeGreaterThan(9)
    expect(opts).toMatchObject({ variable: 'vv', date: '2026-10-01', start: '2026-09-01', end: '2026-10-10', render: false, hillshade: true })
    expect(typeof opts.runTool).toBe('function')
    expect(res.summary).toBe('READ SUMMARY')
    expect(res.stats).toEqual({ read: 'ok', mean: 5 })
    expect(res.layers).toEqual([layer, hill]) // primary first
  })

  it('defaults to rendering, and treats empty strings as absent', async () => {
    await executeTool('use_dataset', LAHORE, { dataset_id: 'planetary-computer:cop-dem-glo-30', variable: '  ', date: '' })
    const opts = readers.readDataset.mock.calls[0][2]
    expect(opts.render).toBe(true)
    expect(opts.hillshade).toBe(false)
    expect(opts.variable).toBeUndefined()
    expect(opts.date).toBeUndefined()
  })

  it('accepts a bare collection id when it is unambiguous', async () => {
    await executeTool('use_dataset', LAHORE, { dataset_id: 'cop-dem-glo-30' })
    expect(readers.readDataset.mock.calls[0][0].id).toBe('planetary-computer:cop-dem-glo-30')
  })

  it('reads the alternate route when the caller names it (the Earth Engine copy of a dataset)', async () => {
    await executeTool('use_dataset', LAHORE, { dataset_id: 'gee:NASA/NASADEM_HGT/001' })
    const entry = readers.readDataset.mock.calls[0][0]
    expect(entry.id).toBe('gee:NASA/NASADEM_HGT/001')
    expect(entry.access.kind).toBe('earthengine')
    expect(entry.title).toMatch(/NASADEM/)
  })

  it('tells the model how to recover from an unknown id, without reading anything', async () => {
    const res = await executeTool('use_dataset', LAHORE, { dataset_id: 'planetary-computer:does-not-exist' })
    expect(res.summary).toMatch(/No registry dataset has the id "planetary-computer:does-not-exist"/)
    expect(res.summary).toMatch(/find_dataset/)
    expect(readers.readDataset).not.toHaveBeenCalled()
  })

  it('merges a routed tool result: keeps its layer and data, adds the read status', async () => {
    const tool = { id: 'rain', name: 'Rain', type: 'geojson' as const }
    readers.readDataset.mockResolvedValue(ok({ summary: 'ROUTED', summary_data: { read: 'ok', routed_to: 'fetch_weather_history' }, passthrough: { summary: 'raw', summary_data: { annual_precip_mm: 640 }, layer: tool } }))
    const res = await executeTool('use_dataset', LAHORE, { dataset_id: 'open-meteo:era5-archive' })
    expect(res.summary).toBe('ROUTED')
    expect(res.stats).toEqual({ annual_precip_mm: 640, read: 'ok', routed_to: 'fetch_weather_history' })
    expect(res.layers).toEqual([tool])
    expect(res.provenance.items).toEqual(['open-meteo:era5-archive'])
  })

  it('still needs one of dataset_id / collection', async () => {
    const res = await executeTool('use_dataset', LAHORE, {})
    expect(res.status).toBe('refused')
    expect(res.summary).toMatch(/needs a `dataset_id`/)
  })
})
