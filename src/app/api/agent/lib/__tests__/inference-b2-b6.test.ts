/**
 * Unit tests for Phase 2 B2–B6 — provider clients, gateway caching, and new tools.
 *
 * B2: HF / Replicate / selfhosted provider clients (request-building + error-mapping)
 * B3: detect_objects — tile-grid detection, degrade path, result structure
 * B4: segment_feature — mask→polygon conversion, degrade path
 * B5: classify_vegetation — WorldCover + NDVI, honesty framing
 * B6: makeInferenceCacheKey, deep-model cost labeling
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// B2 — HuggingFace provider
// ---------------------------------------------------------------------------

import { boxToGeoPolygon } from '../inference/box-geo'

describe('boxToGeoPolygon (pixel box → geo polygon)', () => {
  const tileBounds = { west: 10.0, south: 20.0, east: 10.01, north: 20.01 }
  const tilePx = 256

  it('returns a closed 5-point ring', () => {
    const coords = boxToGeoPolygon({ xmin: 0, ymin: 0, xmax: 256, ymax: 256 }, tileBounds, tilePx)
    expect(coords[0]).toHaveLength(5)
    expect(coords[0][0]).toEqual(coords[0][4])  // closed ring
  })

  it('maps full-tile box to exactly the tile bounds', () => {
    const coords = boxToGeoPolygon({ xmin: 0, ymin: 0, xmax: 256, ymax: 256 }, tileBounds, tilePx)
    const ring = coords[0]
    const lons = ring.map((p) => p[0])
    const lats = ring.map((p) => p[1])
    expect(Math.min(...lons)).toBeCloseTo(tileBounds.west, 8)
    expect(Math.max(...lons)).toBeCloseTo(tileBounds.east, 8)
    expect(Math.min(...lats)).toBeCloseTo(tileBounds.south, 8)
    expect(Math.max(...lats)).toBeCloseTo(tileBounds.north, 8)
  })

  it('maps a center quarter-tile box to the center quarter of the tile bounds', () => {
    const coords = boxToGeoPolygon({ xmin: 64, ymin: 64, xmax: 192, ymax: 192 }, tileBounds, tilePx)
    const ring = coords[0]
    const lons = ring.map((p) => p[0])
    const lats = ring.map((p) => p[1])
    const lonMid = (tileBounds.west + tileBounds.east) / 2
    const latMid = (tileBounds.south + tileBounds.north) / 2
    // Center quarter: lon ∈ [0.25..0.75] of tile, lat similar
    expect(Math.min(...lons)).toBeCloseTo(tileBounds.west + (tileBounds.east - tileBounds.west) * 0.25, 6)
    expect(Math.max(...lons)).toBeCloseTo(tileBounds.west + (tileBounds.east - tileBounds.west) * 0.75, 6)
    // Y is flipped: ymin=64 pixel → near north side, ymax=192 → near south
    expect(Math.max(...lats)).toBeCloseTo(latMid + (tileBounds.north - latMid) * 0.5, 5)
    expect(Math.min(...lats)).toBeCloseTo(latMid - (latMid - tileBounds.south) * 0.5, 5)
  })

  it('y-axis flip: pixel ymin=0 maps to north latitude', () => {
    const coords = boxToGeoPolygon({ xmin: 0, ymin: 0, xmax: 10, ymax: 0 }, tileBounds, tilePx)
    const ring = coords[0]
    const maxLat = Math.max(...ring.map((p) => p[1]))
    expect(maxLat).toBeCloseTo(tileBounds.north, 6)
  })
})

// ---------------------------------------------------------------------------
// B2 — HF provider fetch integration (mock fetch)
// ---------------------------------------------------------------------------

// The HF provider client was deleted (ISS-104): HuggingFace serverless serves
// none of these models — verified 2026-08-09 and re-verified 2026-08-10, every
// candidate reports an inferenceProviderMapping with zero providers. Its tests
// went with it; see hf-retirement.test.ts for the assertions that replaced them.

// ---------------------------------------------------------------------------
// B2 — Replicate provider (mocked fetch)
// ---------------------------------------------------------------------------

describe('Replicate provider — predict + poll (mocked fetch)', () => {
  const savedToken = process.env.REPLICATE_API_TOKEN

  beforeEach(() => {
    process.env.REPLICATE_API_TOKEN = 'r8_test_token'
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    if (savedToken === undefined) delete process.env.REPLICATE_API_TOKEN
    else process.env.REPLICATE_API_TOKEN = savedToken
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('creates prediction then polls until succeeded', async () => {
    const { infer } = await import('../inference/providers/replicate')
    const { MODEL_REGISTRY } = await import('../inference/registry')

    // First call: create prediction
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true, status: 201,
        json: async () => ({
          id: 'pred_abc123',
          status: 'starting',
          urls: { get: 'https://api.replicate.com/v1/predictions/pred_abc123' },
        }),
        headers: { get: () => null },
      } as any)
      // Second call: poll → still processing
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ id: 'pred_abc123', status: 'processing' }),
        headers: { get: () => null },
      } as any)
      // Third call: poll → succeeded
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({
          id: 'pred_abc123',
          status: 'succeeded',
          output: {
            combined_mask: 'https://example.com/mask.png',
            scores: [0.93],
          },
        }),
        headers: { get: () => null },
      } as any)

    const result = await infer(
      'meta/sam-2',
      { imageUrl: 'https://example.com/tile.jpg', inputPoints: [[128, 128]] },
      MODEL_REGISTRY['sam2'],
    )

    expect(result.maskUrl).toBe('https://example.com/mask.png')
    expect(result.confidence).toBeCloseTo(0.93, 2)
    expect(result.provenance).toContain('replicate')
    expect(result.resolution_limit).toBeTruthy()
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('throws when prediction fails', async () => {
    const { infer } = await import('../inference/providers/replicate')
    const { MODEL_REGISTRY } = await import('../inference/registry')

    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true, status: 201,
        json: async () => ({ id: 'pred_fail', status: 'starting', urls: { get: 'https://api.replicate.com/v1/predictions/pred_fail' } }),
        headers: { get: () => null },
      } as any)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ id: 'pred_fail', status: 'failed', error: 'CUDA out of memory' }),
        headers: { get: () => null },
      } as any)

    await expect(
      infer('meta/sam-2', { imageUrl: 'https://example.com/tile.jpg' }, MODEL_REGISTRY['sam2']),
    ).rejects.toThrow('CUDA out of memory')
  })

  it('throws when REPLICATE_API_TOKEN is missing', async () => {
    delete process.env.REPLICATE_API_TOKEN
    const { infer } = await import('../inference/providers/replicate')
    const { MODEL_REGISTRY } = await import('../inference/registry')

    await expect(
      infer('meta/sam-2', {}, MODEL_REGISTRY['sam2']),
    ).rejects.toThrow('REPLICATE_API_TOKEN')
  })

  it('builds correct grounding-dino input (dot-terminated prompt)', async () => {
    const { infer } = await import('../inference/providers/replicate')
    const { MODEL_REGISTRY } = await import('../inference/registry')

    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true, status: 201,
        json: async () => ({ id: 'p1', status: 'starting', urls: { get: 'https://api.replicate.com/v1/predictions/p1' } }),
        headers: { get: () => null },
      } as any)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({
          id: 'p1', status: 'succeeded',
          output: { detections: [{ phrase: 'car', bbox: [10, 10, 100, 100], logit: 0.78 }] },
        }),
        headers: { get: () => null },
      } as any)

    await infer(
      'adirik/grounding-dino',
      { imageUrl: 'https://example.com/tile.jpg', prompt: 'car', threshold: 0.25 },
      MODEL_REGISTRY['grounding_dino'],
    )

    const createCall = vi.mocked(fetch).mock.calls[0]
    const body = JSON.parse(createCall[1]!.body as string)
    // text_prompt should end with '.'
    expect(body.input.text_prompt).toBe('car.')
  })
})

// ---------------------------------------------------------------------------
// B2 — Self-hosted provider (mocked fetch)
// ---------------------------------------------------------------------------

describe('Selfhosted provider — POST + parse (mocked fetch)', () => {
  const savedEndpoint = process.env.INFERENCE_ENDPOINT

  beforeEach(() => {
    process.env.INFERENCE_ENDPOINT = 'http://localhost:8080'
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.INFERENCE_ENDPOINT
    else process.env.INFERENCE_ENDPOINT = savedEndpoint
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('POSTs to INFERENCE_ENDPOINT + route and returns normalized output', async () => {
    const { infer } = await import('../inference/providers/selfhosted')
    const { MODEL_REGISTRY } = await import('../inference/registry')

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        geojson: { type: 'FeatureCollection', features: [] },
        confidence: 0.85,
        resolution_limit: 'test',
        provenance: 'selfhosted:/infer/grounding-dino',
      }),
      headers: { get: () => null },
    } as any)

    const result = await infer(
      '/infer/grounding-dino',
      { prompt: 'car' },
      MODEL_REGISTRY['grounding_dino'],
    )

    expect(result.geojson).toBeDefined()
    expect(result.confidence).toBe(0.85)
    expect(result.provenance).toBe('selfhosted:/infer/grounding-dino')

    const callUrl = vi.mocked(fetch).mock.calls[0][0] as string
    expect(callUrl).toBe('http://localhost:8080/infer/grounding-dino')
  })

  it('throws on non-200 from self-hosted server', async () => {
    const { infer } = await import('../inference/providers/selfhosted')
    const { MODEL_REGISTRY } = await import('../inference/registry')

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false, status: 500,
      text: async () => 'Internal Server Error',
      headers: { get: () => null },
    } as any)

    await expect(
      infer('/infer/grounding-dino', {}, MODEL_REGISTRY['grounding_dino']),
    ).rejects.toThrow('500')
  })

  it('throws when response has no recognized output field', async () => {
    const { infer } = await import('../inference/providers/selfhosted')
    const { MODEL_REGISTRY } = await import('../inference/registry')

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ confidence: 0.5 }), // no geojson/maskPng/maskUrl/labels
      headers: { get: () => null },
    } as any)

    await expect(
      infer('/infer/grounding-dino', {}, MODEL_REGISTRY['grounding_dino']),
    ).rejects.toThrow('geojson')
  })

  it('throws when INFERENCE_ENDPOINT is not set', async () => {
    delete process.env.INFERENCE_ENDPOINT
    const { infer } = await import('../inference/providers/selfhosted')
    const { MODEL_REGISTRY } = await import('../inference/registry')

    await expect(
      infer('/infer/grounding-dino', {}, MODEL_REGISTRY['grounding_dino']),
    ).rejects.toThrow('INFERENCE_ENDPOINT')
  })
})

// ---------------------------------------------------------------------------
// B3 — detect_objects — honest degrade path (no provider)
// ---------------------------------------------------------------------------

describe('detect_objects — honest degrade (B3)', () => {
  const VARS = ['INFERENCE_PROVIDER', 'HF_API_TOKEN', 'REPLICATE_API_TOKEN', 'INFERENCE_ENDPOINT']
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    VARS.forEach((v) => { saved[v] = process.env[v]; delete process.env[v] })
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    VARS.forEach((v) => { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v] })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('returns an honest degrade message (not throw) when no provider configured', async () => {
    const { detectObjects } = await import('../../tools/inference')

    // Mock tile fetch to succeed so we get to the inference call
    vi.mocked(fetch).mockResolvedValue({
      ok: true, status: 200,
      arrayBuffer: async () => new ArrayBuffer(1000),
      headers: { get: () => null },
    } as any)

    const nairobi = { type: 'Polygon', coordinates: [[[36.80, -1.30], [36.82, -1.30], [36.82, -1.28], [36.80, -1.28], [36.80, -1.30]]] }
    const ctx = {
      aoi: nairobi,
      bbox: [36.80, -1.30, 36.82, -1.28] as [number, number, number, number],
      centroid: { lat: -1.29, lng: 36.81 },
      areaKm2: 0.5,
      emit: vi.fn(),
      runTool: vi.fn(),
    }

    const result = await detectObjects(ctx, { target: 'car' })

    expect(result.summary).toBeTruthy()
    expect(typeof result.summary).toBe('string')
    expect(result.summary.length).toBeGreaterThan(10)
    // No layer returned when degrade
    // (Could have layer if some tiles succeed — but with no provider all tiles return InferenceError)
  })

  it('asks for a target rather than guessing one', async () => {
    // The argument is `target` (a noun the profiler can size); an empty one names it.
    const { detectObjects } = await import('../../tools/inference')
    const ctx = {
      aoi: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
      bbox: [0, 0, 1, 1] as [number, number, number, number],
      centroid: { lat: 0.5, lng: 0.5 },
      areaKm2: 1,
      emit: undefined,
      runTool: vi.fn(),
    }
    const result = await detectObjects(ctx, {})
    expect(result.summary).toContain('`target`')
    expect(result.summary).toContain('footprint_m')
  })
})

// ---------------------------------------------------------------------------
// segment_feature — ISS-110
// ---------------------------------------------------------------------------
//
// The old block here tested `maskToGeoBoundingBox`, which reduced SAM2's mask to
// its bounding rectangle and asserted "returns a closed 5-point ring" — i.e. it
// pinned the ISS-110 defect as correct behaviour. Both it and the function are
// gone; the outline path is covered by perception/__tests__/segment.test.ts,
// which asserts the property that distinguishes an outline from a box.
//
// What remains here is the degrade path, rewritten: the previous version only
// checked that the summary was a string longer than 10 characters, which is true
// of every possible outcome including a wrong one.

describe('segment_feature — degrade path', () => {
  const VARS = ['ROBOFLOW_API_KEY']
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    VARS.forEach((v) => { saved[v] = process.env[v]; delete process.env[v] })
  })
  afterEach(() => {
    VARS.forEach((v) => { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v] })
  })

  it('names the missing credential instead of returning an empty outline', async () => {
    const { segmentFeature } = await import('../../tools/inference')
    const nairobi = { type: 'Polygon', coordinates: [[[36.80, -1.30], [36.81, -1.30], [36.81, -1.29], [36.80, -1.29], [36.80, -1.30]]] }
    const ctx = {
      aoi: nairobi,
      bbox: [36.80, -1.30, 36.81, -1.29] as [number, number, number, number],
      centroid: { lat: -1.295, lng: 36.805 },
      areaKm2: 0.2,
      emit: vi.fn(),
      runTool: vi.fn(),
      focus: undefined,
    }

    const result = await segmentFeature(ctx, { lat: -1.295, lon: 36.805 })
    expect(result.summary).toContain('ROBOFLOW_API_KEY')
    expect(result.summary).toMatch(/not configured/i)
    // A missing key must not produce geometry.
    expect(result.layer).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// B5 — classify_vegetation — honesty framing
// ---------------------------------------------------------------------------

import { worldCoverToFunctionalType, ndviToCanopyNote } from '../../tools/inference'

describe('worldCoverToFunctionalType (B5 — WorldCover → functional type string)', () => {
  it('maps Tree Cover at high density to closed-canopy forest', () => {
    expect(worldCoverToFunctionalType('Tree Cover', 85)).toBe('closed-canopy forest')
  })
  it('maps Tree Cover at moderate density to mixed woodland', () => {
    expect(worldCoverToFunctionalType('Tree Cover', 60)).toContain('woodland')
  })
  it('maps Tree Cover at low density to sparse tree cover', () => {
    expect(worldCoverToFunctionalType('Tree Cover', 30)).toContain('sparse')
  })
  it('maps Shrubland to shrubland description', () => {
    expect(worldCoverToFunctionalType('Shrubland', 5)).toContain('shrub')
  })
  it('maps Cropland to cropland description', () => {
    expect(worldCoverToFunctionalType('Cropland', 0)).toContain('crop')
  })
  it('maps Mangroves correctly', () => {
    expect(worldCoverToFunctionalType('Mangroves', 90)).toContain('mangrove')
  })
  it('passes through unknown class as-is', () => {
    expect(worldCoverToFunctionalType('Unknown Exotic Class', 50)).toBe('Unknown Exotic Class')
  })
})

describe('ndviToCanopyNote (B5 — NDVI + tree cover % → canopy description)', () => {
  it('returns unavailable note when ndvi is null', () => {
    expect(ndviToCanopyNote(null, 60)).toContain('unavailable')
  })
  it('high NDVI + dense cover → dense, high vigor', () => {
    const note = ndviToCanopyNote(0.75, 80)
    expect(note).toContain('dense')
    expect(note).toContain('high vigor')
  })
  it('moderate NDVI → moderate vigor', () => {
    const note = ndviToCanopyNote(0.5, 50)
    expect(note).toContain('moderate vigor')
  })
  it('low NDVI → stressed / dormant', () => {
    const note = ndviToCanopyNote(0.2, 20)
    expect(note).toContain('stressed')
  })
  it('includes the NDVI value in the note', () => {
    const note = ndviToCanopyNote(0.63, 60)
    expect(note).toContain('0.63')
  })
})

describe('classify_vegetation — WorldCover degrade path (B5)', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('returns summary with species honest note when WorldCover fails', async () => {
    const { classifyVegetation } = await import('../../tools/inference')
    // All fetches fail
    vi.mocked(fetch).mockRejectedValue(new Error('network error'))

    const nairobi = { type: 'Polygon', coordinates: [[[36.80, -1.30], [36.82, -1.30], [36.82, -1.28], [36.80, -1.28], [36.80, -1.30]]] }
    const ctx = {
      aoi: nairobi,
      bbox: [36.80, -1.30, 36.82, -1.28] as [number, number, number, number],
      centroid: { lat: -1.29, lng: 36.81 },
      areaKm2: 0.5,
      emit: vi.fn(),
      runTool: vi.fn(),
    }

    const result = await classifyVegetation(ctx, {})
    // Should always return a summary even on data failure
    expect(typeof result.summary).toBe('string')
    expect(result.summary.length).toBeGreaterThan(20)
    // The summary should mention functional type and/or honesty note
    expect(result.summary.toLowerCase()).toMatch(/functional|vegetation|land cover|species/)
  })
})

// ---------------------------------------------------------------------------
// B6 — makeInferenceCacheKey
// ---------------------------------------------------------------------------

import { makeInferenceCacheKey } from '../inference/gateway'

describe('makeInferenceCacheKey (B6 — cache key generation)', () => {
  it('produces a stable key for the same model + aoi + prompt', () => {
    const k1 = makeInferenceCacheKey('grounding_dino', 'sig123', 'car')
    const k2 = makeInferenceCacheKey('grounding_dino', 'sig123', 'car')
    expect(k1).toBe(k2)
  })

  it('varies by model key', () => {
    const k1 = makeInferenceCacheKey('grounding_dino', 'sig123', 'car')
    const k2 = makeInferenceCacheKey('sam2', 'sig123', 'car')
    expect(k1).not.toBe(k2)
  })

  it('varies by aoi signature', () => {
    const k1 = makeInferenceCacheKey('grounding_dino', 'sig-A')
    const k2 = makeInferenceCacheKey('grounding_dino', 'sig-B')
    expect(k1).not.toBe(k2)
  })

  it('varies by prompt (different objects)', () => {
    const k1 = makeInferenceCacheKey('grounding_dino', 'sig123', 'car')
    const k2 = makeInferenceCacheKey('grounding_dino', 'sig123', 'building')
    expect(k1).not.toBe(k2)
  })

  it('works without a prompt (model + aoi only)', () => {
    const k = makeInferenceCacheKey('veg_type', 'sig456')
    expect(k).toContain('veg_type')
    expect(k).toContain('sig456')
  })

  it('starts with "inference:" prefix for TTL-map lookup', () => {
    const k = makeInferenceCacheKey('grounding_dino', 'aoiSig', 'solar panel')
    expect(k.startsWith('inference:')).toBe(true)
  })

  it('truncates very long prompts to avoid oversized cache keys', () => {
    const longPrompt = 'a'.repeat(300)
    const k = makeInferenceCacheKey('grounding_dino', 'sig', longPrompt)
    expect(k.length).toBeLessThan(200)
  })
})
