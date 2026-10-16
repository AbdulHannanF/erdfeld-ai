/**
 * The caller's evidence-ledger runs, newest first.
 *
 *   GET /api/ledger?limit=20&cursor=<id>  → { runs: [{ id, query, createdAt, operations, nodeCount }], nextCursor }
 *
 * Owner scoping is the project rule: only runs saved under the caller's owner key are listed (an
 * anonymous request without an `x-owner-token` lists nothing). 503 `database_unavailable` when the
 * store cannot be reached, so a client can tell "no runs" from "no database".
 */

import { NextRequest, NextResponse } from 'next/server'

import { getRequestOwner } from '@/lib/auth'
import { ListQuerySchema, queryObject, validate } from '@/lib/api-schemas'
import { db } from '@/lib/db'
import { enforceRateLimit } from '@/lib/rate-limit'
import { getLogger } from '../agent/lib/logger'

export const dynamic = 'force-dynamic'

const log = getLogger('api/ledger')

export async function GET(req: NextRequest) {
  const limited = await enforceRateLimit(req, 'lists')
  if (limited) return limited
  const q = validate(ListQuerySchema, queryObject(req.nextUrl.searchParams))
  if (!q.ok) return q.response
  const { limit, cursor } = q.data

  const owner = await getRequestOwner(req)
  if (!owner) return NextResponse.json({ runs: [], nextCursor: null })

  try {
    const rows = await db.planRun.findMany({
      where: { ownerToken: owner },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, query: true, createdAt: true, nodes: { orderBy: { idx: 'asc' }, select: { op: true } } },
    })
    const page = rows.slice(0, limit)
    return NextResponse.json({
      runs: page.map((r) => ({
        id: r.id,
        query: r.query,
        createdAt: r.createdAt.toISOString(),
        nodeCount: r.nodes.length,
        operations: [...new Set(r.nodes.map((n) => n.op))],
      })),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    })
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'list failed')
    return NextResponse.json({ error: 'database_unavailable', message: 'The evidence ledger could not be reached.' }, { status: 503 })
  }
}
