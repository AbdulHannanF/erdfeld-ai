/** Provider adapters (Phase 1): local-onnx | roboflow | hf | custom-http.
 *
 *  One entry point, `runModel(spec, input)`, so the perception pipeline never
 *  branches on provider. Every adapter normalises to `RoboflowPrediction[]`
 *  (the shape the existing georeferencing, seam-dedupe and provenance code in
 *  `cv.ts` already consumes), so Phase 2 reuses all of it unchanged.
 *
 *  **Failure is never an empty result.** An adapter that returns "0 detections"
 *  after an HTTP 503 is indistinguishable from a model that genuinely found
 *  nothing, and the difference decides whether the user should believe the
 *  answer. Errors come back as `{ ok: false, error }` with the provider named.
 */

import { fetchGuarded } from '@/lib/url-guard'
import { getLogger } from '../logger'
import type { RoboflowPrediction } from '../cv'
import type { ModelProvider, ModelSpec } from './model-spec'

const log = getLogger('agent/inference-adapters')

export interface ModelRunInput {
  /** Raw image bytes for the tile being analysed. */
  imageBytes: Buffer | Uint8Array
  /** Free-text target, for models that take a prompt (open-vocabulary / CLIP). */
  prompt?: string
  /** Confidence floor; falls back to the spec's default, then 0.3. */
  confidence?: number
  /**
   * Pixel size of the square image being sent, and the space predictions should
   * come back in. Defaults to 256 (a single slippy tile) so existing callers are
   * unchanged; the perception pipeline sends native-resolution mosaics at the
   * model's own input size and needs coordinates in that space.
   */
  imagePx?: number
}

export type ModelRunResult =
  | { ok: true; predictions: RoboflowPrediction[]; provenance: string; raw?: unknown }
  | { ok: false; error: string; retryable?: boolean }

/** What a user must supply to make each provider usable. Surfaced in Settings
 *  and in tool output, so an unconfigured provider explains itself. */
export function describeProviderRequirement(provider: ModelProvider): string {
  switch (provider) {
    case 'local-onnx':
      return 'Needs the .onnx weights: either an https URL the server can download once, or an absolute path to a local file. Runs on CPU or GPU via onnxruntime-node — no key, no rate limit, no bill.'
    case 'roboflow':
      return 'Needs ROBOFLOW_API_KEY in .env (free tier at roboflow.com).'
    case 'custom-http':
      return 'Needs an absolute http(s) endpoint URL that accepts a POSTed image and returns predictions.'
    case 'hf':
      return 'HuggingFace is a weight host for local-onnx downloads, not an inference route — HF serverless serves none of the vision models this app needs (verified 2026-08-10). Set HF_API_TOKEN only to raise download rate limits or reach gated repos.'
  }
}

// ---------------------------------------------------------------------------
// Prediction normalisation — shared by every HTTP-shaped provider
// ---------------------------------------------------------------------------

/** Pull a prediction array out of the shapes real inference servers return. */
function predictionArray(payload: any): any[] | null {
  if (Array.isArray(payload)) return payload
  for (const key of ['predictions', 'detections', 'results', 'objects', 'outputs']) {
    if (Array.isArray(payload?.[key])) return payload[key]
  }
  // Roboflow workflows nest one level deeper.
  if (Array.isArray(payload?.outputs?.[0]?.predictions)) return payload.outputs[0].predictions
  return null
}

/**
 * Normalise one raw prediction to centre-x/y + width/height.
 *
 * Accepts the two conventions in the wild: centre+size (Roboflow, YOLO) and
 * corner boxes (`x0/y0/x1/y1`, `xmin/…`, or `bbox: [x0,y0,x1,y1]`). Returns null
 * for anything it cannot place, so a malformed row is dropped rather than
 * georeferenced to the wrong spot.
 */
function normalizePrediction(p: any, fallbackClass?: string): RoboflowPrediction | null {
  if (!p || typeof p !== 'object') return null

  const num = (...vals: unknown[]) => {
    for (const v of vals) {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
    return null
  }

  const cls =
    (typeof p.class === 'string' && p.class) ||
    (typeof p.label === 'string' && p.label) ||
    (typeof p.name === 'string' && p.name) ||
    fallbackClass ||
    'object'
  const confidence = num(p.confidence, p.score, p.conf) ?? 0

  let x = num(p.x, p.cx, p.center_x)
  let y = num(p.y, p.cy, p.center_y)
  let width = num(p.width, p.w)
  let height = num(p.height, p.h)

  if (x == null || y == null || width == null || height == null) {
    const box = Array.isArray(p.bbox) ? p.bbox : Array.isArray(p.box) ? p.box : null
    const x0 = num(p.x0, p.xmin, p.left, box?.[0])
    const y0 = num(p.y0, p.ymin, p.top, box?.[1])
    const x1 = num(p.x1, p.xmax, p.right, box?.[2])
    const y1 = num(p.y1, p.ymax, p.bottom, box?.[3])
    if (x0 == null || y0 == null || x1 == null || y1 == null) return null
    width = Math.abs(x1 - x0)
    height = Math.abs(y1 - y0)
    x = Math.min(x0, x1) + width / 2
    y = Math.min(y0, y1) + height / 2
  }

  if (!(width > 0) || !(height > 0)) return null
  return { class: cls, confidence, x, y, width, height }
}

/** Normalise a whole payload, or explain why it could not be read. */
function normalizePayload(
  payload: any,
  spec: ModelSpec,
  minConfidence: number,
): { ok: true; predictions: RoboflowPrediction[] } | { ok: false; error: string } {
  const arr = predictionArray(payload)
  if (!arr) {
    const keys = payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 8).join(', ') : typeof payload
    return {
      ok: false,
      error:
        `Could not find predictions in the response from "${spec.id}" (${spec.provider}). ` +
        `Top-level keys were: ${keys || '(none)'}. Expected an array, or an object with ` +
        `"predictions" / "detections" / "results".`,
    }
  }
  const predictions = arr
    .map((p) => normalizePrediction(p, spec.classes?.length === 1 ? spec.classes[0] : undefined))
    .filter((p): p is RoboflowPrediction => p !== null && p.confidence >= minConfidence)
  return { ok: true, predictions }
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

function toBase64(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

async function runCustomHttp(spec: ModelSpec, input: ModelRunInput, minConfidence: number): Promise<ModelRunResult> {
  let res: Response
  try {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: spec.id,
        image: { type: 'base64', value: toBase64(input.imageBytes) },
        prompt: input.prompt,
        confidence: minConfidence,
      }),
      signal: AbortSignal.timeout(120_000),
    }
    // An endpoint the browser registered is fetched through the SSRF guard.
    res = spec.untrusted ? await fetchGuarded(spec.ref, init) : await fetch(spec.ref, init)
  } catch (err: any) {
    return {
      ok: false,
      retryable: true,
      error: `custom-http endpoint ${spec.ref} for "${spec.id}" was unreachable: ${err?.message ?? 'network error'}.`,
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return {
      ok: false,
      retryable: res.status >= 500 || res.status === 429,
      error: `custom-http endpoint ${spec.ref} for "${spec.id}" returned HTTP ${res.status}. ${body.slice(0, 200)}`.trim(),
    }
  }
  const payload = await res.json().catch(() => null)
  const norm = normalizePayload(payload, spec, minConfidence)
  if (!norm.ok) return norm
  return {
    ok: true,
    predictions: norm.predictions,
    provenance: `custom-http:${new URL(spec.ref).host} (${spec.id})`,
    raw: payload,
  }
}

async function runRoboflow(spec: ModelSpec, input: ModelRunInput, minConfidence: number): Promise<ModelRunResult> {
  const key = process.env.ROBOFLOW_API_KEY?.trim()
  if (!key) {
    return {
      ok: false,
      error:
        `"${spec.id}" runs on Roboflow, but ROBOFLOW_API_KEY is not set. ` +
        `${describeProviderRequirement('roboflow')}`,
    }
  }
  // The key is a credential: it goes in the query string the API requires, and
  // never into provenance, logs or error text.
  const url = `https://detect.roboflow.com/${spec.ref}?api_key=${encodeURIComponent(key)}&confidence=${Math.round(minConfidence * 100)}`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: toBase64(input.imageBytes),
      signal: AbortSignal.timeout(120_000),
    })
  } catch (err: any) {
    return { ok: false, retryable: true, error: `Roboflow was unreachable for "${spec.id}": ${err?.message ?? 'network error'}.` }
  }
  if (!res.ok) {
    return {
      ok: false,
      retryable: res.status === 429 || res.status >= 500,
      error:
        res.status === 404
          ? `Roboflow has no model at "${spec.ref}" (HTTP 404). Check the project/version in the model's ref.`
          : `Roboflow returned HTTP ${res.status} for "${spec.id}" (${spec.ref}).`,
    }
  }
  const payload = await res.json().catch(() => null)
  const norm = normalizePayload(payload, spec, minConfidence)
  if (!norm.ok) return norm
  return { ok: true, predictions: norm.predictions, provenance: `roboflow:${spec.ref} (${spec.id})`, raw: payload }
}

/**
 * HuggingFace is registered as a provider so a model can *declare* an HF origin,
 * but it is not an inference route.
 *
 * Verified twice against the live API (2026-08-09 and re-checked 2026-08-10):
 * `grounding-dino-tiny`, `grounding-dino-base`, `sam2-hiera-large`,
 * `owlv2-base-patch16-ensemble` and `clip-vit-base-patch32` all return an
 * `inferenceProviderMapping` containing **zero** providers. Nothing hosts them.
 * File hosting works fine, so HF's real role is supplying weights to local-onnx.
 */
async function runHf(spec: ModelSpec): Promise<ModelRunResult> {
  return {
    ok: false,
    error:
      `"${spec.id}" is registered against HuggingFace serverless inference, which does not run it. ` +
      `Verified 2026-08-10: the vision models this app needs report zero inference providers on HF. ` +
      `Re-register it as provider "local-onnx" pointing at the .onnx weights (HF file hosting works, ` +
      `so an https URL to the repo file is fine), or as "custom-http" against your own endpoint. ` +
      `${describeProviderRequirement('hf')}`,
  }
}

async function runLocalOnnx(spec: ModelSpec, input: ModelRunInput, minConfidence: number): Promise<ModelRunResult> {
  // Imported lazily: onnxruntime-node is a native module, and a box with no
  // local models registered should never pay to load it.
  const { runSpecOnnxInference } = await import('./local-onnx')
  return runSpecOnnxInference(spec, input, minConfidence)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Run one registered model. Never throws; never reports a failure as an empty result. */
export async function runModel(spec: ModelSpec, input: ModelRunInput): Promise<ModelRunResult> {
  const minConfidence = input.confidence ?? spec.defaultConfidence ?? 0.3
  try {
    switch (spec.provider) {
      case 'custom-http': return await runCustomHttp(spec, input, minConfidence)
      case 'roboflow':    return await runRoboflow(spec, input, minConfidence)
      case 'local-onnx':  return await runLocalOnnx(spec, input, minConfidence)
      case 'hf':          return await runHf(spec)
    }
  } catch (err: any) {
    log.warn({ model: spec.id, provider: spec.provider, err: err?.message }, 'adapter threw')
    return {
      ok: false,
      error: `Running "${spec.id}" via ${spec.provider} failed: ${err?.message ?? 'unknown error'}.`,
    }
  }
}

export { normalizePrediction, predictionArray }
