/** Replicate pay-per-call provider.
 *
 *  API pattern: POST /v1/models/{owner}/{name}/predictions → poll /v1/predictions/{id}
 *  Auth: REPLICATE_API_TOKEN env var.
 *  Route: "{owner}/{name}" slug (e.g. 'meta/sam-2', 'adirik/grounding-dino').
 *
 *  Supports:
 *    detect   → Grounding-DINO: bbox detections → GeoJSON polygons
 *    segment  → SAM2: mask URL returned in maskUrl field
 *    classify → generic: label array
 *
 *  References (as of 2026):
 *    Grounding-DINO: https://replicate.com/adirik/grounding-dino
 *    SAM2:           https://replicate.com/meta/sam-2
 */

import { fetchWithRetry } from '../../cache'
import { boxToGeoPolygon } from '../box-geo'
import type { ModelEntry, NormalizedOutput } from '../registry'

const REPLICATE_API = 'https://api.replicate.com/v1'
/** Generous timeout: cold GPU starts on Replicate can take 30–90 s. */
const REPLICATE_TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 2_000
const MAX_POLL_ATTEMPTS = 50  // 50 × 2 s = 100 s max poll

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function infer(
  route: string,
  input: Record<string, unknown>,
  entry: ModelEntry,
): Promise<NormalizedOutput> {
  const token = process.env.REPLICATE_API_TOKEN?.trim()
  if (!token) throw new Error('REPLICATE_API_TOKEN is not set')

  const headers = {
    'Authorization': `Token ${token}`,
    'Content-Type': 'application/json',
  }

  // Create the prediction
  const predictionUrl = `${REPLICATE_API}/models/${route}/predictions`
  const body = buildInput(entry, input)

  const createRes = await fetchWithRetry(
    predictionUrl,
    { method: 'POST', headers, body: JSON.stringify({ input: body }) },
    { timeoutMs: REPLICATE_TIMEOUT_MS },
  )

  if (!createRes.ok) {
    const text = await createRes.text().catch(() => '')
    throw new Error(`Replicate create prediction HTTP ${createRes.status}: ${text.slice(0, 300)}`)
  }

  const prediction = await createRes.json() as { id: string; status: string; urls?: { get?: string }; error?: string }

  if (!prediction.id) throw new Error('Replicate: no prediction id in response')

  // Poll until succeeded or failed
  const pollUrl = prediction.urls?.get ?? `${REPLICATE_API}/predictions/${prediction.id}`
  const result = await pollPrediction(pollUrl, headers)

  return normalizePrediction(result, route, entry, input)
}

// ---------------------------------------------------------------------------
// Input builder (model-specific)
// ---------------------------------------------------------------------------

function buildInput(entry: ModelEntry, input: Record<string, unknown>): Record<string, unknown> {
  switch (entry.key) {
    case 'grounding_dino': {
      const prompt = String(input.prompt ?? '')
      return {
        image: input.imageUrl ?? input.image,
        text_prompt: prompt.endsWith('.') ? prompt : `${prompt}.`,
        box_threshold: Number(input.threshold ?? 0.25),
        text_threshold: Number(input.textThreshold ?? 0.25),
      }
    }
    case 'sam2': {
      const pts = input.inputPoints as number[][] | undefined
      const result: Record<string, unknown> = {
        image: input.imageUrl ?? input.image,
        multimask_output: false,
      }
      if (pts?.length) {
        result.input_points = JSON.stringify(pts)
        result.input_labels = JSON.stringify(
          (input.inputLabels as number[] | undefined) ?? pts.map(() => 1),
        )
      }
      return result
    }
    case 'prithvi_flood': {
      return {
        image: input.imageUrl ?? input.image,
        task: input.task ?? 'flood',
      }
    }
    default:
      // Generic passthrough for unknown models
      return { ...input }
  }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

interface ReplicatePrediction {
  id: string
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled'
  output?: unknown
  error?: string | null
}

async function pollPrediction(
  getUrl: string,
  headers: Record<string, string>,
): Promise<ReplicatePrediction> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const res = await fetchWithRetry(
      getUrl,
      { headers },
      { timeoutMs: REPLICATE_TIMEOUT_MS },
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Replicate poll HTTP ${res.status}: ${body.slice(0, 200)}`)
    }

    const pred = await res.json() as ReplicatePrediction

    if (pred.status === 'succeeded') return pred
    if (pred.status === 'failed' || pred.status === 'canceled') {
      throw new Error(`Replicate prediction ${pred.status}: ${pred.error ?? 'no error message'}`)
    }

    // Still processing — wait and retry
    await sleep(POLL_INTERVAL_MS)
  }

  throw new Error(
    `Replicate prediction timed out after ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s`,
  )
}

// ---------------------------------------------------------------------------
// Output normalization
// ---------------------------------------------------------------------------

function normalizePrediction(
  pred: ReplicatePrediction,
  route: string,
  entry: ModelEntry,
  input: Record<string, unknown>,
): NormalizedOutput {
  const provenance = `replicate:${route}`

  switch (entry.key) {
    case 'grounding_dino':
      return normalizeGroundingDino(pred.output, provenance, input, entry)
    case 'sam2':
      return normalizeSam2(pred.output, provenance, entry)
    case 'prithvi_flood':
      return normalizePrithviFlood(pred.output, provenance, entry)
    default:
      return normalizeGeneric(pred.output, provenance, entry)
  }
}

interface GroundingDinoOutput {
  detections?: Array<{
    phrase?: string
    bbox?: [number, number, number, number]  // [x1, y1, x2, y2] absolute pixels
    logit?: number
  }>
}

function normalizeGroundingDino(
  output: unknown,
  provenance: string,
  input: Record<string, unknown>,
  entry: ModelEntry,
): NormalizedOutput {
  const out = output as GroundingDinoOutput | null
  const detections = out?.detections ?? []
  const threshold = Number(input.threshold ?? 0.25)
  const tileBounds = input.tileBounds as
    | { west: number; south: number; east: number; north: number }
    | undefined
  const tilePx = Number(input.tilePx ?? 256)

  const features = detections
    .filter((d) => (d.logit ?? 1) >= threshold && d.bbox)
    .map((d) => {
      const [x1, y1, x2, y2] = d.bbox!
      const box = { xmin: x1, ymin: y1, xmax: x2, ymax: y2 }
      const coords = tileBounds
        ? boxToGeoPolygon(box, tileBounds, tilePx)
        : [[[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]]
      return {
        type: 'Feature',
        properties: { label: d.phrase ?? 'object', confidence: d.logit ?? 0.5 },
        geometry: { type: 'Polygon', coordinates: coords },
      }
    })

  const maxConf = features.length > 0
    ? Math.max(...features.map((f) => f.properties.confidence as number))
    : 0

  return {
    geojson: { type: 'FeatureCollection', features },
    provenance,
    confidence: maxConf,
    resolution_limit: entry.resolutionLimit,
  }
}

interface Sam2Output {
  combined_mask?: string   // URL to a combined binary mask PNG
  individual_masks?: string[]
  scores?: number[]
}

function normalizeSam2(output: unknown, provenance: string, entry: ModelEntry): NormalizedOutput {
  const out = output as Sam2Output | null
  const maskUrl = out?.combined_mask ?? out?.individual_masks?.[0] ?? ''
  const confidence = Array.isArray(out?.scores) && out!.scores!.length > 0
    ? Number(out!.scores![0])
    : 0.8  // SAM2 is generally high-quality; default to 0.8 if no score

  return {
    maskUrl,
    provenance,
    confidence,
    resolution_limit: entry.resolutionLimit,
  }
}

function normalizePrithviFlood(output: unknown, provenance: string, entry: ModelEntry): NormalizedOutput {
  // Prithvi flood model outputs a segmentation mask URL
  const maskUrl = typeof output === 'string' ? output : (output as any)?.mask ?? ''
  return {
    maskUrl,
    provenance,
    confidence: 0.7,  // model-level confidence; task-specific heads vary
    resolution_limit: entry.resolutionLimit,
  }
}

function normalizeGeneric(output: unknown, provenance: string, entry: ModelEntry): NormalizedOutput {
  if (typeof output === 'string') {
    return { maskUrl: output, provenance, confidence: 0.5, resolution_limit: entry.resolutionLimit }
  }
  if (Array.isArray(output)) {
    const labels = output.map((o) =>
      typeof o === 'string' ? o : `${o?.label ?? 'unknown'}${o?.score != null ? `:${Number(o.score).toFixed(3)}` : ''}`
    )
    return { labels, provenance, confidence: 0.5, resolution_limit: entry.resolutionLimit }
  }
  return {
    labels: [JSON.stringify(output).slice(0, 200)],
    provenance,
    confidence: 0.3,
    resolution_limit: entry.resolutionLimit,
  }
}
