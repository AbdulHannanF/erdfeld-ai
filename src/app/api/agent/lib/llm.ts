/** Multi-provider streaming LLM: one request builder per provider, one internal event stream out. */

import { assertSafeUrl } from '@/lib/url-guard'

import { createGeminiStream, type Phase } from './gemini'
import { anthropicEvents, openaiEvents, toAnthropicMessages, type LLMEvent } from './llm-adapters'
import { defaultModel, type ModelProvider } from './models'
import { scrubSecret } from './providers'

export async function* readableToAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * P7.1 — deterministic, offline stub provider used only by the SSE-contract
 * smoke test (`scripts/sse-smoke-test.mjs`). It emits canned internal events so the
 * agentic loop in `route.ts` exercises the full event sequence
 * (plan → tool_call → layer → token → done) with no network call and no real
 * LLM. Two-phase + stateless: it decides what to emit purely from the message
 * history, so concurrent requests can't interfere.
 *
 *   Phase 1 (no tools run yet): a one-step `submit_plan` calling `render_to_map`
 *     (the only network-free tool — keeps the smoke test hermetic).
 *   Phase 2 (route has fed back "All planned tools have executed"): a plain
 *     synthesis sentence with no tool calls, so the loop terminates.
 */
export async function* createStubStream(messages: any[]): AsyncGenerator<LLMEvent> {
  const last = messages[messages.length - 1]
  const lastContent = typeof last?.content === 'string' ? last.content : ''
  const toolsAlreadyRan = /All planned tools have executed|All tools have completed/i.test(lastContent)

  // Steps are written with `args` objects here; the wire format carries them as `args_json`.
  const submitPlan = (steps: Array<{ tool: string; args: unknown; reason: string; depends_on?: number[] }>): LLMEvent => ({
    type: 'tool_call', id: 'stub-plan', name: 'submit_plan',
    args: { kind: 'plan', steps: steps.map(({ args, ...rest }) => ({ ...rest, args_json: JSON.stringify(args) })) },
  })

  if (!toolsAlreadyRan) {
    // Offline visualization fixture: layer -> style_layer + make_chart over its features.
    const user = String(messages.find((m) => m?.role === 'user')?.content ?? '')
    // Live-data E2E: "stub-run: [{tool, args}, ...]" runs exactly those real tools,
    // so the UI can be exercised against real imagery without an LLM.
    const direct = user.match(/stub-run:\s*(\[[\s\S]*\])/)
    if (direct) {
      const steps = (JSON.parse(direct[1]) as any[]).map((s, i) => ({ tool: s.tool, args: s.args ?? {}, reason: `stub-run step ${i}` }))
      yield submitPlan(steps)
      yield { type: 'done', finishReason: 'tool_calls' }
      return
    }
    if (/styled fields/i.test(user)) {
      const spec = {
        data: { name: '${node:0}#features' },
        mark: { type: 'bar', cornerRadiusEnd: 2 },
        encoding: {
          x: { field: 'name', type: 'nominal', sort: null, title: null },
          y: { field: 'ndvi', type: 'quantitative', title: 'Median NDVI' },
        },
      }
      yield { type: 'text', text: 'Planning.' }
      yield submitPlan([
        { tool: 'render_to_map', args: { name: 'Fields', fixture: 'fields' }, reason: 'fixture parcels' },
        { tool: 'style_layer', args: { result_id: { from_node: 0 }, property: 'ndvi', colormap: 'rdylgn' }, reason: 'colour by ndvi', depends_on: [0] },
        { tool: 'make_chart', args: { spec: JSON.stringify(spec), title: 'Median NDVI per field' }, reason: 'chart ndvi', depends_on: [0] },
      ])
      yield { type: 'done', finishReason: 'tool_calls' }
      return
    }
    yield { type: 'text', text: 'Planning the analysis.' }
    yield submitPlan([
      {
        tool: 'render_to_map',
        args: { name: 'Smoke Test Layer', data_type: 'geojson' },
        reason: 'SSE-contract smoke test',
      },
    ])
    yield { type: 'done', finishReason: 'tool_calls' }
    return
  }

  // stub-run answers with the executed tools' own summaries (the plan digest), so the text shown
  // is what the tools measured; the stub never writes a narrative of its own.
  const ran = String(messages.find((m) => m?.role === 'user')?.content ?? '')
  const digest = String([...messages].reverse().find((m) => m?.role === 'tool')?.content ?? '')
  if (/stub-run:/.test(ran) && digest) {
    const lines = digest.replace(/^Plan executed\. Results:\n/, '').split('\n')
      .map((l) => l.replace(/^Step \d+ — \S+ \([^)]*\): /, ''))
      // bracketed lines are instructions to a model (citation hints, validation notes); the UI shows badges
      .filter((l) => l.trim() && !/^\[(?!skipped\])/.test(l.trim()))
    yield { type: 'text', text: lines.join('\n\n') }
  } else {
    yield { type: 'text', text: 'Smoke-test analysis complete — the stub layer was rendered.' }
  }
  yield { type: 'done', finishReason: 'stop' }
}

/** Hard cap on a single provider stream. Kept under the route's `maxDuration` (300 s) so a
 *  hung/zombie connection is dropped before the function itself is killed. The signal also
 *  carries the request-scoped client-abort (P7.3) so a disconnect cancels the stream. */
const DEFAULT_LLM_TIMEOUT_MS = 110_000

/** Per-call limit. A local model on CPU (an Ollama box with no GPU) can need minutes for one turn: raise it with
 *  GEOAGENT_LLM_TIMEOUT_MS (milliseconds, 10 000 or more). The whole run still ends at the route's own budget. */
export function llmTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.GEOAGENT_LLM_TIMEOUT_MS)
  return Number.isFinite(n) && n >= 10_000 ? Math.floor(n) : DEFAULT_LLM_TIMEOUT_MS
}

export async function createProviderStream(
  messages: any[],
  tools: any[],
  config: { provider?: string; apiKey?: string; baseUrl?: string; model?: string; clientBaseUrl?: boolean; phase?: Phase },
  abortSignal?: AbortSignal,
): Promise<AsyncIterable<LLMEvent>> {
  const { provider, apiKey, baseUrl, model } = config

  // P7.1 — test-only stub. `provider` comes from the request body, so this is
  // gated behind an env flag that a real deployment never sets; without it the
  // stub falls through to the `default` "unknown provider" throw below.
  if (provider === 'stub') {
    if (process.env.AGENT_ALLOW_STUB === '1') {
      return createStubStream(messages)
    }
    throw new Error('Stub provider is disabled. Set AGENT_ALLOW_STUB=1 (test/CI only).')
  }

  // P7.3 — every provider call is bounded: a generous timeout for a hung connection, combined
  // with the request-scoped client-abort so a disconnected reader cancels it.
  const timeoutSignal = AbortSignal.timeout(llmTimeoutMs())
  const signal = abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal

  // Gemini and Gemma go through the native SDK adapter; the rest speak HTTP below.
  if (provider === 'gemini') {
    if (!apiKey) throw new Error('No Gemini API key. Set GEMINI_API_KEY on the server or enter yours in Settings → AI Model.')
    return createGeminiStream(messages, tools, { apiKey, model, phase: config.phase }, signal)
  }

  // A base URL the browser chose may not point the server at an internal address.
  if (config.clientBaseUrl && baseUrl) await assertSafeUrl(baseUrl)

  // `native` carries a provider's own turn record (see LLMEvent); only its adapter reads it.
  messages = messages.map(({ native: _native, ...m }) => m)

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  let url: string

  switch (provider) {
    case 'ollama':
      url = `${(baseUrl || 'http://localhost:11434').replace(/\/$/, '')}/v1/chat/completions`
      break
    case 'openai':
      url = 'https://api.openai.com/v1/chat/completions'
      headers['Authorization'] = `Bearer ${apiKey}`
      break
    case 'claude':
      url = `${(baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`
      headers['x-api-key'] = apiKey || ''
      headers['anthropic-version'] = '2023-06-01'
      break
    case 'custom':
      url = `${(baseUrl || '').replace(/\/$/, '')}/chat/completions`
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
      break
    default:
      throw new Error(`Unknown provider "${provider}". Open Settings → AI Model.`)
  }

  const selectedModel = model || defaultModel(provider as ModelProvider)

  let body: any
  if (provider === 'claude') {
    const converted = toAnthropicMessages(messages)
    // Prompt caching: the agent loop re-sends the same tools + system prompt every iteration and
    // the conversation only grows, so cache up to the system prompt and up to the latest turn.
    const ephemeral = { type: 'ephemeral' } as const
    const lastTurn = converted.messages[converted.messages.length - 1]
    if (lastTurn) {
      const blocks = lastTurn.content
      blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: ephemeral }
    }
    body = {
      model: selectedModel,
      max_tokens: 8192,
      system: [{ type: 'text', text: converted.system || 'You are Erdfeld AI, an expert geospatial AI analyst.', cache_control: ephemeral }],
      messages: converted.messages,
      tools: tools.map((t: any) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      })),
      stream: true,
    }
  } else if (provider === 'ollama') {
    body = { model: selectedModel, messages, tools, stream: true, stream_options: { include_usage: true }, max_tokens: 2048 }
  } else {
    body = { model: selectedModel, messages, tools, stream: true }
  }

  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`AI provider (${provider}) error ${response.status}: ${scrubSecret(errText, apiKey).slice(0, 200)}`)
  }
  if (!response.body) throw new Error('No response body from AI provider')
  const bytes = readableToAsyncIterable(response.body)
  return provider === 'claude' ? anthropicEvents(bytes) : openaiEvents(bytes)
}
