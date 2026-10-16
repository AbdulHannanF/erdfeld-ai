/** The `local-onnx` provider — the durable engine (spec §2).
 *
 *  > Paid APIs are optional accelerators, never dependencies. Local weights are
 *  > the durable engine.
 *
 *  Generalises the fixed three-model `cv-onnx.ts` path to any registered
 *  `ModelSpec`: weights come from the spec's `ref`, which is either an https URL
 *  (downloaded once into `public/models/`, then reused) or an absolute path to a
 *  file already on disk — the case that matters when the owner supplies weights
 *  directly rather than from a public host.
 *
 *  The YOLO pre/post-processing is reused from `cv-onnx.ts` rather than
 *  duplicated: same letterbox, same decode, same NMS, same tile-pixel mapping.
 */

import * as fs from 'fs'
import * as path from 'path'
import { fetchGuarded } from '@/lib/url-guard'
import { getLogger } from '../logger'
import {
  decodeYolov8Output,
  nmsBoxes,
  onnxToTilePixels,
  preprocessTile,
  type LetterboxResult,
  type RawDetection,
} from '../cv-onnx'
import { decodeEndToEnd, decodeEndToEndObb, detectOnnxLayout } from './onnx-layout'
import type { RoboflowPrediction } from '../cv'
import type { ModelSpec } from './model-spec'
import type { ModelRunInput, ModelRunResult } from './adapters'

const log = getLogger('agent/local-onnx')

const MODELS_DIR = path.join(process.cwd(), 'public', 'models')

/** Sessions are expensive to build and safe to share; keyed by resolved file path. */
const sessionCache = new Map<string, any>()

/** Where a downloaded model for this spec is cached. Ids are sanitised because
 *  they come from user input and become a filename. */
export function localModelPath(spec: ModelSpec): string {
  const safe = spec.id.replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(MODELS_DIR, `${safe}.onnx`)
}

/** True when the spec's ref points at a file already on disk. */
function isLocalPath(ref: string): boolean {
  return !/^https?:\/\//i.test(ref)
}

/**
 * Resolve the spec to a readable .onnx file, downloading once if needed.
 * Throws with a message naming what to do — these surface straight to the user.
 */
export async function ensureModelFile(spec: ModelSpec): Promise<string> {
  if (isLocalPath(spec.ref)) {
    if (!fs.existsSync(spec.ref)) {
      throw new Error(
        `weights not found at "${spec.ref}". Point the model's ref at an existing .onnx file, ` +
        `or at an https URL the server can download once.`,
      )
    }
    return spec.ref
  }

  const dest = localModelPath(spec)
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest

  fs.mkdirSync(MODELS_DIR, { recursive: true })
  const headers: Record<string, string> = {}
  // HF file hosting works even though HF serverless inference does not; a token
  // is only needed for gated repos and for a higher rate limit.
  const hfToken = process.env.HF_API_TOKEN?.trim()
  if (hfToken && /huggingface\.co/i.test(spec.ref)) headers.Authorization = `Bearer ${hfToken}`

  const init: RequestInit = { headers, redirect: 'follow', signal: AbortSignal.timeout(300_000) }
  const res = spec.untrusted ? await fetchGuarded(spec.ref, init) : await fetch(spec.ref, init)
  if (!res.ok) {
    throw new Error(
      res.status === 401 || res.status === 403
        ? `download of "${spec.ref}" was refused (HTTP ${res.status}). If the repo is gated, set HF_API_TOKEN in .env.`
        : res.status === 404
          ? `no file at "${spec.ref}" (HTTP 404). The URL must point directly at the .onnx file.`
          : `download of "${spec.ref}" failed with HTTP ${res.status}.`,
    )
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length < 1024) {
    throw new Error(`download of "${spec.ref}" returned only ${bytes.length} bytes — not a model file.`)
  }
  // Write via a temp file so a killed process cannot leave a truncated model
  // that later loads as a corrupt session.
  const tmp = `${dest}.part`
  fs.writeFileSync(tmp, bytes)
  fs.renameSync(tmp, dest)
  log.info({ model: spec.id, bytes: bytes.length, dest }, 'downloaded ONNX weights')
  return dest
}

async function getSession(modelPath: string): Promise<any> {
  const cached = sessionCache.get(modelPath)
  if (cached) return cached
  const ort = await import('onnxruntime-node' as string)
  const session = await ort.InferenceSession.create(modelPath)
  sessionCache.set(modelPath, session)
  return session
}

/**
 * Run a registered local-ONNX model over one tile.
 *
 * Assumes an Ultralytics-style YOLO export: output `[1, 4 + numClasses, anchors]`.
 * When the spec declares no classes, the channel count implies them and labels
 * fall back to `class_N` — honest about not knowing the vocabulary rather than
 * inventing names.
 */
export async function runSpecOnnxInference(
  spec: ModelSpec,
  input: ModelRunInput,
  minConfidence: number,
): Promise<ModelRunResult> {
  let modelPath: string
  try {
    modelPath = await ensureModelFile(spec)
  } catch (err: any) {
    return { ok: false, error: `local-onnx model "${spec.id}": ${err?.message ?? 'unknown error'}` }
  }

  let session: any
  try {
    session = await getSession(modelPath)
  } catch (err: any) {
    return {
      ok: false,
      error:
        `local-onnx model "${spec.id}" failed to load from ${modelPath}: ${err?.message ?? 'unknown error'}. ` +
        `The file may be corrupt or not an ONNX export — delete it and let it re-download.`,
    }
  }

  let pre: LetterboxResult
  try {
    const bytes = Buffer.from(input.imageBytes)
    pre = await preprocessTile(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      spec.inputSize,
    )
  } catch (err: any) {
    return { ok: false, error: `local-onnx model "${spec.id}": could not decode the tile image (${err?.message ?? 'unknown'}).` }
  }

  let outputData: Float32Array
  let outputDims: readonly number[] | undefined
  try {
    const ort = await import('onnxruntime-node' as string)
    const tensor = new ort.Tensor('float32', pre.tensor, [1, 3, spec.inputSize, spec.inputSize])
    const results = await session.run({ [session.inputNames[0]]: tensor })
    const output = results[session.outputNames[0]]
    outputData = output.data as Float32Array
    outputDims = output.dims as readonly number[]
  } catch (err: any) {
    return { ok: false, error: `local-onnx model "${spec.id}" failed during inference: ${err?.message ?? 'unknown error'}.` }
  }

  // Identify the layout rather than assuming one. Guessing here once turned
  // YOLOv10's [1, 300, 6] into "296 classes × 6 anchors" and produced five
  // confident detections out of noise (observed 2026-08-10).
  const layout = detectOnnxLayout(outputDims, spec.inputSize, spec.classes?.length)
  if (layout.kind === 'unknown') {
    return {
      ok: false,
      error:
        `local-onnx model "${spec.id}": ${layout.reason} ` +
        `No detections are reported — decoding an unrecognised tensor would invent them. ` +
        `Register the model as custom-http behind your own decoder if its head is non-standard.`,
    }
  }

  // Ultralytics heads need NMS; end-to-end heads have already applied it.
  let raw: RawDetection[]
  let needsNms: boolean
  if (layout.kind === 'ultralytics') {
    raw = decodeYolov8Output(outputData, layout.numAnchors, layout.numClasses, minConfidence)
    needsNms = true
  } else if (layout.kind === 'end-to-end-obb') {
    raw = decodeEndToEndObb(outputData, layout.numRows, minConfidence)
    needsNms = false
  } else {
    raw = decodeEndToEnd(outputData, layout.numRows, minConfidence)
    needsNms = false
  }

  if (raw.length === 0) {
    return { ok: true, predictions: [], provenance: `local-onnx:${spec.id} (${path.basename(modelPath)}, ${layout.kind})` }
  }

  const boxes = raw.map((d) => [d.cx - d.w / 2, d.cy - d.h / 2, d.cx + d.w / 2, d.cy + d.h / 2])
  const kept = needsNms
    ? nmsBoxes(boxes, raw.map((d) => d.confidence), 0.45)
    : raw.map((_, i) => i)

  // Predictions come back in the space of the image that was sent: one 256 px
  // tile by default, or the mosaic's own size when the perception pipeline sent
  // a native-resolution mosaic.
  const outputPx = input.imagePx ?? 256
  const predictions: RoboflowPrediction[] = kept.map((i) => {
    const d = raw[i]
    const px = onnxToTilePixels(d.cx, d.cy, d.w, d.h, spec.inputSize, outputPx, pre.padX, pre.padY)
    return {
      class: spec.classes?.[d.classIdx] ?? `class_${d.classIdx}`,
      confidence: d.confidence,
      x: px.x,
      y: px.y,
      width: px.width,
      height: px.height,
    }
  })

  return { ok: true, predictions, provenance: `local-onnx:${spec.id} (${path.basename(modelPath)}, ${layout.kind})` }
}

/** Test seam — drop cached sessions. */
export function _resetSessions(): void {
  sessionCache.clear()
}
