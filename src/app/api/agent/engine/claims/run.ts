/** Running a claim: instantiate the recipe's plan for the plot, execute it through the one
 *  executor with the ledger recording every node, then evaluate the decision rule on what was
 *  recorded. The verdict is a pure function of the recorded figures and the recipe version. */

import type { GeoResult } from '@/lib/geo-result'

import type { PlanStep } from '../../lib/plan'
import { topoSort } from '../../lib/plan'
import type { EvidenceStore } from '../evidence-store'
import { runOperation, type RunEnv } from '../execute'
import { LedgerRecorder } from '../ledger'
import { resolveFromNode, validatePlan, withImpliedDeps } from '../plan'
import { instantiatePlan, resolveParams, type ParamValues } from './params'
import { decide, type Decided, type NodeRecord } from './rule'
import type { Recipe } from './schema'
import { recipeKey } from './schema'

export interface ClaimRunOptions {
  geometry: GeoJSON.Geometry
  /** Where results and the ledger run are kept. Absent: nothing is kept (evaluation, tests). */
  evidence?: EvidenceStore
  owner?: string | null
  /** Clock for "today" defaults. */
  now?: number
  emit?: RunEnv['emit']
}

export interface ClaimOutcome {
  recipe: string
  params: ParamValues
  decision: Decided
  runId: string | null
  /** One per recipe step, in recipe order; `idx` is the node's index in the ledger run. */
  nodes: Array<{ step: number; idx: number; op: string; resultId: string | null; status: NodeRecord['status'] }>
  results: GeoResult[]
}

export class ClaimInputError extends Error {
  constructor(public errors: string[]) {
    super(errors.join('; '))
  }
}

/** A node as the decision rule sees it. */
export function toNodeRecord(idx: number, op: string, result: GeoResult | null): NodeRecord {
  if (!result) return { idx, op, status: 'skipped' }
  return {
    idx, op, status: result.status,
    stats: result.stats ?? null,
    summary: result.summary.split('\n').find((l) => l.trim())?.slice(0, 300),
    flags: result.validation.filter((c) => c.status === 'fail').map((c) => c.message),
  }
}

export async function runClaim(recipe: Recipe, rawParams: Record<string, unknown>, opts: ClaimRunOptions): Promise<ClaimOutcome> {
  const now = opts.now ?? Date.now()
  const resolved = resolveParams(recipe, rawParams, opts.geometry, new Date(now).toISOString().slice(0, 10))
  if (!resolved.ok) throw new ClaimInputError(resolved.errors)
  const params = resolved.params
  const steps: PlanStep[] = instantiatePlan(recipe, params)
  const env: RunEnv = { aoi: opts.geometry, evidence: opts.evidence, emit: opts.emit, now }

  // A recipe that names an operation this server does not offer (an env-flagged capability) cannot run.
  const valid = validatePlan(steps, env)
  const unrunnable = !valid.ok && valid.reasons.filter((r) => /unknown tool/.test(r))
  if (unrunnable && unrunnable.length) {
    return {
      recipe: recipeKey(recipe), params, runId: null, nodes: [], results: [],
      decision: {
        verdict: 'cannot_determine', confidence: null, rule: 'recipe_unrunnable', kind: 'out_of_scope', inputs: {},
        reason: `This server does not offer an operation the recipe needs. ${unrunnable.join(' ')}`,
      },
    }
  }

  const ledger = new LedgerRecorder()
  const scheduled = withImpliedDeps(steps)
  const results = new Map<number, GeoResult>()
  const nodeOf = new Map<number, number>()
  const failed = new Set<number>()
  for (const batch of topoSort(scheduled)) {
    await Promise.all(batch.map(async (i) => {
      const step = steps[i]
      const plan = { step: i, refBase: 0, dependsOn: scheduled[i].depends_on }
      if ((scheduled[i].depends_on ?? []).some((d) => failed.has(d))) {
        failed.add(i)
        nodeOf.set(i, ledger.skipped({ name: step.tool }, step.args, plan))
        return
      }
      const args = resolveFromNode(step.args, (n) => results.get(n)?.result_id ?? '')
      const idx = ledger.start({ name: step.tool }, step.args, plan)
      nodeOf.set(i, idx)
      const result = await runOperation(step.tool, args, env)
      ledger.finish(idx, result)
      results.set(i, result)
      if (result.status === 'failed' || result.status === 'refused') failed.add(i)
    }))
  }

  const records = steps.map((s, i) => toNodeRecord(i, s.tool, results.get(i) ?? null))
  const decision = decide(recipe.decision, { params, nodes: records })

  const runId = opts.evidence
    ? (await opts.evidence.saveRun({
        ownerToken: opts.owner || null,
        query: `claim ${recipeKey(recipe)}: ${recipe.claim.replace(/\{(\w+)\}/g, (_m, k) => String(params[k] ?? ''))}`,
        aoi: opts.geometry, focus: null, nodes: ledger.snapshot,
      })) || null
    : null

  return {
    recipe: recipeKey(recipe), params, decision, runId,
    nodes: steps.map((s, i) => {
      const n = ledger.snapshot[nodeOf.get(i)!]
      return { step: i, idx: n.idx, op: n.op, resultId: n.resultId, status: n.status as NodeRecord['status'] }
    }),
    results: steps.flatMap((_s, i) => (results.has(i) ? [results.get(i)!] : [])),
  }
}
