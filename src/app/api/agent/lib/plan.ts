/**
 * P4.1 — Plan validation and topological scheduling.
 *
 * The model submits a plan as a structured `submit_plan` tool call
 * (`{ kind: 'plan' | 'replan', steps: [...] }`; schema below). A step's arguments travel as a
 * JSON-encoded string (`args_json`): a free-form nested object has no `properties`, which
 * Gemini's function-declaration schema rejects, and Gemini is a supported provider. These
 * pure helpers:
 *   - validate the call's arguments against a Zod schema and parse each step's `args_json`,
 *     returning the reason on failure so the route can hand it back to the model to retry,
 *   - compute parallel-safe execution batches respecting `depends_on`.
 *
 * No I/O — fully unit-testable.
 */

import { z } from 'zod'

import { toLlmSchema } from '../engine/llm-schema'

export interface PlanStep {
  /** Tool name (must match a registered tool to actually run). */
  tool: string
  /** Arguments object passed to the tool. A value `{ "from_node": <step index> }` (or the text
   *  `${node:<step index>}` inside a string) stands for an earlier step's `result_id`. */
  args: Record<string, unknown>
  /** Short human-readable justification, shown in the plan timeline. */
  reason: string
  /** 0-based indices (within this plan's `steps`) that must finish first. */
  depends_on?: number[]
  /** Hint that steps sharing a group are intended to run together. */
  parallel_group?: number
}

export interface Plan {
  steps: PlanStep[]
}

export type PlanKind = 'plan' | 'replan'

export interface SubmittedPlan {
  kind: PlanKind
  plan: Plan
}

/** Name of the tool the model calls to submit a plan. It is not a runnable plan step. */
export const SUBMIT_PLAN_TOOL = 'submit_plan'

const PlanStepSchema = z.object({
  tool: z.string().min(1).describe('Exact name of a tool.'),
  args_json: z.string().optional().describe(
    'JSON object with the arguments for that tool, e.g. {"product":"imagery"}. Use "{}" when it takes none. ' +
    'To use an earlier step\'s result as an argument, put {"from_node": <step index>} as the value ' +
    '(or ${node:<step index>} inside a string); it is replaced by that step\'s result_id, and that step becomes a dependency.',
  ),
  reason: z.string().optional().describe('Short justification shown in the plan timeline.'),
  depends_on: z.array(z.number().int()).optional().describe('0-based indices of steps in THIS submission that must finish first.'),
  parallel_group: z.number().int().optional().describe('Steps sharing a group run together.'),
})

/** Most steps one `submit_plan` call may carry. */
export const MAX_PLAN_STEPS = 12

const PlanSchema = z.object({
  kind: z.enum(['plan', 'replan']),
  steps: z.array(PlanStepSchema).min(1).max(MAX_PLAN_STEPS, `a plan has at most ${MAX_PLAN_STEPS} steps; run the essential steps first and add the rest as a replan`),
})

/** The `submit_plan` tool definition the model is offered. */
export function submitPlanDefinition() {
  const parameters = toLlmSchema(PlanSchema)
  // `args_json` is how the model passes arguments, so it is part of the contract, not optional.
  parameters.properties.steps.items.required = ['tool', 'args_json', 'reason']
  return {
    type: 'function',
    function: {
      name: SUBMIT_PLAN_TOOL,
      description:
        'Submit an execution plan of 1 to 12 steps. This is the only way to run a tool, even a single one. ' +
        'The system runs the steps for you, in dependency order and in parallel where possible, and ' +
        'returns their results. Call it alone in the turn. `kind: "plan"` is the first plan; ' +
        '`kind: "replan"` adds only the extra steps needed after a plan left an essential gap. ' +
        'Use exact tool names from the other tools; never submit_plan itself.',
      parameters,
    },
  }
}

/** Validate the arguments of a `submit_plan` call and decode each step's `args_json`. */
export function parseSubmitPlan(args: unknown): { ok: true; submitted: SubmittedPlan } | { ok: false; error: string } {
  const parsed = PlanSchema.safeParse(args)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') }
  }
  const steps: PlanStep[] = []
  for (const [i, s] of parsed.data.steps.entries()) {
    const decoded = decodeArgs(s.args_json)
    if (!decoded.ok) return { ok: false, error: `steps.${i}.args_json: ${decoded.error}` }
    steps.push({
      tool: s.tool,
      args: decoded.args,
      reason: s.reason ?? '',
      depends_on: s.depends_on,
      parallel_group: s.parallel_group,
    })
  }
  return { ok: true, submitted: { kind: parsed.data.kind, plan: { steps } } }
}

function decodeArgs(raw: string | undefined): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (raw === undefined || raw.trim() === '') return { ok: true, args: {} }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (e: any) {
    return { ok: false, error: `not valid JSON (${e.message})` }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'must be a JSON object' }
  return { ok: true, args: value as Record<string, unknown> }
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * Group steps into parallel-safe execution batches respecting `depends_on`.
 * Each returned batch is a list of step indices whose dependencies are all
 * satisfied by earlier batches — so a batch can be run with `Promise.all`.
 * Out-of-range dependency indices are ignored (treated as satisfied).
 * Throws `Error('plan dependency cycle detected')` if the graph has a cycle.
 */
export function topoSort(steps: PlanStep[]): number[][] {
  const n = steps.length
  const done = new Array<boolean>(n).fill(false)
  const batches: number[][] = []
  let remaining = n

  while (remaining > 0) {
    const batch: number[] = []
    for (let i = 0; i < n; i++) {
      if (done[i]) continue
      const deps = steps[i].depends_on ?? []
      const ready = deps.every((d) => d < 0 || d >= n || done[d])
      if (ready) batch.push(i)
    }
    if (batch.length === 0) {
      throw new Error('plan dependency cycle detected')
    }
    for (const i of batch) done[i] = true
    batches.push(batch)
    remaining -= batch.length
  }

  return batches
}

/** True if the plan's `depends_on` graph contains a cycle. */
export function hasCycle(steps: PlanStep[]): boolean {
  try {
    topoSort(steps)
    return false
  } catch {
    return true
  }
}

/** Tool names referenced by the plan that are not in the known-tools set. */
export function unknownTools(plan: Plan, validTools: Set<string>): string[] {
  const bad = new Set<string>()
  for (const s of plan.steps) if (!validTools.has(s.tool)) bad.add(s.tool)
  return [...bad]
}
