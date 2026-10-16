/** The one executor: resolve an operation, validate (static), run, finalise, validate (dynamic),
 *  and return a single `GeoResult`. Nothing else in the app runs an operation (ADR-0001 §2–3).
 *
 *  The model chooses operations and arguments; this code computes nothing but the envelope.
 */

import { GEO_RESULT_SCHEMA, GeoResultSchema, type GeoResult, type ValidationCheck } from '@/lib/geo-result'

import { withRequestAbortSignal } from '../lib/cache'
import { abortable } from '../lib/deadline'
import { errorReason, isFetchFailureSummary } from '../lib/fetch-failure'
import { buildPointAoi, getAreaKm2, getBbox, getCentroid } from '../lib/geometry'
import { registryFromEnv, type ModelRegistry } from '../lib/inference/model-registry'
import { currentModelProfile } from '../lib/inference/profile'
import { getLogger } from '../lib/logger'
import type { EmitFn, PointFocus, ResultStore, ToolCtx, ToolOutput } from '../lib/types'
import type { RequestLlmConfig } from '../lib/vision/vlm'
import { cachePolicy, expiryFor, isCacheableStatus, type CachePolicy } from './cache-policy'
import type { EvidenceStore } from './evidence-store'
import { inputsHash, resultId } from './hash'
import type { AnyOperation } from './operation'
import { resolveOperation } from './registry'
import { genericDynamicChecks, hasFailure, runStaticChecks, validateParams } from './validate'

const log = getLogger('engine/execute')

/** Everything an operation needs from the request besides its own arguments. */
export interface RunEnv {
  /** The drawn AOI (a bare GeoJSON geometry). */
  aoi: any
  emit?: EmitFn
  focus?: PointFocus
  /** Models registered for this request (Settings + env + built-ins). */
  models?: ModelRegistry
  llm?: RequestLlmConfig
  /** Results of this request + the client's reusable layers, for make_chart / style_layer. */
  results?: ResultStore
  /** The user's question, when there is one: the static plan check compares the period it states
   *  with the period each step reads. */
  question?: string
  /** Clock override for the date checks and cache expiry (tests). */
  now?: number
  /** Where results are stored (the evidence ledger) and cache hits are looked up. Absent: every
   *  operation runs and nothing is kept. */
  evidence?: EvidenceStore
  /** Aborts when the client leaves or the run's time budget ends. Each operation also gets its own
   *  deadline on top of this (`stepTimeoutMs`). */
  signal?: AbortSignal
  /** `refresh`: run even when a fresh cached result exists, and store the outcome (re-runs). */
  cache?: 'use' | 'refresh'
}

/** The context an operation (and its static checks) sees. A point the user clicked narrows the
 *  AOI to a ~200 m circle around it. */
export function buildCtx(env: RunEnv): ToolCtx {
  const aoi = env.focus ? buildPointAoi(env.focus.lat, env.focus.lng) : env.aoi
  const ctx: ToolCtx = {
    aoi,
    bbox: getBbox(aoi),
    centroid: env.focus ? { lat: env.focus.lat, lng: env.focus.lng } : getCentroid(aoi),
    areaKm2: getAreaKm2(aoi),
    emit: env.emit,
    focus: env.focus,
    runTool: (name, args) => runNested(name, args, env),
    models: env.models ?? registryFromEnv(currentModelProfile()),
    llm: env.llm,
    results: env.results,
    signal: env.signal,
  }
  return ctx
}

/** An operation calling another one (digitize_features routing to map_flood, a dataset read
 *  routed to a dedicated tool): arguments are parsed, the output is returned as-is. The caller's
 *  own result is the one that is validated and hashed. */
async function runNested(name: string, rawArgs: Record<string, any>, env: RunEnv): Promise<ToolOutput> {
  const resolved = resolveOperation(name, rawArgs)
  if (!resolved) return { summary: `Unknown tool: ${name}` }
  const params = validateParams(resolved.op, resolved.args)
  if (!params.ok) return { summary: params.check.message }
  return resolved.op.run(buildCtx(env), params.args)
}

/** Wall-clock one operation may take: its own `timeoutMs`, else twice its typical cost and at least a minute. */
export const stepTimeoutMs = (op: AnyOperation): number => op.timeoutMs ?? Math.max(60_000, op.cost.typicalSeconds * 2000)

/** Run an operation until it finishes or `signal` aborts (its own timeout, the run budget, a client leaving). */
const runBounded = (op: AnyOperation, ctx: ToolCtx, args: Record<string, any>, signal: AbortSignal, limitMs: number): Promise<ToolOutput> =>
  abortable(withRequestAbortSignal(signal, () => op.run(ctx, args)), signal, 'the operation', limitMs)

const unique = <T>(xs: T[]): T[] => [...new Set(xs)]

function statusOf(checks: ValidationCheck[], failed: boolean, refused: boolean): GeoResult['status'] {
  if (refused) return 'refused'
  if (failed) return 'failed'
  return hasFailure(checks) ? 'flagged' : 'ok'
}

interface Draft {
  op: { name: string; version: string }
  inputs: string
  output: ToolOutput
  validation: ValidationCheck[]
  status: GeoResult['status']
  fallbackSummary?: string
}

function finalise(d: Draft): GeoResult {
  const layers = [...(d.output.layer ? [d.output.layer] : []), ...(d.output.layers ?? [])]
  const sources = unique([
    ...layers.map((l) => l.provenance?.source).filter((s): s is string => !!s),
    ...(d.output.sources ?? []),
  ])
  const items = unique([
    ...(d.output.provenance_items ?? []),
    ...layers.map((l) => l.raster?.sceneId).filter((s): s is string => !!s),
  ])
  const methods = unique(layers.map((l) => l.provenance?.method).filter((m): m is string => !!m))
  const notes = unique([
    ...(d.output.uncertainty?.notes ?? []),
    ...layers.map((l) => l.provenance?.resolution_limit).filter((n): n is string => !!n),
  ])
  const ranges = d.output.uncertainty?.ranges
  const result: GeoResult = {
    schema: GEO_RESULT_SCHEMA,
    result_id: resultId(d.inputs, items),
    op: d.op,
    status: d.status,
    summary: d.output.summary,
    layers,
    ...(d.output.charts?.length ? { charts: d.output.charts } : {}),
    ...(d.output.summary_data ? { stats: d.output.summary_data } : {}),
    ...(d.output.layer_style ? { layer_style: d.output.layer_style } : {}),
    provenance: {
      sources,
      items,
      method: methods.length ? methods.join(' | ') : `${d.op.name}@${d.op.version}`,
      ...(layers.find((l) => l.provenance?.date)?.provenance?.date ? { date: layers.find((l) => l.provenance?.date)!.provenance!.date } : {}),
      inputs_hash: d.inputs,
    },
    ...(notes.length || ranges ? { uncertainty: { notes, ...(ranges ? { ranges } : {}) } } : {}),
    validation: d.validation,
    ...(d.output.cv_fallback_recommended ? { cv_fallback_model: d.output.suggested_cv_model || 'informal_struct' } : {}),
  }
  return GeoResultSchema.parse(result)
}

/** Refusals and failures carry no layers, figures or sources: just the reason. */
function bare(op: { name: string; version: string }, inputs: string, summary: string, validation: ValidationCheck[], status: GeoResult['status']): GeoResult {
  return finalise({ op, inputs, output: { summary, failed: status === 'failed' }, validation, status })
}

const refusalSummary = (name: string, checks: ValidationCheck[]): string =>
  `**${name} was not run.** ` + checks.filter((c) => c.status === 'fail').map((c) => c.message).join(' ')

/** What running (or reusing) an operation produced, and the cache policy that applied. */
interface Outcome {
  result: GeoResult
  policy?: CachePolicy
  /** Served from the result cache: already stored, nothing to persist. */
  hit?: boolean
}

export async function runOperation(name: string, rawArgs: Record<string, any>, env: RunEnv): Promise<GeoResult> {
  const { result, policy, hit } = await execute(name, rawArgs, env)
  if (env.evidence && !hit) {
    // Every executed operation is kept as evidence; only an answer under a cacheable policy gets a cache key.
    const now = env.now ?? Date.now()
    const cacheable = policy?.cacheable && isCacheableStatus(result.status) ? policy : null
    await env.evidence.put(result, { cacheKey: cacheable?.key ?? null, expiresAt: cacheable ? expiryFor(result, cacheable, now) : null, now })
  }
  return result
}

async function execute(name: string, rawArgs: Record<string, any>, env: RunEnv): Promise<Outcome> {
  const refuse = (op: { name: string; version: string }, inputs: string, summary: string, checks: ValidationCheck[]): Outcome => ({
    result: bare(op, inputs, summary, checks, 'refused'),
  })
  const resolved = resolveOperation(name, rawArgs ?? {})
  if (!resolved) {
    const check: ValidationCheck = { id: 'op_exists', phase: 'static', status: 'fail', message: `Unknown tool: ${name}. Use only the tools offered.` }
    return refuse({ name, version: '0' }, inputsHash({ op: name, version: '0', args: rawArgs ?? {}, aoi: env.aoi, focus: env.focus }), `Unknown tool: ${name}`, [check])
  }
  const { op } = resolved
  const meta = { name: op.name, version: op.version }
  const hashOf = (args: Record<string, unknown>) => inputsHash({ op: op.name, version: op.version, args, aoi: env.aoi, focus: env.focus })

  // ---- static ----------------------------------------------------------
  const params = validateParams(op, resolved.args)
  if (!params.ok) return refuse(meta, hashOf(resolved.args), refusalSummary(op.name, [params.check]), [params.check])
  const args = params.args
  const inputs = hashOf(args)
  const limitMs = stepTimeoutMs(op)
  const timeout = AbortSignal.timeout(limitMs)
  const signal = env.signal ? AbortSignal.any([env.signal, timeout]) : timeout
  const ctx = buildCtx({ ...env, signal })
  const staticChecks = runStaticChecks(op, ctx, args, env.now)
  if (hasFailure(staticChecks)) return refuse(meta, inputs, refusalSummary(op.name, staticChecks), staticChecks)

  // ---- cache -----------------------------------------------------------
  const now = env.now ?? Date.now()
  const policy = cachePolicy(op, args, inputs, now)
  if (env.evidence && policy.cacheable && env.cache !== 'refresh') {
    const stored = await env.evidence.lookup(policy.key, now)
    if (stored) {
      const { result, computedAt } = stored
      log.info({ op: op.name, result_id: result.result_id }, 'served from the result cache')
      return { policy, hit: true, result: { ...result, provenance: { ...result.provenance, cached: true, computed_at: new Date(computedAt).toISOString() } } }
    }
  }

  // ---- run -------------------------------------------------------------
  let output: ToolOutput
  try {
    output = await runBounded(op, ctx, args, signal, limitMs)
  } catch (err) {
    log.error({ op: op.name, err: errorReason(err) }, 'operation threw')
    // A throw is a failure to run, never an empty result: say so in those words.
    const summary = `**${op.name} failed:** ${errorReason(err)}. This is a failure, not an absence of data.`
    return { policy, result: bare(meta, inputs, summary, staticChecks, 'failed') }
  }

  // An operation may decline after looking at the data (too little history to forecast): a refusal
  // carries only its reason and is never cached.
  if (output.refused) return { policy, result: bare(meta, inputs, output.summary, staticChecks, 'refused') }

  // ---- dynamic ---------------------------------------------------------
  // An upstream that could not be read is a failure, which the tool flags or words with the
  // standard connectivity note; it is never an empty result.
  const failed = output.failed ?? isFetchFailureSummary(output.summary)
  const draft = finalise({ op: meta, inputs, output: { ...output, failed }, validation: staticChecks, status: 'ok' })
  const dynamic = failed ? [] : dynamicChecksFor(op, output, ctx, args, draft)
  const validation = [...staticChecks, ...dynamic]
  return { policy, result: { ...draft, validation, status: statusOf(validation, failed, false) } }
}

function dynamicChecksFor(op: AnyOperation, output: ToolOutput, ctx: ToolCtx, args: Record<string, any>, draft: GeoResult): ValidationCheck[] {
  return [
    ...genericDynamicChecks(output, draft.layers, draft.provenance.sources),
    ...(op.dynamicChecks?.(output, ctx, args) ?? []),
  ]
}
