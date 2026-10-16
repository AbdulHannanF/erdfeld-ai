/**
 * Q-27 — claim verification cases.
 *
 *   POST /api/cases { claim_type, params, geometry } → 201 the case view (verdict, evidence timeline,
 *   narration). Runs the recipe through the engine, so the run is in the ledger and the verdict is
 *   evaluated from the recorded results. Synchronous: a case takes seconds to about a minute.
 *   GET  /api/cases → the claim types this server can verify (recipe catalogue).
 */

import { NextRequest, NextResponse } from 'next/server'

import { getRequestOwner } from '@/lib/auth'
import { BODY_LIMITS, CaseCreateSchema, parseBody } from '@/lib/api-schemas'
import { enforceRateLimit } from '@/lib/rate-limit'

import { defaultCaseStore } from '../agent/engine/claims/case-store'
import { defaultCatalog } from '../agent/engine/claims/loader'
import { ClaimInputError, UnknownClaimType, createCase, loadCaseView } from '../agent/engine/claims/service'
import { defaultEvidenceStore } from '../agent/engine/evidence-store'
import { getLogger } from '../agent/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const log = getLogger('api/cases')

export async function POST(req: NextRequest) {
  const limited = await enforceRateLimit(req, 'cases')
  if (limited) return limited
  const parsed = await parseBody(req, CaseCreateSchema, { max: BODY_LIMITS.small * 4 })
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  try {
    const owner = (await getRequestOwner(req)) || null
    const deps = { catalog: defaultCatalog(), evidence: await defaultEvidenceStore(), cases: await defaultCaseStore() }
    const record = await createCase(deps, { claimType: body.claim_type, params: body.params, geometry: body.geometry as GeoJSON.Geometry, owner })
    return NextResponse.json(await loadCaseView(deps, record), { status: 201 })
  } catch (err) {
    if (err instanceof UnknownClaimType) return NextResponse.json({ error: 'unknown_claim_type', message: err.message }, { status: 400 })
    if (err instanceof ClaimInputError) {
      return NextResponse.json({ error: 'invalid_request', issues: err.errors.map((m) => ({ path: 'params', message: m })) }, { status: 400 })
    }
    log.error({ err: (err as Error)?.message }, 'create case failed')
    return NextResponse.json({ error: 'Failed to run the claim' }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({
    claim_types: defaultCatalog().list().map((r) => ({
      ref: `${r.id}@${r.version}`, id: r.id, version: r.version, title: r.title, description: r.description, claim: r.claim, params: r.params,
    })),
  })
}
