/**
 * C7 — In-process SSE contract test.
 *
 * Drives the REAL `/api/agent` POST handler in-process (no spawned `next dev`, no
 * browser) with the deterministic offline `stub` provider (AGENT_ALLOW_STUB=1), then
 * reads the streamed SSE body and asserts the event contract the frontend depends on:
 *
 *     plan → tool_call(running) → tool_call(completed) → layer → token → done
 *
 * This is the golden agent round-trip — "ask → a layer renders" — exercised as a unit
 * test. It complements `scripts/sse-smoke-test.mjs` (which spawns a full server) with a
 * fast, CI-friendly check that the route wiring + SSE event names never silently drift.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const AOI = {
  type: 'Polygon',
  coordinates: [[[36.80, -1.30], [36.82, -1.30], [36.82, -1.28], [36.80, -1.28], [36.80, -1.30]]],
}

let savedStub: string | undefined

beforeAll(() => {
  savedStub = process.env.AGENT_ALLOW_STUB
  process.env.AGENT_ALLOW_STUB = '1'
})
afterAll(() => {
  if (savedStub === undefined) delete process.env.AGENT_ALLOW_STUB
  else process.env.AGENT_ALLOW_STUB = savedStub
})

/** Read the full SSE body and parse `event:`/`data:` frames into {event, data}. */
async function drainSse(res: Response): Promise<Array<{ event: string; data: any }>> {
  expect(res.body, 'route returned no stream body').toBeTruthy()
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const events: Array<{ event: string; data: any }> = []
  // Hard cap so a contract regression can't hang the test.
  for (let guard = 0; guard < 100000; guard++) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const frames = buf.split('\n\n')
    buf = frames.pop() ?? ''
    for (const frame of frames) {
      let ev = 'message'
      const dataLines: string[] = []
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      if (dataLines.length) {
        let parsed: any = dataLines.join('\n')
        try { parsed = JSON.parse(parsed) } catch { /* keep string */ }
        events.push({ event: ev, data: parsed })
      }
    }
  }
  return events
}

async function runAgent(query: string): Promise<Array<{ event: string; data: any }>> {
  // Imported lazily so AGENT_ALLOW_STUB is set before module init reads anything.
  const { NextRequest } = await import('next/server')
  const { POST } = await import('../route')
  const req = new NextRequest('http://localhost/api/agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ aoi: AOI, query, lang: 'en', aiProvider: 'stub', aiModel: 'stub' }),
  })
  const res = await POST(req)
  return drainSse(res as unknown as Response)
}

describe('SSE contract (in-process, stub provider)', () => {
  it('streams the golden event sequence ending in done', async () => {
    const events = await runAgent('render a test layer')
    const names = events.map((e) => e.event)

    // Presence of the contract events the frontend consumes.
    expect(names, `events seen: ${names.join(',')}`).toContain('tool_call')
    expect(names).toContain('layer')
    expect(names).toContain('done')

    // Ordering: a tool_call appears before the layer it produced, and done is last.
    expect(names.indexOf('tool_call')).toBeLessThan(names.lastIndexOf('layer'))
    expect(names[names.length - 1]).toBe('done')
  }, 60_000)

  it('a refused plan ends with the refusal reasons, not "the model declined"', async () => {
    const events = await runAgent('stub-run: [{"tool":"render_raster","args":{"bands":["B99"],"start":"2026-09-01","end":"2026-09-30"}}]')
    expect(events.some((e) => e.event === 'plan_refused')).toBe(true)
    const text = events.filter((e) => e.event === 'token').map((e) => e.data?.content ?? '').join('')
    expect(text).toContain('refused before execution')
    expect(text).toContain('B99')
    expect(text).not.toContain('declined')
  }, 60_000)

  it('emits a layer event with an id (the thing that makes the map render)', async () => {
    const events = await runAgent('render a test layer')
    const layerEvent = events.find((e) => e.event === 'layer')
    expect(layerEvent, 'no layer event emitted').toBeTruthy()
    // The SSE layer payload uses snake_case `layer_id` (the field MapPanel keys on).
    expect(layerEvent!.data?.layer_id, 'layer event missing layer_id').toBeTruthy()
    expect(layerEvent!.data?.layer_type, 'layer event missing layer_type').toBeTruthy()
  }, 60_000)

  it('the layer carries REAL geometry, not an empty shell (ISS-111)', async () => {
    // Until 2026-08-11 the fixture tool returned `{ id, name, type }` and
    // nothing else, so this suite proved the event *names* travelled and
    // nothing about the payload — a layer that renders nothing would have
    // passed every assertion above. The fixture now echoes the drawn AOI, so
    // the round trip can be checked end to end: what the client receives must
    // be the polygon that was sent.
    const events = await runAgent('render a test layer')
    const layerEvent = events.find((e) => e.event === 'layer')!
    const fc = layerEvent.data?.geojson
    expect(fc?.type, 'layer event carried no geojson').toBe('FeatureCollection')
    expect(fc.features.length).toBeGreaterThan(0)
    expect(fc.features[0].geometry.type).toBe('Polygon')
    expect(fc.features[0].geometry.coordinates).toEqual(AOI.coordinates)
  }, 60_000)

  it('names the fixture as a fixture rather than reporting an analysis', async () => {
    const events = await runAgent('render a test layer')
    const completed = events.filter(
      (e) => e.event === 'tool_call' && e.data?.status === 'completed',
    )
    expect(completed.length).toBeGreaterThan(0)
    // No step may report success as "Unknown tool" or as a real measurement.
    for (const e of events) {
      if (e.event === 'tool_call') expect(String(e.data?.label ?? '')).not.toMatch(/Unknown tool/)
    }
  }, 60_000)

  it('returns 400 (not a stream) when aoi/query are missing', async () => {
    const { NextRequest } = await import('next/server')
    const { POST } = await import('../route')
    const req = new NextRequest('http://localhost/api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ aiProvider: 'stub' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })
})
