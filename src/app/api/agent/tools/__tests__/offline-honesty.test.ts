import { afterEach, describe, expect, it, vi } from 'vitest'

import { executeTool } from '..'

// A connectivity failure must never be reported as "no data exists here".
const aoi = { type: 'Polygon', coordinates: [[[74.30, 31.50], [74.33, 31.50], [74.33, 31.53], [74.30, 31.53], [74.30, 31.50]]] }

describe('tools under a total network outage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each([
    ['compute_spectral_index', { index: 'NDWI' }],
    ['fetch_surface_water', {}],
    ['fetch_dem', {}],
    ['fetch_elevation_derivatives', {}],
    ['fetch_precipitation_history', {}],
    ['analyze_raster', { operation: 'stats' }],
  ])('%s reports a connectivity failure, not an absence of data', async (tool, args) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const r = await executeTool(tool, aoi, args)
    expect(r.summary).toMatch(/connectivity failure/i)
    expect(r.status, 'an outage is a failure, never an empty result').toBe('failed')
    expect(r.summary).not.toMatch(/No Sentinel-2 scene found|returned no JRC|likely ocean|ocean-only|No Sentinel-2 L2A scene covers/i)
    expect(r.layers).toHaveLength(0)
  })
})
