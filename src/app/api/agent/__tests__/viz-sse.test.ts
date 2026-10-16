/**
 * In-process SSE test for the visualization path: the offline stub plans
 * render_to_map(fixture fields) -> style_layer + make_chart, and the route must stream
 * the `layer`, `layer_style` and `chart` events the client store consumes.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const AOI = {
  type: 'Polygon',
  coordinates: [[[36.80, -1.30], [36.82, -1.30], [36.82, -1.28], [36.80, -1.28], [36.80, -1.30]]],
}

let savedStub: string | undefined
let NextRequest: typeof import('next/server').NextRequest
let POST: typeof import('../route').POST
// The run itself takes ~0.3 s. What made this file slow was the first request paying for loading the
// whole route and tool graph (~2.5 s warm, far more on a cold transform cache or under suite load),
// inside a 5 s test timeout. Loading it here, under the hook's own generous timeout, keeps the tests
// measuring the run.
beforeAll(async () => {
  savedStub = process.env.AGENT_ALLOW_STUB
  process.env.AGENT_ALLOW_STUB = '1'
  ;({ NextRequest } = await import('next/server'))
  ;({ POST } = await import('../route'))
}, 120_000)
afterAll(() => {
  if (savedStub === undefined) delete process.env.AGENT_ALLOW_STUB
  else process.env.AGENT_ALLOW_STUB = savedStub
})

async function run(query: string, extra: Record<string, unknown> = {}): Promise<Array<{ event: string; data: any }>> {
  const res = await POST(new NextRequest('http://localhost/api/agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ aoi: AOI, query, lang: 'en', aiProvider: 'stub', aiModel: 'stub', ...extra }),
  }))
  const reader = (res as Response).body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const events: Array<{ event: string; data: any }> = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const frames = buf.split('\n\n')
    buf = frames.pop() ?? ''
    for (const frame of frames) {
      let ev = 'message'
      let data = ''
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (data) events.push({ event: ev, data: JSON.parse(data) })
    }
  }
  return events
}

describe('visualization SSE events (stub provider)', () => {
  it('streams layer -> layer_style and chart, with the chart rows taken from the layer features', async () => {
    const events = await run('show styled fields')
    const names = events.map((e) => e.event)
    expect(names).toContain('layer')
    expect(names).toContain('layer_style')
    expect(names).toContain('chart')
    expect(names.indexOf('layer')).toBeLessThan(names.indexOf('layer_style'))

    const layer = events.find((e) => e.event === 'layer')!.data
    const style = events.find((e) => e.event === 'layer_style')!.data
    expect(style.layer_id).toBe(layer.layer_id)
    expect(style.vector_style).toMatchObject({ property: 'ndvi', kind: 'graduated', colormap: 'rdylgn' })

    const chart = events.find((e) => e.event === 'chart')!.data
    expect(chart.layer_id).toBe(layer.layer_id)
    expect(chart.title).toBe('Median NDVI per field')
    const rows = chart.spec.data.values
    expect(rows).toHaveLength(layer.geojson.features.length)
    expect(rows[0]).toMatchObject({ name: 'Field A', ndvi: 0.31, _fid: 0 })
  })

  it('reports no failed tool for the visualization steps', async () => {
    const events = await run('show styled fields')
    const errors = events.filter((e) => e.event === 'tool_call' && e.data.status === 'error')
    expect(errors).toEqual([])
  })
})
