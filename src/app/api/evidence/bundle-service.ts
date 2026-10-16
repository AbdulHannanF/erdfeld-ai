/** Builds and signs the evidence bundle of one ledger run (shared by the bundle and summary routes). */

import { NextRequest, NextResponse } from 'next/server'

import { getRequestOwner } from '@/lib/auth'
import { buildBundleBody, signBundle, type EvidenceBundle } from '@/lib/evidence-bundle'
import { codeSha, getSigningKey } from '@/lib/evidence-key'
import { canAccessProject } from '@/lib/projects'
import { defaultEvidenceStore } from '../agent/engine/evidence-store'
import { defaultCaseStore } from '../agent/engine/claims/case-store'
import { defaultCatalog } from '../agent/engine/claims/loader'
import { fillTemplate } from '../agent/engine/claims/rule'
import { toLedgerExport } from '../agent/engine/ledger'

/** The signed bundle of a run the caller owns, or the error response to return. */
export async function signedBundleFor(req: NextRequest, runId: string): Promise<EvidenceBundle | NextResponse> {
  const store = await defaultEvidenceStore()
  const run = await store.getRun(runId)
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
  if (!canAccessProject(run.ownerToken, await getRequestOwner(req))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const results = await store.getResults(run.nodes.flatMap((n) => (n.resultId ? [n.resultId] : [])))
  const signer = getSigningKey()
  const c = await (await defaultCaseStore()).byRun(runId)
  const recipe = c ? defaultCatalog().get(c.recipe) : undefined
  const claim = c && recipe
    ? {
        case_id: c.id, claim_type: c.claimType, recipe: c.recipe, recipe_body: recipe, claim: fillTemplate(recipe.claim, (n) => c.params[n]),
        params: c.params, geometry: c.geometry, verdict: c.verdict, confidence: c.confidence, decision: c.decision,
      }
    : undefined
  const body = buildBundleBody(toLedgerExport(run, results), signer, { codeSha: codeSha(), baseUrl: req.nextUrl.origin, claim })
  return signBundle(body, signer)
}
