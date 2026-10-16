/** No-key CV: ONNX YOLO inference for aerial imagery detection.
 *
 *  Each supported model is fetched from a documented public URL on first use
 *  and cached at public/models/<slug>.onnx (gitignored). If the download or
 *  inference session fails, the caller receives an empty InferenceOutcome with
 *  an `error` field — no crash, no fabricated detections.
 *
 *  Output format matches runRoboflowInference so all downstream georef +
 *  dedupe + provenance code in cv.ts / other.ts is reused unchanged.
 */

import * as fs from 'fs'
import * as path from 'path'
import sharp from 'sharp'
import type { InferenceOutcome, RoboflowPrediction } from './cv'

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

export interface OnnxModelInfo {
  /** Download URL — public HuggingFace model file. */
  downloadUrl: string
  /** License shorthand (must be redistribution-friendly). */
  license: string
  /** Upstream model card / source URL for attribution. */
  source: string
  /** Ordered class names as exported from the training config. */
  classes: string[]
  /** ONNX model input size (square). Default 640 for YOLOv8. */
  inputSize: number
  /** Min confidence for this model (used when caller doesn't override). */
  defaultConfidence: number
}

/** Models with open weights + redistribution-friendly licenses.
 *  All three are YOLOv8n fine-tuned on aerial/satellite imagery (AGPL-3.0).
 *  See public/models/README.md for provenance details.
 */
export const ONNX_MODEL_REGISTRY: Record<string, OnnxModelInfo> = {
  solar_panel: {
    downloadUrl:
      'https://huggingface.co/keremberke/yolov8n-solar-panel-detection/resolve/main/best.onnx',
    license: 'AGPL-3.0',
    source: 'https://huggingface.co/keremberke/yolov8n-solar-panel-detection',
    classes: ['solar-panel'],
    inputSize: 640,
    defaultConfidence: 0.35,
  },
  informal_struct: {
    downloadUrl:
      'https://huggingface.co/keremberke/yolov8n-building-detection/resolve/main/best.onnx',
    license: 'AGPL-3.0',
    source: 'https://huggingface.co/keremberke/yolov8n-building-detection',
    classes: ['building'],
    inputSize: 640,
    defaultConfidence: 0.30,
  },
  road_damage: {
    downloadUrl:
      'https://huggingface.co/keremberke/yolov8n-road-damage-detection/resolve/main/best.onnx',
    license: 'AGPL-3.0',
    source: 'https://huggingface.co/keremberke/yolov8n-road-damage-detection',
    classes: ['D00', 'D10', 'D20', 'D40'],
    inputSize: 640,
    defaultConfidence: 0.30,
  },
}

// ---------------------------------------------------------------------------
// Model path helpers
// ---------------------------------------------------------------------------

const MODELS_DIR = path.join(process.cwd(), 'public', 'models')

export function modelFilePath(slug: string): string {
  return path.join(MODELS_DIR, `${slug}.onnx`)
}

export function modelExists(slug: string): boolean {
  try {
    return fs.existsSync(modelFilePath(slug))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Model download (lazy — on first inference call)
// ---------------------------------------------------------------------------

/** Download the ONNX file for `slug` from its registry URL into public/models/.
 *  Silently skips if the file already exists. Returns the local path on success
 *  or throws on network / write failure.
 *
 *  HuggingFace gated/private repos require a Bearer token. Set HF_API_TOKEN in
 *  .env (free account at huggingface.co → Settings → Access Tokens → New token
 *  with "Read" scope). The token is only used for the download; the model runs
 *  entirely locally via onnxruntime-node after that. */
export async function downloadOnnxModel(slug: string): Promise<string> {
  const info = ONNX_MODEL_REGISTRY[slug]
  if (!info) throw new Error(`No ONNX model registered for "${slug}"`)

  const filePath = modelFilePath(slug)
  if (fs.existsSync(filePath)) return filePath

  // Ensure the directory exists.
  fs.mkdirSync(MODELS_DIR, { recursive: true })

  const headers: Record<string, string> = {}
  const hfToken = process.env.HF_API_TOKEN
  if (hfToken?.trim()) headers['Authorization'] = `Bearer ${hfToken.trim()}`

  const resp = await fetch(info.downloadUrl, {
    headers,
    signal: AbortSignal.timeout(120_000), // 120 s — model files can be ~10 MB
  })

  if (resp.status === 401) {
    const tokenHint = hfToken
      ? 'The HF_API_TOKEN in .env may not have accepted this model\'s terms — visit ' +
        `${info.source} on huggingface.co, click "Agree and access repository", then retry.`
      : 'Add HF_API_TOKEN=<your_token> to .env (free: huggingface.co → Settings → Access Tokens → ' +
        'Read scope). Alternatively, manually download the file:\n' +
        `  curl -L -H "Authorization: Bearer <token>" "${info.downloadUrl}" \\\n` +
        `       -o public/models/${slug}.onnx`
    throw new Error(
      `ONNX model download blocked (HTTP 401 — model is gated or private on HuggingFace). ${tokenHint}`,
    )
  }

  if (!resp.ok) {
    throw new Error(
      `Model download failed: HTTP ${resp.status} from ${info.downloadUrl}. ` +
        `Check ${info.source} for the correct file path.`,
    )
  }

  const buf = Buffer.from(await resp.arrayBuffer())

  // A 2xx body is not proof of a model. An error page, a captive-portal
  // redirect, or a JSON error object all arrive as HTTP 200 and used to be
  // written straight to <slug>.onnx — where, because the download is skipped
  // whenever the file exists, they poisoned every later run with
  // "Protobuf parsing failed" and never self-healed. (Observed: a 2-byte "{}"
  // saved as informal_struct.onnx.) Validate before committing the file.
  if (buf.length < 1024) {
    throw new Error(
      `Model download from ${info.downloadUrl} returned only ${buf.length} bytes — ` +
      `an error page, not a model. Nothing was written. Check ${info.source}.`,
    )
  }
  // ONNX files are protobuf; the Ultralytics exports all begin with a 0x08 field tag.
  if (buf[0] === 0x3c /* '<' */ || buf[0] === 0x7b /* '{' */) {
    throw new Error(
      `Model download from ${info.downloadUrl} returned HTML/JSON, not an ONNX file. ` +
      `Nothing was written. Check ${info.source}.`,
    )
  }

  // Write via a temp file so an interrupted download cannot leave a truncated
  // model that later loads as a corrupt session.
  const tmpPath = `${filePath}.part`
  fs.writeFileSync(tmpPath, buf)
  fs.renameSync(tmpPath, filePath)
  return filePath
}

// ---------------------------------------------------------------------------
// InferenceSession cache (one session per model slug per process)
// ---------------------------------------------------------------------------

const sessionCache = new Map<string, any>()

async function getSession(modelPath: string, slug: string): Promise<any> {
  if (sessionCache.has(slug)) return sessionCache.get(slug)
  // Dynamic import so webpack doesn't attempt to bundle the native addon.
  // Next.js serverExternalPackages config also prevents bundling.
  const ort = await import('onnxruntime-node' as string)
  const session = await ort.InferenceSession.create(modelPath)
  sessionCache.set(slug, session)
  return session
}

// ---------------------------------------------------------------------------
// Preprocessing: tile bytes → [1, 3, H, W] Float32 tensor (CHW, RGB 0–1)
// ---------------------------------------------------------------------------

export interface LetterboxResult {
  tensor: Float32Array
  /** Scale applied to the shorter dimension — same for both dims since tiles are square. */
  scale: number
  /** X-axis padding added (px, for non-square inputs — will be 0 for square tiles). */
  padX: number
  /** Y-axis padding added. */
  padY: number
}

/** Compute letterbox scale + padding for any src size → square target. */
export function letterboxDimensions(
  srcW: number,
  srcH: number,
  targetSize: number,
): { scale: number; padX: number; padY: number } {
  const scale = Math.min(targetSize / srcW, targetSize / srcH)
  const newW = Math.round(srcW * scale)
  const newH = Math.round(srcH * scale)
  const padX = Math.floor((targetSize - newW) / 2)
  const padY = Math.floor((targetSize - newH) / 2)
  return { scale, padX, padY }
}

/** Decode tile image bytes → CHW Float32 tensor, letterboxed to targetSize×targetSize.
 *  Uses gray (114, 114, 114) padding — standard YOLO letterbox convention. */
export async function preprocessTile(
  tileBytes: ArrayBuffer,
  targetSize = 640,
): Promise<LetterboxResult> {
  const buf = Buffer.from(tileBytes)

  // Resize with letterboxing using gray background.
  const { data } = await sharp(buf)
    .resize(targetSize, targetSize, {
      fit: 'contain',
      background: { r: 114, g: 114, b: 114 },
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const tensor = new Float32Array(3 * targetSize * targetSize)
  for (let y = 0; y < targetSize; y++) {
    for (let x = 0; x < targetSize; x++) {
      const srcIdx = (y * targetSize + x) * 3
      tensor[0 * targetSize * targetSize + y * targetSize + x] = data[srcIdx + 0] / 255
      tensor[1 * targetSize * targetSize + y * targetSize + x] = data[srcIdx + 1] / 255
      tensor[2 * targetSize * targetSize + y * targetSize + x] = data[srcIdx + 2] / 255
    }
  }

  // Esri tiles are always 256×256 squares — scale and padding computed for documentation.
  const { scale, padX, padY } = letterboxDimensions(256, 256, targetSize)
  return { tensor, scale, padX, padY }
}

// ---------------------------------------------------------------------------
// YOLOv8 output decoding
// ---------------------------------------------------------------------------

export interface RawDetection {
  cx: number  // centre-x in model-input pixels
  cy: number  // centre-y in model-input pixels
  w: number
  h: number
  classIdx: number
  confidence: number
}

/** Decode YOLOv8 output tensor.
 *
 *  Standard Ultralytics ONNX export shape: [batch=1, 4+numClasses, numAnchors=8400].
 *  Channel layout: rows are channels (cx, cy, w, h, class_0 … class_N),
 *  columns are anchors — i.e., outputData[(channel * numAnchors) + anchorIdx].
 */
export function decodeYolov8Output(
  outputData: Float32Array,
  numAnchors: number,
  numClasses: number,
  confidenceThreshold: number,
): RawDetection[] {
  const results: RawDetection[] = []

  for (let i = 0; i < numAnchors; i++) {
    const cx = outputData[0 * numAnchors + i]
    const cy = outputData[1 * numAnchors + i]
    const w  = outputData[2 * numAnchors + i]
    const h  = outputData[3 * numAnchors + i]

    let maxProb = 0
    let maxClass = 0
    for (let c = 0; c < numClasses; c++) {
      const p = outputData[(4 + c) * numAnchors + i]
      if (p > maxProb) { maxProb = p; maxClass = c }
    }

    if (maxProb >= confidenceThreshold) {
      results.push({ cx, cy, w, h, classIdx: maxClass, confidence: maxProb })
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// NMS (greedy, IoU-based)
// ---------------------------------------------------------------------------

/** Intersection-over-union for two [x1, y1, x2, y2] boxes. */
export function iou(a: number[], b: number[]): number {
  const ix1 = Math.max(a[0], b[0])
  const iy1 = Math.max(a[1], b[1])
  const ix2 = Math.min(a[2], b[2])
  const iy2 = Math.min(a[3], b[3])
  const interW = Math.max(0, ix2 - ix1)
  const interH = Math.max(0, iy2 - iy1)
  const inter = interW * interH
  if (inter === 0) return 0
  const aArea = (a[2] - a[0]) * (a[3] - a[1])
  const bArea = (b[2] - b[0]) * (b[3] - b[1])
  return inter / (aArea + bArea - inter + 1e-10)
}

/** Greedy NMS. `boxes` is in [x1, y1, x2, y2] format. Returns kept indices. */
export function nmsBoxes(boxes: number[][], scores: number[], iouThresh: number): number[] {
  const order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a])
  const suppressed = new Set<number>()
  const kept: number[] = []

  for (const i of order) {
    if (suppressed.has(i)) continue
    kept.push(i)
    for (const j of order) {
      if (i === j || suppressed.has(j)) continue
      if (iou(boxes[i], boxes[j]) > iouThresh) suppressed.add(j)
    }
  }
  return kept
}

// ---------------------------------------------------------------------------
// Coordinate mapping: model-input pixels → tile pixels
// ---------------------------------------------------------------------------

/** Map a detection box from model-input space (inputSize×inputSize, letterboxed)
 *  back to tile pixel space (tileSize×tileSize).
 *
 *  For square tiles (256×256) letterboxed to a square target (640×640),
 *  the scale is uniform and there is no padding, so the mapping is linear. */
export function onnxToTilePixels(
  cx: number,
  cy: number,
  w: number,
  h: number,
  inputSize: number,
  tileSize: number,
  padX = 0,
  padY = 0,
): { x: number; y: number; width: number; height: number } {
  const scale = tileSize / (inputSize - 2 * Math.max(padX, padY) || inputSize)
  // Remove padding then scale back to tile space
  const x = (cx - padX) * (tileSize / (inputSize - 2 * padX || inputSize))
  const y = (cy - padY) * (tileSize / (inputSize - 2 * padY || inputSize))
  const bw = w * (tileSize / (inputSize - 2 * padX || inputSize))
  const bh = h * (tileSize / (inputSize - 2 * padY || inputSize))
  void scale // suppress unused var — kept for conceptual clarity
  return { x, y, width: bw, height: bh }
}

// ---------------------------------------------------------------------------
// Top-level inference call
// ---------------------------------------------------------------------------

/** Run ONNX YOLO inference on a single tile.
 *
 *  Downloads the model on first call (cached locally thereafter).
 *  Returns an InferenceOutcome matching the runRoboflowInference contract
 *  so all downstream georef + dedupe + provenance logic is reused unchanged. */
export async function runOnnxInference(
  slug: string,
  tileBytes: ArrayBuffer,
  confidenceThreshold: number,
): Promise<InferenceOutcome> {
  const info = ONNX_MODEL_REGISTRY[slug]
  if (!info) {
    return { predictions: [], error: `No ONNX model registered for "${slug}"` }
  }

  // Download if not cached.
  let modelPath: string
  try {
    modelPath = await downloadOnnxModel(slug)
  } catch (err: any) {
    return { predictions: [], error: `Model download failed: ${err?.message ?? 'unknown'}` }
  }

  // Load / reuse inference session.
  let session: any
  try {
    session = await getSession(modelPath, slug)
  } catch (err: any) {
    return { predictions: [], error: `ONNX session load failed: ${err?.message ?? 'unknown'}` }
  }

  // Preprocess tile.
  let preprocessed: LetterboxResult
  try {
    preprocessed = await preprocessTile(tileBytes, info.inputSize)
  } catch (err: any) {
    return { predictions: [], error: `Preprocessing failed: ${err?.message ?? 'unknown'}` }
  }

  // Run inference.
  let outputData: Float32Array
  try {
    const ort = await import('onnxruntime-node' as string)
    const inputName = session.inputNames[0]
    const tensor = new ort.Tensor('float32', preprocessed.tensor, [1, 3, info.inputSize, info.inputSize])
    const results = await session.run({ [inputName]: tensor })
    const output = results[session.outputNames[0]]
    outputData = output.data as Float32Array
  } catch (err: any) {
    return { predictions: [], error: `Inference failed: ${err?.message ?? 'unknown'}` }
  }

  // Decode output — determine numAnchors from output shape.
  const numClasses = info.classes.length
  const numAnchors = Math.round(outputData.length / (4 + numClasses))
  const rawDets = decodeYolov8Output(outputData, numAnchors, numClasses, confidenceThreshold)

  if (rawDets.length === 0) return { predictions: [] }

  // NMS.
  const boxes = rawDets.map((d) => [
    d.cx - d.w / 2,
    d.cy - d.h / 2,
    d.cx + d.w / 2,
    d.cy + d.h / 2,
  ])
  const scores = rawDets.map((d) => d.confidence)
  const kept = nmsBoxes(boxes, scores, 0.45)

  // Map to tile pixel coordinates + Roboflow-compatible prediction shape.
  const predictions: RoboflowPrediction[] = kept.map((idx) => {
    const d = rawDets[idx]
    const px = onnxToTilePixels(d.cx, d.cy, d.w, d.h, info.inputSize, 256, preprocessed.padX, preprocessed.padY)
    const className = info.classes[d.classIdx] ?? `class_${d.classIdx}`
    return {
      class: className,
      confidence: d.confidence,
      x: px.x,
      y: px.y,
      width: px.width,
      height: px.height,
    }
  })

  return { predictions }
}
