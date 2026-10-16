/** Vision-language inspection backend — Phase 2.5 (spec §3.6 A).
 *
 *  WHY. The decisive finding of the 2026-08-09 audit came from *looking* at a
 *  true-colour crop and recognising solid white cloud. The agent could not do
 *  that: it reasons only over text summaries, so a statistic derived from a
 *  cloud top and one derived from a field are the same kind of object to it.
 *  This module gives it eyes, so a number can be cross-checked against the
 *  picture it claims to describe.
 *
 *  Provider-agnostic on purpose. A vision model is reached through whichever of
 *  these is available, in order:
 *
 *    1. an explicit `VLM_ENDPOINT` + `VLM_MODEL` (a local sidecar — Ollama,
 *       vLLM, llama.cpp — which is the target-box design);
 *    2. the AI provider the user already configured in Settings, when it is
 *       vision-capable (OpenAI / Claude / Gemini all are);
 *    3. an Ollama endpoint, but ONLY after asking it which models it actually
 *       serves and whether the chosen one reports the `vision` capability.
 *
 *  Rule 3 exists because a text-only model handed an image does not fail — it
 *  ignores the image and describes what it imagines, which is fabrication with
 *  a confident tone. Guessing from the model's name is not verification.
 *
 *  When nothing is available the answer is a refusal that names what would fix
 *  it. There is no "describe it from the numbers" fallback: that would be the
 *  agent inventing a picture, which is the exact failure this exists to catch.
 */

import { assertSafeUrl } from '@/lib/url-guard'

import { getLogger } from '../logger'
import { defaultModel, type ModelProvider } from '../models'

const log = getLogger('agent/vlm')

export type VlmWire = 'ollama' | 'openai' | 'claude'

export interface VlmConfig {
  wire: VlmWire
  /** Base URL without a trailing slash. */
  baseUrl: string
  model: string
  apiKey?: string
  /** Where this configuration came from, for honest provenance. */
  origin: string
}

/** The LLM settings the request already carries (Settings → AI Model). */
export interface RequestLlmConfig {
  provider?: string
  apiKey?: string
  baseUrl?: string
  model?: string
  /** The base URL came from the browser: it must pass the SSRF guard before the server calls it. */
  clientBaseUrl?: boolean
}

export type VlmResolution =
  | { ok: true; config: VlmConfig }
  | { ok: false; reason: string }

const DEFAULT_OLLAMA = 'http://localhost:11434'

/** Providers whose current model families all accept images. */
const VISION_CAPABLE_PROVIDERS: Record<string, { wire: VlmWire; base: string }> = {
  openai: { wire: 'openai', base: 'https://api.openai.com/v1' },
  gemini: { wire: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  claude: { wire: 'claude', base: 'https://api.anthropic.com' },
}

function trimUrl(u: string): string {
  return u.replace(/\/+$/, '')
}

/** Ask an Ollama server what it serves and whether a model can see.
 *  Returns null when the server is unreachable — never a guess. */
export async function probeOllamaVision(
  baseUrl: string,
  preferredModel?: string,
  timeoutMs = 8000,
): Promise<{ model: string; models: string[] } | null> {
  const base = trimUrl(baseUrl)
  let models: string[] = []
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data: any = await res.json()
    models = (data?.models ?? []).map((m: any) => String(m?.name ?? m?.model ?? '')).filter(Boolean)
  } catch (err: any) {
    log.warn({ base, err: err?.message }, 'ollama /api/tags unreachable')
    return null
  }
  if (models.length === 0) return { model: '', models: [] }

  // Ask about the preferred model first, then the rest — the first one that
  // reports a vision capability wins.
  const order = preferredModel && models.includes(preferredModel)
    ? [preferredModel, ...models.filter((m) => m !== preferredModel)]
    : models
  for (const model of order) {
    try {
      const res = await fetch(`${base}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) continue
      const info: any = await res.json()
      const caps: string[] = Array.isArray(info?.capabilities) ? info.capabilities.map(String) : []
      // Older Ollama builds predate `capabilities`; fall back to the projector
      // key, which only multimodal models carry.
      const hasProjector = !!(info?.details?.families ?? []).some?.((f: string) => /clip|mllama|vision/i.test(f))
        || typeof info?.projector_info === 'object'
      if (caps.includes('vision') || hasProjector) return { model, models }
    } catch {
      /* try the next model */
    }
  }
  return { model: '', models }
}

/**
 * Decide which vision backend to use for this request.
 *
 * `env` is injected so the resolution is testable without mutating the process
 * environment, and so a caller can force a specific backend.
 */
export async function resolveVlm(
  llm?: RequestLlmConfig,
  env: Record<string, string | undefined> = process.env,
): Promise<VlmResolution> {
  // 1 — an explicit sidecar wins; the operator has said what it is.
  const endpoint = env.VLM_ENDPOINT?.trim()
  if (endpoint) {
    const model = env.VLM_MODEL?.trim()
    if (!model) {
      return {
        ok: false,
        reason:
          'VLM_ENDPOINT is set but VLM_MODEL is not, so there is no model to send the image to. ' +
          'Set VLM_MODEL to a vision model served by that endpoint.',
      }
    }
    const wire = (env.VLM_WIRE?.trim() as VlmWire | undefined)
      ?? (/\/v1\/?$/.test(endpoint) ? 'openai' : 'ollama')
    return {
      ok: true,
      config: { wire, baseUrl: trimUrl(endpoint), model, apiKey: env.VLM_API_KEY?.trim(), origin: 'VLM_ENDPOINT' },
    }
  }

  // A base URL the browser chose may not point the server at an internal address (SSRF).
  const provider = llm?.provider?.toLowerCase()
  const clientBase = provider === 'gemini' ? undefined : llm?.baseUrl // Gemini always uses its own endpoint
  if (clientBase && llm?.clientBaseUrl) {
    try {
      await assertSafeUrl(clientBase)
    } catch (err: any) {
      return { ok: false, reason: `The configured AI base URL was refused: ${err.message}` }
    }
  }

  // 2 — the provider the user already configured, when it can see.
  if (provider && VISION_CAPABLE_PROVIDERS[provider] && llm?.apiKey) {
    const spec = VISION_CAPABLE_PROVIDERS[provider]
    return {
      ok: true,
      config: {
        wire: spec.wire,
        baseUrl: trimUrl(clientBase || spec.base),
        model: env.VLM_MODEL?.trim() || llm.model || defaultModel(provider as ModelProvider),
        apiKey: llm.apiKey,
        origin: `Settings → AI Model (${provider})`,
      },
    }
  }

  // 3 — an Ollama endpoint, but only after asking what it actually serves.
  const ollamaBase = provider === 'ollama' && clientBase
    ? clientBase
    : env.OLLAMA_BASE_URL?.trim()
  if (ollamaBase) {
    const probe = await probeOllamaVision(ollamaBase, llm?.model)
    if (!probe) {
      return {
        ok: false,
        reason:
          `The Ollama endpoint at ${trimUrl(ollamaBase)} did not respond, so no vision model could be ` +
          `confirmed. No description is produced — a text-only model handed an image describes what it ` +
          `imagines rather than what is there.`,
      }
    }
    if (!probe.model) {
      return {
        ok: false,
        reason:
          `The Ollama endpoint at ${trimUrl(ollamaBase)} serves ` +
          (probe.models.length ? `${probe.models.join(', ')}, none of which report a vision capability` : 'no models') +
          `. Pull a vision model (e.g. \`ollama pull qwen2.5vl\`) or set VLM_ENDPOINT/VLM_MODEL.`,
      }
    }
    return {
      ok: true,
      config: {
        wire: 'ollama',
        baseUrl: trimUrl(ollamaBase),
        model: probe.model,
        origin: `Ollama at ${trimUrl(ollamaBase)} (vision capability verified)`,
      },
    }
  }

  return {
    ok: false,
    reason:
      'No vision model is configured. Set VLM_ENDPOINT + VLM_MODEL (a local Ollama/vLLM sidecar), ' +
      'or choose a vision-capable provider in Settings → AI Model (OpenAI, Claude or Gemini). ' +
      'Nothing is described from the numbers alone — that would be the agent inventing a picture.',
  }
}

export interface DescribeImageRequest {
  /** Base64 PNGs, in the order the prompt refers to them. */
  images: string[]
  prompt: string
  config: VlmConfig
  timeoutMs?: number
  signal?: AbortSignal
}

export interface DescribeImageResult {
  text: string
  model: string
  wire: VlmWire
  origin: string
}

/** Build the request body for a wire format. Exported so a test can assert the
 *  exact bytes we send, rather than trusting that a mock was called. */
export function buildVlmBody(req: Omit<DescribeImageRequest, 'signal' | 'timeoutMs'>): {
  url: string
  headers: Record<string, string>
  body: unknown
} {
  const { images, prompt, config } = req
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  if (config.wire === 'ollama') {
    return {
      url: `${config.baseUrl}/api/chat`,
      headers,
      // Ollama's native shape: images ride on the message as bare base64.
      body: {
        model: config.model,
        messages: [{ role: 'user', content: prompt, images }],
        stream: false,
        options: { temperature: 0 },
      },
    }
  }

  if (config.wire === 'claude') {
    if (config.apiKey) headers['x-api-key'] = config.apiKey
    headers['anthropic-version'] = '2023-06-01'
    return {
      url: `${config.baseUrl}/v1/messages`,
      headers,
      body: {
        model: config.model,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            ...images.map((data) => ({
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data },
            })),
            { type: 'text', text: prompt },
          ],
        }],
      },
    }
  }

  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`
  return {
    url: `${config.baseUrl}/chat/completions`,
    headers,
    body: {
      model: config.model,
      max_tokens: 1024,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...images.map((data) => ({
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${data}` },
          })),
        ],
      }],
    },
  }
}

/** Pull the text out of whichever response shape came back. */
export function extractVlmText(wire: VlmWire, data: any): string {
  if (wire === 'ollama') return String(data?.message?.content ?? '').trim()
  if (wire === 'claude') {
    const blocks = Array.isArray(data?.content) ? data.content : []
    return blocks.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n').trim()
  }
  return String(data?.choices?.[0]?.message?.content ?? '').trim()
}

/** Send images + a prompt to the resolved vision model. Throws with an honest,
 *  user-surfaceable message; never returns an empty string as if it were an
 *  answer (an empty description is indistinguishable from "nothing is there"). */
export async function describeImage(req: DescribeImageRequest): Promise<DescribeImageResult> {
  const { config, timeoutMs = 120_000, signal } = req
  if (req.images.length === 0) throw new Error('describeImage: no image to inspect')

  const { url, headers, body } = buildVlmBody(req)
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: combined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`vision model (${config.model} via ${config.wire}) returned HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  const data = await res.json()
  const text = extractVlmText(config.wire, data)
  if (!text) {
    throw new Error(
      `vision model (${config.model}) returned an empty description. Treated as a failure, not as ` +
      `"nothing is visible" — the two are not the same answer.`,
    )
  }
  return { text, model: config.model, wire: config.wire, origin: config.origin }
}
