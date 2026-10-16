import { NextRequest } from 'next/server'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { createTestDb, describeDb, type TestDb } from '@/test/db'

// The route uses the app's shared Prisma client, which reads DATABASE_URL: point it at the test schema first.
let t: TestDb
let route: typeof import('../route')

beforeAll(async () => {
  t = await createTestDb()
  process.env.DATABASE_URL = t.url
  route = await import('../route')
}, 60_000)
afterAll(async () => {
  const { db } = await import('@/lib/db')
  await db.$disconnect()
  await t?.drop()
})

const list = (owner: string, qs = '') => route.GET(new NextRequest(`http://x/api/ledger${qs}`, { headers: { 'x-owner-token': owner } }))
const node = (idx: number, op: string) => ({ idx, op, version: '1', args: {}, dependsOn: [], status: 'ok', startedAt: new Date(0), ms: 1 })

describeDb('GET /api/ledger', () => {
  it("lists the caller's runs newest first, in pages, and nobody else's", async () => {
    const mk = (ownerToken: string, query: string, createdAt: Date, ops: string[]) =>
      t.prisma.planRun.create({ data: { ownerToken, query, aoi: {}, createdAt, nodes: { create: ops.map((op, i) => node(i, op)) } } })
    const a = await mk('erin', 'oldest', new Date('2026-01-01'), ['fetch_dem'])
    await mk('erin', 'middle', new Date('2026-02-01'), ['fetch_ndvi', 'fetch_ndvi'])
    const c = await mk('erin', 'newest', new Date('2026-03-01'), [])
    await mk('frank', 'not erin\'s', new Date('2026-04-01'), ['x'])

    const p1 = await (await list('erin', '?limit=2')).json()
    expect(p1.runs.map((r: { query: string }) => r.query)).toEqual(['newest', 'middle'])
    expect(p1.runs[0]).toMatchObject({ id: c.id, nodeCount: 0, operations: [] })
    expect(p1.runs[1]).toMatchObject({ nodeCount: 2, operations: ['fetch_ndvi'] })
    const p2 = await (await list('erin', `?limit=2&cursor=${p1.nextCursor}`)).json()
    expect(p2.runs.map((r: { id: string }) => r.id)).toEqual([a.id])
    expect(p2.nextCursor).toBeNull()

    expect((await (await list('')).json()).runs).toEqual([])
    expect((await list('erin', '?limit=abc')).status).toBe(400)
  })
})
