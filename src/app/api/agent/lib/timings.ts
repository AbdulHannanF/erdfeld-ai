/** Per-stage timing spans for one operation (Q-14/Q-15).
 *
 *  `withTimings(fn)` opens a scope; inside it (including every async continuation, via
 *  AsyncLocalStorage) `span(stage, fn)` adds the wall-clock time of `fn` to that stage and
 *  `mark(stage)` records the time since the scope opened. Outside a scope both are free
 *  pass-throughs, so tools and libraries can call them unconditionally and tests need no setup.
 *
 *  Stages overlap on purpose (statistics run while the scene is still being gated), so they
 *  do not sum to `total`; a stage that ran several times reports the sum of its calls.
 *  Milliseconds, rounded. A stage that never ran is absent, not zero.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/** Stages a tool can report. `llm_plan` / `llm_synthesis` / `total` are added by the route. */
export const TOOL_STAGES = ['stac_search', 'scene_scoring', 'stats', 'render', 'first_layer'] as const
export const STAGES = [...TOOL_STAGES, 'llm_plan', 'llm_synthesis', 'total'] as const
export type Stage = (typeof STAGES)[number]
export type Timings = Partial<Record<Stage, number>>

interface Scope {
  started: number
  ms: Map<Stage, number>
}

const scopeStore = new AsyncLocalStorage<Scope>()

/** Run `fn` with a fresh timing scope; returns its value and the stages it recorded. */
export async function withTimings<T>(fn: () => Promise<T>): Promise<{ value: T; timings: Timings }> {
  const scope: Scope = { started: Date.now(), ms: new Map() }
  const value = await scopeStore.run(scope, fn)
  return { value, timings: snapshot(scope) }
}

function snapshot(scope: Scope): Timings {
  const out: Timings = {}
  for (const [stage, ms] of scope.ms) out[stage] = Math.round(ms)
  return out
}

/** Time `fn` into `stage` (also when it throws). */
export async function span<T>(stage: Stage, fn: () => Promise<T>): Promise<T> {
  const scope = scopeStore.getStore()
  if (!scope) return fn()
  const t0 = Date.now()
  try {
    return await fn()
  } finally {
    scope.ms.set(stage, (scope.ms.get(stage) ?? 0) + (Date.now() - t0))
  }
}

/** Record the time since the scope opened under `stage` (first call wins). */
export function mark(stage: Stage): void {
  const scope = scopeStore.getStore()
  if (scope && !scope.ms.has(stage)) scope.ms.set(stage, Date.now() - scope.started)
}
