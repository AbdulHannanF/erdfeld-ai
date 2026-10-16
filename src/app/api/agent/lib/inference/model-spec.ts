/** User-pluggable model specs — the Phase 1 registry primitive (spec §3.7).
 *
 *  A model is registered as
 *    { provider: local-onnx | roboflow | hf | custom-http, id, task, classes,
 *      input_size, profile, license }
 *  from Settings or from the `GEOAGENT_MODELS` env var. No redeploy, no code
 *  change — which is what "use any foundation model for free" means in practice:
 *  local weights have no rate limit and no bill.
 *
 *  This module is pure: no I/O, no `process.env`, no provider knowledge beyond
 *  the shape of a reference. Settings is a free-text JSON field, so parsing is a
 *  trust boundary — every rejection carries a message the user can act on, and a
 *  half-valid entry never reaches a provider.
 */

/** Where a model actually runs. */
export const MODEL_PROVIDERS = ['local-onnx', 'roboflow', 'hf', 'custom-http'] as const
export type ModelProvider = (typeof MODEL_PROVIDERS)[number]

/** What the model produces. */
export const MODEL_TASKS = ['detect', 'segment', 'classify', 'embed'] as const
export type ModelTask = (typeof MODEL_TASKS)[number]

/** Hardware tier. `tiny` must run on 4 GB VRAM and on CPU (spec §2). */
export const MODEL_PROFILES = ['tiny', 'base', 'large'] as const
export type ModelProfile = (typeof MODEL_PROFILES)[number]

export interface ModelSpec {
  /** Unique key tools use to request this model. */
  id: string
  provider: ModelProvider
  /**
   * Provider-specific pointer:
   *   local-onnx  → an https URL to a .onnx file, or an absolute local path
   *   roboflow    → "project/version"
   *   hf          → "owner/repo"
   *   custom-http → an absolute http(s) endpoint
   */
  ref: string
  task: ModelTask
  /** Ordered class names as exported from the training config. */
  classes?: string[]
  /** Square input size the model expects. */
  inputSize: number
  profile: ModelProfile
  license?: string
  /** Native ground resolution in metres/pixel, for the resolution-honesty check. */
  resolutionM?: number
  /**
   * Pixels across an object's long axis below which this model stops seeing it.
   *
   * Phase 2, measured: the DOTA-trained detector returns correct vehicles where a
   * car spans ~40 px and returns *nothing* where it spans ~18 px. Without this
   * declared floor the pipeline reports that honest blindness as "0 cars here",
   * which is a different and false claim.
   */
  minObjectPx?: number
  /**
   * Natural-language targets this model covers, when its class names are not
   * themselves the user's words (e.g. DOTA's "small vehicle" answers "car").
   */
  targets?: string[]
  /** Honest statement of what this model can and cannot answer. */
  resolutionLimit?: string
  /** Confidence floor when the caller does not override. */
  defaultConfidence?: number
  /** Free-text note carried into provenance. */
  notes?: string
  /** Set by the registry for a spec the browser supplied: its URLs must pass the SSRF guard
   *  (public hosts only, redirects checked) before the server fetches them. */
  untrusted?: boolean
}

export type ParseResult =
  | { ok: true; spec: ModelSpec }
  | { ok: false; error: string }

/** Accept both the snake_case of the spec document and the camelCase of the code. */
function pick(raw: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) if (raw[n] !== undefined && raw[n] !== null) return raw[n]
  return undefined
}

function refLooksLikePath(ref: string): boolean {
  return /^https?:\/\//i.test(ref) || ref.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(ref)
}

function isHttpUrl(ref: string): boolean {
  return /^https?:\/\/\S+$/i.test(ref)
}

/** `owner/name` — exactly one slash, both halves non-empty. */
function isTwoPartRef(ref: string): boolean {
  const parts = ref.split('/')
  return parts.length === 2 && parts.every((p) => p.trim().length > 0)
}

/**
 * Validate one model spec. Returns the normalised spec or a message naming both
 * the offending field and — when known — the model id, so a user staring at a
 * list of models can tell which line is wrong.
 */
export function parseModelSpec(input: unknown): ParseResult {
  let raw: unknown = input
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return { ok: false, error: 'Model spec is empty.' }
    try {
      raw = JSON.parse(text)
    } catch {
      return { ok: false, error: 'Model spec is not valid JSON.' }
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Model spec must be a JSON object.' }
  }
  const r = raw as Record<string, unknown>

  const idRaw = pick(r, 'id', 'key')
  const id = typeof idRaw === 'string' ? idRaw.trim() : ''
  // Prefix every later message with the id when we have one.
  const at = id ? ` (model "${id}")` : ''
  if (!id) return { ok: false, error: 'Model spec needs a non-empty "id".' }

  const provider = pick(r, 'provider') as ModelProvider
  if (!provider || !MODEL_PROVIDERS.includes(provider)) {
    return {
      ok: false,
      error: `Unknown "provider"${at}: ${JSON.stringify(provider ?? null)}. Must be one of ${MODEL_PROVIDERS.join(' | ')}.`,
    }
  }

  const refRaw = pick(r, 'ref', 'route', 'url', 'model_id', 'modelId')
  const ref = typeof refRaw === 'string' ? refRaw.trim() : ''
  if (!ref) {
    return { ok: false, error: `Model spec needs a non-empty "ref"${at} — the ${provider} model reference.` }
  }

  const task = pick(r, 'task') as ModelTask
  if (!task || !MODEL_TASKS.includes(task)) {
    return {
      ok: false,
      error: `Unknown "task"${at}: ${JSON.stringify(task ?? null)}. Must be one of ${MODEL_TASKS.join(' | ')}.`,
    }
  }

  // Provider-specific ref shape. Catching this here turns a confusing runtime
  // 404 into an actionable message at registration time.
  switch (provider) {
    case 'local-onnx':
      if (!refLooksLikePath(ref)) {
        return { ok: false, error: `"ref"${at} for local-onnx must be an https URL to a .onnx file or an absolute local path, got "${ref}".` }
      }
      break
    case 'custom-http':
      if (!isHttpUrl(ref)) {
        return { ok: false, error: `"ref"${at} for custom-http must be an absolute http(s) endpoint, got "${ref}".` }
      }
      break
    case 'roboflow':
      if (!isTwoPartRef(ref)) {
        return { ok: false, error: `"ref"${at} for roboflow must be "project/version", got "${ref}".` }
      }
      break
    case 'hf':
      if (!isTwoPartRef(ref)) {
        return { ok: false, error: `"ref"${at} for hf must be "owner/repo", got "${ref}".` }
      }
      break
  }

  const profileRaw = pick(r, 'profile')
  const profile = (profileRaw ?? 'base') as ModelProfile
  if (!MODEL_PROFILES.includes(profile)) {
    return {
      ok: false,
      error: `Unknown "profile"${at}: ${JSON.stringify(profileRaw)}. Must be one of ${MODEL_PROFILES.join(' | ')}.`,
    }
  }

  const classesRaw = pick(r, 'classes')
  let classes: string[] | undefined
  if (classesRaw !== undefined) {
    if (!Array.isArray(classesRaw) || classesRaw.some((c) => typeof c !== 'string')) {
      return { ok: false, error: `"classes"${at} must be an array of strings.` }
    }
    classes = classesRaw as string[]
  }

  const sizeRaw = pick(r, 'inputSize', 'input_size')
  let inputSize = 640
  if (sizeRaw !== undefined) {
    const n = Number(sizeRaw)
    if (!Number.isFinite(n) || n < 32 || n > 8192) {
      return { ok: false, error: `"input_size"${at} must be a number between 32 and 8192, got ${JSON.stringify(sizeRaw)}.` }
    }
    inputSize = Math.round(n)
  }

  const confRaw = pick(r, 'defaultConfidence', 'default_confidence', 'confidence')
  let defaultConfidence: number | undefined
  if (confRaw !== undefined) {
    const n = Number(confRaw)
    if (!Number.isFinite(n) || n <= 0 || n > 1) {
      return { ok: false, error: `"default_confidence"${at} must be a number in (0, 1], got ${JSON.stringify(confRaw)}.` }
    }
    defaultConfidence = n
  }

  const resRaw = pick(r, 'resolutionM', 'resolution_m')
  let resolutionM: number | undefined
  if (resRaw !== undefined) {
    const n = Number(resRaw)
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, error: `"resolution_m"${at} must be a positive number, got ${JSON.stringify(resRaw)}.` }
    }
    resolutionM = n
  }

  const minPxRaw = pick(r, 'minObjectPx', 'min_object_px')
  let minObjectPx: number | undefined
  if (minPxRaw !== undefined) {
    const n = Number(minPxRaw)
    if (!Number.isFinite(n) || n <= 0 || n > 4096) {
      return { ok: false, error: `"min_object_px"${at} must be a positive number under 4096, got ${JSON.stringify(minPxRaw)}.` }
    }
    minObjectPx = Math.round(n)
  }

  const targetsRaw = pick(r, 'targets')
  let targets: string[] | undefined
  if (targetsRaw !== undefined) {
    if (!Array.isArray(targetsRaw) || targetsRaw.some((t) => typeof t !== 'string')) {
      return { ok: false, error: `"targets"${at} must be an array of strings.` }
    }
    targets = targetsRaw as string[]
  }

  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

  return {
    ok: true,
    spec: {
      id,
      provider,
      ref,
      task,
      classes,
      inputSize,
      profile,
      license: str(pick(r, 'license')),
      resolutionM,
      minObjectPx,
      targets,
      resolutionLimit: str(pick(r, 'resolutionLimit', 'resolution_limit')),
      defaultConfidence,
      notes: str(pick(r, 'notes')),
    },
  }
}

/**
 * Parse a list of specs, keeping the good ones and reporting the bad ones.
 *
 * One malformed entry must not silently discard a user's whole model list, and a
 * duplicate id must not silently shadow an earlier entry — both are reported so
 * the UI can show exactly which line needs fixing.
 */
export function parseModelSpecList(input: unknown): { specs: ModelSpec[]; errors: string[] } {
  if (input == null) return { specs: [], errors: [] }

  let list: unknown = input
  if (typeof list === 'string') {
    const text = list.trim()
    if (!text) return { specs: [], errors: [] }
    try {
      list = JSON.parse(text)
    } catch {
      return { specs: [], errors: ['Model list is not valid JSON.'] }
    }
  }
  if (!Array.isArray(list)) {
    return { specs: [], errors: ['Model list must be a JSON array of model specs.'] }
  }

  const specs: ModelSpec[] = []
  const errors: string[] = []
  const seen = new Set<string>()

  for (const entry of list) {
    const r = parseModelSpec(entry)
    if (!r.ok) {
      errors.push(r.error)
      continue
    }
    if (seen.has(r.spec.id)) {
      errors.push(`Duplicate model id "${r.spec.id}" — ids must be unique; the later entry was ignored.`)
      continue
    }
    seen.add(r.spec.id)
    specs.push(r.spec)
  }

  return { specs, errors }
}
