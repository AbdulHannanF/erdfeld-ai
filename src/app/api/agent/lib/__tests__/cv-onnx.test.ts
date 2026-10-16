import { describe, expect, it } from 'vitest'
import {
  decodeYolov8Output,
  iou,
  letterboxDimensions,
  nmsBoxes,
  ONNX_MODEL_REGISTRY,
  onnxToTilePixels,
} from '../cv-onnx'
import { ONNX_SUPPORTED_MODELS, pickCvProvider } from '../cv'

// ---------------------------------------------------------------------------
// letterboxDimensions
// ---------------------------------------------------------------------------

describe('letterboxDimensions', () => {
  it('square → square: scale=1, no padding', () => {
    const { scale, padX, padY } = letterboxDimensions(640, 640, 640)
    expect(scale).toBe(1)
    expect(padX).toBe(0)
    expect(padY).toBe(0)
  })

  it('256 tile → 640 target: uniform scale with no padding (square source)', () => {
    const { scale, padX, padY } = letterboxDimensions(256, 256, 640)
    expect(scale).toBeCloseTo(640 / 256, 5)
    expect(padX).toBe(0)
    expect(padY).toBe(0)
  })

  it('wide image → square: padded top/bottom', () => {
    // 640×320 → 640×640: scale=1 for width, height needs padding
    const { scale, padX, padY } = letterboxDimensions(640, 320, 640)
    expect(scale).toBe(1)
    expect(padX).toBe(0)
    expect(padY).toBe(160) // (640 - 320*1) / 2
  })

  it('tall image → square: padded left/right', () => {
    const { scale, padX, padY } = letterboxDimensions(320, 640, 640)
    expect(scale).toBe(1)
    expect(padX).toBe(160)
    expect(padY).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// iou
// ---------------------------------------------------------------------------

describe('iou', () => {
  it('identical boxes → 1.0', () => {
    expect(iou([0, 0, 10, 10], [0, 0, 10, 10])).toBeCloseTo(1.0)
  })

  it('non-overlapping boxes → 0', () => {
    expect(iou([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0)
  })

  it('50% overlap', () => {
    // Box A: [0,0,10,10]  Box B: [5,0,15,10] — 5×10 intersection / 200-50 union
    const result = iou([0, 0, 10, 10], [5, 0, 15, 10])
    expect(result).toBeCloseTo(50 / 150, 4)
  })

  it('contained box → high IoU', () => {
    const result = iou([0, 0, 10, 10], [2, 2, 8, 8])
    // intersection = 6×6 = 36, union = 100 + 36 - 36 = 100
    expect(result).toBeCloseTo(36 / 100, 4)
  })
})

// ---------------------------------------------------------------------------
// nmsBoxes
// ---------------------------------------------------------------------------

describe('nmsBoxes', () => {
  it('single box → kept', () => {
    const kept = nmsBoxes([[0, 0, 10, 10]], [0.9], 0.45)
    expect(kept).toEqual([0])
  })

  it('two non-overlapping boxes → both kept', () => {
    const kept = nmsBoxes(
      [[0, 0, 10, 10], [20, 20, 30, 30]],
      [0.9, 0.8],
      0.45,
    )
    expect(kept).toHaveLength(2)
  })

  it('two heavily-overlapping boxes → lower-conf suppressed', () => {
    // Near-identical boxes: IoU ≈ 0.96
    const kept = nmsBoxes(
      [[0, 0, 10, 10], [1, 1, 11, 11]],
      [0.9, 0.7],
      0.45,
    )
    expect(kept).toEqual([0]) // only the 0.9-score box
  })

  it('respects iouThresh — below threshold keeps both', () => {
    // ~50% overlap
    const kept = nmsBoxes(
      [[0, 0, 10, 10], [5, 0, 15, 10]],
      [0.9, 0.8],
      0.6, // threshold above the ~0.33 iou
    )
    expect(kept).toHaveLength(2)
  })

  it('three boxes: top-scoring suppresses only nearby one', () => {
    const boxes = [
      [0, 0, 10, 10],   // high conf — idx 0
      [1, 1, 11, 11],   // overlaps idx 0 heavily — idx 1
      [50, 50, 60, 60], // far away — idx 2
    ]
    const scores = [0.9, 0.8, 0.7]
    const kept = nmsBoxes(boxes, scores, 0.45)
    expect(kept).toContain(0)
    expect(kept).not.toContain(1)
    expect(kept).toContain(2)
  })
})

// ---------------------------------------------------------------------------
// decodeYolov8Output
// ---------------------------------------------------------------------------

describe('decodeYolov8Output', () => {
  const NUM_ANCHORS = 8400
  const NUM_CLASSES = 1

  /** Build a minimal YOLOv8 output buffer with one synthetic positive detection. */
  function makeSyntheticOutput(
    cx: number, cy: number, w: number, h: number, classProb: number,
  ): Float32Array {
    // Column-major layout: [4+C, 8400]
    const data = new Float32Array((4 + NUM_CLASSES) * NUM_ANCHORS)
    // Anchor 0 is our detection
    data[0 * NUM_ANCHORS + 0] = cx
    data[1 * NUM_ANCHORS + 0] = cy
    data[2 * NUM_ANCHORS + 0] = w
    data[3 * NUM_ANCHORS + 0] = h
    data[4 * NUM_ANCHORS + 0] = classProb
    return data
  }

  it('returns one detection above threshold', () => {
    const data = makeSyntheticOutput(320, 320, 50, 50, 0.8)
    const dets = decodeYolov8Output(data, NUM_ANCHORS, NUM_CLASSES, 0.5)
    expect(dets).toHaveLength(1)
    expect(dets[0].cx).toBe(320)
    expect(dets[0].cy).toBe(320)
    expect(dets[0].confidence).toBeCloseTo(0.8, 5)
    expect(dets[0].classIdx).toBe(0)
  })

  it('filters below threshold', () => {
    const data = makeSyntheticOutput(320, 320, 50, 50, 0.3)
    const dets = decodeYolov8Output(data, NUM_ANCHORS, NUM_CLASSES, 0.5)
    expect(dets).toHaveLength(0)
  })

  it('multi-class: picks the highest-prob class', () => {
    const numClasses = 3
    const data = new Float32Array((4 + numClasses) * NUM_ANCHORS)
    data[0 * NUM_ANCHORS + 0] = 100
    data[1 * NUM_ANCHORS + 0] = 200
    data[2 * NUM_ANCHORS + 0] = 30
    data[3 * NUM_ANCHORS + 0] = 40
    data[4 * NUM_ANCHORS + 0] = 0.2  // class 0
    data[5 * NUM_ANCHORS + 0] = 0.8  // class 1 ← winner
    data[6 * NUM_ANCHORS + 0] = 0.4  // class 2
    const dets = decodeYolov8Output(data, NUM_ANCHORS, numClasses, 0.5)
    expect(dets).toHaveLength(1)
    expect(dets[0].classIdx).toBe(1)
    expect(dets[0].confidence).toBeCloseTo(0.8, 5)
  })
})

// ---------------------------------------------------------------------------
// onnxToTilePixels
// ---------------------------------------------------------------------------

describe('onnxToTilePixels', () => {
  it('center of 640×640 → center of 256×256 (no padding)', () => {
    const result = onnxToTilePixels(320, 320, 20, 20, 640, 256, 0, 0)
    expect(result.x).toBeCloseTo(128, 1)
    expect(result.y).toBeCloseTo(128, 1)
    expect(result.width).toBeCloseTo((20 * 256) / 640, 2)
    expect(result.height).toBeCloseTo((20 * 256) / 640, 2)
  })

  it('top-left corner maps near (0, 0)', () => {
    const result = onnxToTilePixels(0, 0, 10, 10, 640, 256, 0, 0)
    expect(result.x).toBeCloseTo(0, 1)
    expect(result.y).toBeCloseTo(0, 1)
  })
})

// ---------------------------------------------------------------------------
// ONNX_MODEL_REGISTRY completeness
// ---------------------------------------------------------------------------

describe('ONNX_MODEL_REGISTRY', () => {
  it('has all three priority models', () => {
    expect(ONNX_MODEL_REGISTRY).toHaveProperty('solar_panel')
    expect(ONNX_MODEL_REGISTRY).toHaveProperty('informal_struct')
    expect(ONNX_MODEL_REGISTRY).toHaveProperty('road_damage')
  })

  it('each entry has required fields', () => {
    for (const [slug, info] of Object.entries(ONNX_MODEL_REGISTRY)) {
      expect(info.downloadUrl, `${slug}.downloadUrl`).toBeTruthy()
      expect(info.license, `${slug}.license`).toBeTruthy()
      expect(info.source, `${slug}.source`).toBeTruthy()
      expect(info.classes.length, `${slug}.classes`).toBeGreaterThan(0)
      expect(info.inputSize, `${slug}.inputSize`).toBeGreaterThan(0)
    }
  })

  it('all entries use redistribution-friendly licenses (not "research only")', () => {
    const okLicenses = ['AGPL-3.0', 'Apache-2.0', 'MIT', 'CC-BY-4.0', 'CC-BY-SA-4.0']
    for (const [slug, info] of Object.entries(ONNX_MODEL_REGISTRY)) {
      expect(okLicenses, `${slug} license "${info.license}" is not redistribution-friendly`).toContain(info.license)
    }
  })

  it('download URLs are HTTPS', () => {
    for (const [slug, info] of Object.entries(ONNX_MODEL_REGISTRY)) {
      expect(info.downloadUrl, `${slug} downloadUrl`).toMatch(/^https:\/\//)
    }
  })
})

// ---------------------------------------------------------------------------
// pickCvProvider
// ---------------------------------------------------------------------------

describe('pickCvProvider', () => {
  it('prefers roboflow when key is set', () => {
    expect(pickCvProvider('solar_panel', {}, { ROBOFLOW_API_KEY: 'abc' })).toBe('roboflow')
  })

  it('falls back to onnx for supported models when no key', () => {
    expect(pickCvProvider('solar_panel', {}, {})).toBe('onnx')
    expect(pickCvProvider('informal_struct', {}, {})).toBe('onnx')
    expect(pickCvProvider('road_damage', {}, {})).toBe('onnx')
  })

  it('returns none for unsupported models without roboflow key', () => {
    expect(pickCvProvider('manhole', {}, {})).toBe('none')
    expect(pickCvProvider('water_channel', {}, {})).toBe('none')
  })

  // ISS-128. These two used to assert `'hf'` — the fifth time in this project a
  // test has pinned a defect as correct behaviour (after ISS-110, 106, 107,
  // 108). `hf` pointed at `api-inference.huggingface.co`, which no longer
  // resolves (curl exit 6) and which served neither grounding-dino model even
  // before that (`inferenceProviderMapping: {}`, re-verified 2026-08-16).
  it('never routes a text_prompt to a backend that cannot run it', () => {
    expect(pickCvProvider('manhole', { text_prompt: 'manhole cover' }, {})).toBe('none')
  })

  it('lets a text_prompt fall through to the working local ONNX detector', () => {
    // The old order put `hf` ABOVE the ONNX check, so this request went to a
    // dead host while a working provider sat one line below.
    expect(pickCvProvider('solar_panel', { text_prompt: 'solar panel' }, {})).toBe('onnx')
  })

  it('still prefers roboflow for a text_prompt when a key is configured', () => {
    expect(pickCvProvider('manhole', { text_prompt: 'manhole' }, { ROBOFLOW_API_KEY: 'abc' })).toBe('roboflow')
  })

  it('explicit provider=onnx forces onnx', () => {
    expect(pickCvProvider('solar_panel', { provider: 'onnx' }, { ROBOFLOW_API_KEY: 'abc' })).toBe('onnx')
  })

  it('explicit provider=roboflow returns none when no key', () => {
    expect(pickCvProvider('solar_panel', { provider: 'roboflow' }, {})).toBe('none')
  })

  it('asking for provider=hf by name gets an honest refusal, not a dead route', () => {
    expect(pickCvProvider('solar_panel', { provider: 'hf' }, { ROBOFLOW_API_KEY: 'abc' })).toBe('none')
  })
})

// ---------------------------------------------------------------------------
// ONNX_SUPPORTED_MODELS set
// ---------------------------------------------------------------------------

describe('ONNX_SUPPORTED_MODELS', () => {
  it('contains exactly the three priority categories', () => {
    expect(ONNX_SUPPORTED_MODELS.has('solar_panel')).toBe(true)
    expect(ONNX_SUPPORTED_MODELS.has('informal_struct')).toBe(true)
    expect(ONNX_SUPPORTED_MODELS.has('road_damage')).toBe(true)
    expect(ONNX_SUPPORTED_MODELS.has('manhole')).toBe(false)
  })

  it('matches ONNX_MODEL_REGISTRY keys', () => {
    for (const slug of ONNX_SUPPORTED_MODELS) {
      expect(ONNX_MODEL_REGISTRY, `${slug} in ONNX_SUPPORTED_MODELS but not in registry`).toHaveProperty(slug)
    }
  })
})
