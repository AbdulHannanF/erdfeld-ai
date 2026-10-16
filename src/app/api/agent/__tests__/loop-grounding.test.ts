/**
 * The loop around an operation: progress an operation reports is not answer text, the model reads
 * a structured facts line per result, a hung operation ends the step instead of the run, and an
 * answer with unbacked figures says so. The model and the executor are scripted.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GEO_RESULT_SCHEMA, type GeoResult } from '@/lib/geo-result'

import type { LLMEvent } from '../lib/llm-adapters'

const turns: LLMEvent[][] = []
const seen: any[][] = []
const phases: Array<string | undefined> = []

vi.mock('../lib/llm', () => ({
  createProviderStream: vi.fn(async (messages: any[], _tools: any[], cfg: any) => {
    seen.push(JSON.parse(JSON.stringify(messages)))
    phases.push(cfg.phase)
    const turn = turns.shift() ?? []
    return (async function* () { yield* turn })()
  }),
}))

const exec = vi.hoisted(() => ({ run: null as null | ((env: any) => Promise<GeoResult>) }))
vi.mock('../engine/execute', () => ({ runOperation: (_n: string, _a: unknown, env: any) => exec.run!(env) }))
vi.mock('../engine/plan', async (orig) => ({ ...(await orig<typeof import('../engine/plan')>()), validatePlan: () => ({ ok: true }) }))

import { runAgent } from '../loop'

const AOI = { type: 'Polygon', coordinates: [[[36.80, -1.30], [36.82, -1.30], [36.82, -1.28], [36.80, -1.28], [36.80, -1.30]]] }

const result = (over: Partial<GeoResult> = {}): GeoResult => ({
  schema: GEO_RESULT_SCHEMA,
  result_id: 'r_00000000000000a1',
  op: { name: 'fetch_ndvi', version: '1' },
  status: 'ok',
  summary: 'NDVI mean 0.42',
  layers: [],
  stats: { mean: 0.42, valid_pixel_pct: 98.8, scene_date: '2024-07-16' },
  provenance: { sources: ['Sentinel-2 L2A'], items: ['S2B_37MBU_20240716'], method: 'titiler', date: '2024-07-16', inputs_hash: 'h' },
  validation: [],
  ...over,
} as GeoResult)

const planTurn = (): LLMEvent[] => [
  { type: 'tool_call', id: 'p1', name: 'submit_plan', args: { kind: 'plan', steps: [{ tool: 'fetch_ndvi', args_json: '{}', reason: 'r' }] } },
  { type: 'done', finishReason: 'tool_calls' },
]
const answerTurn = (t: string): LLMEvent[] => [{ type: 'text', text: t }, { type: 'done', finishReason: 'stop' }]

async function run(extra: Partial<Parameters<typeof runAgent>[0]> = {}) {
  const events: Array<{ event: string; data: any }> = []
  await runAgent({
    aoi: AOI, query: 'q', owner: null, llm: { provider: 'stub' }, signal: new AbortController().signal,
    emit: (event, data) => events.push({ event, data }), ...extra,
  })
  const of = (name: string) => events.filter((e) => e.event === name).map((e) => e.data)
  return { of, answer: of('token').map((t) => t.content).join('') }
}

beforeEach(() => {
  turns.length = 0; seen.length = 0; phases.length = 0
  exec.run = async () => result()
})

describe('operation progress', () => {
  it('goes to thinking events and never into the answer', async () => {
    exec.run = async (env) => { env.emit('token', { type: 'token', content: 'Reading cloud-masked NDVI pixels...\n' }); return result() }
    turns.push(planTurn(), answerTurn('Mean NDVI was 0.42 [[r_00000000000000a1#mean]].'))
    const { of, answer } = await run()
    expect(of('thinking').map((t) => t.content)).toEqual(['Reading cloud-masked NDVI pixels...\n'])
    expect(answer).not.toMatch(/Reading cloud-masked/)
  })
})

describe('grounding', () => {
  it('gives the synthesis turn the scene, date, coverage, method and validation of each result', async () => {
    turns.push(planTurn(), answerTurn('ok'))
    await run()
    const digest = seen[1].find((m) => m.role === 'tool').content as string
    expect(digest).toContain('[facts: status=ok')
    expect(digest).toContain('S2B_37MBU_20240716')
    expect(digest).toContain('valid_pixel_pct=98.8')
    expect(digest).toContain('validation=passed')
  })

  it('plans at the plan phase and writes the analysis at the synthesis phase', async () => {
    turns.push(planTurn(), answerTurn('ok'))
    await run()
    expect(phases).toEqual(['plan', 'synthesis'])
  })

  it('lists sentences whose figures no citation backs, and leaves them in the answer', async () => {
    turns.push(planTurn(), answerTurn('Mean NDVI was 0.42 [[r_00000000000000a1#mean]]. About 37% of the area is bare soil.'))
    const { answer } = await run()
    expect(answer).toContain('About 37% of the area is bare soil.')
    expect(answer).toMatch(/Unverified statements[\s\S]*37% of the area is bare soil[\s\S]*has no citation/)
    expect(answer).not.toMatch(/- Mean NDVI was 0\.42/)
  })
})

describe('time budget', () => {
  it('ends a hung operation at its limit and still writes the analysis', async () => {
    exec.run = (env) => new Promise((res) => env.signal.addEventListener('abort', () => res(result({ status: 'failed', summary: '**fetch_ndvi failed:** stopped.' })), { once: true }))
    turns.push(planTurn(), answerTurn('The step did not finish, so nothing was measured.'))
    // 5 s budget: the tools get ~3.75 s, the rest is held for the analysis.
    const { of, answer } = await run({ budgetMs: 5_000, startedAt: Date.now() })
    expect(of('tool_call').some((t) => t.status === 'error')).toBe(true)
    expect(answer).toContain('nothing was measured')
    expect(answer).toMatch(/1 step was skipped or stopped at the time budget/)
    expect(seen[1].at(-1).content).toMatch(/skipped or stopped at the time budget/)
  }, 15_000)
})
