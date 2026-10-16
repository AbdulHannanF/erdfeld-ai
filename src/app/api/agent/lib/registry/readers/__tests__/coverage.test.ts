/** Coverage pre-check: refuse from the registry entry alone, before any network call. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { coveragePrecheck, isUsOnly } from '../common'
import { readDataset } from '../index'
import { AOI, DENVER, entry } from './fixtures'

afterEach(() => vi.unstubAllGlobals())

const dep = (kind: string) => entry({
  id: `planetary-computer:3dep-lidar-${kind}`, collection: `3dep-lidar-${kind}`, themes: ['lidar'],
  spatial: { bbox: [-166.85, 17.66, -64.56, 71.39], global: false }, temporal: { start: '2012-01-01', end: '2022-01-01' },
})

describe('coveragePrecheck', () => {
  it('treats 3DEP as United-States-only even though its declared bbox is wider', () => {
    expect(isUsOnly(dep('hag'))).toBe(true)
    expect(isUsOnly(entry({ id: 'usgs-3dep:lidar-ept', source: 'usgs-3dep' }))).toBe(true)
    expect(isUsOnly(entry({ collection: 'cop-dem-glo-30' }))).toBe(false)
    // Lahore is outside the declared bbox of 3DEP entirely; a Canadian AOI is inside the bbox but not the US.
    const canada = { ...AOI, bbox: [-100, 50, -99.9, 50.1] as [number, number, number, number] }
    expect(coveragePrecheck(dep('hag'), canada, {})?.reason).toMatch(/United States and its territories only/)
    expect(coveragePrecheck(dep('hag'), AOI, {})?.reason).toMatch(/outside the dataset's declared extent/)
    expect(coveragePrecheck(dep('hag'), DENVER, {})).toBeNull()
    const hawaii = { ...AOI, bbox: [-157.9, 21.3, -157.8, 21.4] as [number, number, number, number] }
    expect(coveragePrecheck(dep('hag'), hawaii, {})).toBeNull()
  })

  it('refuses a period outside the dataset temporal extent', () => {
    const e = entry({ temporal: { start: '2000-02-18', end: '2005-12-31' } })
    expect(coveragePrecheck(e, AOI, { date: '2024-01-01' })?.reason).toMatch(/outside the dataset's temporal extent/)
    expect(coveragePrecheck(e, AOI, { start: '2004', end: '2006' })).toBeNull()
  })

  it('handles declared boxes that cross the antimeridian and global datasets', () => {
    const fiji = entry({ spatial: { bbox: [170, -20, -170, -10], global: false } })
    expect(coveragePrecheck(fiji, { ...AOI, bbox: [179.5, -18, 179.9, -17.5] }, {})).toBeNull()
    expect(coveragePrecheck(fiji, { ...AOI, bbox: [-175, -18, -174.5, -17.5] }, {})).toBeNull()
    expect(coveragePrecheck(fiji, AOI, {})?.reason).toMatch(/declared extent/)
    expect(coveragePrecheck(entry(), AOI, {})).toBeNull()
  })
})

describe('readDataset refuses fast', () => {
  it('returns no_coverage for US-only lidar over Lahore, naming the reason, and looks up OpenTopography instead of searching 3DEP', async () => {
    const fetchMock = vi.fn(async (u: any) => {
      expect(String(u)).toMatch(/otCatalog/) // nothing else may be called
      return new Response(JSON.stringify({ Datasets: [] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const t = Date.now()
    const res = await readDataset(dep('hag'), AOI, {})
    expect(Date.now() - t).toBeLessThan(500)
    expect(res.status).toBe('no_coverage')
    expect(res.stats).toBeNull()
    expect(res.coverage.verdict).toBe('none')
    expect(res.summary).toMatch(/OpenTopography catalog .* lists \*\*no lidar point-cloud survey\*\*/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses non-lidar datasets with no network at all', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const e = entry({ collection: 'regional', spatial: { bbox: [5, 45, 10, 48], global: false } })
    const res = await readDataset(e, AOI, {})
    expect(res.status).toBe('no_coverage')
    expect(res.summary).toMatch(/outside the dataset's declared extent/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
