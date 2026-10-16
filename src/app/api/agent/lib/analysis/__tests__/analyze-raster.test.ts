/** Offline tests for the `analyze_raster` tool's argument handling.
 *
 *  These cover only the paths that refuse BEFORE any network call, so the suite
 *  runs with no credentials and no upstream. The behaviour that needs real
 *  pixels lives in `analyze-live.test.ts`.
 */

import { describe, it, expect } from 'vitest'
import { executeTool } from '../../../tools'

const AOI = {
  type: 'Polygon',
  coordinates: [[[74.30, 31.50], [74.36, 31.50], [74.36, 31.56], [74.30, 31.56], [74.30, 31.50]]],
}

describe('analyze_raster — static validation (nothing runs when it fails)', () => {
  it('is reachable through the dispatcher under its own name', async () => {
    const r = await executeTool('analyze_raster', AOI, { operation: 'nonsense' })
    expect(r.summary).not.toMatch(/unknown tool/i)
  })

  it('names the supported operations when given an unknown one', async () => {
    const r = await executeTool('analyze_raster', AOI, { operation: 'kriging' })
    expect(r.status).toBe('refused')
    expect(r.summary).toContain('variogram')
    expect(r.summary).toContain('transect')
    expect(r.stats).toBeUndefined()
  })

  it('refuses a change analysis without both dates', async () => {
    const r = await executeTool('analyze_raster', AOI, { operation: 'change', date: '2024-05-01' })
    expect(r.summary).toMatch(/needs two dates/)
    expect(r.stats).toBeUndefined()
  })

  it('refuses a correlation without a second index', async () => {
    const r = await executeTool('analyze_raster', AOI, { operation: 'correlate' })
    expect(r.summary).toMatch(/second index/)
  })

  it('refuses to correlate an index with itself instead of reporting r = 1', async () => {
    const r = await executeTool('analyze_raster', AOI, { operation: 'correlate', index: 'NDVI', index2: 'ndvi' })
    expect(r.summary).toMatch(/trivially/)
  })

  it('refuses a transect with no line', async () => {
    const r = await executeTool('analyze_raster', AOI, { operation: 'transect' })
    expect(r.summary).toMatch(/needs a line/)
  })

  it('refuses a transect whose line is not a pair of positions', async () => {
    const r = await executeTool('analyze_raster', AOI, { operation: 'transect', line: [[74.31, 31.51]] })
    expect(r.summary).toMatch(/needs a line/)
  })

  it('refuses an unknown texture metric by name', async () => {
    const r = await executeTool('analyze_raster', AOI, { operation: 'texture', metric: 'glcm-contrast' })
    expect(r.status).toBe('refused')
    expect(r.summary).toMatch(/metric/)
    expect(r.summary).toMatch(/stddev/)
  })

  it('rejects a non-polygon AOI rather than analysing a point', async () => {
    const r = await executeTool('analyze_raster', { type: 'Point', coordinates: [74.32, 31.52] }, {
      operation: 'stats',
    })
    expect(r.status).toBe('refused')
    expect(r.summary).toMatch(/no measurable area/)
    expect(r.stats).toBeUndefined()
  })

  it('refuses a variogram lag finer than the pixels the AOI resolves to, before any fetch', async () => {
    const r = await executeTool('analyze_raster', AOI, { operation: 'variogram', lag_m: 2 })
    expect(r.status).toBe('refused')
    expect(r.summary).toMatch(/finer than/)
  })

  it('refuses an index it does not know instead of substituting NDVI', async () => {
    const r = await executeTool('analyze_raster', AOI, { operation: 'stats', index: 'GNDVI' })
    expect(r.status).toBe('refused')
  })
})
