/**
 * Unit tests for Phase 2 B1 — inference gateway scaffolding.
 *
 * Covers:
 *  - assessResolution: species/buildings/vehicles/functional-type/unknown
 *  - MODEL_REGISTRY: structural integrity
 *  - resolveInferenceProvider: none / HF auto-detect / explicit override / fallback
 *  - runInference: honest none path / unknown model / no fabrication
 */

import { describe, it, expect, afterEach } from 'vitest'
import { assessResolution, MODEL_REGISTRY } from '../inference/registry'
import { resolveInferenceProvider, runInference } from '../inference/gateway'

// ---------------------------------------------------------------------------
// assessResolution
// ---------------------------------------------------------------------------

describe('assessResolution', () => {
  it('species@10m → cannot answer, downgrades to functional_type', () => {
    const r = assessResolution('species', 10)
    expect(r.canAnswer).toBe(false)
    expect(r.downgradedTo).toBe('functional_type')
    expect(r.honestNote).toContain('species')
    expect(r.honestNote).toContain('10')
  })

  it('species@0.5m → can answer (sub-meter data satisfies <1m threshold)', () => {
    const r = assessResolution('species', 0.5)
    expect(r.canAnswer).toBe(true)
    expect(r.downgradedTo).toBeUndefined()
  })

  it('species@1m → exact threshold → can answer', () => {
    const r = assessResolution('species', 1)
    expect(r.canAnswer).toBe(true)
  })

  it('functional_type@10m → can answer (Sentinel-2 native)', () => {
    const r = assessResolution('functional_type', 10)
    expect(r.canAnswer).toBe(true)
    expect(r.honestNote).toBeTruthy()
  })

  it('land_cover@10m → can answer', () => {
    const r = assessResolution('land_cover', 10)
    expect(r.canAnswer).toBe(true)
  })

  it('canopy_height@10m → can answer (GEDI ~25m coverage)', () => {
    const r = assessResolution('canopy_height', 10)
    expect(r.canAnswer).toBe(true)
  })

  it('buildings@10m → cannot answer individual footprints, downgrades to built_area', () => {
    const r = assessResolution('buildings', 10)
    expect(r.canAnswer).toBe(false)
    expect(r.downgradedTo).toBe('built_area')
    expect(r.honestNote).toContain('10')
  })

  it('buildings@2m → can answer (sub-5m threshold)', () => {
    const r = assessResolution('buildings', 2)
    expect(r.canAnswer).toBe(true)
  })

  it('vehicles@10m → cannot answer, no downgrade (not achievable at any free tier)', () => {
    const r = assessResolution('vehicles', 10)
    expect(r.canAnswer).toBe(false)
    expect(r.downgradedTo).toBeUndefined()
    expect(r.honestNote).toContain('0.5')
  })

  it('vehicles@0.3m → can answer', () => {
    const r = assessResolution('vehicles', 0.3)
    expect(r.canAnswer).toBe(true)
  })

  it('flood_extent@10m → can answer (SAR-based mapping)', () => {
    const r = assessResolution('flood_extent', 10)
    expect(r.canAnswer).toBe(true)
  })

  it('burn_scar@10m → can answer (Sentinel-2 NBR)', () => {
    const r = assessResolution('burn_scar', 10)
    expect(r.canAnswer).toBe(true)
  })

  it('unknown intent → defaults to canAnswer=true with generic note', () => {
    const r = assessResolution('some_exotic_unknown_intent', 10)
    expect(r.canAnswer).toBe(true)
    expect(r.honestNote).toBeTruthy()
    expect(r.honestNote.length).toBeGreaterThan(10)
  })

  it('honestNote is always a non-empty string', () => {
    const intents = ['species', 'functional_type', 'buildings', 'vehicles', 'land_cover', 'unknown']
    for (const intent of intents) {
      const r = assessResolution(intent, 10)
      expect(r.honestNote, `intent=${intent}`).toBeTruthy()
      expect(typeof r.honestNote, `intent=${intent}`).toBe('string')
    }
  })
})

// ---------------------------------------------------------------------------
// MODEL_REGISTRY
// ---------------------------------------------------------------------------

describe('MODEL_REGISTRY', () => {
  it('has all required model entries', () => {
    expect(MODEL_REGISTRY['grounding_dino']).toBeDefined()
    expect(MODEL_REGISTRY['sam2']).toBeDefined()
    expect(MODEL_REGISTRY['veg_type']).toBeDefined()
    expect(MODEL_REGISTRY['prithvi_flood']).toBeDefined()
  })

  it('grounding_dino has correct task', () => {
    expect(MODEL_REGISTRY['grounding_dino'].task).toBe('detect')
    expect(MODEL_REGISTRY['grounding_dino'].output).toBe('geojson')
  })

  it('sam2 has correct task', () => {
    expect(MODEL_REGISTRY['sam2'].task).toBe('segment')
    expect(MODEL_REGISTRY['sam2'].output).toBe('mask')
  })

  it('veg_type has correct task', () => {
    expect(MODEL_REGISTRY['veg_type'].task).toBe('classify')
    expect(MODEL_REGISTRY['veg_type'].output).toBe('labels')
  })

  it('all entries have required fields with valid values', () => {
    for (const [key, entry] of Object.entries(MODEL_REGISTRY)) {
      expect(entry.key, `${key}.key`).toBe(key)
      expect(entry.task, `${key}.task`).toMatch(/^(detect|segment|classify)$/)
      expect(entry.inputResolutionM, `${key}.inputResolutionM`).toBeGreaterThan(0)
      expect(entry.resolutionLimit, `${key}.resolutionLimit`).toBeTruthy()
      expect(entry.costTier, `${key}.costTier`).toMatch(/^(free|cheap|gpu)$/)
      expect(entry.output, `${key}.output`).toMatch(/^(geojson|mask|labels)$/)
      expect(typeof entry.routes, `${key}.routes`).toBe('object')
    }
  })

  it('all entries have at least one provider route', () => {
    for (const [key, entry] of Object.entries(MODEL_REGISTRY)) {
      const routeCount = Object.keys(entry.routes).length
      expect(routeCount, `${key} has no routes`).toBeGreaterThan(0)
    }
  })

  it('veg_type resolutionLimit mentions species limitation', () => {
    expect(MODEL_REGISTRY['veg_type'].resolutionLimit.toLowerCase()).toContain('species')
  })
})

// ---------------------------------------------------------------------------
// resolveInferenceProvider (env-dependent — restore env after each test)
// ---------------------------------------------------------------------------

describe('resolveInferenceProvider', () => {
  const saved: Record<string, string | undefined> = {}
  const VARS = ['INFERENCE_PROVIDER', 'HF_API_TOKEN', 'REPLICATE_API_TOKEN', 'INFERENCE_ENDPOINT']

  function clearVars() {
    for (const v of VARS) {
      saved[v] = process.env[v]
      delete process.env[v]
    }
  }
  function restoreVars() {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v]
      else process.env[v] = saved[v]
    }
  }

  afterEach(restoreVars)

  it('returns none when no credentials are configured', () => {
    clearVars()
    const entry = MODEL_REGISTRY['grounding_dino']
    expect(resolveInferenceProvider(entry)).toBe('none')
  })

  // ISS-104: this used to assert `.toBe('huggingface')`. HF_API_TOKEN is set on
  // any install that downloads local-onnx weights, so auto-selecting HF from its
  // presence routed real queries to a backend that serves none of these models.
  it('does NOT auto-detect huggingface from HF_API_TOKEN — it is a weight-download token', () => {
    clearVars()
    process.env.HF_API_TOKEN = 'hf_test_token'
    expect(resolveInferenceProvider(MODEL_REGISTRY['grounding_dino'])).toBe('none')
  })

  it('auto-detects replicate when REPLICATE_API_TOKEN is set (and model has replicate route)', () => {
    clearVars()
    process.env.REPLICATE_API_TOKEN = 'r8_test_token'
    expect(resolveInferenceProvider(MODEL_REGISTRY['sam2'])).toBe('replicate')
  })

  it('respects explicit INFERENCE_PROVIDER=replicate over auto-detected HF', () => {
    clearVars()
    process.env.INFERENCE_PROVIDER = 'replicate'
    process.env.REPLICATE_API_TOKEN = 'r8_test_token'
    process.env.HF_API_TOKEN = 'hf_test_token' // HF would win in auto-detect
    expect(resolveInferenceProvider(MODEL_REGISTRY['grounding_dino'])).toBe('replicate')
  })

  it('falls back to none when explicit provider has no credentials', () => {
    clearVars()
    process.env.INFERENCE_PROVIDER = 'replicate'
    // No REPLICATE_API_TOKEN → cannot use replicate → none (not auto-fallback)
    expect(resolveInferenceProvider(MODEL_REGISTRY['grounding_dino'])).toBe('none')
  })

  it('returns none for a model with no HF route when only HF_API_TOKEN is set', () => {
    clearVars()
    process.env.HF_API_TOKEN = 'hf_test_token'
    // prithvi_flood has no huggingface route
    expect(resolveInferenceProvider(MODEL_REGISTRY['prithvi_flood'])).toBe('none')
  })

  it('respects INFERENCE_PROVIDER=selfhosted when INFERENCE_ENDPOINT is set', () => {
    clearVars()
    process.env.INFERENCE_PROVIDER = 'selfhosted'
    process.env.INFERENCE_ENDPOINT = 'http://localhost:8080'
    expect(resolveInferenceProvider(MODEL_REGISTRY['grounding_dino'])).toBe('selfhosted')
  })
})

// ---------------------------------------------------------------------------
// runInference — honest none path (no backend = no throw, no fabrication)
// ---------------------------------------------------------------------------

describe('runInference', () => {
  const saved: Record<string, string | undefined> = {}
  const VARS = ['INFERENCE_PROVIDER', 'HF_API_TOKEN', 'REPLICATE_API_TOKEN', 'INFERENCE_ENDPOINT']

  function clearVars() {
    for (const v of VARS) {
      saved[v] = process.env[v]
      delete process.env[v]
    }
  }
  function restoreVars() {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v]
      else process.env[v] = saved[v]
    }
  }

  afterEach(restoreVars)

  it('returns honest InferenceError (not throw) when no provider is configured', async () => {
    clearVars()
    const result = await runInference('grounding_dino', { prompt: 'cars' })
    expect('honestMessage' in result).toBe(true)
    const err = result as { error: string; honestMessage: string }
    expect(err.error).toBe('no_provider')
    expect(err.honestMessage).toContain('INFERENCE_PROVIDER')
    expect(err.honestMessage).not.toContain('undefined')
    expect(err.honestMessage).not.toContain('null')
  })

  it('returns error for an unknown model key', async () => {
    clearVars()
    const result = await runInference('not_a_real_model_key', {})
    expect('error' in result).toBe(true)
    const err = result as { error: string; honestMessage: string }
    expect(err.error).toBe('unknown_model')
    expect(err.honestMessage).toContain('not_a_real_model_key')
  })

  it('does not fabricate output (no geojson/maskPng/labels) on unconfigured path', async () => {
    clearVars()
    const result = await runInference('veg_type', { aoiGeoJson: {} })
    expect('geojson' in result).toBe(false)
    expect('maskPng' in result).toBe(false)
    expect('labels' in result).toBe(false)
    expect('confidence' in result).toBe(false)
  })

  it('honest message includes the model resolution_limit so agent can cite it', async () => {
    clearVars()
    const result = await runInference('veg_type', {})
    const err = result as { error: string; honestMessage: string }
    // The honest message should include the model's resolution_limit
    expect(err.honestMessage).toContain(MODEL_REGISTRY['veg_type'].resolutionLimit)
  })

  it('returns error for veg_type when no backend configured', async () => {
    clearVars()
    const result = await runInference('veg_type', {})
    const err = result as { error: string; honestMessage: string }
    expect(err.error).toBe('no_provider')
  })
})
