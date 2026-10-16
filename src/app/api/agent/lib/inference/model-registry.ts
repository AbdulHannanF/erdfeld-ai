/** The pluggable model registry (spec §3.7).
 *
 *  Three sources, merged per request, in increasing precedence:
 *
 *    built-in   → shipped defaults, deliberately few and all verified
 *    env        → `GEOAGENT_MODELS` (a JSON array) for operators
 *    settings   → models the user added in the UI, sent with the request
 *
 *  Nothing here needs a redeploy, which is what "use any foundation model for
 *  free" means in practice: local weights have no rate limit and no bill.
 *
 *  Models heavier than the box are excluded and REPORTED, never silently
 *  dropped — a user who added a `large` model on a 4 GB box must be told why it
 *  did not appear rather than watch it quietly never run.
 */

import { checkUrlSyntax } from '@/lib/url-guard'

import { getLogger } from '../logger'
import { profileAllows, type ModelProfile } from './profile'
import { parseModelSpecList, type ModelSpec, type ModelTask } from './model-spec'

const log = getLogger('agent/model-registry')

export type ModelSource = 'builtin' | 'env' | 'settings'

/**
 * Shipped defaults.
 *
 * Deliberately short. Two findings constrain it, both measured (see the v2 spec
 * §1 and ISSUES ISS-104):
 *
 *  - **HuggingFace serverless runs none of the vision models we need.**
 *    Re-verified 2026-08-10: grounding-dino-tiny/base, sam2-hiera-large,
 *    owlv2-base-patch16-ensemble and clip-vit-base-patch32 all report an
 *    `inferenceProviderMapping` with zero providers. HF stays in the provider
 *    list as a **weight host** for `local-onnx` downloads, never as an inference
 *    route — so no built-in has `provider: 'hf'`.
 *
 *  - **Generic open-vocabulary detectors are blind on nadir imagery.** Grounding
 *    DINO, OWLv2 and YOLO-World each scored 0 against real 0.3 m imagery
 *    containing obvious cars, buildings, a pool and solar panels. Shipping one
 *    as a default would advertise a capability we measured as absent.
 *
 *  The three `keremberke` ONNX weights the app used are gone from upstream
 *  (verified 404 at the repo API on 2026-08-10) and the owner holds replacements
 *  on another machine. In their place Phase 2 ships ONE curated aerial detector,
 *  found and verified live on 2026-08-10 — see `dota-aerial-obb` below. Adding
 *  more is a registry entry, not a code change.
 */
export const BUILTIN_MODELS: ModelSpec[] = [
  {
    id: 'dota-aerial-obb',
    provider: 'local-onnx',
    ref: 'https://huggingface.co/steven0226/yolo26m-obb-dota/resolve/main/best.onnx',
    task: 'detect',
    // DOTA v1.0, Ultralytics class order. Confirmed twice against the tensor:
    // index 0 boxed aircraft at Schiphol, index 10 boxed cars in Manhattan.
    classes: [
      'plane', 'ship', 'storage tank', 'baseball diamond', 'tennis court', 'basketball court',
      'ground track field', 'harbor', 'bridge', 'large vehicle', 'small vehicle', 'helicopter',
      'roundabout', 'soccer ball field', 'swimming pool',
    ],
    inputSize: 1024,
    // 81 MB, and it ran on this box's CPU during verification — no VRAM needed.
    profile: 'tiny',
    defaultConfidence: 0.25,
    minObjectPx: 32,
    license:
      'Community checkpoint (steven0226/yolo26m-obb-dota) — licence not stated upstream. ' +
      'YOLO derivatives are typically AGPL-3.0; confirm before commercial use.',
    resolutionLimit:
      'Aerial-trained (DOTA), so unlike ground-level detectors it works from nadir — but it needs ' +
      'the object to span roughly 32 px. Measured 2026-08-10: correct vehicles over Manhattan at ' +
      '0.11 m/px (car ≈ 40 px), and nothing at all over Lahore at 0.25 m/px (car ≈ 18 px). ' +
      'Below the floor the pipeline reports "not resolvable here" rather than "none found".',
    notes:
      'Tier A curated aerial detector. Verified live 2026-08-10 by cropping its own boxes out of the ' +
      'source mosaic: 7/7 were aircraft at Schiphol; Manhattan crops were cars including yellow taxis. ' +
      'Must be fed a mosaic at its native 1024 px input — upscaling a smaller mosaic misplaces boxes.',
  },
  {
    id: 'clip',
    provider: 'roboflow',
    ref: 'clip/ViT-B-16',
    task: 'embed',
    inputSize: 224,
    profile: 'tiny',
    license: 'MIT (OpenAI CLIP weights)',
    resolutionM: 0.3,
    resolutionLimit:
      'Labels an image crop against free-text phrases; it does not localise. ' +
      'Meaningful only when the crop already isolates one object — pair it with ' +
      'a mask or box source. Verified working on Roboflow serverless 2026-08-10.',
    notes: 'Tier B labeller: scores SAM2 masks against the user phrase plus distractors.',
  },
  {
    id: 'sam2',
    provider: 'roboflow',
    ref: 'sam2/hiera-large',
    task: 'segment',
    inputSize: 1024,
    profile: 'base',
    license: 'Apache-2.0 (Meta SAM 2)',
    resolutionLimit:
      'Produces polygon geometry from any resolution; labels must come from ' +
      'elsewhere (e.g. CLIP). Roboflow hosts it PROMPT-ONLY — automatic mode ' +
      'returns a single mask, not hundreds — so segment-everything needs a local ' +
      'SAM2. Minimum meaningful polygon at 10 m is roughly 1 ha.',
    notes: 'Hosted SAM2 is prompt-only (measured); Tier B automatic masking must run locally.',
  },
]

export interface SkippedModel {
  id: string
  reason: string
}

export interface ModelRegistry {
  /** Usable models on this box, by id. */
  models: Map<string, ModelSpec>
  /** Registered but excluded (e.g. too heavy for the profile), with the reason. */
  skipped: SkippedModel[]
  /** Human-readable parse failures, safe to show in the UI. */
  errors: string[]
  /** Where a model came from — for provenance and for the Settings UI. */
  sourceOf(id: string): ModelSource | undefined
  /** Usable models for a task, in precedence order. */
  forTask(task: ModelTask): ModelSpec[]
}

export interface BuildRegistryOptions {
  /** Effective hardware profile for this box. */
  profile: ModelProfile
  /** Raw `GEOAGENT_MODELS` value (a JSON array string). */
  envJson?: string | null
  /** Model specs the user added in Settings, sent with the request. */
  userSpecs?: unknown
}

/**
 * Merge the three sources into one registry for this request.
 *
 * Later sources overwrite earlier ids on purpose: a user must be able to point
 * a built-in id at their own endpoint without editing code.
 */
export function buildModelRegistry(opts: BuildRegistryOptions): ModelRegistry {
  const { profile, envJson, userSpecs } = opts

  const envParsed = parseModelSpecList(envJson)
  const userParsed = parseModelSpecList(userSpecs)
  const errors = [
    ...envParsed.errors.map((e) => `GEOAGENT_MODELS: ${e}`),
    ...userParsed.errors,
  ]

  const models = new Map<string, ModelSpec>()
  const sources = new Map<string, ModelSource>()
  const skipped: SkippedModel[] = []

  const add = (spec: ModelSpec, source: ModelSource) => {
    // A browser-supplied endpoint may not point the server at an internal address (SSRF).
    if (source === 'settings') {
      spec = { ...spec, untrusted: true }
      if (/^https?:\/\//i.test(spec.ref) && (spec.provider === 'custom-http' || spec.provider === 'local-onnx')) {
        const check = checkUrlSyntax(spec.ref)
        if (!check.ok) {
          errors.push(`"${spec.id}": the endpoint was refused (${check.reason}).`)
          return
        }
      }
    }
    if (!profileAllows(profile, spec.profile)) {
      skipped.push({
        id: spec.id,
        reason:
          `declared profile "${spec.profile}" but this machine resolves to "${profile}" ` +
          `— set MODEL_PROFILE to override, or register a lighter variant.`,
      })
      // A heavier same-id entry must not leave a lighter one shadowed.
      return
    }
    models.set(spec.id, spec)
    sources.set(spec.id, source)
  }

  for (const spec of BUILTIN_MODELS) add(spec, 'builtin')
  for (const spec of envParsed.specs) add(spec, 'env')
  for (const spec of userParsed.specs) add(spec, 'settings')

  if (errors.length) log.warn({ errors }, 'model registry parse errors')
  if (skipped.length) log.info({ skipped, profile }, 'models excluded by hardware profile')

  return {
    models,
    skipped,
    errors,
    sourceOf: (id) => sources.get(id),
    forTask: (task) => [...models.values()].filter((m) => m.task === task),
  }
}

/** Build the registry from the process environment plus request-supplied specs. */
export function registryFromEnv(profile: ModelProfile, userSpecs?: unknown): ModelRegistry {
  return buildModelRegistry({ profile, envJson: process.env.GEOAGENT_MODELS, userSpecs })
}
