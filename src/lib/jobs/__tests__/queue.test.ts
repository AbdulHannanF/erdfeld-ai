import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'

import { TEST_DATABASE_URL, createTestDb, describeDb, type TestDb } from '@/test/db'

import { backoffMs, batchProgress, claim, complete, enqueueBatch, fail, failExhausted, heartbeat, lostJobMessage, type ClaimedJob } from '../queue'
import { startWorker } from '../worker'

let t: TestDb
// the DB suites below skip without DATABASE_URL_TEST; the pure tests still run
beforeAll(async () => { if (TEST_DATABASE_URL) t = await createTestDb() }, 60_000)
afterAll(async () => { await t?.drop() })
// every test starts on an empty queue, so a job left by another test is never claimed by accident
beforeEach(async () => { if (t) await t.prisma.jobBatch.deleteMany() })

const AOI = { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] }
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ op: 'noop', args: { i }, aoi: AOI }))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const events = async (batchId: string) => (await t.prisma.jobEvent.findMany({ where: { batchId }, orderBy: { id: 'asc' } })).map((e) => e.type)
const OK = { resultId: 'r', resultStatus: 'ok' }

it('backoff doubles from 2 s and is capped at a minute', () => {
  expect([1, 2, 3, 4].map(backoffMs)).toEqual([2000, 4000, 8000, 16000])
  expect(backoffMs(20)).toBe(60_000)
})

describeDb('queue', () => {
  it('enqueues a batch with a queued job per item and a first event', async () => {
    const id = await enqueueBatch(t.prisma, items(3), { owner: 'alice', label: 'x' })
    expect(await batchProgress(t.prisma, id)).toEqual({ total: 3, queued: 3, running: 0, done: 0, failed: 0 })
    expect(await events(id)).toEqual(['batch_queued'])
    const jobs = await t.prisma.job.findMany({ where: { batchId: id }, orderBy: { idx: 'asc' } })
    expect(jobs.map((j) => j.idx)).toEqual([0, 1, 2])
    expect(jobs[1].args).toEqual({ i: 1 })
    await expect(enqueueBatch(t.prisma, [], { owner: null })).rejects.toThrow()
  })

  it('concurrent claimers never get the same job and none is left behind', async () => {
    const id = await enqueueBatch(t.prisma, items(40), { owner: null })
    const got: ClaimedJob[] = []
    await Promise.all(Array.from({ length: 8 }, async (_, w) => {
      for (;;) {
        const j = await claim(t.prisma, `w${w}`, 60_000)
        if (!j) return
        if (j.batchId === id) got.push(j)
      }
    }))
    expect(got).toHaveLength(40)
    expect(new Set(got.map((j) => j.id)).size).toBe(40)
    expect(got.every((j) => j.attempts === 1)).toBe(true)
  })

  it('a live lease holds the job; an expired one hands it to the next claimer, and the old holder is fenced out', async () => {
    const id = await enqueueBatch(t.prisma, items(1), { owner: null })
    const a = (await claim(t.prisma, 'A', 800))!
    expect(a.batchId).toBe(id)
    expect(await claim(t.prisma, 'B', 800)).toBeNull()
    await sleep(500)
    expect(await heartbeat(t.prisma, a, 800)).toBe(true) // extended to about t=1300
    await sleep(500)
    expect(await claim(t.prisma, 'B', 800)).toBeNull() // t=1000: the original lease would have ended
    await sleep(500) // t=1500: expired
    const b = (await claim(t.prisma, 'B', 60_000))!
    expect(b.id).toBe(a.id)
    expect(b.attempts).toBe(2)
    expect(await heartbeat(t.prisma, a, 800)).toBe(false)
    expect(await complete(t.prisma, a, OK)).toBe(false)
    expect(await fail(t.prisma, a, { error: 'late' })).toBeNull()
    expect(await complete(t.prisma, b, OK)).toBe(true)
    expect(await complete(t.prisma, b, OK)).toBe(false) // completes once
    expect(await events(id)).toEqual(['batch_queued', 'job_done', 'batch_done'])
  })

  it('a failed attempt waits out its backoff, then runs again; the last failure is final', async () => {
    const id = await enqueueBatch(t.prisma, items(1), { owner: null, maxAttempts: 2 })
    const a = (await claim(t.prisma, 'A', 60_000))!
    expect(await fail(t.prisma, a, { error: 'upstream down' })).toBe('retry')
    expect(await claim(t.prisma, 'A', 60_000)).toBeNull() // runAt is 2 s away
    await t.prisma.job.updateMany({ where: { batchId: id }, data: { runAt: new Date(0) } })
    const b = (await claim(t.prisma, 'A', 60_000))!
    expect(b.attempts).toBe(2)
    expect(await fail(t.prisma, b, { error: 'still down', resultId: 'r_f', resultStatus: 'failed' })).toBe('failed')
    expect(await events(id)).toEqual(['batch_queued', 'job_retry', 'job_failed', 'batch_done'])
    const job = await t.prisma.job.findFirst({ where: { batchId: id } })
    expect(job).toMatchObject({ status: 'failed', attempts: 2, error: 'still down', resultId: 'r_f' })
  })

  it('a job whose lease expires on its last attempt fails instead of looping', async () => {
    const id = await enqueueBatch(t.prisma, items(1), { owner: null, maxAttempts: 1 })
    await claim(t.prisma, 'A', 200)
    await sleep(500)
    expect(await claim(t.prisma, 'B', 200)).toBeNull()
    expect(await t.prisma.job.findFirst({ where: { batchId: id } })).toMatchObject({ status: 'failed', attempts: 1 })
    expect(await events(id)).toEqual(['batch_queued', 'job_failed', 'batch_done'])
  })

  it('batch_done is emitted exactly once when the last jobs finish at the same time', async () => {
    const id = await enqueueBatch(t.prisma, items(6), { owner: null })
    const held: ClaimedJob[] = []
    for (let i = 0; i < 6; i++) held.push((await claim(t.prisma, `w${i}`, 60_000))!)
    expect(await Promise.all(held.map((j) => complete(t.prisma, j, OK)))).toEqual(Array(6).fill(true))
    const ev = await events(id)
    expect(ev.filter((e) => e === 'batch_done')).toHaveLength(1)
    expect(ev.at(-1)).toBe('batch_done')
    expect(ev.filter((e) => e === 'job_done')).toHaveLength(6)
  })
})

describeDb('worker', () => {
  it('runs a batch to completion on several slots, retrying a thrown attempt', async () => {
    const id = await enqueueBatch(t.prisma, items(12), { owner: null })
    const seen = new Map<number, number>()
    const w = startWorker({
      db: t.prisma, concurrency: 4, pollMs: 20, leaseMs: 5000,
      run: async (job) => {
        const n = (seen.get(job.idx) ?? 0) + 1
        seen.set(job.idx, n)
        if (job.idx === 5 && n === 1) throw new Error('boom')
        await sleep(10)
        return { ok: true, resultId: `r${job.idx}`, resultStatus: 'ok' }
      },
    })
    // job 5's retry waits 2 s of backoff; pull its runAt forward instead of sleeping
    await sleep(300)
    await t.prisma.job.updateMany({ where: { batchId: id, status: 'queued' }, data: { runAt: new Date(0) } })
    for (let i = 0; i < 100 && (await batchProgress(t.prisma, id)).done < 12; i++) await sleep(50)
    await w.stop()
    expect(await batchProgress(t.prisma, id)).toEqual({ total: 12, queued: 0, running: 0, done: 12, failed: 0 })
    expect(seen.get(5)).toBe(2)
    expect([...seen.entries()].filter(([i]) => i !== 5).every(([, n]) => n === 1)).toBe(true)
    const ev = await events(id)
    expect(ev.filter((e) => e === 'batch_done')).toHaveLength(1)
    expect(ev).toContain('job_retry')
  })
})

describeDb('lost workers', () => {
  it('says what happened to a job whose worker is gone, and settles one batch without anybody claiming', async () => {
    const id = await enqueueBatch(t.prisma, items(1), { owner: null, maxAttempts: 1 })
    const other = await enqueueBatch(t.prisma, items(1), { owner: null, maxAttempts: 1 })
    await claim(t.prisma, 'A', 200)
    await claim(t.prisma, 'A', 200)
    await sleep(500)
    expect(await failExhausted(t.prisma, id)).toBe(1) // only the batch asked about
    const job = await t.prisma.job.findFirst({ where: { batchId: id } })
    expect(job).toMatchObject({ status: 'failed', attempts: 1, error: lostJobMessage(1) })
    expect(job!.error).toMatch(/stopped before it finished.*ran out of memory.*1 time and no attempt is left/)
    expect(await t.prisma.job.findFirst({ where: { batchId: other } })).toMatchObject({ status: 'running' })
    expect(await events(id)).toEqual(['batch_queued', 'job_failed', 'batch_done'])
    const failed = (await t.prisma.jobEvent.findMany({ where: { batchId: id, type: 'job_failed' } }))[0]
    expect((failed.data as any).error).toBe(lostJobMessage(1))
    expect(await failExhausted(t.prisma, id)).toBe(0) // settled once
  })

  it('a job with an attempt left is retried after a lost worker, and the retry completes', async () => {
    const id = await enqueueBatch(t.prisma, items(1), { owner: null, maxAttempts: 2 })
    const a = (await claim(t.prisma, 'A', 200))!
    await sleep(500)
    expect(await failExhausted(t.prisma, id)).toBe(0) // not exhausted: it is claimable again
    const b = (await claim(t.prisma, 'B', 60_000))!
    expect(b).toMatchObject({ id: a.id, attempts: 2 })
    expect(await complete(t.prisma, b, OK)).toBe(true)
  })

  it('a worker paused past its lease gets it back when a request renews it, before anyone else claims', async () => {
    const id = await enqueueBatch(t.prisma, items(1), { owner: null })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const w = startWorker({ db: t.prisma, concurrency: 1, pollMs: 20, leaseMs: 60_000, run: async () => { await gate; return { ok: true, ...OK } } })
    for (let i = 0; i < 100 && (await batchProgress(t.prisma, id)).running === 0; i++) await sleep(10)
    // the container was frozen: the lease ran out with no timer to extend it
    await t.prisma.job.updateMany({ where: { batchId: id }, data: { leaseUntil: new Date(Date.now() - 5000) } })
    expect(await w.renewLeases()).toBe(1)
    const job = await t.prisma.job.findFirst({ where: { batchId: id } })
    expect(job!.leaseUntil!.getTime()).toBeGreaterThan(Date.now())
    expect(await claim(t.prisma, 'other', 60_000)).toBeNull()
    release()
    for (let i = 0; i < 100 && (await batchProgress(t.prisma, id)).done === 0; i++) await sleep(10)
    await w.stop()
    expect(await batchProgress(t.prisma, id)).toMatchObject({ done: 1, failed: 0 })
  })

  it('a renewal that finds the claim gone marks the job lost and its outcome is dropped', async () => {
    const id = await enqueueBatch(t.prisma, items(1), { owner: null, maxAttempts: 2 })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const w = startWorker({ db: t.prisma, concurrency: 1, pollMs: 20, leaseMs: 60_000, run: async () => { await gate; return { ok: true, ...OK } } })
    for (let i = 0; i < 100 && (await batchProgress(t.prisma, id)).running === 0; i++) await sleep(10)
    // another worker took the job while this process was frozen
    await t.prisma.job.updateMany({ where: { batchId: id }, data: { leaseUntil: new Date(Date.now() - 5000) } })
    const stolen = (await claim(t.prisma, 'other', 60_000))!
    expect(stolen.attempts).toBe(2)
    expect(await w.renewLeases()).toBe(0)
    release()
    await w.stop()
    expect(await t.prisma.job.findFirst({ where: { batchId: id } })).toMatchObject({ status: 'running', workerId: 'other', attempts: 2 }) // the late outcome changed nothing
  })
})
