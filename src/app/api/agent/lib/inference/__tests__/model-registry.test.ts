/**
 * The Phase 1 pluggable model registry (spec §3.7): built-ins + `GEOAGENT_MODELS`
 * env + models added from Settings, merged and filtered by hardware profile,
 * with no redeploy.
 *
 * Also pins the retirement of the dead HuggingFace assumption. Verified live
 * 2026-08-10: `grounding-dino-tiny`, `grounding-dino-base`, `sam2-hiera-large`,
 * `owlv2-base-patch16-ensemble` and even `clip-vit-base-patch32` all report
 * `inferenceProviderMapping` with **zero** providers. HF serverless runs none of
 * them, so no built-in may route inference there — HF is a weight *host* only.
 */

import { describe, expect, it } from 'vitest'
import { BUILTIN_MODELS, buildModelRegistry } from '../model-registry'
import type { ModelSpec } from '../model-spec'

const userDetector: Partial<ModelSpec> & Record<string, unknown> = {
  id: 'my_cars',
  provider: 'custom-http',
  ref: 'https://gpu.example.com/detect',
  task: 'detect',
  classes: ['car'],
  profile: 'tiny',
}

describe('BUILTIN_MODELS — honest defaults', () => {
  it('routes no model to hf for inference (HF serverless serves none of them)', () => {
    const hfInference = BUILTIN_MODELS.filter((m) => m.provider === 'hf')
    expect(hfInference, `hf-routed built-ins: ${hfInference.map((m) => m.id).join(', ')}`).toEqual([])
  })

  it('ships no nadir-blind open-vocabulary detector as a built-in', () => {
    // Measured on real 0.3 m Esri imagery: Grounding DINO, OWLv2 and YOLO-World
    // all scored 0 on obvious cars/buildings/pool/solar panels. Registering one
    // as a default would be shipping a capability we measured as absent.
    const banned = /grounding[-_ ]?dino|owlv2|yolo[-_ ]?world/i
    const offenders = BUILTIN_MODELS.filter((m) => banned.test(m.id) || banned.test(m.ref))
    expect(offenders.map((m) => m.id)).toEqual([])
  })

  it('every built-in is itself a valid spec', () => {
    for (const m of BUILTIN_MODELS) {
      expect(m.id, 'id').toBeTruthy()
      expect(m.ref, `${m.id} ref`).toBeTruthy()
      expect(m.profile, `${m.id} profile`).toBeTruthy()
      expect(m.resolutionLimit, `${m.id} must carry an honesty note`).toBeTruthy()
    }
  })

  it('built-in ids are unique', () => {
    const ids = BUILTIN_MODELS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('buildModelRegistry — merge order and provenance', () => {
  it('includes built-ins by default', () => {
    const r = buildModelRegistry({ profile: 'large' })
    for (const b of BUILTIN_MODELS) expect(r.models.has(b.id)).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('adds a model from Settings with no redeploy — the Phase 1 gate', () => {
    const r = buildModelRegistry({ profile: 'tiny', userSpecs: [userDetector] })
    const m = r.models.get('my_cars')
    expect(m).toBeDefined()
    expect(m!.provider).toBe('custom-http')
    expect(r.sourceOf('my_cars')).toBe('settings')
  })

  it('adds a model from the GEOAGENT_MODELS env var', () => {
    const r = buildModelRegistry({
      profile: 'tiny',
      envJson: JSON.stringify([{ ...userDetector, id: 'env_model' }]),
    })
    expect(r.models.has('env_model')).toBe(true)
    expect(r.sourceOf('env_model')).toBe('env')
  })

  it('lets Settings override env, and env override a built-in', () => {
    const builtinId = BUILTIN_MODELS[0]?.id
    const r = buildModelRegistry({
      profile: 'large',
      envJson: JSON.stringify([
        { ...userDetector, id: 'shared', ref: 'https://env.example/infer' },
        ...(builtinId ? [{ ...userDetector, id: builtinId, ref: 'https://env.example/override' }] : []),
      ]),
      userSpecs: [{ ...userDetector, id: 'shared', ref: 'https://settings.example/infer' }],
    })
    expect(r.models.get('shared')!.ref).toBe('https://settings.example/infer')
    expect(r.sourceOf('shared')).toBe('settings')
    if (builtinId) {
      expect(r.models.get(builtinId)!.ref).toBe('https://env.example/override')
      expect(r.sourceOf(builtinId)).toBe('env')
    }
  })

  it('surfaces parse errors without dropping the valid entries', () => {
    const r = buildModelRegistry({
      profile: 'tiny',
      userSpecs: [userDetector, { id: 'broken', provider: 'nope', ref: 'x', task: 'detect' }],
    })
    expect(r.models.has('my_cars')).toBe(true)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain('broken')
  })
})

describe('buildModelRegistry — browser-supplied endpoints (SSRF)', () => {
  it('refuses a Settings model that points at metadata, link-local or private hosts', () => {
    for (const ref of ['http://169.254.169.254/latest', 'http://metadata.google.internal/', 'http://10.0.0.7/detect']) {
      const r = buildModelRegistry({ profile: 'tiny', userSpecs: [{ ...userDetector, ref }] })
      expect(r.models.has('my_cars'), ref).toBe(false)
      expect(r.errors.join('\n')).toMatch(/refused/)
    }
  })
  it('marks Settings specs untrusted and leaves operator (env) specs alone, private hosts included', () => {
    const env = JSON.stringify([{ ...userDetector, id: 'sidecar', ref: 'http://10.0.0.7:8000/detect' }])
    const r = buildModelRegistry({ profile: 'tiny', envJson: env, userSpecs: [userDetector] })
    expect(r.models.get('my_cars')?.untrusted).toBe(true)
    expect(r.models.get('sidecar')?.untrusted).toBeUndefined()
  })
})

describe('buildModelRegistry — hardware profile gating (spec §2)', () => {
  const heavy = { ...userDetector, id: 'heavy', profile: 'large' }
  const light = { ...userDetector, id: 'light', profile: 'tiny' }

  it('excludes a model heavier than the box, and says why', () => {
    const r = buildModelRegistry({ profile: 'tiny', userSpecs: [heavy, light] })
    expect(r.models.has('light')).toBe(true)
    expect(r.models.has('heavy')).toBe(false)
    const reason = r.skipped.find((s) => s.id === 'heavy')?.reason
    expect(reason).toBeDefined()
    expect(reason).toMatch(/profile|vram|tiny/i)
  })

  it('the 4090 box loads everything', () => {
    const r = buildModelRegistry({ profile: 'large', userSpecs: [heavy, light] })
    expect(r.models.has('heavy')).toBe(true)
    expect(r.models.has('light')).toBe(true)
    expect(r.skipped).toEqual([])
  })

  it('a skipped model is still reported by id, so the user is not left guessing', () => {
    const r = buildModelRegistry({ profile: 'tiny', userSpecs: [heavy] })
    const s = r.skipped.find((x) => x.id === 'heavy')
    expect(s, 'heavy was not reported as skipped').toBeDefined()
    expect(s!.reason).toContain('large')
  })

  it('skips a built-in too heavy for the box — the dev P1000 cannot host SAM2', () => {
    // This box is a Quadro P1000 (4 GB) → profile "tiny"; the built-in sam2 is
    // "base". It must be excluded WITH a reason, not silently missing.
    const r = buildModelRegistry({ profile: 'tiny' })
    expect(r.models.has('sam2')).toBe(false)
    expect(r.models.has('clip')).toBe(true)   // tiny — still available
    expect(r.skipped.find((s) => s.id === 'sam2')?.reason).toMatch(/base/)
  })
})

describe('buildModelRegistry — lookup helpers', () => {
  it('lists models for a task', () => {
    const r = buildModelRegistry({
      profile: 'large',
      userSpecs: [userDetector, { ...userDetector, id: 'seg', task: 'segment' }],
    })
    expect(r.forTask('detect').map((m) => m.id)).toContain('my_cars')
    expect(r.forTask('segment').map((m) => m.id)).toContain('seg')
    expect(r.forTask('detect').map((m) => m.id)).not.toContain('seg')
  })

  it('sourceOf returns undefined for an unknown id', () => {
    expect(buildModelRegistry({ profile: 'tiny' }).sourceOf('nope')).toBeUndefined()
  })
})
