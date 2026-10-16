/**
 * ISS-104 — retire the dead HuggingFace gateway assumption.
 *
 * The legacy gateway auto-selected providers in the order
 * [huggingface, replicate, selfhosted] and treated HF as "configured" whenever
 * HF_API_TOKEN was present. That token IS present in this project's .env,
 * because HF file hosting is how local-onnx weights are downloaded — so on a
 * normal install the gateway routed `grounding_dino` and `sam2` to HuggingFace
 * serverless and failed, while a working provider sat further down the list.
 *
 * HF serves none of these models. Verified against the live API on 2026-08-09
 * and re-verified 2026-08-10: `grounding-dino-tiny`, `grounding-dino-base`,
 * `sam2-hiera-large`, `owlv2-base-patch16-ensemble` and `clip-vit-base-patch32`
 * all return an `inferenceProviderMapping` with ZERO providers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MODEL_REGISTRY } from '../registry'
import { resolveInferenceProvider } from '../gateway'

const saved = { ...process.env }
beforeEach(() => {
  delete process.env.INFERENCE_PROVIDER
  delete process.env.HF_API_TOKEN
  delete process.env.REPLICATE_API_TOKEN
  delete process.env.INFERENCE_ENDPOINT
})
afterEach(() => { process.env = { ...saved } })

describe('MODEL_REGISTRY — no live route points at HF serverless', () => {
  it('no entry declares a huggingface route', () => {
    const withHf = Object.values(MODEL_REGISTRY).filter((m) => 'huggingface' in m.routes)
    expect(
      withHf.map((m) => m.key),
      'these still route to a backend that serves nothing',
    ).toEqual([])
  })

  it('every remaining route targets a provider that can actually run it', () => {
    for (const entry of Object.values(MODEL_REGISTRY)) {
      const providers = Object.keys(entry.routes)
      expect(providers.length, `${entry.key} has no usable route`).toBeGreaterThan(0)
      for (const p of providers) expect(['replicate', 'selfhosted']).toContain(p)
    }
  })
})

describe('resolveInferenceProvider — HF_API_TOKEN must not capture routing', () => {
  it('does not select huggingface just because the download token is set', () => {
    // The realistic install: a token for weight downloads and nothing else.
    process.env.HF_API_TOKEN = 'hf_download_token'
    for (const entry of Object.values(MODEL_REGISTRY)) {
      expect(resolveInferenceProvider(entry), `${entry.key}`).not.toBe('huggingface')
    }
  })

  it('picks the provider that is genuinely configured, not the first in a stale order', () => {
    process.env.HF_API_TOKEN = 'hf_download_token'
    process.env.INFERENCE_ENDPOINT = 'http://localhost:9000'
    // sam2 has a selfhosted route; with only that configured it must be chosen.
    expect(resolveInferenceProvider(MODEL_REGISTRY.sam2)).toBe('selfhosted')
  })

  it('still returns none when nothing is configured', () => {
    for (const entry of Object.values(MODEL_REGISTRY)) {
      expect(resolveInferenceProvider(entry)).toBe('none')
    }
  })

  it('an explicit INFERENCE_PROVIDER=huggingface is refused, not honoured', () => {
    process.env.INFERENCE_PROVIDER = 'huggingface'
    process.env.HF_API_TOKEN = 'hf_download_token'
    for (const entry of Object.values(MODEL_REGISTRY)) {
      expect(resolveInferenceProvider(entry), `${entry.key}`).toBe('none')
    }
  })
})
