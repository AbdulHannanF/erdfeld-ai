/**
 * Q-24 — the state of one batch: counts and, per job, its status, attempts, error and the
 * `resultId` of its stored result (fetch it with GET /api/results/:resultId).
 * Owner-scoped like projects: 404 unknown, 403 another owner's.
 */

import { NextRequest, NextResponse } from 'next/server'

import { getRequestOwner } from '@/lib/auth'
import { db } from '@/lib/db'
import { batchProgress, failExhausted } from '@/lib/jobs/queue'
import { renewJobLeases } from '@/lib/jobs/start'
import { canAccessProject } from '@/lib/projects'

import { getLogger } from '../../agent/lib/logger'

export const dynamic = 'force-dynamic'

const log = getLogger('api/jobs/[id]')

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const batch = await db.jobBatch.findUnique({ where: { id } })
    if (!batch) return NextResponse.json({ error: 'Job batch not found' }, { status: 404 })
    if (!canAccessProject(batch.ownerToken, await getRequestOwner(req))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    // A request is when a throttled container has CPU: renew the leases of the jobs this process is
    // running first, then give a job whose worker is gone for good its verdict instead of leaving it "running".
    await renewJobLeases()
    await failExhausted(db, id)
    const [progress, rows] = await Promise.all([
      batchProgress(db, id),
      db.job.findMany({
        where: { batchId: id }, orderBy: { idx: 'asc' },
        select: { idx: true, op: true, status: true, attempts: true, resultId: true, resultStatus: true, error: true, startedAt: true, finishedAt: true, leaseUntil: true },
      }),
    ])
    const now = Date.now()
    // `stalled`: running, but its worker has not renewed the lease: it is being, or will be, retried.
    const jobs = rows.map(({ leaseUntil, ...j }) => ({ ...j, stalled: j.status === 'running' && !!leaseUntil && leaseUntil.getTime() < now }))
    return NextResponse.json({
      id, label: batch.label, createdAt: batch.createdAt.toISOString(),
      state: progress.queued + progress.running === 0 ? 'finished' : 'active',
      progress, jobs,
    })
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'get failed')
    return NextResponse.json({ error: 'Failed to load the job batch' }, { status: 500 })
  }
}
