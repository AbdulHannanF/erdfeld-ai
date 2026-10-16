/**
 * Provider adapters (Phase 1): local-onnx | roboflow | hf | custom-http.
 *
 * Every adapter normalises to one output shape so the perception pipeline never
 * branches on provider, and every failure is an honest message rather than an
 * empty-but-successful result — an adapter that returns "0 detections" when it
 * actually errored is indistinguishable from a model that found nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runModel, describeProviderRequirement } from '../adapters'
import type { ModelSpec } from '../model-spec'
import { _resetCache } from '../../cache'

const spec = (over: Partial<ModelSpec> = {}): ModelSpec => ({
  id: 'm', provider: 'custom-http', ref: 'https://gpu.local/detect',
  task: 'detect', inputSize: 640, profile: 'tiny', ...over,
})

const IMAGE = Buffer.from('fake-png-bytes')

beforeEach(() => { _resetCache(); vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete process.env.ROBOFLOW_API_KEY })

// ---------------------------------------------------------------------------
// custom-http — the generic escape hatch
// ---------------------------------------------------------------------------

describe('custom-http adapter', () => {
  it('POSTs the image and normalises a predictions payload', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        predictions: [
          { x: 100, y: 120, width: 40, height: 20, class: 'car', confidence: 0.91 },
          { x: 200, y: 220, width: 30, height: 18, class: 'car', confidence: 0.62 },
        ],
      }),
    } as any)

    const out = await runModel(spec(), { imageBytes: IMAGE })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.predictions).toHaveLength(2)
    expect(out.predictions[0]).toMatchObject({ class: 'car', confidence: 0.91, width: 40 })
    expect(out.provenance).toContain('custom-http')
    expect(out.provenance).toContain('gpu.local')

    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toBe('https://gpu.local/detect')
    expect(init!.method).toBe('POST')
  })

  it('accepts a bare array of predictions as well as {predictions:[…]}', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => [{ x: 1, y: 2, width: 3, height: 4, class: 'tree', confidence: 0.5 }],
    } as any)
    const out = await runModel(spec(), { imageBytes: IMAGE })
    expect(out.ok && out.predictions[0].class).toBe('tree')
  })

  it('normalises x0/y0/x1/y1 corner boxes to centre+size', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ predictions: [{ x0: 10, y0: 20, x1: 30, y1: 60, class: 'car', confidence: 0.8 }] }),
    } as any)
    const out = await runModel(spec(), { imageBytes: IMAGE })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.predictions[0]).toMatchObject({ x: 20, y: 40, width: 20, height: 40 })
  })

  it('reports an HTTP failure honestly instead of returning zero detections', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'overloaded' } as any)
    const out = await runModel(spec(), { imageBytes: IMAGE })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toMatch(/503/)
    expect(out.error).toMatch(/custom-http|gpu\.local/)
  })

  it('reports an unrecognised payload rather than silently finding nothing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ weird: true }) } as any)
    const out = await runModel(spec(), { imageBytes: IMAGE })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toMatch(/could not|unrecognis|unrecogniz/i)
  })

  it('an empty prediction list IS a valid result — that is a real "found nothing"', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ predictions: [] }) } as any)
    const out = await runModel(spec(), { imageBytes: IMAGE })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.predictions).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// roboflow
// ---------------------------------------------------------------------------

describe('roboflow adapter', () => {
  it('refuses without a key, naming the env var', async () => {
    const out = await runModel(spec({ provider: 'roboflow', ref: 'aerial-cars/3' }), { imageBytes: IMAGE })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('ROBOFLOW_API_KEY')
  })

  it('calls the serverless endpoint for the ref and normalises predictions', async () => {
    process.env.ROBOFLOW_API_KEY = 'test-key'
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ predictions: [{ x: 5, y: 6, width: 7, height: 8, class: 'car', confidence: 0.77 }] }),
    } as any)

    const out = await runModel(spec({ provider: 'roboflow', ref: 'aerial-cars/3' }), { imageBytes: IMAGE })
    expect(out.ok && out.predictions).toHaveLength(1)
    const url = String(vi.mocked(fetch).mock.calls[0][0])
    expect(url).toContain('aerial-cars/3')
    expect(url).toContain('api_key=')
  })

  it('never puts the api key in the provenance string', async () => {
    process.env.ROBOFLOW_API_KEY = 'super-secret-key'
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ predictions: [] }),
    } as any)
    const out = await runModel(spec({ provider: 'roboflow', ref: 'aerial-cars/3' }), { imageBytes: IMAGE })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.provenance).not.toContain('super-secret-key')
  })
})

// ---------------------------------------------------------------------------
// hf — retired as an inference route
// ---------------------------------------------------------------------------

describe('hf adapter (retired as an inference route)', () => {
  it('refuses to run inference and explains what HF is still good for', async () => {
    const out = await runModel(spec({ provider: 'hf', ref: 'IDEA-Research/grounding-dino-tiny' }), { imageBytes: IMAGE })
    expect(out.ok).toBe(false)
    if (out.ok) return
    // Verified live twice (2026-08-09 and 2026-08-10): zero providers serve these.
    expect(out.error).toMatch(/serverless|inference/i)
    expect(out.error).toMatch(/local-onnx/)
    expect(fetch).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// describeProviderRequirement — what the user must do to enable a provider
// ---------------------------------------------------------------------------

describe('describeProviderRequirement', () => {
  it('names the credential or resource each provider needs', () => {
    expect(describeProviderRequirement('roboflow')).toContain('ROBOFLOW_API_KEY')
    expect(describeProviderRequirement('local-onnx')).toMatch(/onnx|weights/i)
    expect(describeProviderRequirement('custom-http')).toMatch(/endpoint|url/i)
    expect(describeProviderRequirement('hf')).toMatch(/weight|download/i)
  })
})
