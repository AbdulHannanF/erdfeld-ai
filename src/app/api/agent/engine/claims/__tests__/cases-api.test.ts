import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GeoResult } from '@/lib/geo-result'
import { verifyBundle } from '@/lib/evidence-bundle'
import { getSigningKey } from '@/lib/evidence-key'
import { inputsHash, resultId } from '../../hash'
import { memoryStore } from '../../__tests__/memory-store'
import type { CaseRecord, CaseStore, NewCase } from '../case-store'

const h = vi.hoisted(() => ({ evidence: null as any, cases: null as any, stats: {} as Record<string, any> }))
vi.mock('../../evidence-store', () => ({ defaultEvidenceStore: async () => h.evidence }))
vi.mock('../case-store', async (orig) => ({ ...(await orig<typeof import('../case-store')>()), defaultCaseStore: async () => h.cases }))
vi.mock('../../execute', async (orig) => ({
  ...(await orig<typeof import('../../execute')>()),
  // The two Sentinel-2 reads are canned: this test is about cases, not about the network.
  runOperation: async (name: string, args: Record<string, any>, env: any): Promise<GeoResult> => {
    const stats = h.stats[args.operation as string]
    const inputs = inputsHash({ op: name, version: '1.0.0', args, aoi: env.aoi, focus: undefined })
    const items = [`S2_${args.operation}`]
    const result: GeoResult = {
      schema: 'geo-result/1', result_id: resultId(inputs, items), op: { name, version: '1.0.0' }, status: stats ? 'ok' : 'failed',
      summary: stats ? 'ok' : '**analyze_raster failed:** timeout. This is a failure, not an absence of data.', layers: [], ...(stats ? { stats } : {}),
      provenance: { sources: ['Sentinel-2 L2A'], items, method: 'm', inputs_hash: inputs }, validation: [],
    }
    await env.evidence?.put(result, { cacheKey: null, expiresAt: null, now: 0 })
    return result
  },
}))

import { GET as getCase } from '../../../../cases/[id]/route'
import { GET as listTypes, POST as postCase } from '../../../../cases/route'
import { signedBundleFor } from '../../../../evidence/bundle-service'
import { reverifyClaim } from '../reverify'

const plot = { type: 'Polygon', coordinates: [[[-55, -7], [-54.997, -7], [-54.997, -7.003], [-55, -7.003], [-55, -7]]] }
const intact = {
  stats: { median: 0.85, mean: 0.85, p25: 0.8, p75: 0.9, clear_pixels: 780, in_polygon_pixels: 784, clear_pct: 99, scene_date: '2020-07-30' },
  change: { date_before: '2020-07-30', date_after: '2024-07-28', sensor_resolution_m: 10, median_delta: -0.01, mean_delta: -0.01, decreased_pct: 0, increased_pct: 0, threshold: 0.2, pixels_clear_both: 770 },
}
const post = (body: unknown, owner?: string) =>
  postCase(new NextRequest('http://localhost/api/cases', { method: 'POST', body: JSON.stringify(body), headers: owner ? { 'x-owner-token': owner } : {} }))
const get = (id: string, owner?: string) =>
  getCase(new NextRequest(`http://localhost/api/cases/${id}`, { headers: owner ? { 'x-owner-token': owner } : {} }), { params: Promise.resolve({ id }) })
const valid = { claim_type: 'not_cleared_since', params: { date: '2020-07-31', as_of: '2024-07-31' }, geometry: plot }

beforeEach(() => {
  process.env.RATE_LIMIT_DISABLED = '1'
  h.evidence = memoryStore().store
  const rows = new Map<string, CaseRecord>()
  h.cases = {
    async create(c: NewCase) { const r = { jobId: null, ...c, id: `case${rows.size + 1}`, createdAt: new Date(0).toISOString() } as CaseRecord; rows.set(r.id, r); return r },
    async get(id: string) { return rows.get(id) ?? null },
    async byRun(runId: string) { return [...rows.values()].find((r) => r.runId === runId) ?? null },
    async byJob(jobId: string) { return [...rows.values()].find((r) => r.jobId === jobId) ?? null },
    async many(ids: string[]) { return ids.flatMap((i) => rows.get(i) ?? []) },
  } satisfies CaseStore
  h.stats = structuredClone(intact)
})

describe('POST /api/cases: validation', () => {
  it.each([
    ['a malformed claim type', { ...valid, claim_type: 'Not A Type' }],
    ['a missing plot', { claim_type: 'not_cleared_since', params: valid.params }],
    ['a Point instead of a polygon', { ...valid, geometry: { type: 'Point', coordinates: [1, 2] } }],
    ['an unknown field', { ...valid, owner: 'bob' }],
  ])('400 invalid_request for %s', async (_n, body) => {
    const r = await post(body)
    expect(r.status).toBe(400)
    expect((await r.json()).error).toBe('invalid_request')
  })

  it('400 unknown_claim_type for a type with no recipe, listing those that exist', async () => {
    const r = await post({ ...valid, claim_type: 'crop_present' })
    expect(r.status).toBe(400)
    const b = await r.json()
    expect(b.error).toBe('unknown_claim_type')
    expect(b.message).toContain('not_cleared_since@1.0.0')
  })

  it('400 with every parameter problem of the recipe, before anything runs', async () => {
    const r = await post({ ...valid, params: { as_of: '2024-02-30', extra: 1 } })
    expect(r.status).toBe(400)
    const b = await r.json()
    expect(b.issues.map((i: any) => i.message)).toEqual(expect.arrayContaining(['date is required', 'as_of must be a calendar date, YYYY-MM-DD', 'extra is not a parameter of not_cleared_since']))
    expect(h.evidence).toBeTruthy()
  })

  it('413 over the body cap', async () => {
    const r = await post({ ...valid, params: { date: 'x'.repeat(70_000) } })
    expect(r.status).toBe(413)
  })

  it('lists the claim types with their parameters', async () => {
    const b = await (await listTypes()).json()
    expect(b.claim_types.map((t: any) => t.ref)).toEqual(expect.arrayContaining(['flooded_on@1.0.0', 'not_cleared_since@1.0.0']))
  })
})

describe('POST/GET /api/cases: a case', () => {
  it('runs the recipe, records the ledger run and answers with verdict, timeline and narration citing result ids', async () => {
    const r = await post(valid, 'alice')
    expect(r.status).toBe(201)
    const c = await r.json()
    expect(c).toMatchObject({ recipe: 'not_cleared_since@1.0.0', verdict: 'supported', claim: 'This plot has not been cleared since 2020-07-31.' })
    expect(c.confidence).toBeGreaterThan(0.5)
    expect(c.run_id).toBeTruthy()
    expect(c.timeline).toHaveLength(2)
    expect(c.timeline[0]).toMatchObject({ step: 0, op: 'analyze_raster', date: '2020-07-30', status: 'ok' })
    const ids = c.timeline.map((t: any) => t.result_id)
    expect(ids.every((i: string) => /^r_/.test(i))).toBe(true)
    const text = c.explain.map((l: any) => l.text).join('\n')
    expect(text).toContain('median NDVI was 0.85')
    expect(text).toContain('Verdict: Supported')
    expect(c.explain.flatMap((l: any) => l.cites)).toEqual(expect.arrayContaining(ids))
    expect(text).not.toMatch(/undefined|NaN/)
  })

  it('is owner-scoped: 200 for the owner, 403 for another owner and for anonymous, 404 for unknown', async () => {
    const id = (await (await post(valid, 'alice')).json()).id
    expect((await get(id, 'alice')).status).toBe(200)
    expect((await get(id, 'bob')).status).toBe(403)
    expect((await get(id)).status).toBe(403)
    expect((await get('nope', 'alice')).status).toBe(404)
    expect((await get('bad id!', 'alice')).status).toBe(400)
  })

  it('a failed read is Cannot determine (fetch failed) with no confidence, never a guess', async () => {
    h.stats = {}
    const c = await (await post(valid, 'alice')).json()
    expect(c).toMatchObject({ verdict: 'cannot_determine', confidence: null, decision: { kind: 'fetch_failed' } })
    expect(c.explain.map((l: any) => l.text).join('\n')).toContain('a failure, not an absence of data')
  })

  it('a clearing signal is Contradicted', async () => {
    h.stats.change = { ...h.stats.change, decreased_pct: 70, median_delta: -0.4 }
    expect(await (await post(valid, 'alice')).json()).toMatchObject({ verdict: 'contradicted' })
  })
})

describe('signed bundle of a case', () => {
  it('names recipe@version, the verdict and the embedded recipe; the signature holds; the verdict re-evaluates from the bundle alone', async () => {
    const c = await (await post(valid, 'alice')).json()
    const bundle = await signedBundleFor(new NextRequest('http://localhost/x', { headers: { 'x-owner-token': 'alice' } }), c.run_id)
    if (bundle instanceof Response) throw new Error('no bundle')
    expect(bundle.body.claim).toMatchObject({ recipe: 'not_cleared_since@1.0.0', verdict: 'supported', case_id: c.id, claim_type: 'not_cleared_since' })
    expect((bundle.body.claim!.recipe_body as any).version).toBe('1.0.0')
    expect(verifyBundle(bundle, getSigningKey().publicKeyPem).valid).toBe(true)
    expect(reverifyClaim(bundle.body)).toMatchObject({ ok: true, same: true, recomputed: { verdict: 'supported' } })

    // A bundle whose verdict was edited does not follow from its own evidence.
    const forged = structuredClone(bundle.body)
    forged.claim!.verdict = 'contradicted'
    expect(reverifyClaim(forged)).toMatchObject({ ok: true, same: false })
  })

  it('a run that is not a claim has no claim section', async () => {
    const runId = await h.evidence.saveRun({ ownerToken: 'alice', query: 'q', aoi: {}, focus: null, nodes: [] })
    const bundle = await signedBundleFor(new NextRequest('http://localhost/x', { headers: { 'x-owner-token': 'alice' } }), runId)
    if (bundle instanceof Response) throw new Error('no bundle')
    expect(bundle.body.claim).toBeUndefined()
  })
})
