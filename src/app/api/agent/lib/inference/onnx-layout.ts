/** ONNX detection-output layout identification.
 *
 *  WHY THIS EXISTS: on 2026-08-10 the local-onnx adapter was handed YOLOv10's
 *  end-to-end output `[1, 300, 6]`, inferred "296 classes × 6 anchors" from the
 *  dims, decoded the resulting garbage, and reported **5 confident detections**.
 *  Nothing was wrong with the model or the runtime — the decoder simply assumed
 *  a layout and never checked.
 *
 *  An unrecognised tensor must be an error, not detections. So the shape is now
 *  matched against the layouts we can actually decode, and anything else is
 *  rejected by name.
 *
 *  Pure module: no I/O, no runtime dependency.
 */

import type { RawDetection } from '../cv-onnx'

/**
 * Anchor count for an Ultralytics YOLO export at a given square input size.
 * Detection heads run at strides 8, 16 and 32, so the totals are fixed:
 * 640 → 8400, 800 → 13125, 1024 → 21504.
 */
export function expectedAnchors(inputSize: number): number {
  const s = inputSize
  return (s / 8) ** 2 + (s / 16) ** 2 + (s / 32) ** 2
}

export type OnnxLayout =
  /** Ultralytics YOLOv8/v11: `[1, 4 + numClasses, numAnchors]`, needs NMS. */
  | { kind: 'ultralytics'; numClasses: number; numAnchors: number }
  /** End-to-end (YOLOv10, RT-DETR): `[1, N, 6]` rows of x0,y0,x1,y1,score,class. NMS already applied. */
  | { kind: 'end-to-end'; numRows: number }
  /**
   * Oriented-bounding-box end-to-end (DOTA-trained aerial detectors):
   * `[1, N, 7]` rows of **cx,cy,w,h**,score,class,angle. NMS already applied.
   *
   * Note the box convention differs from the 6-column head: these are centre and
   * size, not corners. Verified 2026-08-10 by cropping the decoded boxes out of
   * the source mosaic — read as corners the rows are invalid (x1 < x0), read as
   * centre+size all seven contained aircraft.
   */
  | { kind: 'end-to-end-obb'; numRows: number }
  | { kind: 'unknown'; reason: string }

/**
 * Identify the output layout, or explain why it cannot be decoded.
 *
 * `declaredClasses` (from the model spec) is used as a cross-check, not as a
 * source of truth: if the tensor says one class and the user declared three,
 * something is wrong and decoding either way would mislabel every detection.
 */
export function detectOnnxLayout(
  dims: readonly number[] | undefined,
  inputSize: number,
  declaredClasses: number | undefined,
): OnnxLayout {
  const shape = dims ? dims.join('×') : '(no dims reported)'
  if (!dims || dims.length !== 3) {
    return {
      kind: 'unknown',
      reason: `output shape ${shape} is not a 3-D detection tensor.`,
    }
  }

  const [, d1, d2] = dims

  // End-to-end: a small fixed row budget, exactly 6 values per row.
  if (d2 === 6 && d1 >= 1 && d1 <= 5000) {
    return { kind: 'end-to-end', numRows: d1 }
  }

  // Oriented-box end-to-end: the same fixed row budget with an extra angle
  // column. Checked before the Ultralytics branch because [1, 300, 7] would
  // otherwise be read as "295 classes × 7 anchors" — the ISS-122 failure, which
  // this head reproduced exactly when first tried.
  if (d2 === 7 && d1 >= 1 && d1 <= 5000) {
    return { kind: 'end-to-end-obb', numRows: d1 }
  }

  // Ultralytics: the anchor count is determined by the input size, so it is a
  // precise test rather than a guess.
  const anchors = expectedAnchors(inputSize)
  if (d2 === anchors && d1 > 4) {
    const numClasses = d1 - 4
    if (declaredClasses != null && declaredClasses !== numClasses) {
      return {
        kind: 'unknown',
        reason:
          `output shape ${shape} encodes ${numClasses} class(es) but the model declared ${declaredClasses}. ` +
          `Decoding would mislabel every detection — fix "classes" on the model, or drop it to use the tensor's own count.`,
      }
    }
    return { kind: 'ultralytics', numClasses, numAnchors: d2 }
  }

  return {
    kind: 'unknown',
    reason:
      `output shape ${shape} matches neither an Ultralytics export ` +
      `([1, 4+classes, ${anchors}] at input ${inputSize}) nor an end-to-end head ` +
      `([1, N, 6], or [1, N, 7] for oriented boxes).`,
  }
}

/**
 * Decode an oriented-box end-to-end tensor: N rows of
 * `[cx, cy, w, h, score, classIndex, angleRadians]`, already NMS-ed.
 *
 * The angle is deliberately discarded here: downstream georeferencing emits
 * axis-aligned rings, and rotating the box without also rotating the ring would
 * put the polygon somewhere the object is not. An axis-aligned box around a
 * rotated object is honest; a mis-rotated one is not.
 */
export function decodeEndToEndObb(
  data: Float32Array,
  numRows: number,
  confidenceThreshold: number,
): RawDetection[] {
  const out: RawDetection[] = []
  for (let i = 0; i < numRows; i++) {
    const o = i * 7
    const score = data[o + 4]
    if (!(score >= confidenceThreshold)) continue
    const w = data[o + 2]
    const h = data[o + 3]
    if (!(w > 0) || !(h > 0)) continue
    out.push({
      cx: data[o + 0],
      cy: data[o + 1],
      w,
      h,
      classIdx: Math.max(0, Math.round(data[o + 5])),
      confidence: score,
    })
  }
  return out
}

/**
 * Decode an end-to-end detection tensor: N rows of
 * `[x0, y0, x1, y1, score, classIndex]`, already NMS-ed by the model.
 *
 * Returns the same `RawDetection` shape as the Ultralytics decoder so the
 * caller's mapping and filtering stay identical.
 */
export function decodeEndToEnd(
  data: Float32Array,
  numRows: number,
  confidenceThreshold: number,
): RawDetection[] {
  const out: RawDetection[] = []
  for (let i = 0; i < numRows; i++) {
    const o = i * 6
    const score = data[o + 4]
    if (!(score >= confidenceThreshold)) continue
    const x0 = data[o + 0]
    const y0 = data[o + 1]
    const x1 = data[o + 2]
    const y1 = data[o + 3]
    const w = Math.abs(x1 - x0)
    const h = Math.abs(y1 - y0)
    if (!(w > 0) || !(h > 0)) continue
    out.push({
      cx: Math.min(x0, x1) + w / 2,
      cy: Math.min(y0, y1) + h / 2,
      w,
      h,
      classIdx: Math.max(0, Math.round(data[o + 5])),
      confidence: score,
    })
  }
  return out
}
