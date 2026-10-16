/** Plan graph semantics (openEO process-graph style, Q-42 groundwork).
 *
 *  A step may name an earlier step's output as an argument: the value `{ "from_node": 2 }` (or
 *  the text `${node:2}` inside a string) is replaced by that step's `result_id` just before the
 *  step runs. The whole plan is validated statically BEFORE anything executes: every operation
 *  exists, references and dependencies point backwards (so the graph is acyclic by construction),
 *  and each step's own static checks pass. A plan that fails is refused with every reason, so the model can replan.
 */

import type { PlanStep } from '../lib/plan'
import { buildCtx } from './execute'
import type { RunEnv } from './execute'
import { periodMismatch } from './period'
import { resolveOperation } from './registry'
import { runStaticChecks, validateParams } from './validate'

const NODE_TEXT = /\$\{node:(\d+)\}/g

function isFromNode(v: unknown): v is { from_node: number } {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && Number.isInteger((v as any).from_node)
}

/** Every step index a value refers to. */
export function referencedNodes(value: unknown): number[] {
  if (isFromNode(value)) return [value.from_node]
  if (typeof value === 'string') return [...value.matchAll(NODE_TEXT)].map((m) => Number(m[1]))
  if (Array.isArray(value)) return value.flatMap(referencedNodes)
  if (value && typeof value === 'object') return Object.values(value).flatMap(referencedNodes)
  return []
}

/** Replace node references with the `result_id` of the step they name. */
export function resolveFromNode<T>(value: T, idOf: (step: number) => string): T {
  const walk = (v: unknown): unknown => {
    if (isFromNode(v)) return idOf(v.from_node)
    if (typeof v === 'string') return v.replace(NODE_TEXT, (_m, n) => idOf(Number(n)))
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value) as T
}

/** `depends_on` plus every step a `from_node` reference implies. */
export function effectiveDeps(step: PlanStep): number[] {
  return [...new Set([...(step.depends_on ?? []), ...referencedNodes(step.args)])]
}

/** The plan with its implied dependencies written into `depends_on`, ready to schedule. */
export function withImpliedDeps(steps: PlanStep[]): PlanStep[] {
  return steps.map((s) => ({ ...s, depends_on: effectiveDeps(s).length ? effectiveDeps(s) : s.depends_on }))
}

const PLACEHOLDER_ID = 'r_0000000000000000'

export type PlanValidation = { ok: true } | { ok: false; reasons: string[] }

/** Static validation of a whole plan; nothing has run. */
export function validatePlan(steps: PlanStep[], env: RunEnv): PlanValidation {
  const reasons: string[] = []
  const n = steps.length
  const ctx = buildCtx(env)
  steps.forEach((step, i) => {
    const label = `Step ${i} (${step.tool})`
    const resolved = resolveOperation(step.tool, step.args)
    if (!resolved) {
      reasons.push(`${label}: unknown tool. Use only the tools offered.`)
      return
    }
    for (const d of step.depends_on ?? []) {
      if (!Number.isInteger(d) || d < 0 || d >= n) reasons.push(`${label}: depends_on ${d} is not a step of this plan (0..${n - 1}).`)
      else if (d >= i) reasons.push(`${label}: depends_on ${d} points forward; a step can only depend on an earlier one.`)
    }
    for (const r of referencedNodes(step.args)) {
      if (!Number.isInteger(r) || r < 0 || r >= n) reasons.push(`${label}: from_node ${r} is not a step of this plan (0..${n - 1}).`)
      else if (r >= i) reasons.push(`${label}: from_node ${r} points forward; a step can only use an earlier step's result.`)
    }
    const args = resolveFromNode(resolved.args, () => PLACEHOLDER_ID)
    const params = validateParams(resolved.op, args)
    if (!params.ok) {
      reasons.push(`${label}: ${params.check.message}`)
      return
    }
    const failed = runStaticChecks(resolved.op, ctx, params.args, env.now).filter((c) => c.status === 'fail')
    for (const c of failed) reasons.push(`${label}: ${c.message}`)
    // The question states a period: a step reading another one cannot test it.
    if (env.question) {
      const miss = periodMismatch(step.tool, params.args, !!resolved.op.limits?.needsDates, env.question, env.now ?? Date.now())
      if (miss) reasons.push(`${label}: ${miss}`)
    }
  })
  return reasons.length ? { ok: false, reasons } : { ok: true }
}

