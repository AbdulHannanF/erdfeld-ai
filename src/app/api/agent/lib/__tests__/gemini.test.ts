import { ApiError } from '@google/genai'
import { describe, expect, it, vi } from 'vitest'

import { apiMessage, backoffMs, createGeminiStream, geminiConfig, retryAfterMs, RETRY_POLICY, toGeminiContents, type GeminiClient } from '../gemini'
import { geminiModelChain, isGemma } from '../models'

const SIG = 'sig-abc'
const signal = new AbortController().signal

async function* chunks(...cs: any[]) { for (const c of cs) yield c }
const chunk = (parts: any[], finishReason?: string) => ({ candidates: [{ content: { role: 'model', parts }, finishReason }] })
const apiError = (status: number, message = 'x') => new ApiError({ status, message })

async function drain(gen: AsyncIterable<any>) {
  const out: any[] = []
  for await (const e of gen) out.push(e)
  return out
}

function fakeClient(...responses: Array<(model: string) => any>): GeminiClient & { calls: any[] } {
  const calls: any[] = []
  return {
    calls,
    models: {
      generateContentStream: vi.fn(async (p: any) => {
        calls.push(p)
        return responses[Math.min(calls.length - 1, responses.length - 1)](p.model)
      }),
    },
  } as any
}
const fast = { sleep: vi.fn(async () => {}), random: () => 0.5, env: {} as Record<string, string> }

describe('model chain', () => {
  it('pins stable ids with a fallback chain, overridable by env', () => {
    expect(geminiModelChain(undefined, {})).toEqual(['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'])
    expect(geminiModelChain(undefined, { GEOAGENT_MODEL_GEMINI: 'gemma-4-31b-it', GEOAGENT_MODEL_GEMINI_FALLBACKS: 'gemini-3.6-flash, gemma-4-31b-it' }))
      .toEqual(['gemma-4-31b-it', 'gemini-3.6-flash'])
    expect(geminiModelChain('gemini-3.1-pro-preview', { GEOAGENT_MODEL_GEMINI_FALLBACKS: '' })).toEqual(['gemini-3.1-pro-preview'])
    expect(isGemma('gemma-4-26b-a4b-it')).toBe(true)
    expect(isGemma('gemini-3.8-flash')).toBe(false)
  })
})

describe('request conversion', () => {
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'Planning', tool_calls: [{ id: 'gemini_call_0', type: 'function', function: { name: 'submit_plan', arguments: '{"kind":"plan"}' } }] },
    { role: 'tool', tool_call_id: 'gemini_call_0', content: 'done' },
    { role: 'user', content: 'now write it' },
  ]

  it('moves the system prompt out and merges tool results with the following user text', () => {
    const { system, contents } = toGeminiContents(history, 'gemini-3.8-flash')
    expect(system).toBe('sys')
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user'])
    expect(contents[2].parts![0].functionResponse).toEqual({ name: 'submit_plan', response: { output: 'done' } })
    expect(contents[2].parts![1].text).toBe('now write it')
  })

  it('echoes the native model turn verbatim, thought signature included', () => {
    const native = { role: 'model', parts: [{ text: 'Planning' }, { functionCall: { name: 'submit_plan', args: { kind: 'plan' } }, thoughtSignature: SIG }] }
    const { contents } = toGeminiContents(history.map((m) => (m.role === 'assistant' ? { ...m, native } : m)), 'gemini-3.8-flash')
    expect(contents[1]).toBe(native)
  })

  it('puts the documented dummy signature on a transferred function call, for Gemini 3 only', () => {
    expect(toGeminiContents(history, 'gemini-3.8-flash').contents[1].parts![1].thoughtSignature).toBe('skip_thought_signature_validator')
    expect(toGeminiContents(history, 'gemma-4-31b-it').contents[1].parts![1].thoughtSignature).toBeUndefined()
    expect(toGeminiContents(history, 'gemini-2.5-flash').contents[1].parts![1].thoughtSignature).toBeUndefined()
  })

  it('sets thinking only where thinkingLevel is accepted, and declares tools by JSON schema', () => {
    const tools = [{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object', properties: {} } } }]
    const g3 = geminiConfig('gemini-3.8-flash', 'sys', tools, signal, {})
    expect(g3.thinkingConfig?.thinkingLevel).toBe('LOW')
    expect(geminiConfig('gemini-3.8-flash', 'sys', tools, signal, { GEOAGENT_GEMINI_THINKING_SYNTHESIS: 'high' }, 'synthesis').thinkingConfig?.thinkingLevel).toBe('HIGH')
    expect(g3.temperature).toBeUndefined()
    expect(geminiConfig('gemma-4-31b-it', 'sys', tools, signal, {})).toMatchObject({ temperature: 1, topP: 0.95, topK: 64 })
    expect(g3.systemInstruction).toBe('sys')
    expect((g3.tools as any)[0].functionDeclarations[0]).toMatchObject({ name: 't', parametersJsonSchema: { type: 'object' } })
    expect(geminiConfig('gemma-4-31b-it', 'sys', tools, signal, {}).thinkingConfig).toBeUndefined()
    expect(geminiConfig('gemini-2.5-flash', 'sys', tools, signal, {}).thinkingConfig).toBeUndefined()
    expect(geminiConfig('gemini-3.8-flash', '', [], signal, {}).tools).toBeUndefined()
  })
})

describe('createGeminiStream', () => {
  it('streams text and a function call, and emits the native turn with its signature', async () => {
    const client = fakeClient(() => chunks(
      chunk([{ text: 'Plan' }]),
      chunk([{ text: 'ning.' }, { functionCall: { name: 'submit_plan', args: { kind: 'plan' } }, thoughtSignature: SIG }], 'STOP'),
    ))
    const events = await drain(createGeminiStream([{ role: 'user', content: 'q' }], [], { apiKey: 'k' }, signal, { ...fast, client }))
    expect(events.filter((e) => e.type === 'text').map((e) => e.text).join('')).toBe('Planning.')
    expect(events.find((e) => e.type === 'tool_call')).toMatchObject({ id: 'gemini_call_0', name: 'submit_plan', args: { kind: 'plan' } })
    expect(events.find((e) => e.type === 'native').content).toEqual({
      role: 'model',
      parts: [{ text: 'Planning.' }, { functionCall: { name: 'submit_plan', args: { kind: 'plan' } }, thoughtSignature: SIG }],
    })
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' })
  })

  it('keeps a signature that arrives on an empty text part and skips thought summaries', async () => {
    const client = fakeClient(() => chunks(
      chunk([{ text: 'Hidden', thought: true }, { text: 'Answer' }]),
      chunk([{ text: '', thoughtSignature: SIG }], 'STOP'),
    ))
    const events = await drain(createGeminiStream([{ role: 'user', content: 'q' }], [], { apiKey: 'k' }, signal, { ...fast, client }))
    expect(events.filter((e) => e.type === 'text').map((e) => e.text)).toEqual(['Answer'])
    expect(events.find((e) => e.type === 'native').content.parts).toEqual([{ text: 'Answer' }, { text: '', thoughtSignature: SIG }])
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' })
  })

  it('maps MAX_TOKENS to length', async () => {
    const client = fakeClient(() => chunks(chunk([{ text: 'cut' }], 'MAX_TOKENS')))
    const events = await drain(createGeminiStream([{ role: 'user', content: 'q' }], [], { apiKey: 'k' }, signal, { ...fast, client }))
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'length' })
  })

  it('retries 503 with backoff, then succeeds on the same model', async () => {
    const sleep = vi.fn(async () => {})
    const client = fakeClient(() => { throw apiError(503) }, () => chunks(chunk([{ text: 'ok' }], 'STOP')))
    const events = await drain(createGeminiStream([{ role: 'user', content: 'q' }], [], { apiKey: 'k' }, signal, { ...fast, sleep, client }))
    expect(events[0]).toEqual({ type: 'text', text: 'ok' })
    expect(client.calls.map((c) => c.model)).toEqual(['gemini-3.8-flash', 'gemini-3.8-flash'])
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('also retries an error raised while reading the first chunk', async () => {
    const client = fakeClient(
      () => (async function* () { throw apiError(429, 'quota') })(),
      () => chunks(chunk([{ text: 'ok' }], 'STOP')),
    )
    const events = await drain(createGeminiStream([{ role: 'user', content: 'q' }], [], { apiKey: 'k' }, signal, { ...fast, client }))
    expect(events[0]).toEqual({ type: 'text', text: 'ok' })
  })

  it('moves down the fallback chain when a model keeps failing, then reports exhaustion honestly', async () => {
    const client = fakeClient((model) => {
      if (model === 'gemini-3.5-flash') return chunks(chunk([{ text: 'from fallback' }], 'STOP'))
      throw apiError(503)
    })
    const events = await drain(createGeminiStream([{ role: 'user', content: 'q' }], [], { apiKey: 'k' }, signal, { ...fast, client }))
    expect(events[0]).toEqual({ type: 'text', text: 'from fallback' })
    expect(events.some((e) => e.type === 'native')).toBe(false) // its signatures belong to the fallback model
    expect(client.calls.filter((c) => c.model === 'gemini-3.8-flash')).toHaveLength(RETRY_POLICY.attempts)

    const dead = fakeClient(() => { throw apiError(503, 'overloaded') })
    await expect(drain(createGeminiStream([{ role: 'user', content: 'q' }], [], { apiKey: 'k' }, signal, { ...fast, client: dead })))
      .rejects.toThrow(/Every model in the fallback chain/)
  })

  it('stops a model that loops instead of writing until the output limit', async () => {
    const client = fakeClient(() => chunks(...Array.from({ length: 30 }, () => chunk([{ text: 'a a a a a a a ' }]))))
    await expect(drain(createGeminiStream([{ role: 'user', content: 'q' }], [], { apiKey: 'k' }, signal, { ...fast, client }))).rejects.toThrow(/repeating itself/)
  })

  it('does not retry or fall back on a client error such as 400 or 401', async () => {
    for (const status of [400, 401]) {
      const client = fakeClient(() => { throw apiError(status, 'bad') })
      await expect(drain(createGeminiStream([{ role: 'user', content: 'q' }], [], { apiKey: 'k' }, signal, { ...fast, client }))).rejects.toThrow(String(status))
      expect(client.calls).toHaveLength(1)
    }
  })

  it('never lets the API key reach an error message', async () => {
    const client = fakeClient(() => { throw apiError(400, 'API key not valid: AIzaSyFAKEKEY1234567890') })
    await expect(drain(createGeminiStream([{ role: 'user', content: 'q' }], [], { apiKey: 'AIzaSyFAKEKEY1234567890' }, signal, { ...fast, client })))
      .rejects.toThrow(/\[redacted\]/)
  })

  it('stops retrying when the caller aborts', async () => {
    const ac = new AbortController()
    const client = fakeClient(() => { ac.abort(); throw apiError(503) })
    await expect(drain(createGeminiStream([{ role: 'user', content: 'q' }], [], { apiKey: 'k' }, ac.signal, { ...fast, client }))).rejects.toBeTruthy()
    expect(client.calls).toHaveLength(1)
  })

  it('throws when the prompt was blocked', async () => {
    const client = fakeClient(() => chunks({ promptFeedback: { blockReason: 'SAFETY' } }))
    await expect(drain(createGeminiStream([{ role: 'user', content: 'q' }], [], { apiKey: 'k' }, signal, { ...fast, client }))).rejects.toThrow(/blocked.*SAFETY/)
  })
})

describe('token accounting and caps', () => {
  it('reports what the provider billed for a turn as a usage event before done', async () => {
    const client = fakeClient(() => chunks(
      chunk([{ text: 'Hello' }]),
      { ...chunk([{ text: ' there' }], 'STOP'), usageMetadata: { promptTokenCount: 2100, candidatesTokenCount: 40, thoughtsTokenCount: 120, cachedContentTokenCount: 1800 } },
    ))
    const events = await drain(createGeminiStream([{ role: 'user', content: 'hi' }], [], { apiKey: 'k', model: 'gemini-3.8-flash', phase: 'synthesis' }, signal, { client, ...fast }))
    const usage = events.find((e) => e.type === 'usage')
    expect(usage).toEqual({ type: 'usage', usage: { promptTokens: 2100, outputTokens: 40, thoughtTokens: 120, cachedTokens: 1800 } })
    expect(events.at(-1).type).toBe('done')
  })

  it('caps output per phase and honours the override', async () => {
    const { maxOutputFor } = await import('../gemini')
    expect(maxOutputFor('plan', {})).toBe(6144)
    expect(maxOutputFor('synthesis', {})).toBe(8192)
    expect(maxOutputFor('plan', { GEOAGENT_MAX_OUTPUT_PLAN: '2048' })).toBe(2048)
    expect(maxOutputFor('plan', { GEOAGENT_MAX_OUTPUT_PLAN: '5' })).toBe(6144)
  })

  it('makes the per-call LLM timeout configurable, default unchanged', async () => {
    const { llmTimeoutMs } = await import('../llm')
    expect(llmTimeoutMs({})).toBe(110_000)
    expect(llmTimeoutMs({ GEOAGENT_LLM_TIMEOUT_MS: '600000' })).toBe(600_000)
    expect(llmTimeoutMs({ GEOAGENT_LLM_TIMEOUT_MS: '50' })).toBe(110_000)
    expect(llmTimeoutMs({ GEOAGENT_LLM_TIMEOUT_MS: 'soon' })).toBe(110_000)
  })
})

describe('backoff', () => {
  it('grows exponentially, is jittered, capped, and honours the server hint', () => {
    const lo = (n: number) => backoffMs(n, undefined, RETRY_POLICY, () => 0)
    const hi = (n: number) => backoffMs(n, undefined, RETRY_POLICY, () => 1)
    expect(lo(0)).toBe(500)
    expect(hi(0)).toBe(1000)
    expect(hi(1)).toBe(2000)
    expect(hi(10)).toBe(RETRY_POLICY.maxDelayMs)
    expect(backoffMs(0, 7000, RETRY_POLICY, () => 0)).toBe(7000)
  })
  it('unwraps a doubly JSON-wrapped provider error to its message', () => {
    const inner = JSON.stringify({ error: { code: 402, message: 'Your prepayment credits are depleted.' } })
    expect(apiMessage(JSON.stringify({ error: { message: inner } }))).toBe('Your prepayment credits are depleted.')
    expect(apiMessage('plain text')).toBe('plain text')
  })
  it('reads the retry delay out of a Gemini error', () => {
    expect(retryAfterMs(new Error('{"error":{"details":[{"retryDelay":"34s"}]}}'))).toBe(34_000)
    expect(retryAfterMs(new Error('Retry-After: 5'))).toBe(5000)
    expect(retryAfterMs(new Error('boom'))).toBeUndefined()
  })
})
