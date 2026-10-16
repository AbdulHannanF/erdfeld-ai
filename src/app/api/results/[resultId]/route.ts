/**
 * Q-47 — one stored result.
 *
 *   GET /api/results/:resultId → the full GeoResult stored under this content-addressed id.
 *
 * Results are shared between users (the id is a content hash), so reading one requires an
 * owned run that contains it: the caller must own a ledger node with this result_id (or that
 * node's run must be an open, ownerless one).
 */

import { NextRequest, NextResponse } from 'next/server'

import { getRequestOwner } from '@/lib/auth'
import { ResultIdParams, validate } from '@/lib/api-schemas'
import { defaultEvidenceStore } from '../../agent/engine/evidence-store'
import { getLogger } from '../../agent/lib/logger'

export const dynamic = 'force-dynamic'

const log = getLogger('api/results')

export async function GET(req: NextRequest, { params }: { params: Promise<{ resultId: string }> }) {
  const p = validate(ResultIdParams, await params)
  if (!p.ok) return p.response
  const { resultId } = p.data
  try {
    const store = await defaultEvidenceStore()
    const stored = await store.getResult(resultId)
    if (!stored) return NextResponse.json({ error: 'Result not found' }, { status: 404 })
    if (!(await store.canReadResult(resultId, await getRequestOwner(req)))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    return NextResponse.json({ result: stored.result, computed_at: new Date(stored.computedAt).toISOString() })
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'get failed')
    return NextResponse.json({ error: 'Failed to load the result' }, { status: 500 })
  }
}
