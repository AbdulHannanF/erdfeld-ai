/** Re-evaluate a bundle's verdict from the bundle alone: the embedded recipe's decision rule on
 *  the figures the bundle recorded. Pure. A mismatch means the verdict does not follow from the
 *  evidence it is signed with. (Re-fetching the evidence is the ledger re-run's job.) */

import type { BundleBody } from '@/lib/evidence-bundle'

import { stepOrder } from './service'
import { decide, type NodeRecord } from './rule'
import { RecipeSchema } from './schema'

export type Reverification =
  | { ok: true; same: boolean; recomputed: { verdict: string; confidence: number | null; rule: string } }
  | { ok: false; reason: string }

export function reverifyClaim(body: Pick<BundleBody, 'claim' | 'run'>): Reverification {
  const claim = body.claim
  if (!claim) return { ok: false, reason: 'The bundle carries no claim.' }
  const recipe = RecipeSchema.safeParse(claim.recipe_body)
  if (!recipe.success) return { ok: false, reason: 'The embedded recipe is not valid.' }
  const order = stepOrder(recipe.data, claim.params)
  const nodes: NodeRecord[] = body.run.nodes.map((n, k) => ({
    idx: order[k] ?? k, op: n.op, status: n.status as NodeRecord['status'], stats: (n.figures ?? null) as NodeRecord['stats'],
  }))
  const d = decide(recipe.data.decision, { params: claim.params, nodes })
  return {
    ok: true,
    same: d.verdict === claim.verdict && d.confidence === claim.confidence && d.rule === claim.decision.rule,
    recomputed: { verdict: d.verdict, confidence: d.confidence, rule: d.rule },
  }
}
