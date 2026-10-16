/** ISS-111 — `render_to_map` told the LLM it had rendered something it had not.
 *
 *  It advertised "Render data as a named map layer" and returned
 *  `{ id, name, type }` with no geojson, no tiles and no data. The layer entry
 *  appeared in the UI rendering nothing, and the agent was free to cite it.
 *
 *  These tests defend the two halves of the fix: the model can no longer reach
 *  it, and what remains is honest about being a test fixture.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { executeTool } from '../../tools'
import { getToolDefinitions, registryJson } from '../../engine/registry'

const AOI = {
  type: 'Polygon',
  coordinates: [[[74.30, 31.50], [74.36, 31.50], [74.36, 31.56], [74.30, 31.56], [74.30, 31.50]]],
}

const originalStub = process.env.AGENT_ALLOW_STUB
afterEach(() => {
  if (originalStub === undefined) delete process.env.AGENT_ALLOW_STUB
  else process.env.AGENT_ALLOW_STUB = originalStub
})

describe('render_to_map is not offered to the model', () => {
  it('has no schema, so the LLM cannot call it', () => {
    const names = getToolDefinitions().map((t: any) => t.function.name)
    expect(names).not.toContain('render_to_map')
    process.env.AGENT_ALLOW_STUB = '1' // even where it can run, it is neither offered nor listed
    expect(getToolDefinitions().map((t: any) => t.function.name)).not.toContain('render_to_map')
    expect(registryJson().map((o) => o.name)).not.toContain('render_to_map')
  })

  it('every other tool still has a schema — the removal was surgical', () => {
    const names = getToolDefinitions().map((t: any) => t.function.name)
    expect(names).toContain('analyze_raster')
    expect(names).toContain('inspect_imagery')
    expect(names).toContain('map_flood')
    expect(names.length).toBeGreaterThan(25)
  })
})

describe('render_to_map without the test flag', () => {
  it('refuses instead of claiming success', async () => {
    delete process.env.AGENT_ALLOW_STUB
    const r = await executeTool('render_to_map', AOI, { name: 'X', data_type: 'geojson' })
    expect(r.status).toBe('refused')
    expect(r.summary).toMatch(/Unknown tool: render_to_map/)
    expect(r.summary).not.toMatch(/rendered on map/)
  })

  it('emits NO layer — an empty layer shell was the defect', async () => {
    delete process.env.AGENT_ALLOW_STUB
    const r = await executeTool('render_to_map', AOI, { name: 'X', data_type: 'geojson' })
    expect(r.layers).toHaveLength(0)
    expect(r.stats).toBeUndefined()
  })

  it('points the caller at the tool that would actually measure something', async () => {
    delete process.env.AGENT_ALLOW_STUB
    const r = await executeTool('render_to_map', AOI, {})
    expect(r.validation[0].message).toMatch(/Use only the tools offered/)
  })
})

describe('render_to_map as the gated SSE contract fixture', () => {
  it('emits the REAL drawn AOI, not an empty shell', async () => {
    process.env.AGENT_ALLOW_STUB = '1'
    const r = await executeTool('render_to_map', AOI, { name: 'Smoke Test Layer', data_type: 'geojson' })
    expect(r.layers.length).toBeGreaterThan(0)
    const fc = r.layers[0]!.geojson
    expect(fc.type).toBe('FeatureCollection')
    expect(fc.features).toHaveLength(1)
    // The geometry is the polygon that was drawn — not a placeholder.
    expect(fc.features[0].geometry.coordinates).toEqual(AOI.coordinates)
    expect(r.layers[0]!.bounds).toEqual([74.30, 31.50, 74.36, 31.56])
  })

  it('says plainly that it measured nothing', async () => {
    process.env.AGENT_ALLOW_STUB = '1'
    const r = await executeTool('render_to_map', AOI, { name: 'Smoke Test Layer' })
    expect(r.summary).toMatch(/contract fixture/i)
    expect(r.summary).toMatch(/measures nothing/)
    expect(r.layers[0]!.confidence).toBe('low')
    expect(r.layers[0]!.provenance!.source).toMatch(/none/i)
  })

  it('carries no citable figures — nothing here is a measurement', async () => {
    process.env.AGENT_ALLOW_STUB = '1'
    const r = await executeTool('render_to_map', AOI, {})
    expect(r.stats).toBeUndefined()
  })
})
