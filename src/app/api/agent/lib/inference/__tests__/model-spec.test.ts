/**
 * User-pluggable model specs (Phase 1, spec §3.7).
 *
 * A model is added as
 *   { provider: local-onnx | roboflow | hf | custom-http, id, task, classes,
 *     input_size, profile, license }
 * from Settings or env — no redeploy. Settings is a free-text JSON field, so
 * parsing is a trust boundary: it must reject malformed input with a message a
 * user can act on, and must never let a half-valid entry reach a provider.
 */

import { describe, expect, it } from 'vitest'
import {
  parseModelSpec,
  parseModelSpecList,
  MODEL_PROVIDERS,
  MODEL_TASKS,
  MODEL_PROFILES,
} from '../model-spec'

const MINIMAL = { id: 'my_detector', provider: 'custom-http', ref: 'https://gpu.example/infer', task: 'detect' }

describe('parseModelSpec — accepts a valid spec', () => {
  it('parses the minimal required fields and applies defaults', () => {
    const r = parseModelSpec(MINIMAL)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec).toMatchObject({
      id: 'my_detector',
      provider: 'custom-http',
      ref: 'https://gpu.example/infer',
      task: 'detect',
      profile: 'base',
      inputSize: 640,
    })
    // Unknown-by-default fields must be absent, not invented.
    expect(r.spec.classes).toBeUndefined()
    expect(r.spec.license).toBeUndefined()
  })

  it('accepts snake_case as written in the spec, normalising to camelCase', () => {
    const r = parseModelSpec({
      ...MINIMAL,
      input_size: 1024,
      resolution_m: 0.3,
      resolution_limit: 'needs <=0.3 m imagery',
      default_confidence: 0.4,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.inputSize).toBe(1024)
    expect(r.spec.resolutionM).toBe(0.3)
    expect(r.spec.resolutionLimit).toBe('needs <=0.3 m imagery')
    expect(r.spec.defaultConfidence).toBe(0.4)
  })

  it('keeps classes as an ordered string array', () => {
    const r = parseModelSpec({ ...MINIMAL, classes: ['car', 'truck', 'bus'] })
    expect(r.ok && r.spec.classes).toEqual(['car', 'truck', 'bus'])
  })

  it('accepts every declared provider, task and profile', () => {
    // Each provider has its own valid ref shape — see the ref-validation block below.
    const validRef: Record<string, string> = {
      'local-onnx': 'https://h.co/m.onnx',
      'custom-http': 'https://gpu.example/infer',
      roboflow: 'aerial-cars/3',
      hf: 'onnx-community/yolov10n',
    }
    for (const provider of MODEL_PROVIDERS) {
      const r = parseModelSpec({ id: 'm', provider, ref: validRef[provider], task: 'detect' })
      expect(r.ok, `${provider}: ${r.ok ? '' : r.error}`).toBe(true)
    }
    for (const task of MODEL_TASKS) {
      expect(parseModelSpec({ ...MINIMAL, task }).ok, task).toBe(true)
    }
    for (const profile of MODEL_PROFILES) {
      expect(parseModelSpec({ ...MINIMAL, profile }).ok, profile).toBe(true)
    }
  })

  it('parses a JSON string as readily as an object (Settings is a text field)', () => {
    const r = parseModelSpec(JSON.stringify(MINIMAL))
    expect(r.ok && r.spec.id).toBe('my_detector')
  })
})

describe('parseModelSpec — rejects malformed input with an actionable message', () => {
  const bad: Array<[string, unknown, RegExp]> = [
    ['not an object', 42, /object/i],
    ['unparseable JSON', '{nope', /json/i],
    ['missing id', { provider: 'hf', ref: 'a/b', task: 'detect' }, /id/i],
    ['blank id', { ...MINIMAL, id: '   ' }, /id/i],
    ['missing provider', { id: 'm', ref: 'a/b', task: 'detect' }, /provider/i],
    ['unknown provider', { ...MINIMAL, provider: 'sagemaker' }, /provider.*local-onnx/i],
    ['missing ref', { id: 'm', provider: 'hf', task: 'detect' }, /ref/i],
    ['missing task', { id: 'm', provider: 'hf', ref: 'a/b' }, /task/i],
    ['unknown task', { ...MINIMAL, task: 'summarise' }, /task/i],
    ['unknown profile', { ...MINIMAL, profile: 'huge' }, /profile/i],
    ['classes not an array', { ...MINIMAL, classes: 'car,truck' }, /classes/i],
    ['classes with a non-string', { ...MINIMAL, classes: ['car', 7] }, /classes/i],
    ['inputSize not a number', { ...MINIMAL, input_size: 'big' }, /input_?size/i],
    ['inputSize out of range', { ...MINIMAL, input_size: 0 }, /input_?size/i],
    ['confidence above 1', { ...MINIMAL, default_confidence: 5 }, /confidence/i],
  ]

  for (const [label, input, pattern] of bad) {
    it(`rejects ${label}`, () => {
      const r = parseModelSpec(input)
      expect(r.ok, `expected rejection for ${label}`).toBe(false)
      if (r.ok) return
      expect(r.error).toMatch(pattern)
    })
  }

  it('names the offending id in the error so a user can find it in a list', () => {
    const r = parseModelSpec({ id: 'my_model', provider: 'nope', ref: 'x', task: 'detect' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('my_model')
  })
})

describe('parseModelSpec — provider-specific ref validation', () => {
  it('local-onnx requires a URL or a file path, not a bare model id', () => {
    expect(parseModelSpec({ id: 'm', provider: 'local-onnx', ref: 'some-model', task: 'detect' }).ok).toBe(false)
    expect(parseModelSpec({ id: 'm', provider: 'local-onnx', ref: 'https://h.co/best.onnx', task: 'detect' }).ok).toBe(true)
    expect(parseModelSpec({ id: 'm', provider: 'local-onnx', ref: '/models/best.onnx', task: 'detect' }).ok).toBe(true)
    expect(parseModelSpec({ id: 'm', provider: 'local-onnx', ref: 'C:\\models\\best.onnx', task: 'detect' }).ok).toBe(true)
  })

  it('custom-http requires an absolute http(s) endpoint', () => {
    expect(parseModelSpec({ ...MINIMAL, ref: '/infer' }).ok).toBe(false)
    expect(parseModelSpec({ ...MINIMAL, ref: 'ftp://x/y' }).ok).toBe(false)
    expect(parseModelSpec({ ...MINIMAL, ref: 'http://localhost:9000/infer' }).ok).toBe(true)
  })

  it('roboflow requires a "project/version" reference', () => {
    expect(parseModelSpec({ id: 'm', provider: 'roboflow', ref: 'just-a-project', task: 'detect' }).ok).toBe(false)
    expect(parseModelSpec({ id: 'm', provider: 'roboflow', ref: 'aerial-cars/3', task: 'detect' }).ok).toBe(true)
  })

  it('hf requires an "owner/repo" reference', () => {
    expect(parseModelSpec({ id: 'm', provider: 'hf', ref: 'bare-repo', task: 'detect' }).ok).toBe(false)
    expect(parseModelSpec({ id: 'm', provider: 'hf', ref: 'onnx-community/yolov10n', task: 'detect' }).ok).toBe(true)
  })
})

describe('parseModelSpecList', () => {
  it('splits valid entries from invalid ones instead of failing the whole list', () => {
    const { specs, errors } = parseModelSpecList([
      MINIMAL,
      { id: 'broken', provider: 'nope', ref: 'x', task: 'detect' },
      { ...MINIMAL, id: 'second' },
    ])
    expect(specs.map((s) => s.id)).toEqual(['my_detector', 'second'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('broken')
  })

  it('rejects a duplicate id rather than silently shadowing the first', () => {
    const { specs, errors } = parseModelSpecList([MINIMAL, { ...MINIMAL, ref: 'https://other/infer' }])
    expect(specs).toHaveLength(1)
    expect(errors[0]).toMatch(/duplicate/i)
  })

  it('parses a JSON array string (the env var form)', () => {
    const { specs, errors } = parseModelSpecList(JSON.stringify([MINIMAL]))
    expect(errors).toEqual([])
    expect(specs).toHaveLength(1)
  })

  it('returns empty for null / undefined / empty string without complaining', () => {
    for (const v of [null, undefined, '', '   ', []]) {
      const { specs, errors } = parseModelSpecList(v)
      expect(specs).toEqual([])
      expect(errors).toEqual([])
    }
  })

  it('reports a non-array JSON string as an error rather than throwing', () => {
    const { specs, errors } = parseModelSpecList('{"id":"x"}')
    expect(specs).toEqual([])
    expect(errors).toHaveLength(1)
  })
})
