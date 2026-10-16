import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'

import { createEvidenceStore, type EvidenceDb, type EvidenceStore } from '@/app/api/agent/engine/evidence-store'
import { GEO_RESULT_SCHEMA, GeoResultSchema, type GeoResult } from '@/lib/geo-result'
import { createTestDb, describeDb, TEST_DATABASE_URL, type TestDb } from '@/test/db'

import { claim, complete, enqueueBatch, type ClaimedJob } from '../queue'
import { createOperationRunner } from '../runner'

let t: TestDb
let evidence: EvidenceStore
beforeAll(async () => {
  if (!TEST_DATABASE_URL) return
  t = await createTestDb()
  evidence = createEvidenceStore(t.prisma as unknown as EvidenceDb)
}, 60_000)
afterAll(async () => { await t?.drop() })
beforeEach(async () => { if (t) await t.prisma.jobBatch.deleteMany() })

const AOI = { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] }
const RID = 'r_1111111111111111'

/** A stored result with figures and a vector layer, as a finished tool would leave it. */
const source = (): GeoResult => GeoResultSchema.parse({
  schema: GEO_RESULT_SCHEMA, result_id: RID, op: { name: 'query_3d_tiles', version: '1.0.0' }, status: 'ok', summary: 'x',
  layers: [{
    id: 'layer-a', name: 'Buildings', type: 'geojson',
    geojson: { type: 'FeatureCollection', features: [3, 8, 14, 21].map((h, i) => ({ type: 'Feature', properties: { height: h, kind: i % 2 ? 'house' : 'shop' }, geometry: { type: 'Point', coordinates: [0.1 * i, 0.1] } })) },
  }],
  stats: { building_count: 4, heights: [{ label: '2025-01', value: 3 }, { label: '2025-02', value: 8 }] },
  provenance: { sources: ['test'], items: [], method: 'test', inputs_hash: 'h' }, validation: [],
})

async function runJob(op: string, args: Record<string, unknown>, owner: string | null): Promise<ClaimedJob & { out: Awaited<ReturnType<ReturnType<typeof createOperationRunner>>> }> {
  await enqueueBatch(t.prisma, [{ op, args, aoi: AOI }], { owner })
  const job = (await claim(t.prisma, 'w', 60_000))!
  return Object.assign(job, { out: await createOperationRunner(evidence)(job) })
}
const stored = async (id: string) => (await evidence.getResult(id))!.result

describeDb('queued make_chart / style_layer take their input from the evidence store', () => {
  beforeEach(async () => { await evidence.put(source(), { cacheKey: null, expiresAt: null, now: Date.now() }) })

  it('make_chart draws a chart over the picked result', async () => {
    const spec = JSON.stringify({ mark: 'bar', data: { name: `${RID}#heights` }, encoding: { x: { field: 'label', type: 'ordinal' }, y: { field: 'value', type: 'quantitative' } } })
    const j = await runJob('make_chart', { spec, result_id: RID }, null)
    expect(j.out).toMatchObject({ ok: true, resultStatus: 'ok' })
    const r = await stored((j.out as any).resultId)
    expect(r.charts).toHaveLength(1)
    expect(r.charts![0].spec.data.values).toEqual([{ label: '2025-01', value: 3, date: '2025-01' }, { label: '2025-02', value: 8, date: '2025-02' }])
  })

  it('style_layer restyles the picked result\'s vector layer', async () => {
    const j = await runJob('style_layer', { result_id: RID, property: 'height', kind: 'graduated', num_classes: 3 }, null)
    expect(j.out).toMatchObject({ ok: true, resultStatus: 'ok' })
    const r = await stored((j.out as any).resultId)
    expect(r.layer_style).toMatchObject({ layer_id: 'layer-a', style: { property: 'height', kind: 'graduated' } })
    expect(r.layer_style!.legend.length).toBeGreaterThan(1)
  })

  it('an unknown property is refused with a reason, never reported ok', async () => {
    const j = await runJob('style_layer', { result_id: RID, property: 'nope' }, null)
    expect(j.out).toMatchObject({ ok: true, resultStatus: 'refused' })
    expect((await stored((j.out as any).resultId)).summary).toMatch(/nope/)
  })

  it('a result that does not exist is refused, not a no-op that says ok', async () => {
    const j = await runJob('make_chart', { spec: JSON.stringify({ mark: 'bar', data: { name: 'r_2222222222222222#x' } }), result_id: 'r_2222222222222222' }, null)
    expect(j.out).toMatchObject({ ok: true, resultStatus: 'refused' })
    const j2 = await runJob('style_layer', { result_id: 'r_2222222222222222', property: 'height' }, null)
    expect(j2.out).toMatchObject({ ok: true, resultStatus: 'refused' })
  })

  it('only the owner of a run that holds the result may use it', async () => {
    // alice's finished job holds the result; bob's job naming it sees nothing
    await enqueueBatch(t.prisma, [{ op: 'query_3d_tiles', args: {}, aoi: AOI }], { owner: 'alice' })
    const held = (await claim(t.prisma, 'w', 60_000))!
    expect(await complete(t.prisma, held, { resultId: RID, resultStatus: 'ok' })).toBe(true)

    const alice = await runJob('style_layer', { result_id: RID, property: 'height' }, 'alice')
    expect(alice.out).toMatchObject({ ok: true, resultStatus: 'ok' })
    const bob = await runJob('style_layer', { result_id: RID, property: 'height' }, 'bob')
    expect(bob.out).toMatchObject({ ok: true, resultStatus: 'refused' })
  })
})
