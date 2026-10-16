import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'

import { TEST_DATABASE_URL, createTestDb, describeDb, type TestDb } from '@/test/db'

import { claim, complete, enqueueBatch, release, type ClaimedJob } from '../queue'
import { startWorker } from '../worker'

let t: TestDb
beforeAll(async () => { if (TEST_DATABASE_URL) t = await createTestDb() }, 60_000)
afterAll(async () => { await t?.drop() })
beforeEach(async () => { if (t) await t.prisma.jobBatch.deleteMany() })

const AOI = { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] }
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ op: 'noop', args: { i }, aoi: AOI }))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const OK = { resultId: 'r', resultStatus: 'ok' }

/** A runner whose job waits until the test lets it finish. */
function gated() {
  const started: string[] = []
  let open!: () => void
  const gate = new Promise<void>((r) => { open = r })
  const run = async (job: ClaimedJob) => {
    started.push(job.id)
    await gate
    return { ok: true as const, ...OK }
  }
  return { run, started, open }
}

describeDb('drain on shutdown', () => {
  it('a job that finishes within the grace period is completed, and nothing is released', async () => {
    const id = await enqueueBatch(t.prisma, items(1), { owner: null })
    const w = startWorker({
      db: t.prisma, concurrency: 1, pollMs: 20, leaseMs: 60_000,
      run: async () => { await sleep(100); return { ok: true, ...OK } },
    })
    await sleep(30) // the job is running now
    expect(await w.stop({ graceMs: 3000 })).toEqual({ finished: true, released: 0 })
    const job = await t.prisma.job.findFirst({ where: { batchId: id } })
    expect(job).toMatchObject({ status: 'done', resultId: 'r' })
  })

  it('a job still running after the grace period is released: queued, unleased, and claimable at once', async () => {
    const id = await enqueueBatch(t.prisma, items(1), { owner: null })
    const g = gated()
    const w = startWorker({ db: t.prisma, concurrency: 1, pollMs: 20, leaseMs: 60_000, run: g.run })
    for (let i = 0; i < 100 && g.started.length === 0; i++) await sleep(10)
    expect(g.started).toHaveLength(1)

    const result = await w.stop({ graceMs: 150 })
    expect(result).toEqual({ finished: false, released: 1 })

    const job = await t.prisma.job.findFirst({ where: { batchId: id } })
    expect(job).toMatchObject({ status: 'queued', workerId: null, leaseUntil: null, attempts: 0 })
    expect(job!.runAt.getTime()).toBeLessThanOrEqual(Date.now())
    const events = (await t.prisma.jobEvent.findMany({ where: { batchId: id }, orderBy: { id: 'asc' } })).map((e) => e.type)
    expect(events).toEqual(['batch_queued', 'job_retry'])

    // Another worker takes it straight away, without waiting for a lease to expire.
    const next = await claim(t.prisma, 'other-worker', 60_000)
    expect(next).toMatchObject({ id: job!.id, attempts: 1 })

    // The old holder is fenced out: its outcome is dropped, the new claim is untouched.
    g.open()
    await sleep(100)
    expect(await complete(t.prisma, next!, OK)).toBe(true)
    expect(await t.prisma.job.findFirst({ where: { batchId: id } })).toMatchObject({ status: 'done', workerId: 'other-worker' })
  })

  it('a job that is never left leased: after a drain no job of the worker is still running under its lease', async () => {
    const id = await enqueueBatch(t.prisma, items(4), { owner: null })
    const g = gated()
    const w = startWorker({ db: t.prisma, concurrency: 2, pollMs: 20, leaseMs: 60_000, run: g.run })
    for (let i = 0; i < 100 && g.started.length < 2; i++) await sleep(10)
    expect(g.started).toHaveLength(2)

    const result = await w.stop({ graceMs: 100 })
    expect(result.finished).toBe(false)
    expect(result.released).toBe(2)

    const jobs = await t.prisma.job.findMany({ where: { batchId: id } })
    expect(jobs.filter((j) => j.status === 'running')).toHaveLength(0)
    expect(jobs.filter((j) => j.leaseUntil !== null)).toHaveLength(0)
    expect(jobs.filter((j) => j.status === 'queued')).toHaveLength(4)
    g.open()
    await sleep(100)
  })

  it('release is fenced: it does nothing to a job whose claim is gone', async () => {
    const id = await enqueueBatch(t.prisma, items(1), { owner: null })
    const a = (await claim(t.prisma, 'A', 60_000))!
    expect(await complete(t.prisma, a, OK)).toBe(true)
    expect(await release(t.prisma, a, 'too late')).toBe(false)
    expect(await t.prisma.job.findFirst({ where: { batchId: id } })).toMatchObject({ status: 'done', error: null })
  })
})
