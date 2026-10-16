/** Offline tests for the `inspect_imagery` tool.
 *
 *  These cover the paths that resolve before any network call. The behaviour
 *  that needs real pixels and a real model lives in `vision-live.test.ts`.
 */

import { describe, it, expect } from 'vitest'
import { executeTool } from '../../../tools'

const AOI = {
  type: 'Polygon',
  coordinates: [[[74.30, 31.50], [74.36, 31.50], [74.36, 31.56], [74.30, 31.56], [74.30, 31.50]]],
}

describe('inspect_imagery — no vision model configured', () => {
  it('is reachable through the dispatcher under its own name', async () => {
    const r = await executeTool('inspect_imagery', AOI, {})
    expect(r.summary).not.toMatch(/unknown tool/i)
  })

  it('says plainly that it did not look, and names what would let it', async () => {
    const r = await executeTool('inspect_imagery', AOI, {})
    expect(r.summary).toMatch(/No vision model is available/)
    expect(r.summary).toMatch(/VLM_ENDPOINT/)
    expect(r.summary).toMatch(/Settings/)
  })

  it('produces no description, no layer and no citable figures when it cannot see', async () => {
    const r = await executeTool('inspect_imagery', AOI, {})
    expect(r.layers).toHaveLength(0)
    expect(r.stats).toBeUndefined()
  })

  it('points at the cloud numbers, which need no vision model', async () => {
    const r = await executeTool('inspect_imagery', AOI, {})
    expect(r.summary).toMatch(/analyze_raster/)
    expect(r.summary).toMatch(/SCL/)
  })

  it('rejects an unknown subject by name before doing anything else', async () => {
    const r = await executeTool('inspect_imagery', AOI, { subject: 'thermal' })
    expect(r.status).toBe('refused')
    expect(r.summary).toContain('subject')
    expect(r.summary).toContain('truecolor')
  })
})
