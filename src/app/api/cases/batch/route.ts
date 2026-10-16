/**
 * Q-28 — batch input: one claim, N plots.
 *
 *   POST /api/cases/batch { claim_type, params, label?, plots: [{ name?, geometry, params? }] }
 *     → 202 { id, total, status, events }
 *
 * Every plot's parameters are checked against the recipe first (400 naming the plot); then each
 * plot becomes a `verify_claim` job on the job queue, and the worker stores one Case per plot.
 * Follow it with GET /api/cases/batch/:id and the job SSE stream, /api/jobs/:id/events.
 */

import { NextRequest, NextResponse } from 'next/server'

import { getRequestOwner } from '@/lib/auth'
import { BODY_LIMITS, CaseBatchSchema, parseBody } from '@/lib/api-schemas'
import { db } from '@/lib/db'
import { enforceRateLimit } from '@/lib/rate-limit'

import { defaultCatalog } from '../../agent/engine/claims/loader'
import { BatchInputError, enqueueClaimBatch } from '../../agent/engine/claims/batch'
import { UnknownClaimType } from '../../agent/engine/claims/service'
import { getLogger } from '../../agent/lib/logger'

export const dynamic = 'force-dynamic'

const log = getLogger('api/cases/batch')

export async function POST(req: NextRequest) {
  const limited = await enforceRateLimit(req, 'casesBatch')
  if (limited) return limited
  const parsed = await parseBody(req, CaseBatchSchema, { max: BODY_LIMITS.jobs })
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  try {
    const owner = (await getRequestOwner(req)) || null
    const made = await enqueueClaimBatch(db, defaultCatalog(), {
      claimType: body.claim_type, params: body.params, label: body.label, owner,
      plots: body.plots.map((p) => ({ name: p.name, geometry: p.geometry as GeoJSON.Geometry, params: p.params })),
    })
    return NextResponse.json({ ...made, status: `/api/cases/batch/${made.id}`, events: `/api/jobs/${made.id}/events` }, { status: 202 })
  } catch (err) {
    if (err instanceof UnknownClaimType) return NextResponse.json({ error: 'unknown_claim_type', message: err.message }, { status: 400 })
    if (err instanceof BatchInputError) return NextResponse.json({ error: 'invalid_request', issues: err.issues }, { status: 400 })
    log.error({ err: (err as Error)?.message }, 'queue batch failed')
    return NextResponse.json({ error: 'Failed to queue the batch' }, { status: 500 })
  }
}
