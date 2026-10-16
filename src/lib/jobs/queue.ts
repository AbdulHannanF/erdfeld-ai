/** The job queue (Q-24): every state change of a job, in SQL, on PostgreSQL.
 *
 *  Lifecycle: `queued` -> (claim) `running` -> `done`, or back to `queued` with a backoff after a
 *  failed attempt, or `failed` once `maxAttempts` claims are used up.
 *
 *  - **Claim** is one `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)`, so any
 *    number of workers (processes, replicas) take distinct jobs without blocking each other.
 *  - **Lease**: a claim holds the job until `leaseUntil`. The holder extends it with `heartbeat`;
 *    a running job whose lease has passed was abandoned (crash, kill) and is claimed again.
 *    Every claim counts as an attempt, so a job that keeps killing its worker ends up `failed`
 *    instead of looping for ever.
 *  - **Fencing**: heartbeat, complete and fail only act on the claim they were given
 *    (`workerId` + `attempts`). A worker that lost its lease finds out (they return false) and
 *    must drop its outcome; the job belongs to whoever claimed it since.
 *  - Time is the database's (`clock_timestamp()` in UTC, the zone Prisma stores `DateTime` in), so
 *    hosts with skewed clocks agree about leases.
 *  - **Events**: each terminal or retry transition appends a `JobEvent` in the same transaction,
 *    with the batch row locked first. That serialises a batch's events, so their ids become
 *    visible in order and an SSE cursor never skips one, and it makes the one `batch_done` event
 *    exactly-once.
 *
 *  Guarantee: a job is *completed* once (the fenced UPDATE can succeed once). Execution is
 *  at-least-once: a worker killed after computing but before completing is re-run, and the
 *  executor stores results by content hash, so the re-run overwrites the same `Result` row.
 */

import { Prisma, type PrismaClient } from '@prisma/client'

export type JobStatus = 'queued' | 'running' | 'done' | 'failed'

export interface JobItem {
  op: string
  args: Record<string, unknown>
  /** GeoJSON geometry. */
  aoi: unknown
}

/** A job as a worker holds it after a claim. */
export interface ClaimedJob {
  id: string
  batchId: string
  idx: number
  op: string
  args: Record<string, unknown>
  aoi: unknown
  /** Including this claim. */
  attempts: number
  maxAttempts: number
  workerId: string
  /** The batch's owner (null: open), for jobs that store things on the owner's behalf. */
  owner: string | null
}

export interface Progress {
  total: number
  queued: number
  running: number
  done: number
  failed: number
}

export const DEFAULT_MAX_ATTEMPTS = 3

const NOW = Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC')`
const ms = (n: number) => Prisma.sql`(${Math.max(0, Math.round(n))}::int * interval '1 millisecond')`

/** Delay before attempt `attempts + 1`: 2 s, 4 s, 8 s ... capped at one minute. */
export function backoffMs(attempts: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempts - 1))
}

type Tx = Prisma.TransactionClient

async function progressOf(tx: Tx | PrismaClient, batchId: string): Promise<Progress> {
  const rows = await tx.$queryRaw<Array<{ status: JobStatus; n: number }>>`
    SELECT status, count(*)::int AS n FROM "Job" WHERE "batchId" = ${batchId} GROUP BY status`
  const p: Progress = { total: 0, queued: 0, running: 0, done: 0, failed: 0 }
  for (const r of rows) {
    p[r.status] = r.n
    p.total += r.n
  }
  return p
}

/** Run `fn` in a transaction that holds the batch row (see the module comment on events). */
async function withBatchLock<T>(db: PrismaClient, batchId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "JobBatch" WHERE id = ${batchId} FOR UPDATE`
    return fn(tx)
  })
}

async function addEvent(tx: Tx, batchId: string, type: string, data: Record<string, unknown>): Promise<void> {
  await tx.jobEvent.create({ data: { batchId, type, data: data as Prisma.InputJsonObject } })
}

/** After a job reached `done` or `failed`: record progress, and `batch_done` when it was the last. */
async function recordTerminal(tx: Tx, batchId: string, type: 'job_done' | 'job_failed', data: Record<string, unknown>): Promise<void> {
  const progress = await progressOf(tx, batchId)
  await addEvent(tx, batchId, type, { ...data, progress })
  if (progress.queued === 0 && progress.running === 0) await addEvent(tx, batchId, 'batch_done', { progress })
}

export interface EnqueueOptions {
  owner: string | null
  label?: string | null
  maxAttempts?: number
}

/** Create a batch with one job per item. Returns the batch id. */
export async function enqueueBatch(db: PrismaClient, items: JobItem[], opts: EnqueueOptions): Promise<string> {
  if (items.length === 0) throw new Error('A batch needs at least one job')
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  return db.$transaction(async (tx) => {
    const batch = await tx.jobBatch.create({ data: { ownerToken: opts.owner, label: opts.label ?? null } })
    await tx.job.createMany({
      data: items.map((it, idx) => ({
        batchId: batch.id, idx, op: it.op, args: it.args as Prisma.InputJsonObject, aoi: it.aoi as Prisma.InputJsonValue, maxAttempts,
      })),
    })
    await addEvent(tx, batch.id, 'batch_queued', { progress: { total: items.length, queued: items.length, running: 0, done: 0, failed: 0 } })
    return batch.id
  })
}

/** What a job that lost its worker for good says, in words a person can act on. */
export function lostJobMessage(attempts: number): string {
  return `The worker running this job stopped before it finished (the server instance was restarted, stopped or ran out of memory); ` +
    `it was tried ${attempts} time${attempts === 1 ? '' : 's'} and no attempt is left. Run it again, over a smaller area if it is a large one.`
}

/** Jobs that were running when their lease ran out with no attempts left: nobody will run them
 *  again, so they fail here (a worker that was killed on every try would otherwise loop).
 *  `batchId` limits the sweep to one batch: a client polling its batch gets the verdict without
 *  waiting for some worker's next claim. */
export async function failExhausted(db: PrismaClient, batchId?: string): Promise<number> {
  const rows = await db.$queryRaw<Array<{ id: string; batchId: string; attempts: number }>>`
    SELECT id, "batchId", attempts FROM "Job"
    WHERE status = 'running' AND "leaseUntil" < ${NOW} AND attempts >= "maxAttempts"
      AND (${batchId ?? null}::text IS NULL OR "batchId" = ${batchId ?? null})`
  let n = 0
  for (const r of rows) {
    const error = lostJobMessage(r.attempts)
    await withBatchLock(db, r.batchId, async (tx) => {
      const done = await tx.$queryRaw<Array<{ idx: number }>>`
        UPDATE "Job" SET status = 'failed', "finishedAt" = ${NOW}, "workerId" = NULL, "leaseUntil" = NULL,
               error = ${error}
        WHERE id = ${r.id} AND status = 'running' AND "leaseUntil" < ${NOW} AND attempts >= "maxAttempts"
        RETURNING idx`
      if (done.length === 1) {
        n++
        await recordTerminal(tx, r.batchId, 'job_failed', { jobId: r.id, idx: done[0].idx, error })
      }
    })
  }
  return n
}

/** Take the next runnable job, or null. */
export async function claim(db: PrismaClient, workerId: string, leaseMs: number): Promise<ClaimedJob | null> {
  await failExhausted(db)
  const rows = await db.$queryRaw<ClaimedJob[]>`
    UPDATE "Job" SET status = 'running', "workerId" = ${workerId}, attempts = attempts + 1,
           "leaseUntil" = ${NOW} + ${ms(leaseMs)}, "startedAt" = COALESCE("startedAt", ${NOW})
    WHERE id = (
      SELECT id FROM "Job"
      WHERE (status = 'queued' AND "runAt" <= ${NOW})
         OR (status = 'running' AND "leaseUntil" < ${NOW} AND attempts < "maxAttempts")
      ORDER BY "runAt", "createdAt", idx
      FOR UPDATE SKIP LOCKED
      LIMIT 1)
    RETURNING id, "batchId", idx, op, args, aoi, attempts, "maxAttempts", "workerId",
      (SELECT "ownerToken" FROM "JobBatch" WHERE id = "Job"."batchId") AS owner`
  return rows[0] ?? null
}

/** Extend the lease. False: this claim is gone (another worker has the job, or it finished). */
export async function heartbeat(db: PrismaClient, job: ClaimedJob, leaseMs: number): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE "Job" SET "leaseUntil" = ${NOW} + ${ms(leaseMs)}
    WHERE id = ${job.id} AND status = 'running' AND "workerId" = ${job.workerId} AND attempts = ${job.attempts}
    RETURNING id`
  return rows.length === 1
}

export interface Outcome {
  resultId: string
  resultStatus: string
}

/** Mark the claimed job done. False: the claim was lost; nothing changed and the outcome is dropped. */
export async function complete(db: PrismaClient, job: ClaimedJob, outcome: Outcome): Promise<boolean> {
  return withBatchLock(db, job.batchId, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "Job" SET status = 'done', "finishedAt" = ${NOW}, "leaseUntil" = NULL, error = NULL,
             "resultId" = ${outcome.resultId}, "resultStatus" = ${outcome.resultStatus}
      WHERE id = ${job.id} AND status = 'running' AND "workerId" = ${job.workerId} AND attempts = ${job.attempts}
      RETURNING id`
    if (rows.length !== 1) return false
    await recordTerminal(tx, job.batchId, 'job_done', { jobId: job.id, idx: job.idx, resultId: outcome.resultId, resultStatus: outcome.resultStatus })
    return true
  })
}

export interface Failure {
  error: string
  /** The stored result of the failed attempt, when there is one (an upstream failure the executor recorded). */
  resultId?: string
  resultStatus?: string
  /** False: another attempt cannot change the outcome (invalid input), so the job fails now. Default true. */
  retryable?: boolean
}

/** Give a claimed job back because this worker is shutting down: it becomes claimable at once
 *  (`runAt` = now, no lease), and the claim does not count as an attempt, since nothing went wrong
 *  with the job. Fenced like complete and fail. False: the claim is already gone, nothing changed. */
export async function release(db: PrismaClient, job: ClaimedJob, reason: string): Promise<boolean> {
  return withBatchLock(db, job.batchId, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "Job" SET status = 'queued', "workerId" = NULL, "leaseUntil" = NULL, attempts = attempts - 1,
             "runAt" = ${NOW}, error = ${reason}
      WHERE id = ${job.id} AND status = 'running' AND "workerId" = ${job.workerId} AND attempts = ${job.attempts}
      RETURNING id`
    if (rows.length !== 1) return false
    await addEvent(tx, job.batchId, 'job_retry', {
      jobId: job.id, idx: job.idx, error: reason, attempt: job.attempts, retryInMs: 0, progress: await progressOf(tx, job.batchId),
    })
    return true
  })
}

/** The attempt failed. With attempts left the job returns to `queued` after a backoff; otherwise it
 *  is `failed`. Returns what happened, or null when the claim was lost. */
export async function fail(db: PrismaClient, job: ClaimedJob, failure: Failure): Promise<'retry' | 'failed' | null> {
  return withBatchLock(db, job.batchId, async (tx) => {
    const retry = job.attempts < job.maxAttempts && failure.retryable !== false
    const delay = backoffMs(job.attempts)
    const rows = retry
      ? await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE "Job" SET status = 'queued', "workerId" = NULL, "leaseUntil" = NULL, error = ${failure.error},
                 "runAt" = ${NOW} + ${ms(delay)}
          WHERE id = ${job.id} AND status = 'running' AND "workerId" = ${job.workerId} AND attempts = ${job.attempts}
          RETURNING id`
      : await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE "Job" SET status = 'failed', "finishedAt" = ${NOW}, "workerId" = NULL, "leaseUntil" = NULL,
                 error = ${failure.error}, "resultId" = ${failure.resultId ?? null}, "resultStatus" = ${failure.resultStatus ?? null}
          WHERE id = ${job.id} AND status = 'running' AND "workerId" = ${job.workerId} AND attempts = ${job.attempts}
          RETURNING id`
    if (rows.length !== 1) return null
    const base = { jobId: job.id, idx: job.idx, error: failure.error, attempt: job.attempts }
    if (retry) {
      await addEvent(tx, job.batchId, 'job_retry', { ...base, retryInMs: delay, progress: await progressOf(tx, job.batchId) })
      return 'retry'
    }
    await recordTerminal(tx, job.batchId, 'job_failed', { ...base, resultId: failure.resultId ?? null })
    return 'failed'
  })
}

export { progressOf as batchProgress }
