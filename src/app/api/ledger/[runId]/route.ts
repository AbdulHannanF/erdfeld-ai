/**
 * Q-47 — the evidence ledger of one request.
 *
 *   GET /api/ledger/:runId → the executed plan graph (operation@version, arguments, hashes,
 *                            status, dependencies, timings) with each node's provenance items.
 *
 * Owner scoping is the project rule: a run saved under an owner key is readable only by a
 * request resolving to that key (`account:<id>` or the anonymous `x-owner-token`); a run saved
 * without an owner is open, like a legacy project.
 */

import { NextRequest, NextResponse } from 'next/server'

import { getRequestOwner } from '@/lib/auth'
import { RunIdParams, validate } from '@/lib/api-schemas'
import { canAccessProject } from '@/lib/projects'
import { defaultEvidenceStore } from '../../agent/engine/evidence-store'
import { toLedgerExport } from '../../agent/engine/ledger'
import { getLogger } from '../../agent/lib/logger'

export const dynamic = 'force-dynamic'

const log = getLogger('api/ledger')

export async function GET(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const p = validate(RunIdParams, await params)
  if (!p.ok) return p.response
  const { runId } = p.data
  try {
    const store = await defaultEvidenceStore()
    const run = await store.getRun(runId)
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
    if (!canAccessProject(run.ownerToken, await getRequestOwner(req))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const results = await store.getResults(run.nodes.flatMap((n) => (n.resultId ? [n.resultId] : [])))
    return NextResponse.json(toLedgerExport(run, results))
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'get failed')
    return NextResponse.json({ error: 'Failed to load the ledger' }, { status: 500 })
  }
}
