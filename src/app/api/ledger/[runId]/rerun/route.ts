/**
 * Q-47 — re-execute a ledger.
 *
 *   POST /api/ledger/:runId/rerun → runs every node again, bypassing the result cache, and reports
 *                                   per node whether its result_id reproduced or changed and why.
 *
 * Same owner scoping as the ledger itself. Nothing is changed in the original run.
 */

import { NextRequest, NextResponse } from 'next/server'

import { getRequestOwner } from '@/lib/auth'
import { BODY_LIMITS, RerunBodySchema, RunIdParams, parseBody, validate } from '@/lib/api-schemas'
import { canAccessProject } from '@/lib/projects'
import { defaultEvidenceStore } from '../../../agent/engine/evidence-store'
import { rerunLedger } from '../../../agent/engine/rerun'
import { getLogger } from '../../../agent/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const log = getLogger('api/ledger/rerun')

export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const p = validate(RunIdParams, await params)
  if (!p.ok) return p.response
  const { runId } = p.data
  const body = await parseBody(req, RerunBodySchema, { max: BODY_LIMITS.small, optional: true })
  if (!body.ok) return body.response
  try {
    const store = await defaultEvidenceStore()
    const run = await store.getRun(runId)
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
    if (!canAccessProject(run.ownerToken, await getRequestOwner(req))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    return NextResponse.json(await rerunLedger(run, store))
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'rerun failed')
    return NextResponse.json({ error: 'Failed to re-run the ledger' }, { status: 500 })
  }
}
