/** The worker loop: claim, run under a heartbeat, complete or fail. Several slots run side by side;
 *  several processes may run workers on the same database. */

import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'

import type { PrismaClient } from '@prisma/client'

import { getLogger } from '@/app/api/agent/lib/logger'

import { claim, complete, fail, heartbeat, release, type ClaimedJob } from './queue'
import type { JobRunner } from './runner'

const log = getLogger('jobs/worker')

export interface WorkerOptions {
  db: PrismaClient
  run: JobRunner
  /** Jobs run at the same time in this process. */
  concurrency: number
  /** Wait between polls when the queue is empty. */
  pollMs: number
  /** How long a claim lasts without a heartbeat; the heartbeat runs at a third of it. */
  leaseMs: number
}

export interface StopOptions {
  /** Without it, wait for every job in flight however long it takes. With it, wait this long, then
   *  give the jobs still running back to the queue (see `release`). */
  graceMs?: number
}

export interface StopResult {
  /** True when every job finished within the grace period. */
  finished: boolean
  /** Jobs handed back to the queue because they did not finish in time. */
  released: number
}

export interface Worker {
  /** Stop claiming new jobs, then wait for the jobs in flight (see StopOptions). */
  stop(opts?: StopOptions): Promise<StopResult>
  /** Extend the lease of every job this process is running, now. Timers do not run while a
   *  throttled container is paused between requests, so the request handlers that wake the process
   *  call this first: the lease is renewed exactly when there is CPU to run the job. Returns how
   *  many leases were renewed. */
  renewLeases(): Promise<number>
}

/** Longest gap between heartbeats, whatever the lease: a short interval costs one tiny UPDATE and
 *  makes the first beat after a pause come early. */
export const MAX_BEAT_MS = 5_000

export function startWorker(opts: WorkerOptions): Worker {
  const { db, run, concurrency, pollMs, leaseMs } = opts
  // Unique per process start, so a restarted worker is never mistaken for its previous self.
  const id = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`
  let stopped = false
  const wakers = new Set<() => void>()
  // Claims this process holds right now (from the claim until the outcome is recorded). `lost`:
  // a heartbeat found the claim gone (another worker has the job), so its outcome is dropped.
  const inFlight = new Map<string, { job: ClaimedJob; lost: boolean }>()
  const beatMs = Math.max(50, Math.min(Math.floor(leaseMs / 3), MAX_BEAT_MS))

  const sleep = (t: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { wakers.delete(wake); resolve() }, t)
    const wake = () => { clearTimeout(timer); wakers.delete(wake); resolve() }
    wakers.add(wake)
  })

  /** One heartbeat for a claim in flight; a refused one marks it lost. */
  async function beatOnce(entry: { job: ClaimedJob; lost: boolean }): Promise<boolean> {
    try {
      const ok = await heartbeat(db, entry.job, leaseMs)
      if (!ok) entry.lost = true
      return ok
    } catch (err) {
      log.warn({ job: entry.job.id, err: (err as Error).message }, 'heartbeat failed')
      return false
    }
  }

  async function process_(entry: { job: ClaimedJob; lost: boolean }): Promise<void> {
    const job = entry.job
    let lastBeat = Date.now()
    const beat = setInterval(() => {
      const gap = Date.now() - lastBeat
      lastBeat = Date.now()
      // A gap far past the interval means the event loop did not run: a container with throttled CPU
      // was paused, or the process was starved. The lease may already have been taken by another worker.
      if (gap > leaseMs / 2) log.warn({ job: job.id, gapMs: gap, leaseMs }, 'heartbeat ran late: the process was paused (CPU throttling?)')
      void beatOnce(entry)
    }, beatMs)
    try {
      let outcome: Awaited<ReturnType<JobRunner>>
      try {
        outcome = await run(job)
      } catch (err) {
        outcome = { ok: false, error: `The worker threw: ${(err as Error)?.message ?? String(err)}`.slice(0, 500) }
      }
      if (entry.lost) {
        log.warn({ job: job.id, idx: job.idx }, 'lease lost while running; the outcome is dropped')
        return
      }
      if (outcome.ok) {
        if (!(await complete(db, job, outcome))) log.warn({ job: job.id, idx: job.idx }, 'lease lost before completing; the outcome is dropped')
      } else {
        const what = await fail(db, job, outcome)
        if (what == null) log.warn({ job: job.id, idx: job.idx }, 'lease lost before failing; the outcome is dropped')
        else log.warn({ job: job.id, idx: job.idx, attempt: job.attempts, outcome: what, error: outcome.error }, 'job attempt failed')
      }
    } finally {
      clearInterval(beat)
    }
  }

  async function slot(n: number): Promise<void> {
    while (!stopped) {
      let job: ClaimedJob | null = null
      try {
        job = await claim(db, `${id}/${n}`, leaseMs)
      } catch (err) {
        log.warn({ err: (err as Error).message.split('\n').slice(-2).join(' ') }, 'claim failed; the database may be down')
        await sleep(pollMs * 5)
        continue
      }
      if (!job) {
        await sleep(pollMs)
        continue
      }
      if (stopped) {
        // Claimed while the stop was being requested: hand it straight back, do not start it.
        await release(db, job, 'worker shutting down').catch((err) => log.warn({ job: job?.id, err: (err as Error).message }, 'could not release a job'))
        break
      }
      const entry = { job, lost: false }
      inFlight.set(job.id, entry)
      try {
        await process_(entry)
      } catch (err) {
        // Reporting the outcome failed (database down): the lease expires and the job is claimed again.
        log.error({ job: job.id, err: (err as Error).message.split('\n').slice(-2).join(' ') }, 'could not record the job outcome')
      } finally {
        inFlight.delete(job.id)
      }
    }
  }

  const slots = Array.from({ length: concurrency }, (_, n) => slot(n))
  log.info({ worker: id, concurrency, pollMs, leaseMs }, 'job worker started')
  return {
    async renewLeases(): Promise<number> {
      const entries = [...inFlight.values()]
      const renewed = await Promise.all(entries.map(beatOnce))
      return renewed.filter(Boolean).length
    },
    async stop(opts: StopOptions = {}): Promise<StopResult> {
      stopped = true
      for (const wake of [...wakers]) wake()
      const finished = Promise.all(slots).then(() => true)
      if (opts.graceMs === undefined) {
        await finished
        return { finished: true, released: 0 }
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), opts.graceMs) })
      const done = await Promise.race([finished, timeout])
      clearTimeout(timer)
      if (done) return { finished: true, released: 0 }
      let released = 0
      for (const { job } of [...inFlight.values()]) {
        if (await release(db, job, 'worker shutting down before the job finished')) released++
      }
      log.warn({ worker: id, released, graceMs: opts.graceMs }, 'grace period over: running jobs handed back to the queue')
      return { finished: false, released }
    },
  }
}
