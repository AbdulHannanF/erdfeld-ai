/**
 * ONNX output-layout detection.
 *
 * Caught by the live yolov10n run on 2026-08-10: the adapter read YOLOv10's
 * end-to-end output `[1, 300, 6]` as "296 classes × 6 anchors", decoded the
 * garbage, and reported **5 confident detections**. That is the precise failure
 * this codebase exists to prevent — an output the decoder does not understand
 * must never become detections.
 *
 * Two real layouts:
 *   Ultralytics YOLOv8/v11  [1, 4+C, A]  A = (s/8)² + (s/16)² + (s/32)²
 *                                        (8400 at 640, 13125 at 800, 21504 at 1024)
 *   End-to-end YOLOv10/RT-DETR [1, N, 6] rows of [x0, y0, x1, y1, score, class]
 *
 * Anything else is rejected by name.
 */

import { describe, expect, it } from 'vitest'
import { expectedAnchors, detectOnnxLayout, decodeEndToEnd, decodeEndToEndObb } from '../onnx-layout'

describe('expectedAnchors — Ultralytics stride 8/16/32 anchor count', () => {
  it('matches the documented counts', () => {
    expect(expectedAnchors(640)).toBe(8400)
    expect(expectedAnchors(320)).toBe(2100)
    expect(expectedAnchors(1024)).toBe(21504)
  })
})

describe('detectOnnxLayout', () => {
  it('recognises an Ultralytics export at 640 with 1 class', () => {
    const l = detectOnnxLayout([1, 5, 8400], 640, 1)
    expect(l.kind).toBe('ultralytics')
    if (l.kind !== 'ultralytics') return
    expect(l.numClasses).toBe(1)
    expect(l.numAnchors).toBe(8400)
  })

  it('recognises an Ultralytics export at 640 with 80 COCO classes', () => {
    const l = detectOnnxLayout([1, 84, 8400], 640, undefined)
    expect(l.kind).toBe('ultralytics')
    if (l.kind !== 'ultralytics') return
    expect(l.numClasses).toBe(80)
  })

  it('recognises the YOLOv10 end-to-end shape instead of misreading it', () => {
    // The exact shape that produced 5 phantom detections.
    const l = detectOnnxLayout([1, 300, 6], 640, undefined)
    expect(l.kind).toBe('end-to-end')
    if (l.kind !== 'end-to-end') return
    expect(l.numRows).toBe(300)
  })

  it('rejects a shape it cannot place, naming the dims', () => {
    // 9 columns matches no head we can decode. ([1, N, 7] used to live here, but
    // it was measured on 2026-08-10 to be a real oriented-box head — see the
    // "OBB end-to-end head" block below.)
    const l = detectOnnxLayout([1, 300, 9], 640, undefined)
    expect(l.kind).toBe('unknown')
    if (l.kind !== 'unknown') return
    expect(l.reason).toContain('1×300×9')
  })

  it('rejects an anchor count that does not match the input size', () => {
    // 8400 anchors is right for 640, not for 1024.
    expect(detectOnnxLayout([1, 5, 8400], 1024, 1).kind).toBe('unknown')
  })

  it('rejects a 2-D output', () => {
    expect(detectOnnxLayout([8400, 5], 640, 1).kind).toBe('unknown')
  })

  it('refuses when the declared class count contradicts the tensor', () => {
    // Declared 3 classes, but [1, 5, 8400] encodes 1.
    const l = detectOnnxLayout([1, 5, 8400], 640, 3)
    expect(l.kind).toBe('unknown')
    if (l.kind !== 'unknown') return
    expect(l.reason).toMatch(/declared 3/i)
  })
})

describe('decodeEndToEnd — YOLOv10 / RT-DETR rows', () => {
  it('decodes [x0,y0,x1,y1,score,class] rows above the threshold', () => {
    const rows = new Float32Array([
      100, 200, 140, 260, 0.90, 2,
      10, 10, 20, 20, 0.10, 0,     // below threshold
      300, 300, 320, 340, 0.55, 1,
    ])
    const out = decodeEndToEnd(rows, 3, 0.3)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ cx: 120, cy: 230, w: 40, h: 60, classIdx: 2 })
    expect(out[0].confidence).toBeCloseTo(0.9, 5) // Float32 stores 0.9 as 0.89999998
    expect(out[1].classIdx).toBe(1)
  })

  it('drops degenerate boxes rather than emitting zero-area detections', () => {
    const rows = new Float32Array([50, 50, 50, 50, 0.99, 0])
    expect(decodeEndToEnd(rows, 1, 0.3)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Oriented-bounding-box heads (DOTA-trained aerial detectors) — Phase 2
// ---------------------------------------------------------------------------

describe('OBB end-to-end head — [1, N, 7]', () => {
  it('identifies the 7-column head instead of rejecting it as unknown', () => {
    const layout = detectOnnxLayout([1, 300, 7], 1024, 15)
    expect(layout.kind).toBe('end-to-end-obb')
    expect(layout).toMatchObject({ numRows: 300 })
  })

  it('does not mistake it for an Ultralytics head', () => {
    // Measured 2026-08-10: reading [1,300,7] as [1, 4+classes, anchors] yields
    // "295 classes", scores of 1021 and labels like "c163" — the ISS-122 failure.
    const layout = detectOnnxLayout([1, 300, 7], 1024, 15)
    expect(layout).not.toMatchObject({ kind: 'ultralytics' })
  })

  it('decodes rows as centre+size, which is what the head actually emits', () => {
    // Real row from steven0226/yolo26m-obb-dota over Schiphol, verified by
    // cropping the box out of the mosaic: it contained an aircraft.
    // Read as corners this is invalid (x1 < x0), which is how we know.
    const rows = new Float32Array([887.35, 664.27, 179.73, 200.72, 0.97, 0, -0.16])
    const out = decodeEndToEndObb(rows, 1, 0.25)
    expect(out).toHaveLength(1)
    expect(out[0].cx).toBeCloseTo(887.35, 2)
    expect(out[0].cy).toBeCloseTo(664.27, 2)
    expect(out[0].w).toBeCloseTo(179.73, 2)
    expect(out[0].h).toBeCloseTo(200.72, 2)
    expect(out[0].classIdx).toBe(0)
  })

  it('honours the confidence floor', () => {
    const rows = new Float32Array([
      100, 100, 40, 20, 0.80, 10, 0.4,
      200, 200, 40, 20, 0.05, 10, 0.4,
    ])
    expect(decodeEndToEndObb(rows, 2, 0.25)).toHaveLength(1)
  })

  it('drops zero-area rows rather than georeferencing a point as an object', () => {
    const rows = new Float32Array([100, 100, 0, 20, 0.99, 0, 0])
    expect(decodeEndToEndObb(rows, 1, 0.25)).toEqual([])
  })
})
