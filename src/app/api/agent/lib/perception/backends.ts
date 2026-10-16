/** Hosted backends for Tier B, and the tile fetch shared by every tier.
 *
 *  Verified live 2026-08-10 against the real endpoints:
 *
 *  | call                        | result                                           |
 *  |-----------------------------|--------------------------------------------------|
 *  | `sam2/segment_image`        | 196 batched point prompts → 196 predictions, 4.9 s |
 *  | `clip/embed_text`           | batches — 4 phrases → 4 embeddings, one call      |
 *  | `clip/embed_image`          | does NOT batch — an array of 6 returned 1 embedding |
 *
 *  That asymmetry decides the shape of the code: text is embedded once per
 *  request, images once per crop. Both are cheap enough (~0.5 s per crop) but
 *  only because the point grid is filtered by footprint first.
 *
 *  These are *optional accelerators*, never dependencies (spec §2). When
 *  `ROBOFLOW_API_KEY` is absent Tier B skips with a message naming what to set,
 *  and Tier A — which runs on local weights with no key at all — is unaffected.
 */

import { getLogger } from '../logger'
import { cachedFetchJson } from '../cache'

const log = getLogger('agent/perception-backends')

const INFER_BASE = 'https://infer.roboflow.com'

/** Null when Tier B has a backend, otherwise the reason it does not. */
export function hostedSegmentationAvailable(): string | null {
  return process.env.ROBOFLOW_API_KEY?.trim()
    ? null
    : 'ROBOFLOW_API_KEY is not set'
}

function key(): string {
  const k = process.env.ROBOFLOW_API_KEY?.trim()
  if (!k) throw new Error('ROBOFLOW_API_KEY is not set')
  return k
}

async function postJson(path: string, body: unknown, timeoutMs: number): Promise<any> {
  // The key is a credential: it goes in the query string the API requires and
  // never into logs, provenance or error text.
  const res = await fetch(`${INFER_BASE}${path}?api_key=${encodeURIComponent(key())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Roboflow ${path} returned HTTP ${res.status}. ${text.slice(0, 160)}`.trim())
  }
  return res.json()
}

/**
 * Segment an image with a grid of point prompts, in one request.
 *
 * Returns the polygon rings for every prompt, flattened. Degenerate 1–3 point
 * contours come back too — measured, one prediction carried 169 of them — and
 * are dropped by `ringToBox` rather than here, so the caller can count what it
 * discarded.
 */
export async function roboflowSegment(
  image: Buffer,
  points: Array<{ x: number; y: number }>,
): Promise<number[][][]> {
  const preds = await roboflowSegmentPredictions(image, points)
  return preds.flatMap((p) => p.rings)
}

/** One SAM2 prompt's result: its candidate rings and the model's own score. */
export interface SegmentPrediction {
  rings: number[][][]
  confidence: number
}

/**
 * Same call, structured per prompt.
 *
 * `segment_feature` needs the rings for *one* point kept together with that
 * point's confidence, which the flattened form above throws away. Keeping the
 * ring rather than reducing it to a bounding box is the whole of ISS-110.
 */
export async function roboflowSegmentPredictions(
  image: Buffer,
  points: Array<{ x: number; y: number }>,
): Promise<SegmentPrediction[]> {
  const payload = await postJson(
    '/sam2/segment_image',
    {
      image: { type: 'base64', value: image.toString('base64') },
      prompts: { prompts: points.map((p) => ({ points: [{ x: p.x, y: p.y, positive: true }] })) },
    },
    180_000,
  )
  const out: SegmentPrediction[] = []
  for (const pred of payload?.predictions ?? []) {
    const rings = (pred?.masks ?? []).filter((m: unknown) => Array.isArray(m)) as number[][][]
    out.push({ rings, confidence: Number(pred?.confidence ?? 0) })
  }
  log.info({ prompts: points.length, predictions: out.length }, 'sam2 segment')
  return out
}

/** Embed one image crop. Roboflow does not batch these — verified. */
export async function roboflowEmbedImage(crop: Buffer): Promise<number[] | null> {
  const payload = await postJson('/clip/embed_image', { image: { type: 'base64', value: crop.toString('base64') } }, 60_000)
  const emb = payload?.embeddings?.[0]
  return Array.isArray(emb) ? emb : null
}

/** Embed several phrases in one call. Cached: the distractor set rarely changes. */
export async function roboflowEmbedTexts(texts: string[]): Promise<number[][]> {
  return cachedFetchJson<number[][]>(
    `clip-text:${texts.join('|')}`,
    { source: 'inference', ttlMs: 7 * 24 * 60 * 60_000 },
    async () => {
      const payload = await postJson('/clip/embed_text', { text: texts }, 60_000)
      const embs = payload?.embeddings
      if (!Array.isArray(embs)) throw new Error('CLIP returned no text embeddings')
      return embs
    },
  )
}

/**
 * A CLIP-based check that a phrase means anything visually (spec §3.2).
 *
 * Returns the phrase's similarity to a generic overhead-imagery sentence minus
 * its similarity to deliberate nonsense. A phrase that scores no better than
 * nonsense is one CLIP has no visual concept for, which is worth saying before
 * the pipeline spends a minute failing to find it.
 */
export async function clipPhraseCheck(phrase: string): Promise<number | null> {
  if (hostedSegmentationAvailable()) return null
  try {
    const [target, nonsense] = await roboflowEmbedTexts([
      `an overhead satellite photo of ${phrase}`,
      'an overhead satellite photo of qwrtzp blorf',
    ])
    if (!target || !nonsense) return null
    const dot = target.reduce((s, a, i) => s + a * nonsense[i], 0)
    const na = Math.hypot(...target)
    const nb = Math.hypot(...nonsense)
    // Low similarity to nonsense == the phrase is distinctive.
    return na && nb ? 1 - dot / (na * nb) : null
  } catch {
    return null
  }
}
