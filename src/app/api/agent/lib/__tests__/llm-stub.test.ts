import { afterEach, describe, expect, it } from 'vitest'

import { createProviderStream, createStubStream } from '../llm'
import { parseSubmitPlan } from '../plan'

async function drain(gen: AsyncIterable<any>): Promise<any[]> {
  const out: any[] = []
  for await (const chunk of gen) out.push(chunk)
  return out
}

describe('createStubStream (P7.1 SSE-contract smoke stub)', () => {
  it('phase 1: emits a valid one-step render_to_map submit_plan call before any tool ran', async () => {
    const chunks = await drain(createStubStream([{ role: 'user', content: 'analyze this area' }]))
    const call = chunks.find((e) => e.type === 'tool_call')
    expect(call.name).toBe('submit_plan')
    const parsed = parseSubmitPlan(call.args)
    expect(parsed.ok && parsed.submitted.kind).toBe('plan')
    expect(parsed.ok && parsed.submitted.plan.steps).toHaveLength(1)
    expect(parsed.ok && parsed.submitted.plan.steps[0].tool).toBe('render_to_map')
    expect(chunks[chunks.length - 1]).toEqual({ type: 'done', finishReason: 'tool_calls' })
  })

  it('phase 2: emits plain synthesis text (no plan, no tool calls) after tools ran', async () => {
    const chunks = await drain(
      createStubStream([
        { role: 'assistant', content: 'plan' },
        { role: 'user', content: 'All planned tools have executed. Results:\nStep 0 — render_to_map: ok' },
      ]),
    )
    expect(chunks.map((e) => e.type)).toEqual(['text', 'done'])
    expect(chunks[1].finishReason).toBe('stop')
  })

  it('also terminates after the legacy "All tools have completed" directive', async () => {
    const chunks = await drain(
      createStubStream([{ role: 'user', content: 'All tools have completed. Write your analysis now.' }]),
    )
    expect(chunks.some((e) => e.type === 'tool_call')).toBe(false)
  })
})

describe('createProviderStream stub gating (P7.1)', () => {
  const prev = process.env.AGENT_ALLOW_STUB
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENT_ALLOW_STUB
    else process.env.AGENT_ALLOW_STUB = prev
  })

  it('throws when the stub provider is requested without AGENT_ALLOW_STUB', async () => {
    delete process.env.AGENT_ALLOW_STUB
    await expect(createProviderStream([], [], { provider: 'stub' })).rejects.toThrow(/disabled/i)
  })

  it('returns the stub stream when AGENT_ALLOW_STUB=1', async () => {
    process.env.AGENT_ALLOW_STUB = '1'
    const stream = await createProviderStream([{ role: 'user', content: 'hi' }], [], { provider: 'stub' })
    const chunks = await drain(stream)
    expect(chunks.find((e) => e.type === 'tool_call').name).toBe('submit_plan')
  })
})
