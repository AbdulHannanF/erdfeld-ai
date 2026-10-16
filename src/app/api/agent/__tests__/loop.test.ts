/**
 * The agent loop, driven with scripted model turns (no network, no real provider). Each call of
 * the mocked `createProviderStream` plays the next scripted turn and records the history it saw.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LLMEvent } from '../lib/llm-adapters'

const turns: LLMEvent[][] = []
const seen: any[][] = []

vi.mock('../lib/llm', () => ({
  createProviderStream: vi.fn(async (messages: any[], _tools: any[], _cfg: any, signal?: AbortSignal) => {
    seen.push(JSON.parse(JSON.stringify(messages)))
    const turn = turns.shift() ?? [{ type: 'text', text: 'fallback text' } as LLMEvent, { type: 'done', finishReason: 'stop' } as LLMEvent]
    return (async function* () {
      for (const ev of turn) {
        if ((ev as any).type === 'hang') await new Promise((_r, rej) => signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true }))
        else yield ev
      }
    })()
  }),
}))

import { runAgent } from '../loop'

const AOI = { type: 'Polygon', coordinates: [[[36.80, -1.30], [36.82, -1.30], [36.82, -1.28], [36.80, -1.28], [36.80, -1.30]]] }
const step = (tool = 'render_to_map', args: unknown = { name: 'L', data_type: 'geojson' }, extra: object = {}) => ({ tool, args_json: JSON.stringify(args), reason: 'r', ...extra })
const plan = (steps: unknown[], kind = 'plan'): LLMEvent => ({ type: 'tool_call', id: 'p1', name: 'submit_plan', args: { kind, steps } })
const done = (finishReason: string): LLMEvent => ({ type: 'done', finishReason })
const text = (t: string): LLMEvent => ({ type: 'text', text: t })

let saved: string | undefined
beforeAll(() => { saved = process.env.AGENT_ALLOW_STUB; process.env.AGENT_ALLOW_STUB = '1' })
afterAll(() => { if (saved === undefined) delete process.env.AGENT_ALLOW_STUB; else process.env.AGENT_ALLOW_STUB = saved })
beforeEach(() => { turns.length = 0; seen.length = 0 })

async function run(extra: Partial<Parameters<typeof runAgent>[0]> = {}) {
  const events: Array<{ event: string; data: any }> = []
  await runAgent({
    aoi: AOI, query: 'q', owner: null, llm: { provider: 'stub' }, signal: new AbortController().signal,
    emit: (event, data) => events.push({ event, data }), ...extra,
  })
  const of = (name: string) => events.filter((e) => e.event === name).map((e) => e.data)
  const answer = of('token').map((t) => t.content).join('')
  return { events, of, answer }
}
const lastToolReplies = (call: number) => seen[call].filter((m) => m.role === 'tool').map((m) => m.content as string)

describe('single execution path', () => {
  it('runs a submitted plan, then asks for the analysis', async () => {
    turns.push([plan([step()]), done('tool_calls')], [text('Result analysis.'), done('stop')])
    const { of, answer } = await run()
    expect(of('plan')).toHaveLength(1)
    expect(of('tool_call').map((t) => t.status)).toEqual(['running', 'completed'])
    expect(answer).toBe('Result analysis.')
    expect(seen[1].at(-1).content).toMatch(/All planned tools have executed/)
  })

  it('does not run a direct tool call; it answers with how to resubmit as a plan', async () => {
    turns.push(
      [{ type: 'tool_call', id: 'd1', name: 'render_to_map', args: { name: 'L' } }, done('tool_calls')],
      [plan([step()]), done('tool_calls')],
      [text('ok'), done('stop')],
    )
    const { of } = await run()
    expect(of('tool_call').filter((t) => t.status === 'running')).toHaveLength(1) // only the planned run
    expect(lastToolReplies(1)[0]).toMatch(/only through submit_plan/)
    expect(lastToolReplies(1)[0]).toContain('"tool":"render_to_map"')
  })

  it('refuses a plan over the step cap and runs nothing', async () => {
    turns.push([plan(Array.from({ length: 13 }, () => step())), done('tool_calls')], [text('I could not plan that.'), done('stop')])
    const { of } = await run()
    expect(of('tool_call')).toHaveLength(0)
    expect(lastToolReplies(1)[0]).toMatch(/at most 12 steps/)
  })

  it('accepts exactly 12 steps', async () => {
    turns.push([plan(Array.from({ length: 12 }, () => step())), done('tool_calls')], [text('done'), done('stop')])
    const { of } = await run()
    expect(of('tool_call').filter((t) => t.status === 'completed')).toHaveLength(12)
  })

  it('refuses a cyclic plan instead of running it in array order', async () => {
    turns.push([plan([step('render_to_map', {}, { depends_on: [1] }), step('render_to_map', {}, { depends_on: [0] })]), done('tool_calls')], [text('cannot'), done('stop')])
    const { of } = await run()
    expect(of('tool_call')).toHaveLength(0)
    expect(of('plan_refused')).toHaveLength(1)
    expect(lastToolReplies(1)[0]).toMatch(/plan_refused/)
  })

  it('replies to every call of a turn, extras included', async () => {
    turns.push([plan([step()]), { type: 'tool_call', id: 'x', name: 'fetch_dem', args: {} }, done('tool_calls')], [text('ok'), done('stop')])
    await run()
    expect(lastToolReplies(1)).toHaveLength(2)
  })
})

describe('provider turn record', () => {
  it('stores the native turn on the assistant message untouched', async () => {
    const native = { role: 'model', parts: [{ functionCall: { name: 'submit_plan' }, thoughtSignature: 'sig' }] }
    turns.push([plan([step()]), { type: 'native', content: native }, done('tool_calls')], [text('ok'), done('stop')])
    await run()
    expect(seen[1].find((m) => m.role === 'assistant').native).toEqual(native)
  })
})

describe('truncation', () => {
  it('tells the model that a cut-off tool call was not run', async () => {
    turns.push(
      [{ type: 'tool_call', id: 'p1', name: 'submit_plan', args: {}, argsError: 'tool arguments are not valid JSON (Unexpected end)' }, done('length')],
      [plan([step()]), done('tool_calls')],
      [text('ok'), done('stop')],
    )
    const { of } = await run()
    expect(lastToolReplies(1)[0]).toMatch(/Not run: tool arguments are not valid JSON.*token limit/)
    expect(of('tool_call').filter((t) => t.status === 'completed')).toHaveLength(1)
  })

  it('asks for a smaller answer when the turn produced nothing before the limit', async () => {
    turns.push([done('length')], [text('short answer'), done('stop')])
    const { answer } = await run()
    expect(seen[1].at(-1).content).toMatch(/cut off at the output limit/)
    expect(answer).toBe('short answer')
  })

  it('says so when a written answer was cut off', async () => {
    turns.push([text('Half an answ'), done('length')])
    const { answer } = await run()
    expect(answer).toMatch(/cut off at the model's output limit/)
  })
})

describe('honest endings', () => {
  it('says nothing was produced instead of finishing silently', async () => {
    turns.push([done('stop')])
    const { answer, of } = await run()
    expect(answer).toMatch(/No answer was produced, and no tools were run/)
    expect(of('done')).toHaveLength(1)
  })

  it('reports the refusal reasons when the plan was refused and the model then stayed silent', async () => {
    turns.push([plan([step('no_such_tool', {})]), done('tool_calls')], [done('stop')])
    const { answer } = await run()
    expect(answer).toMatch(/Nothing was run: the request was refused/)
  })

  it('ends with a time-budget message when the budget is already spent', async () => {
    const { answer, of } = await run({ budgetMs: 1, startedAt: Date.now() - 10_000 })
    expect(answer).toMatch(/stopped at its time budget/)
    expect(seen).toHaveLength(0)
    expect(of('done')).toHaveLength(1)
  })

  it('stops a model turn that outlives the budget and says so', async () => {
    turns.push([{ type: 'hang' } as any])
    const { answer } = await run({ budgetMs: 150, startedAt: Date.now() })
    expect(answer).toMatch(/stopped at its time budget/)
  })

  it('reports a provider failure as an error event followed by done', async () => {
    const llm = await import('../lib/llm')
    vi.mocked(llm.createProviderStream).mockRejectedValueOnce(new Error('AI provider (gemini) error 503'))
    const { of } = await run()
    expect(of('error')[0].content).toMatch(/503/)
    expect(of('done')).toHaveLength(1)
  })
})
