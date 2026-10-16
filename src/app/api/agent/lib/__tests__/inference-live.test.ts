/**
 * LIVE inference verification (opt-in: INFERENCE_LIVE=1).
 * Hits the configured inference backend — NOT part of the default suite.
 *
 * Run with:
 *   INFERENCE_LIVE=1 INFERENCE_PROVIDER=huggingface HF_API_TOKEN=hf_xxx npx vitest run inference-live
 *   INFERENCE_LIVE=1 INFERENCE_PROVIDER=replicate REPLICATE_API_TOKEN=r8_xxx npx vitest run inference-live
 *   INFERENCE_LIVE=1 INFERENCE_PROVIDER=selfhosted INFERENCE_ENDPOINT=http://localhost:8080 npx vitest run inference-live
 *
 * Degrade path (no backend) — always verifiable:
 *   INFERENCE_LIVE=1 npx vitest run inference-live    (no tokens set → honest messages only)
 */

import { describe, it, expect } from 'vitest'
import { runInference, resolveInferenceProvider } from '../inference/gateway'
import { MODEL_REGISTRY, assessResolution } from '../inference/registry'

const LIVE = !!process.env.INFERENCE_LIVE
const suite = LIVE ? describe : describe.skip

// ---------------------------------------------------------------------------
// Degrade path — verifiable without any backend (always runs when INFERENCE_LIVE=1)
// ---------------------------------------------------------------------------

suite('LIVE inference — degrade path (no backend = honest message, no fabrication)', () => {
  it('runInference returns InferenceError (not throw) when no backend configured', async () => {
    // Save + clear all provider env vars
    const saved = {
      INFERENCE_PROVIDER: process.env.INFERENCE_PROVIDER,
      HF_API_TOKEN: process.env.HF_API_TOKEN,
      REPLICATE_API_TOKEN: process.env.REPLICATE_API_TOKEN,
      INFERENCE_ENDPOINT: process.env.INFERENCE_ENDPOINT,
    }
    delete process.env.INFERENCE_PROVIDER
    delete process.env.HF_API_TOKEN
    delete process.env.REPLICATE_API_TOKEN
    delete process.env.INFERENCE_ENDPOINT

    try {
      const result = await runInference('grounding_dino', { prompt: 'car', imageBytes: [] })
      expect('error' in result).toBe(true)
      const err = result as { error: string; honestMessage: string }
      expect(err.error).toBe('no_provider')
      expect(err.honestMessage).toContain('INFERENCE_PROVIDER')
       
      console.log('   → Degrade message:', err.honestMessage.slice(0, 120))
    } finally {
      Object.entries(saved).forEach(([k, v]) => {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      })
    }
  })

  it('assessResolution("species", 10) correctly degrades (verifiable without backend)', () => {
    const r = assessResolution('species', 10)
    expect(r.canAnswer).toBe(false)
    expect(r.downgradedTo).toBe('functional_type')
     
    console.log('   → Resolution note:', r.honestNote.slice(0, 100))
  })
})

// ---------------------------------------------------------------------------
// Live backend path — only runs when INFERENCE_PROVIDER + credentials are set
// ---------------------------------------------------------------------------

suite('LIVE inference — backend call (requires INFERENCE_PROVIDER + credentials)', () => {
  const provider = (process.env.INFERENCE_PROVIDER || 'none') as string
  const entry = MODEL_REGISTRY['grounding_dino']

  it(`provider resolution: INFERENCE_PROVIDER=${provider} → ${resolveInferenceProvider(entry)}`, () => {
    const resolved = resolveInferenceProvider(entry)
     
    console.log(`   → resolveInferenceProvider(grounding_dino) = ${resolved}`)
    // Just log — no assertion because 'none' is valid if no backend configured
    expect(typeof resolved).toBe('string')
  })

  it('grounding_dino: "car" detection on a known tile returns NormalizedOutput or honest InferenceError', async () => {
    // Use a real public Esri tile over a road in central Nairobi (zoom 17)
    // Tile 75519/59985/17 covers Nairobi CBD
    const tileUrl = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/17/59985/75519'
    const tileBounds = { west: 36.7989, south: -1.2921, east: 36.8005, north: -1.2905 }

    let tileBytes: number[]
    try {
      const res = await fetch(tileUrl, { signal: AbortSignal.timeout(15000) })
      expect(res.ok, `Esri tile fetch failed HTTP ${res.status}`).toBe(true)
      tileBytes = Array.from(new Uint8Array(await res.arrayBuffer()))
       
      console.log(`   → Esri tile: ${tileBytes.length} bytes`)
    } catch (err: any) {
       
      console.warn('   → Esri tile fetch failed (network); degrade path tested only:', err?.message)
      return
    }

    const result = await runInference('grounding_dino', {
      imageBytes: tileBytes,
      prompt: 'car. vehicle.',
      threshold: 0.2,
      tileBounds,
    })

     
    console.log('   → Result:', JSON.stringify(result).slice(0, 200))

    if ('honestMessage' in result) {
      // Degrade path: valid honest error
      const err = result as { error: string; honestMessage: string }
      expect(err.error).toMatch(/^(no_provider|provider_error)$/)
       
      console.log('   → Degraded honestly:', err.honestMessage.slice(0, 120))
    } else {
      // Success path: must have geojson + provenance + resolution_limit
      expect(result.geojson).toBeDefined()
      expect(typeof result.provenance).toBe('string')
      expect(typeof result.resolution_limit).toBe('string')
      expect(result.confidence).toBeGreaterThanOrEqual(0)
      expect(result.confidence).toBeLessThanOrEqual(1)
       
      console.log(`   → Detected ${result.geojson?.features?.length ?? 0} object(s), confidence ${result.confidence.toFixed(2)}`)
    }
  }, 120_000)

  it('veg_type: classify satellite tile returns labels or honest InferenceError', async () => {
    const tileUrl = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/13/4001/4879'

    let tileBytes: number[]
    try {
      const res = await fetch(tileUrl, { signal: AbortSignal.timeout(15000) })
      tileBytes = Array.from(new Uint8Array(await res.arrayBuffer()))
    } catch {
       
      console.warn('   → Esri tile fetch failed; skipping veg_type live test')
      return
    }

    const result = await runInference('veg_type', { imageBytes: tileBytes })

    if ('honestMessage' in result) {
      const err = result as { error: string; honestMessage: string }
      expect(err.error).toMatch(/^(no_provider|provider_error)$/)
       
      console.log('   → Veg type degraded:', err.honestMessage.slice(0, 120))
    } else {
      expect(Array.isArray(result.labels)).toBe(true)
      expect(result.resolution_limit).toContain('species')
       
      console.log('   → Veg type labels:', result.labels?.join(', ').slice(0, 100))
    }
  }, 120_000)
})
