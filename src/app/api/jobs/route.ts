/**
 * Q-24 — submit a batch of operations that would exceed the request budget (many polygons, long
 * series). They run on the job queue, through the same executor as an interactive request.
 *
 *   POST /api/jobs   { label?, maxAttempts?, jobs: [{ op, args?, aoi }] }  → 202 { id, total, ... }
 *
 *   GET  /api/jobs?limit=20&cursor=<id>  → { batches: [{ id, label, createdAt, state, progress, ops, kind: 'tool' | 'claims' }], nextCursor }
 *        the caller's batches, newest first (503 database_unavailable without a database)
 *
 * Unknown operations and invalid arguments are refused up front with the index of the offending
 * entry. Follow progress with GET /api/jobs/:id and GET /api/jobs/:id/events (SSE). Batches are
 * owner-scoped exactly like projects.
 */

import { NextRequest, NextResponse } from 'next/server'

import { getRequestOwner } from '@/lib/auth'
import { db } from '@/lib/db'
import { enqueueBatch, type JobItem } from '@/lib/jobs/queue'
import { VERIFY_CLAIM_OP } from '@/lib/jobs/runner'
import { BODY_LIMITS, CreateJobsBodySchema, ListQuerySchema, parseBody, queryObject, validate } from '@/lib/api-schemas'
import { enforceRateLimit } from '@/lib/rate-limit'

import { resolveOperation } from '../agent/engine/registry'
import { validateParams } from '../agent/engine/validate'
import { getLogger } from '../agent/lib/logger'

export const dynamic = 'force-dynamic'

const log = getLogger('api/jobs')

export async function POST(req: NextRequest) {
  const limited = await enforceRateLimit(req, 'jobs')
  if (limited) return limited
  const parsed = await parseBody(req, CreateJobsBodySchema, { max: BODY_LIMITS.jobs })
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  const items: JobItem[] = []
  for (const [i, j] of body.jobs.entries()) {
    const resolved = resolveOperation(j.op, j.args)
    if (!resolved) return NextResponse.json({ error: `jobs.${i}: unknown operation ${j.op}` }, { status: 400 })
    const params = validateParams(resolved.op, resolved.args)
    if (!params.ok) return NextResponse.json({ error: `jobs.${i}: ${params.check.message}` }, { status: 400 })
    // An operation that works on an existing result cannot be queued without saying which: the
    // worker would run it on nothing and have nothing to report.
    if (resolved.op.inputResult && !(typeof params.args.result_id === 'string' && params.args.result_id)) {
      return NextResponse.json({ error: `jobs.${i}: ${j.op} works on an existing result: pass \`result_id\` (${resolved.op.inputResult.description})` }, { status: 400 })
    }
    items.push({ op: j.op, args: j.args, aoi: j.aoi })
  }

  try {
    const owner = (await getRequestOwner(req)) || null
    const id = await enqueueBatch(db, items, { owner, label: body.label, maxAttempts: body.maxAttempts })
    return NextResponse.json({ id, total: items.length, status: `/api/jobs/${id}`, events: `/api/jobs/${id}/events` }, { status: 202 })
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'enqueue failed')
    return NextResponse.json({ error: 'Failed to queue the jobs' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const limited = await enforceRateLimit(req, 'lists')
  if (limited) return limited
  const q = validate(ListQuerySchema, queryObject(req.nextUrl.searchParams))
  if (!q.ok) return q.response
  const { limit, cursor } = q.data

  const owner = await getRequestOwner(req)
  if (!owner) return NextResponse.json({ batches: [], nextCursor: null })

  try {
    const rows = await db.jobBatch.findMany({
      where: { ownerToken: owner },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, label: true, createdAt: true },
    })
    const page = rows.slice(0, limit)
    const counts = await db.job.groupBy({ by: ['batchId', 'op', 'status'], where: { batchId: { in: page.map((b) => b.id) } }, _count: { _all: true } })
    const batches = page.map((b) => {
      const progress = { total: 0, queued: 0, running: 0, done: 0, failed: 0 }
      const ops = new Set<string>()
      for (const c of counts) {
        if (c.batchId !== b.id) continue
        const n = c._count._all
        progress[c.status as 'queued' | 'running' | 'done' | 'failed'] += n
        progress.total += n
        ops.add(c.op)
      }
      return {
        id: b.id, label: b.label, createdAt: b.createdAt.toISOString(),
        state: progress.queued + progress.running === 0 ? 'finished' : 'active',
        progress, ops: [...ops], kind: ops.has(VERIFY_CLAIM_OP) ? 'claims' : 'tool',
      }
    })
    return NextResponse.json({ batches, nextCursor: rows.length > limit ? page[page.length - 1].id : null })
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'list failed')
    return NextResponse.json({ error: 'database_unavailable', message: 'The job queue could not be reached.' }, { status: 503 })
  }
}
