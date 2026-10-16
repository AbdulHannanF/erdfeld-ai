/** Operation — the contract every capability the planner may use must declare (ADR-0001 §1).
 *
 *  An operation is one entry here, in `engine/ops/*.ts`: its parameters (a zod schema, which is
 *  also the JSON Schema the model sees), what it outputs, the sensors and limits it works within,
 *  its cost, its limitations, what its confidence means, and the checks that run before and after
 *  it. The registry is the only thing the planner may use; adding an operation needs no change to
 *  the planner, the executor or the UI.
 */

import { z } from 'zod'

import type { ValidationCheck } from '@/lib/geo-result'

import type { ToolCtx, ToolOutput } from '../lib/types'

export type OutputKind = 'raster' | 'vector' | 'table' | 'chart' | 'text' | 'mixed'

export interface OperationLimits {
  /** Largest AOI the operation is meant for. Default: the app-wide ceiling (5,000 km²). */
  maxAreaKm2?: number
  /** Smallest AOI that gives a meaningful answer. */
  minAreaKm2?: number
  /** Earliest date the underlying data exists (ISO). Earlier dates are refused. */
  earliest?: string
  /** The operation is time-bound: it reads `date` / `start` / `end` / `before` / `after`. */
  needsDates?: boolean
}

/** What a check sees besides the arguments. */
export type StaticCtx = Pick<ToolCtx, 'aoi' | 'bbox' | 'centroid' | 'areaKm2' | 'focus'>

/** How long a finished result of this operation may be served from the result cache (Q-47).
 *  Absent = never cached (the safe default for a new operation). All values in milliseconds.
 *
 *  - `liveMs`: validity when the answer can change under the same arguments: no explicit dates,
 *    a window that reaches within `SETTLE_DAYS` of today, or a source that is updated in place
 *    (OSM, fires). 0 = never cache.
 *  - `settledMs`: validity when every date is explicit and old enough that new scenes can no
 *    longer change the answer. Omit it when the operation has no such case. */
export interface CacheTtl {
  liveMs: number
  settledMs?: number
}

export interface Operation<S extends z.ZodObject<any> = z.ZodObject<any>> {
  /** The tool name the model calls. */
  name: string
  /** Shown while it runs ("Fetching NDVI..."). */
  label: string
  /** semver; bump when a change could alter results (it is part of the content hash). */
  version: string
  /** What the model sees. */
  description: string
  /** Argument schema. Descriptions here are the LLM contract: do not rename fields. */
  params: S
  output: OutputKind
  /** Sensors / data products it reads, by the ids used in the sensor catalog. */
  sensors?: string[]
  /** Native ground resolution of the data it reads, metres. */
  resolution_m?: number
  limits?: OperationLimits
  cost: { typicalSeconds: number }
  /** Wall-clock the executor lets one run take before it fails it. Default: twice
   *  `cost.typicalSeconds`, at least a minute (see `stepTimeoutMs`). */
  timeoutMs?: number
  /** Result-cache validity (see `CacheTtl`); decided with the operation's other contract fields
   *  because only its author knows how fast the data it reads changes. */
  cacheTtl?: CacheTtl
  /** Honest limits the model must carry into its answer. */
  limitations: string[]
  /** What this operation's `confidence` value means. */
  confidence: string
  /** Intent to test against the data resolution with `assessResolution` (e.g. `vehicles`), when
   *  the arguments name something to be resolved. Return undefined when there is no target. */
  target?: (args: z.infer<S>) => string | undefined
  /** Extra checks before running; any `fail` refuses the run. Pure and fast. */
  staticChecks?: (ctx: StaticCtx, args: z.infer<S>) => ValidationCheck[]
  /** Extra checks on the finished result; any `fail` flags it. */
  dynamicChecks?: (output: ToolOutput, ctx: StaticCtx, args: z.infer<S>) => ValidationCheck[]
  /** The operation works on a result that already exists (the figures or features of an earlier
   *  run) rather than on the AOI alone. In an agent run it reads the request's own results; as a
   *  queued job it needs `result_id`, which the worker loads from the evidence store, so the
   *  toolbox offers a picker of existing results and `POST /api/jobs` refuses the job without one. */
  inputResult?: { description: string }
  run: (ctx: ToolCtx, args: z.infer<S>) => Promise<ToolOutput>
  /** Absent from the registry while this returns false (an env-flagged capability). */
  enabled?: () => boolean
  /** `false`: callable by name but not offered to the model or listed (the offline SSE fixture). */
  modelFacing?: boolean
}

export function defineOperation<S extends z.ZodObject<any>>(op: Operation<S>): Operation<S> {
  return op
}

/** Registry-side view where the argument type is erased. */
export type AnyOperation = Operation<z.ZodObject<any>>

/** Keys the model may use for dates; the generic date checks read these. */
export const DATE_KEYS = ['date', 'date2', 'start', 'end', 'before', 'after'] as const

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
