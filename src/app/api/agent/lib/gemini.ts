/**
 * Native Gemini transport on the `@google/genai` SDK (Gemini API, `generateContentStream`).
 *
 * One path serves Gemini and Gemma 4 model ids: both take system instructions and function
 * declarations on the Gemini API, so there is no per-family branch except the thinking config.
 *
 *  - Thought signatures: Gemini 3 requires the signature on a function-call part to come back
 *    on the next request or it answers 400. The model turn is therefore kept exactly as the
 *    SDK returned it (`native` event) and the route stores it on the assistant message; this
 *    module sends that content back verbatim. History with no native content (another
 *    provider's turns, a stub) gets the documented dummy signature on its first function call.
 *  - Reliability: 429/500/503, 408 and network errors are retried with bounded exponential
 *    backoff plus jitter (honouring the server's retry delay); when a model keeps failing, or is
 *    not served, the next model of the fallback chain is tried. Retries happen only before the
 *    first chunk reaches the caller, so a turn is never half-emitted twice.
 */

import {
  ApiError,
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Part,
} from '@google/genai'

import type { LLMEvent, TokenUsage } from './llm-adapters'
import { geminiModelChain, isGemma } from './models'
import { getLogger } from './logger'
import { scrubSecret } from './providers'

const log = getLogger('agent/gemini')

/** Documented placeholder for a function call the model did not produce (transferred history). */
const DUMMY_SIGNATURE = 'skip_thought_signature_validator'
const SYNTHETIC_ID = 'gemini_call_'
/** Output cap per phase (thinking tokens count against it). Writing a plan is a few hundred tokens and an analysis
 *  about a thousand; the old flat 16 384 only mattered when a model looped. Override: GEOAGENT_MAX_OUTPUT_PLAN /
 *  GEOAGENT_MAX_OUTPUT_SYNTHESIS. */
const MAX_OUTPUT_TOKENS: Record<'plan' | 'synthesis', number> = { plan: 6144, synthesis: 8192 }
export function maxOutputFor(phase: 'plan' | 'synthesis', env: Record<string, string | undefined>): number {
  const n = Number(env[`GEOAGENT_MAX_OUTPUT_${phase.toUpperCase()}`])
  return Number.isFinite(n) && n >= 512 ? Math.floor(n) : MAX_OUTPUT_TOKENS[phase]
}

export interface GeminiClient {
  models: {
    generateContentStream(params: { model: string; contents: Content[]; config?: GenerateContentConfig }): Promise<AsyncIterable<GenerateContentResponse>>
  }
}

export interface GeminiDeps {
  client?: GeminiClient
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
  env?: Record<string, string | undefined>
}

export interface RetryPolicy {
  /** Attempts per model, including the first. */
  attempts: number
  baseMs: number
  maxDelayMs: number
}
export const RETRY_POLICY: RetryPolicy = { attempts: 4, baseMs: 1000, maxDelayMs: 20_000 }

// ---------------------------------------------------------------------------
// Request conversion
// ---------------------------------------------------------------------------

const hasSignature = (m: string) => /^gemini-3/i.test(m.replace(/^models\//, ''))

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  try {
    const v = JSON.parse(String(raw ?? '{}'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

/** Convert the route's OpenAI-shaped history into Gemini contents + system instruction. */
export function toGeminiContents(messages: any[], model: string): { system: string; contents: Content[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const contents: Content[] = []
  const callNames = new Map<string, string>()
  const push = (role: 'user' | 'model', parts: Part[]) => {
    if (parts.length === 0) return
    const last = contents[contents.length - 1]
    if (last?.role === role && role === 'user') last.parts!.push(...parts)
    else contents.push({ role, parts })
  }

  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'assistant') {
      for (const tc of m.tool_calls ?? []) callNames.set(tc.id, tc.function.name)
      if (m.native) {
        contents.push(m.native as Content)
        continue
      }
      const parts: Part[] = []
      if (m.content) parts.push({ text: String(m.content) })
      let first = true
      for (const tc of m.tool_calls ?? []) {
        const part: Part = { functionCall: { name: tc.function.name, args: parseJsonObject(tc.function.arguments) } }
        if (first && hasSignature(model)) part.thoughtSignature = DUMMY_SIGNATURE
        first = false
        parts.push(part)
      }
      push('model', parts)
    } else if (m.role === 'tool') {
      const id = String(m.tool_call_id ?? '')
      push('user', [{
        functionResponse: {
          name: callNames.get(id) ?? 'unknown',
          ...(id && !id.startsWith(SYNTHETIC_ID) ? { id } : {}),
          response: { output: String(m.content ?? '') },
        },
      }])
    } else if (m.content) {
      push('user', [{ text: String(m.content) }])
    }
  }
  return { system, contents }
}

/** A model stuck in a loop ("a a a a...", "////...") writes until the output limit. The last 400 characters
 *  using five distinct characters or fewer is a loop, not prose or a table. */
export function isRepeating(text: string): boolean {
  return text.length >= 400 && new Set(text.slice(-400)).size <= 5
}

/** The sampling Google recommends for Gemma 4. Left to the API default, `gemma-4-31b-it` fell into
 *  endless repetition ("a a a a...", "////...") while copying result ids into citations in 4 of 5
 *  live analysis turns; with these it wrote a coherent analysis in the 3 turns tried (eval/RESULTS.md). */
const GEMMA_SAMPLING = { temperature: 1.0, topP: 0.95, topK: 64 } as const

/** The two kinds of model turn in the loop: writing the plan, and reading its results (analysis or replan). */
export type Phase = 'plan' | 'synthesis'

/** Thinking effort per phase, measured in eval/RESULTS.md. Override with GEOAGENT_GEMINI_THINKING_PLAN /
 *  GEOAGENT_GEMINI_THINKING_SYNTHESIS, or both at once with GEOAGENT_GEMINI_THINKING. */
export const DEFAULT_THINKING: Record<Phase, string> = { plan: 'low', synthesis: 'low' }

export function thinkingLevelFor(phase: Phase, env: Record<string, string | undefined>): ThinkingLevel {
  const raw = env[`GEOAGENT_GEMINI_THINKING_${phase.toUpperCase()}`] ?? env.GEOAGENT_GEMINI_THINKING ?? DEFAULT_THINKING[phase]
  const levels = ThinkingLevel as unknown as Record<string, ThinkingLevel>
  return levels[raw.trim().toUpperCase()] ?? levels[DEFAULT_THINKING[phase].toUpperCase()]
}

/** The request config for one model. Thinking is set only where the model takes `thinkingLevel`. */
export function geminiConfig(model: string, system: string, tools: any[], signal: AbortSignal, env: Record<string, string | undefined>, phase: Phase = 'plan'): GenerateContentConfig {
  const config: GenerateContentConfig = {
    maxOutputTokens: maxOutputFor(phase, env),
    abortSignal: signal,
    httpOptions: { retryOptions: { attempts: 1 } }, // retries are ours, so Retry-After and fallbacks agree
  }
  if (system) config.systemInstruction = system
  if (tools.length > 0) {
    config.tools = [{
      functionDeclarations: tools.map((t: any) => ({
        name: t.function.name,
        description: t.function.description,
        parametersJsonSchema: t.function.parameters,
      })),
    }]
    config.toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } }
  }
  if (hasSignature(model) && !isGemma(model)) {
    config.thinkingConfig = { thinkingLevel: thinkingLevelFor(phase, env) }
  }
  if (isGemma(model)) Object.assign(config, GEMMA_SAMPLING)
  return config
}

// ---------------------------------------------------------------------------
// Errors and retry
// ---------------------------------------------------------------------------

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504])

function statusOf(err: unknown): number | undefined {
  if (err instanceof ApiError) return err.status
  const s = (err as any)?.status ?? (err as any)?.code
  return typeof s === 'number' ? s : undefined
}

const isAbort = (err: unknown, signal: AbortSignal) => signal.aborted || (err as any)?.name === 'AbortError'

/** The server's own retry hint, in ms: a `retryDelay: "34s"` detail or a `Retry-After` mention. */
export function retryAfterMs(err: unknown): number | undefined {
  const text = String((err as any)?.message ?? '')
  const m = text.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/) ?? text.match(/retry[- ]after"?\s*[:=]?\s*"?(\d+(?:\.\d+)?)/i)
  return m ? Math.round(Number(m[1]) * 1000) : undefined
}

/** The human message inside the (sometimes doubly JSON-wrapped) error body the SDK reports. */
export function apiMessage(raw: string): string {
  let msg = raw
  for (let i = 0; i < 3; i++) {
    try {
      const inner = JSON.parse(msg)?.error?.message
      if (typeof inner !== 'string') break
      msg = inner
    } catch {
      break
    }
  }
  return msg.replace(/\s+/g, ' ').trim()
}

export function backoffMs(attempt: number, hint: number | undefined, policy: RetryPolicy, random: () => number): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseMs * 2 ** attempt)
  const jittered = exp / 2 + random() * (exp / 2) // 50-100 % of the step
  return hint !== undefined ? Math.max(hint, jittered) : jittered
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason) }, { once: true })
  })

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

const FINISH: Record<string, string> = { STOP: 'stop', MAX_TOKENS: 'length' }

/** Open the stream for one model and read its first chunk, retrying transient failures. */
async function openWithRetry(
  client: GeminiClient, model: string, params: { contents: Content[]; config: GenerateContentConfig },
  signal: AbortSignal, deps: Required<Pick<GeminiDeps, 'sleep' | 'random'>>, apiKey: string | undefined,
): Promise<{ first: IteratorResult<GenerateContentResponse>; it: AsyncIterator<GenerateContentResponse> }> {
  let lastErr: unknown
  for (let attempt = 0; attempt < RETRY_POLICY.attempts; attempt++) {
    try {
      const stream = await client.models.generateContentStream({ model, ...params })
      const it = stream[Symbol.asyncIterator]()
      return { first: await it.next(), it }
    } catch (err) {
      lastErr = err
      if (isAbort(err, signal)) throw err
      const status = statusOf(err)
      const transient = status === undefined ? true : RETRYABLE.has(status)
      if (!transient || attempt === RETRY_POLICY.attempts - 1) break
      const hint = retryAfterMs(err)
      // A server asking for a long pause is better served by the next model than by waiting.
      if (hint !== undefined && hint > RETRY_POLICY.maxDelayMs) break
      const wait = backoffMs(attempt, hint, RETRY_POLICY, deps.random)
      log.warn({ model, status, attempt: attempt + 1, wait_ms: Math.round(wait) }, 'gemini request failed; retrying')
      await deps.sleep(wait, signal)
    }
  }
  const status = statusOf(lastErr)
  const message = scrubSecret(apiMessage(String((lastErr as any)?.message ?? lastErr)), apiKey).slice(0, 300)
  throw Object.assign(new Error(`AI provider (gemini) error ${status ?? 'network'} on ${model}: ${message}`), { status })
}

/** Should the next model in the chain be tried after this failure? */
function fallbackWorthy(err: unknown): boolean {
  const status = (err as any)?.status as number | undefined
  return status === undefined || RETRYABLE.has(status) || status === 404
}

export async function* createGeminiStream(
  messages: any[],
  tools: any[],
  config: { apiKey?: string; model?: string; phase?: Phase },
  signal: AbortSignal,
  deps: GeminiDeps = {},
): AsyncGenerator<LLMEvent> {
  const env = deps.env ?? process.env
  const client: GeminiClient = deps.client ?? (new GoogleGenAI({ apiKey: config.apiKey }) as unknown as GeminiClient)
  const rt = { sleep: deps.sleep ?? defaultSleep, random: deps.random ?? Math.random }
  const chain = geminiModelChain(config.model, env)

  let opened: Awaited<ReturnType<typeof openWithRetry>> | undefined
  let model = chain[0]
  let failure: unknown
  for (const candidate of chain) {
    model = candidate
    const { system, contents } = toGeminiContents(messages, candidate)
    try {
      opened = await openWithRetry(client, candidate, { contents, config: geminiConfig(candidate, system, tools, signal, env, config.phase) }, signal, rt, config.apiKey)
      break
    } catch (err) {
      failure = err
      if (isAbort(err, signal) || !fallbackWorthy(err)) throw err
      log.warn({ model: candidate }, 'gemini model unavailable; trying the next in the fallback chain')
    }
  }
  if (!opened) {
    throw new Error(`${(failure as Error).message}. Every model in the fallback chain (${chain.join(', ')}) failed.`)
  }
  if (model !== chain[0]) log.warn({ model, primary: chain[0] }, 'serving this turn from a fallback model')

  const parts: Part[] = []
  let calls = 0
  let written = ''
  let finishReason = ''
  let usage: TokenUsage | undefined
  let current = opened.first
  while (!current.done) {
    const chunk = current.value
    const blocked = chunk.promptFeedback?.blockReason
    if (blocked) throw new Error(`AI provider (gemini) blocked the request: ${blocked}.`)
    const um = chunk.usageMetadata
    if (um) {
      usage = {
        promptTokens: um.promptTokenCount ?? 0,
        outputTokens: um.candidatesTokenCount ?? 0,
        thoughtTokens: um.thoughtsTokenCount ?? 0,
        cachedTokens: um.cachedContentTokenCount ?? 0,
      }
    }
    const cand = chunk.candidates?.[0]
    for (const part of cand?.content?.parts ?? []) {
      if (part.thought) continue // a thought summary is not part of the answer; its signature rides on a later part
      const prev = parts[parts.length - 1]
      if (part.functionCall) {
        parts.push(part)
        yield { type: 'tool_call', id: part.functionCall.id ?? `${SYNTHETIC_ID}${calls}`, name: part.functionCall.name ?? '', args: part.functionCall.args ?? {} }
        calls++
      } else if (part.text !== undefined) {
        if (part.text) {
          yield { type: 'text', text: part.text }
          written += part.text
          if (isRepeating(written)) throw new Error(`AI provider (gemini) model ${model} began repeating itself and the turn was stopped.`)
        }
        // Keep the model's parts as returned; only fold text fragments that carry no signature.
        if (prev && prev.text !== undefined && !prev.thoughtSignature && !part.thoughtSignature) prev.text += part.text
        else if (part.text || part.thoughtSignature) parts.push({ ...part })
      } else if (part.thoughtSignature) {
        parts.push(part)
      }
    }
    if (cand?.finishReason) finishReason = FINISH[cand.finishReason] ?? String(cand.finishReason).toLowerCase()
    current = await opened.it.next()
  }

  // A turn from a fallback model is not kept as a native record: its thought signatures belong to that
  // model, and the next turn may go back to the primary. Rebuilt from the tool calls, it carries the
  // documented placeholder signature instead.
  if (parts.length > 0 && model === chain[0]) yield { type: 'native', content: { role: 'model', parts } }
  if (usage) {
    log.info({ model, phase: config.phase ?? 'plan', ...usage }, 'gemini usage')
    yield { type: 'usage', usage }
  }
  yield { type: 'done', finishReason: calls > 0 && (!finishReason || finishReason === 'stop') ? 'tool_calls' : finishReason || 'unknown' }
}
