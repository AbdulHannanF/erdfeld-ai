/**
 * Provider adapters: turn each vendor's raw SSE byte stream into one internal event type,
 * so the agent loop never sees a vendor wire format (Gemini has its own SDK adapter in
 * ./gemini.ts and emits the same events). Also converts the OpenAI-shaped
 * conversation the route builds into the Anthropic Messages request shape.
 *
 *   text       a piece of assistant prose
 *   tool_call  one COMPLETE tool call (emitted only once its arguments are fully received)
 *   done       end of stream; `finishReason` is normalised to OpenAI's vocabulary
 *              ('stop' | 'tool_calls' | 'length' | …), 'unknown' if the provider sent none
 */

/** What one model call used, from the provider's own usage record. */
export interface TokenUsage {
  promptTokens: number
  outputTokens: number
  /** Thinking tokens, billed as output. */
  thoughtTokens: number
  /** Prompt tokens served from the provider's cache (billed at a reduced rate). */
  cachedTokens: number
}

export type LLMEvent =
  | { type: 'text'; text: string }
  | {
      type: 'tool_call'
      id: string
      name: string
      args: Record<string, unknown>
      /** Set when the model's argument JSON could not be parsed; `args` is then `{}`. */
      argsError?: string
    }
  /** The provider's own record of the model turn (Gemini: the SDK `Content`, with its thought
   *  signatures). The loop stores it on the assistant message and the adapter sends it back
   *  verbatim; no other code reads it. */
  | { type: 'native'; content: unknown }
  /** Tokens the provider billed for this model turn (when it reports them). */
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; finishReason: string }

// ---------------------------------------------------------------------------
// SSE framing
// ---------------------------------------------------------------------------

/** Split a byte stream into SSE `data:` payloads. Handles chunk boundaries anywhere (mid-line,
 *  mid-UTF-8-character), CRLF, comments and multi-line data; stops at `[DONE]`. */
export async function* sseData(stream: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (line === '') {
        if (data.length) {
          const payload = data.join('\n')
          data = []
          if (payload === '[DONE]') return
          yield payload
        }
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''))
      }
      // `event:`, `id:`, `retry:` and `:comment` lines carry nothing we need.
    }
  }
  if (data.length && data.join('\n') !== '[DONE]') yield data.join('\n')
}

async function* jsonFrames(stream: AsyncIterable<Uint8Array>): AsyncGenerator<any> {
  for await (const payload of sseData(stream)) {
    try {
      yield JSON.parse(payload)
    } catch {
      throw new Error(`AI provider sent a malformed stream chunk: ${payload.slice(0, 120)}`)
    }
  }
}

function parseArgs(raw: unknown): Pick<Extract<LLMEvent, { type: 'tool_call' }>, 'args' | 'argsError'> {
  if (raw && typeof raw === 'object') return { args: raw as Record<string, unknown> }
  if (typeof raw !== 'string' || raw.trim() === '') return { args: {} }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { args: parsed }
    return { args: {}, argsError: 'tool arguments must be a JSON object' }
  } catch (e: any) {
    return { args: {}, argsError: `tool arguments are not valid JSON (${e.message})` }
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible: OpenAI, Gemini (OpenAI-compat endpoint), custom, Ollama /v1
// ---------------------------------------------------------------------------

export async function* openaiEvents(stream: AsyncIterable<Uint8Array>): AsyncGenerator<LLMEvent> {
  const calls = new Map<number, { id: string; name: string; args: string }>()
  let finishReason = ''
  let reported: TokenUsage | undefined

  // Fragments arrive keyed by `index` (OpenAI streams one call across many chunks). A fragment
  // with no index is a whole call, which is how Ollama and some compat servers send them.
  const accumulate = (tcs: any[]) => {
    for (const tc of tcs) {
      const idx = typeof tc.index === 'number' ? tc.index : calls.size
      let e = calls.get(idx)
      if (!e) {
        e = { id: tc.id || `call_${idx}`, name: '', args: '' }
        calls.set(idx, e)
      }
      if (tc.id) e.id = tc.id
      if (tc.function?.name) e.name = tc.function.name
      const a = tc.function?.arguments
      if (a !== undefined && a !== null) e.args += typeof a === 'string' ? a : JSON.stringify(a)
    }
  }

  for await (const chunk of jsonFrames(stream)) {
    if (chunk.error) throw new Error(`AI provider stream error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`)
    // The usage record arrives on a final chunk with no choices (OpenAI `stream_options.include_usage`, Ollama).
    if (chunk.usage && typeof chunk.usage.prompt_tokens === 'number') {
      reported = {
        promptTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        thoughtTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
        cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
      }
    }
    const choice = chunk.choices?.[0]
    if (!choice) continue
    if (choice.delta?.content) yield { type: 'text', text: choice.delta.content }
    if (choice.delta?.tool_calls) accumulate(choice.delta.tool_calls)
    // Ollama may put the tool calls on the final `message` instead of `delta`.
    else if (choice.message?.tool_calls) accumulate(choice.message.tool_calls)
    if (choice.finish_reason) finishReason = choice.finish_reason
  }

  for (const idx of [...calls.keys()].sort((a, b) => a - b)) {
    const { id, name, args } = calls.get(idx)!
    yield { type: 'tool_call', id, name, ...parseArgs(args) }
  }
  // Some servers (Ollama) report 'stop' even when the turn made tool calls.
  if (reported) yield { type: 'usage', usage: reported }
  yield { type: 'done', finishReason: calls.size > 0 ? 'tool_calls' : finishReason || 'unknown' }
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

const ANTHROPIC_STOP: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
}

export async function* anthropicEvents(stream: AsyncIterable<Uint8Array>): AsyncGenerator<LLMEvent> {
  const blocks = new Map<number, { id: string; name: string; json: string }>()
  let finishReason = ''

  for await (const ev of jsonFrames(stream)) {
    switch (ev.type) {
      case 'content_block_start':
        if (ev.content_block?.type === 'tool_use') {
          blocks.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: '' })
        }
        break
      case 'content_block_delta':
        if (ev.delta?.type === 'text_delta' && ev.delta.text) {
          yield { type: 'text', text: ev.delta.text }
        } else if (ev.delta?.type === 'input_json_delta') {
          const b = blocks.get(ev.index)
          if (b) b.json += ev.delta.partial_json ?? ''
        }
        break
      case 'content_block_stop': {
        const b = blocks.get(ev.index)
        if (b) {
          blocks.delete(ev.index)
          yield { type: 'tool_call', id: b.id, name: b.name, ...parseArgs(b.json) }
        }
        break
      }
      case 'message_delta':
        if (ev.delta?.stop_reason) finishReason = ANTHROPIC_STOP[ev.delta.stop_reason] ?? ev.delta.stop_reason
        break
      case 'error':
        throw new Error(`AI provider stream error: ${ev.error?.message ?? JSON.stringify(ev.error)}`)
    }
  }
  // A tool_use block still open here was cut off (e.g. max_tokens); it is dropped, never guessed.
  yield { type: 'done', finishReason: finishReason || 'unknown' }
}

// ---------------------------------------------------------------------------
// Anthropic request conversion
// ---------------------------------------------------------------------------

type AnthropicBlock = (
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
) & { cache_control?: { type: 'ephemeral' } }

/**
 * Convert the OpenAI-shaped history the route builds into Anthropic's shape: system prompt
 * to the top level, assistant `tool_calls` to `tool_use` blocks, `tool` messages to
 * `tool_result` blocks. Consecutive user-side messages (tool results, then a follow-up
 * instruction) merge into one user turn, with tool_result blocks first as the API requires.
 */
export function toAnthropicMessages(messages: any[]): {
  system: string
  messages: { role: 'user' | 'assistant'; content: AnthropicBlock[] }[]
} {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const out: { role: 'user' | 'assistant'; content: AnthropicBlock[] }[] = []
  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return // the API rejects empty content
    const last = out[out.length - 1]
    if (last?.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }

  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') }])
    } else if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.tool_calls ?? []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments).args })
      }
      push('assistant', blocks)
    } else if (m.content) {
      push('user', [{ type: 'text', text: String(m.content) }])
    }
  }

  for (const msg of out) {
    if (msg.role === 'user') msg.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'))
  }
  return { system, messages: out }
}
