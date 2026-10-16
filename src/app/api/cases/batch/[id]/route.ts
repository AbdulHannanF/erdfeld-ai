/**
 * Q-28 — the state of one claim batch: progress counts and a row per plot (status, and once the
 * case exists its verdict, confidence, abstention kind and case id). Owner-scoped like cases:
 * 404 unknown, 403 another owner's. Live progress is the job SSE stream, /api/jobs/:id/events.
 */

import { NextRequest, NextResponse } from 'next/server'

import { getLogger } from '../../../agent/lib/logger'
import { openBatch } from './access'

export const dynamic = 'force-dynamic'

const log = getLogger('api/cases/batch/[id]')

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const view = await openBatch(req, params)
    return view instanceof Response ? view : NextResponse.json(view)
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'get batch failed')
    return NextResponse.json({ error: 'Failed to load the batch' }, { status: 500 })
  }
}
