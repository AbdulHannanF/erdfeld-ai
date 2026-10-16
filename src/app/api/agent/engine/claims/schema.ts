/** Claim recipes (Q-23): a claim type is a versioned file, not code.
 *
 *  A recipe holds (1) the parameters of the claim, (2) a process graph of registered operations
 *  (the same step shape as `submit_plan`, with `{ "from_node": i }` references, plus
 *  `{ "param": name }` for the claim's own parameters), and (3) a declarative decision rule that
 *  turns the recorded results into Supported / Contradicted / Cannot determine. Every threshold
 *  lives here; changing one means a new recipe version, and the version is stored with each case.
 */

import { z } from 'zod'

export const VERDICTS = ['supported', 'contradicted', 'cannot_determine'] as const
export type Verdict = (typeof VERDICTS)[number]

/** Why a verdict is "Cannot determine". Shown to the user, and counted in the evaluation. */
export const ABSTAIN_KINDS = [
  'fetch_failed', // an upstream could not be read: a failure, never "no data"
  'data_unavailable', // the sources were read and hold nothing usable for this plot and date
  'insufficient_quality', // data exists but too little of it is clear / covering / aligned
  'out_of_scope', // the claim is outside what the sensor or recipe can resolve (plot size, baseline)
  'inconclusive', // clean data, but the signal is neither clearly for nor against
] as const
export type AbstainKind = (typeof ABSTAIN_KINDS)[number]

export const OPERAND_FNS = ['abs', 'sub', 'add', 'mul', 'div', 'min', 'max', 'abs_days', 'add_days', 'day_of_year_gap', 'anniversary_before', 'plot_area_ha'] as const
export type OperandFn = (typeof OPERAND_FNS)[number]

/** A value: a literal, a recorded figure (`{stat: "<node>.<key>"}`), a claim parameter, a named
 *  input, or a function of those. A missing figure is `undefined`, never zero. */
export type Operand =
  | number
  | string
  | boolean
  | { stat: string }
  | { param: string }
  | { ref: string }
  | { fn: OperandFn; args: Operand[] }

export const OperandSchema: z.ZodType<Operand> = z.lazy(() =>
  z.union([
    z.number(),
    z.string(),
    z.boolean(),
    z.object({ stat: z.string().regex(/^\d+\.[A-Za-z0-9_]+$/, 'stat is "<node index>.<figure key>"') }).strict(),
    z.object({ param: z.string().min(1) }).strict(),
    z.object({ ref: z.string().min(1) }).strict(),
    z.object({ fn: z.enum(OPERAND_FNS), args: z.array(OperandSchema) }).strict(),
  ]),
)

export type Cond =
  | { all: Cond[] }
  | { any: Cond[] }
  | { not: Cond }
  | { missing: Operand }
  | { lt: [Operand, Operand] }
  | { lte: [Operand, Operand] }
  | { gt: [Operand, Operand] }
  | { gte: [Operand, Operand] }
  | { eq: [Operand, Operand] }
  | { ne: [Operand, Operand] }

const pair = z.tuple([OperandSchema, OperandSchema])

export const CondSchema: z.ZodType<Cond> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(CondSchema).min(1) }).strict(),
    z.object({ any: z.array(CondSchema).min(1) }).strict(),
    z.object({ not: CondSchema }).strict(),
    z.object({ missing: OperandSchema }).strict(),
    z.object({ lt: pair }).strict(),
    z.object({ lte: pair }).strict(),
    z.object({ gt: pair }).strict(),
    z.object({ gte: pair }).strict(),
    z.object({ eq: pair }).strict(),
    z.object({ ne: pair }).strict(),
  ]),
)

/** confidence = clamp(base + sum(weight * clamp01((value - from) / (to - from))), 0, cap).
 *  A term whose value is missing contributes nothing. It is a stated heuristic, not a
 *  probability: the evaluation (eval/claims) measures how well it is calibrated. */
export const ConfidenceSchema = z.object({
  base: z.number().min(0).max(1),
  terms: z.array(z.object({
    weight: z.number(),
    value: OperandSchema,
    from: z.number(),
    to: z.number(),
  }).strict()).default([]),
  cap: z.number().min(0).max(1).default(0.95),
}).strict()
export type ConfidenceSpec = z.infer<typeof ConfidenceSchema>

export const RuleSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  when: CondSchema,
  verdict: z.enum(VERDICTS),
  /** Required for Cannot determine. */
  kind: z.enum(ABSTAIN_KINDS).optional(),
  /** Template; `{name}` is a named input or a parameter. */
  reason: z.string().min(1),
  /** Supported / Contradicted only; Cannot determine carries no confidence. */
  confidence: ConfidenceSchema.optional(),
}).strict().superRefine((r, ctx) => {
  if (r.verdict === 'cannot_determine' && !r.kind) ctx.addIssue({ code: 'custom', message: `rule ${r.id}: a Cannot determine rule needs a kind` })
  if (r.verdict !== 'cannot_determine' && !r.confidence) ctx.addIssue({ code: 'custom', message: `rule ${r.id}: a ${r.verdict} rule needs a confidence computation` })
  if (r.verdict !== 'cannot_determine' && r.kind) ctx.addIssue({ code: 'custom', message: `rule ${r.id}: only a Cannot determine rule has a kind` })
  if (r.verdict === 'cannot_determine' && r.confidence) ctx.addIssue({ code: 'custom', message: `rule ${r.id}: Cannot determine carries no confidence` })
})
export type Rule = z.infer<typeof RuleSchema>

export const DecisionSchema = z.object({
  /** Plan nodes whose result the decision cannot do without. A required node that failed,
   *  was refused or was flagged is a Cannot determine with the reason of that node. */
  requires: z.array(z.number().int().min(0)).default([]),
  /** Named values the rules and reasons refer to. Evaluated in order; may refer to earlier ones. */
  inputs: z.record(z.string(), OperandSchema).default({}),
  /** First match wins: put abstention conditions before the verdicts. */
  rules: z.array(RuleSchema).min(1),
  /** When no rule matches. */
  otherwise: z.object({
    kind: z.enum(ABSTAIN_KINDS).default('inconclusive'),
    reason: z.string().min(1),
  }).strict(),
}).strict()
export type Decision = z.infer<typeof DecisionSchema>

export const ParamSchema = z.object({
  type: z.enum(['date', 'number', 'integer', 'string']),
  description: z.string().default(''),
  required: z.boolean().default(false),
  /** A literal, or the string "today" for a date param. */
  default: z.union([z.number(), z.string()]).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
}).strict()
export type ParamSpec = z.infer<typeof ParamSchema>

export const StepSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().default(''),
  depends_on: z.array(z.number().int().min(0)).optional(),
  /** Narration of this node's recorded figures: `{key}` is one of its stats. */
  explain: z.string().optional(),
}).strict()
export type RecipeStep = z.infer<typeof StepSchema>

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export const RecipeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  version: z.string().regex(SEMVER, 'version is semver, e.g. 1.0.0'),
  title: z.string().min(1),
  description: z.string().default(''),
  /** Template of the claim as the user states it: `{name}` is a parameter. */
  claim: z.string().min(1),
  /** The plot polygon is always the claim's geometry and the run's AOI; these are the rest. */
  params: z.record(z.string(), ParamSchema).default({}),
  derived: z.record(z.string(), OperandSchema).default({}),
  plan: z.array(StepSchema).min(1),
  decision: DecisionSchema,
  /** What the recipe cannot see, carried into every explanation. */
  limitations: z.array(z.string()).default([]),
}).strict().superRefine((r, ctx) => {
  const n = r.plan.length
  r.plan.forEach((s, i) => {
    for (const d of s.depends_on ?? []) if (d >= i) ctx.addIssue({ code: 'custom', message: `step ${i}: depends_on ${d} must point to an earlier step` })
  })
  for (const idx of r.decision.requires) if (idx >= n) ctx.addIssue({ code: 'custom', message: `decision.requires ${idx} is not a plan step (0..${n - 1})` })
  const ids = r.decision.rules.map((x) => x.id)
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'rule ids must be unique' })
  if (!r.decision.rules.some((x) => x.verdict === 'supported') || !r.decision.rules.some((x) => x.verdict === 'contradicted')) {
    ctx.addIssue({ code: 'custom', message: 'a recipe needs at least one supported and one contradicted rule' })
  }
})
export type Recipe = z.infer<typeof RecipeSchema>

export const recipeKey = (r: Pick<Recipe, 'id' | 'version'>) => `${r.id}@${r.version}`
