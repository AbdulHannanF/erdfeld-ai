/**
 * A run always ends with a terminal event. When something throws mid-run the client gets `error` and then
 * `done`, never a stream that just stops (the live evaluation saw exactly that when the container died).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../engine/execute', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/execute')>()
  return { ...actual, runOperation: vi.fn(async () => { throw new Error('evidence store exploded') }) }
})

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

async function eventNames(res: Response): Promise<string[]> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const names: string[] = []
  for (let guard = 0; guard < 100000; guard++) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const frames = buf.split('\n\n')
    buf = frames.pop() ?? ''
    for (const frame of frames) {
      const m = frame.match(/^event: (.+)$/m)
      if (m) names.push(m[1].trim())
    }
  }
  return names
}

describe('terminal event guarantee', () => {
  it('an operation that throws outside the tool still ends the stream with error then done', async () => {
    const { NextRequest } = await import('next/server')
    const { POST } = await import('../route')
    const req = new NextRequest('http://localhost/api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ aoi: AOI, query: 'render a test layer', lang: 'en', aiProvider: 'stub', aiModel: 'stub' }),
    })
    const names = await eventNames((await POST(req)) as unknown as Response)
    expect(names.at(-1)).toBe('done')
    expect(names.filter((n) => n === 'done')).toHaveLength(1)
    expect(names).toContain('error')
    expect(names.indexOf('error')).toBeLessThan(names.lastIndexOf('done'))
  }, 60_000)
})
