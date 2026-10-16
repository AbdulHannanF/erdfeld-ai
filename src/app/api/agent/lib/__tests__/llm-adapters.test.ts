import { describe, it, expect } from 'vitest'
import { anthropicEvents, openaiEvents, sseData, toAnthropicMessages, type LLMEvent } from '../llm-adapters'

/**
 * Recorded-style raw SSE fixtures: the same assistant turn ("Checking vegetation at 31.1°N." then a
 * fetch_ndvi call with {"product":"imagery"}) as each vendor streams it.
 */

const sse = (...frames: string[]) => frames.join('')
const data = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`

const OPENAI = sse(
  data({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }),
  data({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: 'Checking vegetation ' }, finish_reason: null }] }),
  data({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: 'at 31.1°N.' }, finish_reason: null }] }),
  data({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'fetch_ndvi', arguments: '' } }] }, finish_reason: null }] }),
  data({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"prod' } }] }, finish_reason: null }] }),
  data({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'uct":"imagery"}' } }] }, finish_reason: null }] }),
  data({ id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  'data: [DONE]\n\n',
)

// Gemini's OpenAI-compat endpoint sends the whole call in one chunk, and no [DONE] is required.
const GEMINI = sse(
  data({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Checking vegetation at 31.1°N.' } }], model: 'gemini-flash-latest' }),
  data({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ id: 'gem-1', type: 'function', function: { name: 'fetch_ndvi', arguments: '{"product":"imagery"}' } }] }, finish_reason: 'tool_calls' }] }),
)

// Ollama /v1: finish_reason 'stop' even with tool calls; calls on the final chunk's `message`.
const OLLAMA = sse(
  data({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Checking vegetation ' }, finish_reason: null }] }),
  data({ choices: [{ index: 0, delta: { content: 'at 31.1°N.' }, finish_reason: null }] }),
  data({ choices: [{ index: 0, delta: {}, message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_ol', type: 'function', function: { name: 'fetch_ndvi', arguments: { product: 'imagery' } } }] }, finish_reason: 'stop' }] }),
  'data: [DONE]\n\n',
)

const ev = (event: string, o: unknown) => `event: ${event}\ndata: ${JSON.stringify(o)}\n\n`
const ANTHROPIC = sse(
  ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5-5', stop_reason: null, usage: { input_tokens: 25, output_tokens: 1 } } }),
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ev('ping', { type: 'ping' }),
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking vegetation ' } }),
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'at 31.1°N.' } }),
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01', name: 'fetch_ndvi', input: {} } }),
  ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '' } }),
  ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"prod' } }),
  ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'uct": "ima' } }),
  ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'gery"}' } }),
  ev('content_block_stop', { type: 'content_block_stop', index: 1 }),
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 40 } }),
  ev('message_stop', { type: 'message_stop' }),
)

/** Feed `raw` as bytes cut every `size` bytes, so chunk boundaries fall mid-line and mid-character. */
async function* bytes(raw: string, size: number): AsyncGenerator<Uint8Array> {
  const all = new TextEncoder().encode(raw)
  for (let i = 0; i < all.length; i += size) yield all.slice(i, i + size)
}

async function collect(gen: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> {
  const out: LLMEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

/** Merge adjacent text events and blank the vendor-specific call id, for cross-vendor comparison. */
function normalise(events: LLMEvent[]): LLMEvent[] {
  const out: LLMEvent[] = []
  for (const e of events) {
    const last = out[out.length - 1]
    if (e.type === 'text' && last?.type === 'text') last.text += e.text
    else out.push(e.type === 'tool_call' ? { ...e, id: '' } : { ...e })
  }
  return out
}

const EXPECTED: LLMEvent[] = [
  { type: 'text', text: 'Checking vegetation at 31.1°N.' },
  { type: 'tool_call', id: '', name: 'fetch_ndvi', args: { product: 'imagery' } },
  { type: 'done', finishReason: 'tool_calls' },
]

describe.each([1, 7, 64, 100000])('provider streams yield the same events (chunk size %i bytes)', (size) => {
  it('OpenAI', async () => expect(normalise(await collect(openaiEvents(bytes(OPENAI, size))))).toEqual(EXPECTED))
  it('Gemini (OpenAI-compat)', async () => expect(normalise(await collect(openaiEvents(bytes(GEMINI, size))))).toEqual(EXPECTED))
  it('Ollama (tool_calls on the final message)', async () => expect(normalise(await collect(openaiEvents(bytes(OLLAMA, size))))).toEqual(EXPECTED))
  it('Anthropic (tool_use split over input_json_delta)', async () => expect(normalise(await collect(anthropicEvents(bytes(ANTHROPIC, size))))).toEqual(EXPECTED))
})

describe('adapter details', () => {
  it('keeps provider call ids', async () => {
    const ids = async (g: AsyncIterable<LLMEvent>) => (await collect(g)).filter((e) => e.type === 'tool_call').map((e: any) => e.id)
    expect(await ids(openaiEvents(bytes(OPENAI, 50)))).toEqual(['call_abc'])
    expect(await ids(anthropicEvents(bytes(ANTHROPIC, 50)))).toEqual(['toolu_01'])
  })

  it('emits a tool_call only once complete, and in index order for parallel OpenAI calls', async () => {
    const raw = sse(
      data({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'two', arguments: '{}' } }] } }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'one', arguments: '{"x"' } }] } }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: 'tool_calls' }] }),
    )
    const calls = (await collect(openaiEvents(bytes(raw, 9)))).filter((e) => e.type === 'tool_call')
    expect(calls).toMatchObject([{ id: 'a', name: 'one', args: { x: 1 } }, { id: 'b', name: 'two', args: {} }])
  })

  it('plain text turn: finish reason passes through, no tool calls', async () => {
    const raw = sse(data({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }), 'data: [DONE]\n\n')
    expect(await collect(openaiEvents(bytes(raw, 5)))).toEqual([{ type: 'text', text: 'hi' }, { type: 'done', finishReason: 'stop' }])
  })

  it('Anthropic stop reasons map to the OpenAI vocabulary', async () => {
    const stop = (reason: string) => collect(anthropicEvents(bytes(ev('message_delta', { type: 'message_delta', delta: { stop_reason: reason } }), 8)))
    expect(await stop('end_turn')).toEqual([{ type: 'done', finishReason: 'stop' }])
    expect(await stop('max_tokens')).toEqual([{ type: 'done', finishReason: 'length' }])
  })

  it('reports unparseable tool arguments instead of running with empty ones', async () => {
    const raw = sse(data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'fetch_dem', arguments: '{"a":' } }] }, finish_reason: 'tool_calls' }] }))
    const call: any = (await collect(openaiEvents(bytes(raw, 100)))).find((e) => e.type === 'tool_call')
    expect(call.args).toEqual({})
    expect(call.argsError).toMatch(/not valid JSON/)
  })

  it('drops a tool_use cut off before content_block_stop', async () => {
    const raw = sse(
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'fetch_dem', input: {} } }),
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a' } }),
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
    )
    expect(await collect(anthropicEvents(bytes(raw, 30)))).toEqual([{ type: 'done', finishReason: 'length' }])
  })

  it('throws provider stream errors', async () => {
    await expect(collect(anthropicEvents(bytes(ev('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), 20)))).rejects.toThrow('Overloaded')
    await expect(collect(openaiEvents(bytes(data({ error: { message: 'quota exceeded' } }), 20)))).rejects.toThrow('quota exceeded')
  })

  it('sseData handles CRLF, comments and multi-line data', async () => {
    const out: string[] = []
    for await (const d of sseData(bytes(': keep-alive\r\n\r\ndata: a\r\ndata: b\r\n\r\ndata: [DONE]\r\n\r\ndata: never\r\n\r\n', 3))) out.push(d)
    expect(out).toEqual(['a\nb'])
  })
})

describe('toAnthropicMessages', () => {
  const history = [
    { role: 'system', content: 'You are GeoAgent.' },
    { role: 'user', content: 'assess flood risk' },
    {
      role: 'assistant',
      content: 'Looking.',
      tool_calls: [
        { id: 'toolu_1', type: 'function', function: { name: 'fetch_dem', arguments: '{"a":1}' } },
        { id: 'toolu_2', type: 'function', function: { name: 'fetch_sar', arguments: '' } },
      ],
    },
    { role: 'tool', tool_call_id: 'toolu_1', content: 'DEM ok' },
    { role: 'user', content: 'fallback hint' },
    { role: 'tool', tool_call_id: 'toolu_2', content: 'SAR ok' },
    { role: 'user', content: 'All tools have completed.' },
  ]

  it('moves the system prompt to the top level', () => {
    const r = toAnthropicMessages(history)
    expect(r.system).toBe('You are GeoAgent.')
    expect(r.messages.some((m) => (m.role as string) === 'system')).toBe(false)
  })

  it('converts tool calls to tool_use blocks and tool messages to tool_result blocks', () => {
    const { messages } = toAnthropicMessages(history)
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 'toolu_1', name: 'fetch_dem', input: { a: 1 } },
        { type: 'tool_use', id: 'toolu_2', name: 'fetch_sar', input: {} },
      ],
    })
  })

  it('merges consecutive user-side messages into one turn, tool results first, so roles alternate', () => {
    const { messages } = toAnthropicMessages(history)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'DEM ok' },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: 'SAR ok' },
      { type: 'text', text: 'fallback hint' },
      { type: 'text', text: 'All tools have completed.' },
    ])
  })

  it('omits empty assistant turns and text-less blocks', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't', type: 'function', function: { name: 'x', arguments: '{}' } }] },
    ])
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
    ])
  })
})
