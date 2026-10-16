import JSZip from 'jszip'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GeoResult } from '@/lib/geo-result'
import { summarize, type BatchRow } from '@/lib/case-batch'
import { enqueueBatch } from '@/lib/jobs/queue'
import { VERIFY_CLAIM_OP, createJobRunner } from '@/lib/jobs/runner'
import { startWorker } from '@/lib/jobs/worker'
import { TEST_DATABASE_URL, createTestDb, describeDb, type TestDb } from '@/test/db'
import { inputsHash, resultId } from '../../hash'
import { defaultEvidenceStore } from '../../evidence-store'
import { batchFeatures } from '../batch'
import { defaultCaseStore } from '../case-store'
import { defaultCatalog } from '../loader'

// The Sentinel-1 flood read is canned by where the plot is: this test is about batches, not the network.
const h = vi.hoisted(() => ({ throwOnce: new Set<number>(), calls: 0 }))
vi.mock('../../execute', async (orig) => ({
  ...(await orig<typeof import('../../execute')>()),
  runOperation: async (name: string, args: Record<string, any>, env: any): Promise<GeoResult> => {
    h.calls++
    const lon = env.aoi.coordinates[0][0][0] as number
    if (h.throwOnce.delete(Math.round(lon * 100))) throw new Error('connection reset')
    const flooded = lon < 74.5
    const unreadable = lon > 74.6
    const inputs = inputsHash({ op: name, version: '1.0.0', args, aoi: env.aoi, focus: undefined })
    const result: GeoResult = {
      schema: 'geo-result/1', result_id: resultId(inputs, [`S1_${args.after}`]), op: { name, version: '1.0.0' }, status: unreadable ? 'failed' : 'ok',
      summary: unreadable ? '**map_flood failed:** timeout. This is a failure, not an absence of data.' : 'ok', layers: [],
      ...(unreadable ? {} : { stats: { flood_pct_of_observed: flooded ? 81 : 1, valid_pixel_pct: 99, after_date: args.after, before_date: args.before, before_water_pct: 2, after_water_pct: flooded ? 80 : 2, orbit_match: 'orbit' } }),
      provenance: { sources: ['Sentinel-1 RTC'], items: [`S1_${args.after}`], method: 'm', inputs_hash: inputs }, validation: [],
    }
    await env.evidence?.put(result, { cacheKey: null, expiresAt: null, now: 0 })
    return result
  },
}))

let t: TestDb
let routes: {
  batch: typeof import('../../../../cases/batch/route')
  one: typeof import('../../../../cases/batch/[id]/route')
  exp: typeof import('../../../../cases/batch/[id]/export/route')
  zip: typeof import('../../../../cases/batch/[id]/bundles/route')
}
let db: typeof import('@/lib/db').db

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return // the DB suites below skip
  t = await createTestDb()
  process.env.DATABASE_URL = t.url
  routes = {
    batch: await import('../../../../cases/batch/route'), one: await import('../../../../cases/batch/[id]/route'),
    exp: await import('../../../../cases/batch/[id]/export/route'), zip: await import('../../../../cases/batch/[id]/bundles/route'),
  }
  db = (await import('@/lib/db')).db
}, 150_000)
afterAll(async () => {
  await db?.$disconnect()
  await t?.drop()
})
beforeEach(() => {
  process.env.RATE_LIMIT_DISABLED = '1'
  h.throwOnce.clear()
})

/** A 300 m square at (lon, 31.0). */
const plot = (lon: number) => ({ type: 'Polygon', coordinates: [[[lon, 31.0], [lon + 0.003, 31.0], [lon + 0.003, 30.997], [lon, 30.997], [lon, 31.0]]] })
const req = (path: string, owner?: string, init: { method?: string; body?: string } = {}) => new NextRequest(`http://x${path}`, { ...init, headers: owner ? { 'x-owner-token': owner } : {} })
const post = (body: unknown, owner?: string) => routes.batch.POST(req('/api/cases/batch', owner, { method: 'POST', body: JSON.stringify(body) }))
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const view = async (id: string, owner = 'alice') => (await routes.one.GET(req(`/api/cases/batch/${id}`, owner), ctx(id))).json()
const valid = { claim_type: 'flooded_on', params: { date: '2025-09-04' }, plots: [{ name: 'A', geometry: plot(74.45) }] }

async function runQueue(until: () => Promise<boolean>) {
  const w = startWorker({
    db: db as any, concurrency: 2, pollMs: 20, leaseMs: 5000,
    run: createJobRunner({ catalog: defaultCatalog(), evidence: await defaultEvidenceStore(), cases: await defaultCaseStore() }),
  })
  try {
    const stop = Date.now() + 100_000
    while (!(await until())) {
      if (Date.now() > stop) throw new Error('the batch did not finish in time')
      await new Promise((r) => setTimeout(r, 50))
    }
  } finally {
    await w.stop()
  }
}
const finished = (id: string) => async () => (await view(id)).state === 'finished'

describeDb('POST /api/cases/batch: validation', () => {
  it.each([
    ['no plots', { ...valid, plots: [] }],
    ['a Point as a plot', { ...valid, plots: [{ geometry: { type: 'Point', coordinates: [74.4, 31] } }] }],
    ['a MultiPolygon as a plot', { ...valid, plots: [{ geometry: { type: 'MultiPolygon', coordinates: [plot(74.4).coordinates, plot(74.5).coordinates] } }] }],
    ['a malformed claim type', { ...valid, claim_type: 'Not A Type' }],
    ['an unknown field', { ...valid, owner: 'bob' }],
    ['an unknown plot field', { ...valid, plots: [{ geometry: plot(74.4), owner: 'bob' }] }],
  ])('400 invalid_request for %s', async (_n, body) => {
    const r = await post(body)
    expect(r.status).toBe(400)
    expect((await r.json()).error).toBe('invalid_request')
  })

  it('caps a batch at 500 plots', async () => {
    const many = (n: number) => ({ ...valid, plots: Array.from({ length: n }, (_, i) => ({ name: `p${i}`, geometry: plot(74.4) })) })
    const over = await post(many(501))
    expect(over.status).toBe(400)
    expect(JSON.stringify(await over.json())).toMatch(/500/)
    expect((await post(many(500))).status).toBe(202)
  })

  it('400 unknown_claim_type, queuing nothing', async () => {
    const before = await db.jobBatch.count()
    const r = await post({ ...valid, claim_type: 'crop_present' })
    expect(r.status).toBe(400)
    expect((await r.json()).error).toBe('unknown_claim_type')
    expect(await db.jobBatch.count()).toBe(before)
  })

  it('names the plot whose parameters are wrong and queues nothing', async () => {
    const before = await db.jobBatch.count()
    const r = await post({ ...valid, params: {}, plots: [{ name: 'A', geometry: plot(74.4), params: { date: '2025-09-04' } }, { name: 'B', geometry: plot(74.5) }, { name: 'C', geometry: plot(74.5), params: { date: '2025-02-30' } }] })
    expect(r.status).toBe(400)
    const { issues } = await r.json()
    expect(issues).toEqual([{ path: 'plots.1', message: 'date is required' }, { path: 'plots.2', message: 'date must be a calendar date, YYYY-MM-DD' }])
    expect(await db.jobBatch.count()).toBe(before)
  })

  it('413 over the body cap and 429 over the rate limit', async () => {
    expect((await post({ ...valid, label: 'x'.repeat(9 * 1024 * 1024) })).status).toBe(413)
    delete process.env.RATE_LIMIT_DISABLED
    process.env.RATE_LIMIT_CASES_BATCH_MAX = '1'
    try {
      expect((await post(valid, 'rate-limit-test')).status).toBe(202)
      const limited = await post(valid, 'rate-limit-test')
      expect(limited.status).toBe(429)
      expect(limited.headers.get('Retry-After')).toBeTruthy()
    } finally {
      delete process.env.RATE_LIMIT_CASES_BATCH_MAX
    }
  })
})

describeDb('claim batch: the queue runs the recipe per plot', () => {
  let id: string

  it('queues, runs every plot through the claim evaluator and stores one owned case each', async () => {
    const res = await post({
      claim_type: 'flooded_on', params: { date: '2025-09-04' }, label: 'Sutlej',
      plots: [
        { name: 'in flood', geometry: plot(74.45) },
        { name: 'dry field', geometry: plot(74.55) },
        { name: 'unreadable', geometry: plot(74.65) },
        { name: 'own date', geometry: plot(74.46), params: { date: '2025-09-02' } },
      ],
    }, 'alice')
    expect(res.status).toBe(202)
    const q = await res.json()
    expect(q).toMatchObject({ total: 4, recipe: 'flooded_on@1.0.0', events: `/api/jobs/${q.id}/events` })
    id = q.id

    expect(await view(id)).toMatchObject({ state: 'active', progress: { total: 4, queued: 4 } })
    await runQueue(finished(id))

    const v = await view(id)
    expect(v).toMatchObject({ label: 'Sutlej', claim_type: 'flooded_on@1.0.0', progress: { total: 4, done: 4, failed: 0 } })
    const byName = Object.fromEntries(v.rows.map((r: BatchRow) => [r.name, r]))
    expect(byName['in flood']).toMatchObject({ status: 'done', verdict: 'supported', recipe: 'flooded_on@1.0.0' })
    expect(byName['in flood'].confidence).toBeGreaterThan(0.6)
    expect(byName['dry field']).toMatchObject({ verdict: 'contradicted' })
    // an upstream that could not be read is Cannot determine (fetch failed), a finished job, not an error
    expect(byName['unreadable']).toMatchObject({ status: 'done', verdict: 'cannot_determine', kind: 'fetch_failed', confidence: null, error: null })
    expect(byName['own date'].params.date).toBe('2025-09-02')
    expect(byName['in flood'].params.date).toBe('2025-09-04')
    expect(summarize(v.rows)).toMatchObject({ supported: 2, contradicted: 1, cannot_determine: 1, by_kind: { fetch_failed: 1 }, pending: 0, failed: 0 })

    // the same case the case view reads, owned by the batch's owner
    const c = await (await defaultCaseStore()).get(byName['in flood'].case_id)
    expect(c).toMatchObject({ ownerToken: 'alice', claimType: 'flooded_on', jobId: expect.any(String) })
    expect(byName['in flood'].run_id).toBe(c!.runId)
  }, 150_000)

  it('is owner-scoped (view, export, bundles): 403 for another owner and anonymous, 404 unknown or not a claim batch', async () => {
    for (const who of ['bob', undefined]) {
      expect((await routes.one.GET(req(`/api/cases/batch/${id}`, who), ctx(id))).status).toBe(403)
      expect((await routes.exp.GET(req(`/api/cases/batch/${id}/export`, who), ctx(id))).status).toBe(403)
      expect((await routes.zip.GET(req(`/api/cases/batch/${id}/bundles`, who), ctx(id))).status).toBe(403)
    }
    expect((await routes.one.GET(req('/api/cases/batch/nope', 'alice'), ctx('nope'))).status).toBe(404)
    expect((await routes.one.GET(req('/api/cases/batch/bad id!', 'alice'), ctx('bad id!'))).status).toBe(400)
    const other = await enqueueBatch(db, [{ op: 'fetch_dem', args: {}, aoi: plot(74.4) }], { owner: 'alice' })
    expect((await routes.one.GET(req(`/api/cases/batch/${other}`, 'alice'), ctx(other))).status).toBe(404)
  })

  it('exports one row per plot, with recipe@version, case, run and result ids (CSV and GeoJSON)', async () => {
    const csv = await (await routes.exp.GET(req(`/api/cases/batch/${id}/export?format=csv`, 'alice'), ctx(id))).text()
    const [head, ...lines] = csv.trim().split('\r\n')
    expect(head.split(',')).toEqual(expect.arrayContaining(['lat', 'lon', 'plot', 'verdict', 'confidence', 'abstention_kind', 'recipe', 'param_date', 'case_id', 'run_id', 'result_ids']))
    expect(lines).toHaveLength(4)
    expect(lines.find((l) => l.startsWith(String(31 - 0.0015).slice(0, 6)) && l.includes('in flood'))).toMatch(/supported.*flooded_on@1\.0\.0.*2025-09-04/)

    const res = await routes.exp.GET(req(`/api/cases/batch/${id}/export?format=geojson`, 'alice'), ctx(id))
    expect(res.headers.get('content-disposition')).toContain(`claims-${id}.geojson`)
    const fc = await res.json()
    const f = fc.features.find((x: any) => x.properties.plot === 'unreadable')
    expect(f.properties).toMatchObject({ verdict: 'cannot_determine', abstention_kind: 'fetch_failed', confidence: null, status: 'done' })
    const ok = fc.features.find((x: any) => x.properties.plot === 'in flood').properties
    expect(ok.result_ids).toMatch(/^r_\w+$/)
    expect(ok.run_id).toBeTruthy()
    expect((await routes.exp.GET(req(`/api/cases/batch/${id}/export?format=pdf`, 'alice'), ctx(id))).status).toBe(400)
  })

  it('zips the signed bundle of every case', async () => {
    const res = await routes.zip.GET(req(`/api/cases/batch/${id}/bundles`, 'alice'), ctx(id))
    expect(res.status).toBe(200)
    const zip = await JSZip.loadAsync(await res.arrayBuffer())
    const names = Object.keys(zip.files)
    expect(names).toHaveLength(4)
    const bundle = JSON.parse(await zip.files[names[0]].async('string'))
    expect(bundle.schema).toBe('geoagent.evidence-bundle')
    expect(bundle.body.claim.recipe).toBe('flooded_on@1.0.0')
  })

  it('retries a run that threw, and stores the case once', async () => {
    h.throwOnce.add(Math.round(74.47 * 100))
    const q = await (await post({ ...valid, plots: [{ name: 'flaky', geometry: plot(74.47) }] }, 'alice')).json()
    await runQueue(finished(q.id))
    const v = await view(q.id)
    expect(v.rows[0]).toMatchObject({ status: 'done', attempts: 2, verdict: 'supported', error: null })
    expect(await db.case.count({ where: { jobId: { not: null }, runId: v.rows[0].run_id } })).toBe(1)
  }, 150_000)

  it('fails a job whose parameters are invalid at once (no retry) without a case, and a re-run of a finished job does not make a second case', async () => {
    const batch = await enqueueBatch(db, [
      { op: VERIFY_CLAIM_OP, args: { claim_type: 'flooded_on@1.0.0', params: {}, name: 'no date' }, aoi: plot(74.4) },
      { op: VERIFY_CLAIM_OP, args: { claim_type: 'flooded_on@1.0.0', params: { date: '2025-09-04' }, name: 'ok' }, aoi: plot(74.45) },
    ], { owner: 'alice' })
    await runQueue(finished(batch))
    const v = await view(batch)
    expect(v.rows[0]).toMatchObject({ status: 'failed', attempts: 1, verdict: null, case_id: null })
    expect(v.rows[0].error).toContain('date is required')
    expect(summarize(v.rows)).toMatchObject({ failed: 1, supported: 1 })

    const deps = { catalog: defaultCatalog(), evidence: await defaultEvidenceStore(), cases: await defaultCaseStore() }
    const job = await db.job.findFirstOrThrow({ where: { batchId: batch, idx: 1 } })
    const again = await createJobRunner(deps)({ id: job.id, batchId: batch, idx: 1, op: job.op, args: job.args as any, aoi: job.aoi, attempts: 2, maxAttempts: 3, workerId: 'w', owner: 'alice' })
    expect(again).toMatchObject({ ok: true, resultId: v.rows[1].case_id })
    expect(await db.case.count({ where: { jobId: job.id } })).toBe(1)
  }, 150_000)
})

describe('batchFeatures: the export rows', () => {
  const row = (o: Partial<BatchRow>): BatchRow => ({
    idx: 0, name: 'p', status: 'done', attempts: 1, error: null, geometry: plot(74.4) as GeoJSON.Polygon, case_id: null, verdict: null, confidence: null,
    kind: null, reason: null, recipe: null, run_id: null, params: null, ...o,
  })
  it('leaves the verdict empty for a plot with no case rather than filling one in', () => {
    const fc = batchFeatures([
      row({ idx: 0, status: 'done', verdict: 'supported', confidence: 0.84, kind: undefined as any, reason: 'r', recipe: 'flooded_on@1.0.0', case_id: 'c1', run_id: 'run1', params: { date: '2025-09-04' } }),
      row({ idx: 1, status: 'queued' }),
      row({ idx: 2, status: 'failed', error: 'boom' }),
      row({ idx: 3, status: 'done', verdict: 'cannot_determine', kind: 'data_unavailable', case_id: 'c4', run_id: 'run4', recipe: 'flooded_on@1.0.0', params: { date: '2025-09-05' } }),
    ], new Map([['run1', ['r_a', 'r_b']]]))
    const p = fc.features.map((f) => f.properties!)
    expect(p[0]).toMatchObject({ plot_index: 1, verdict: 'supported', abstention_kind: null, recipe: 'flooded_on@1.0.0', param_date: '2025-09-04', result_ids: 'r_a;r_b', run_id: 'run1' })
    expect(p[1]).toMatchObject({ status: 'queued', verdict: null, confidence: null, case_id: null, run_id: null })
    expect(p[2]).toMatchObject({ status: 'failed', verdict: null, reason: 'boom' })
    expect(p[3]).toMatchObject({ verdict: 'cannot_determine', abstention_kind: 'data_unavailable', result_ids: '' })
  })
})
