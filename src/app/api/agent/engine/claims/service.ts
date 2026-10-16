/** Creating a case (run a recipe, keep the verdict and its ledger run) and describing one (the
 *  view the case page and the API show: claim, verdict, evidence timeline, narration). */

import { toLedgerExport, type LedgerExport } from '../ledger'
import type { EvidenceStore } from '../evidence-store'
import { topoSort } from '../../lib/plan'
import { withImpliedDeps } from '../plan'
import type { CaseRecord, CaseStore } from './case-store'
import { explainCase, type ExplainLine, type ExplainNode } from './explain'
import type { RecipeCatalog } from './loader'
import { instantiatePlan, type ParamValues } from './params'
import { fillTemplate, type Figure } from './rule'
import { runClaim, ClaimInputError } from './run'
import type { Recipe } from './schema'

export class UnknownClaimType extends Error {}
export { ClaimInputError }

export interface CreateCaseInput {
  claimType: string
  params: Record<string, unknown>
  geometry: GeoJSON.Geometry
  owner: string | null
  /** The queue job making the case (batch input): a case it already made is returned as is. */
  jobId?: string
}

export async function createCase(
  deps: { catalog: RecipeCatalog; evidence: EvidenceStore; cases: CaseStore; now?: number },
  input: CreateCaseInput,
): Promise<CaseRecord> {
  if (input.jobId) {
    const made = await deps.cases.byJob(input.jobId)
    if (made) return made
  }
  const [id, version] = input.claimType.split('@')
  const recipe = deps.catalog.get(version ? input.claimType : id)
  if (!recipe) throw new UnknownClaimType(`Unknown claim type "${input.claimType}". Available: ${deps.catalog.list().map((r) => `${r.id}@${r.version}`).join(', ') || 'none'}`)
  const out = await runClaim(recipe, input.params, { geometry: input.geometry, evidence: deps.evidence, owner: input.owner, now: deps.now })
  return deps.cases.create({
    ownerToken: input.owner || null, claimType: recipe.id, recipe: out.recipe, geometry: input.geometry, params: out.params,
    verdict: out.decision.verdict, confidence: out.decision.confidence, runId: out.runId, jobId: input.jobId ?? null,
    decision: { rule: out.decision.rule, reason: out.decision.reason, kind: out.decision.kind, inputs: out.decision.inputs },
  })
}

export interface TimelineEntry {
  step: number
  op: string
  version: string
  status: string
  /** The scene or pass date the node rests on, when it has one. */
  date: string | null
  result_id: string | null
  stats: Record<string, number | string>
  summary: string | null
}

export interface CaseView {
  id: string
  claim_type: string
  claim: string
  recipe: string
  verdict: CaseRecord['verdict']
  confidence: number | null
  decision: CaseRecord['decision']
  params: ParamValues
  geometry: GeoJSON.Geometry
  run_id: string | null
  created_at: string
  timeline: TimelineEntry[]
  explain: ExplainLine[]
  bundle_url: string | null
}

/** Figures of step `step` the decision reads, then those its narration names: what to show first. */
function keyFigures(recipe: Recipe | null, step: number): string[] {
  if (!recipe) return []
  const keys: string[] = []
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o.stat === 'string' && o.stat.startsWith(`${step}.`)) keys.push(o.stat.slice(String(step).length + 1))
      else Object.values(o).forEach(walk)
    }
  }
  walk(recipe.decision)
  const tpl = recipe.plan[step]?.explain ?? ''
  keys.push(...[...tpl.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]))
  return [...new Set(keys)]
}

const DATE_KEYS = ['scene_date', 'date_after', 'after_date']

/** Ledger node k (start order) -> recipe step, replaying the scheduler's batch order. */
export function stepOrder(recipe: Recipe, params: ParamValues): number[] {
  const steps = withImpliedDeps(instantiatePlan(recipe, params))
  return topoSort(steps).flat()
}

export function describeCase(c: CaseRecord, recipe: Recipe | null, ledger: LedgerExport | null, summaries: Map<string, string> = new Map()): CaseView {
  const order = recipe ? stepOrder(recipe, c.params) : []
  const nodes: ExplainNode[] = []
  const timeline: TimelineEntry[] = []
  for (const [k, n] of (ledger?.nodes ?? []).entries()) {
    const step = order[k] ?? k
    const stats = (n.stats ?? null) as Record<string, Figure> | null
    const first = keyFigures(recipe, step)
    const rank = (k: string) => { const i = first.indexOf(k); return i < 0 ? first.length : i }
    const scalars = Object.fromEntries(
      Object.entries(stats ?? {}).filter(([, v]) => typeof v === 'number' || typeof v === 'string').sort(([a], [b]) => rank(a) - rank(b)).slice(0, 14),
    ) as Record<string, number | string>
    const date = n.provenance?.date ?? (DATE_KEYS.map((d) => scalars[d]).find((v) => typeof v === 'string') as string | undefined) ?? null
    const summary = (n.resultId && summaries.get(n.resultId)) || null
    nodes.push({ step, op: n.op, version: n.version, resultId: n.resultId, status: n.status, stats, summary })
    timeline.push({ step, op: n.op, version: n.version, status: n.status, date, result_id: n.resultId, stats: scalars, summary })
  }
  nodes.sort((a, b) => a.step - b.step)
  timeline.sort((a, b) => a.step - b.step)
  return {
    id: c.id, claim_type: c.claimType,
    claim: recipe ? fillTemplate(recipe.claim, (n) => c.params[n]) : c.claimType,
    recipe: c.recipe, verdict: c.verdict, confidence: c.confidence, decision: c.decision, params: c.params,
    geometry: c.geometry, run_id: c.runId, created_at: c.createdAt, timeline,
    explain: explainCase({ recipe, recipeRef: c.recipe, params: c.params, verdict: c.verdict, confidence: c.confidence, decision: c.decision, nodes }),
    bundle_url: c.runId ? `/api/ledger/${c.runId}/bundle` : null,
  }
}

export async function loadCaseView(deps: { catalog: RecipeCatalog; evidence: EvidenceStore }, c: CaseRecord): Promise<CaseView> {
  let ledger: LedgerExport | null = null
  const summaries = new Map<string, string>()
  if (c.runId) {
    const run = await deps.evidence.getRun(c.runId)
    if (run) {
      const results = await deps.evidence.getResults(run.nodes.flatMap((n) => (n.resultId ? [n.resultId] : [])))
      ledger = toLedgerExport(run, results)
      for (const [id, r] of results) summaries.set(id, r.result.summary.split('\n').find((l) => l.trim())?.slice(0, 300) ?? '')
    }
  }
  return describeCase(c, deps.catalog.get(c.recipe) ?? null, ledger, summaries)
}
