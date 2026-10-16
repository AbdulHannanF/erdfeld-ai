/** Persistence for the result cache and the evidence ledger (Q-47), behind Prisma.
 *
 *  Plain columns plus `Json` (jsonb) for the payload, arguments and AOI (Q-21: PostgreSQL).
 *
 *  Writing during a request is best effort and never decides an outcome: when the database cannot
 *  be reached the executor runs the operation and the request simply has no ledger (`lookup`,
 *  `put` and `saveRun` swallow the failure, log it, and remember it for `RETRY_AFTER_MS` so it
 *  does not cost a round trip per operation). Reads for the API throw instead, so "the store is
 *  down" is never reported as "no such result".
 */

import { Prisma } from '@prisma/client'

import { GeoResultSchema, type GeoResult } from '@/lib/geo-result'
import { canAccessProject } from '@/lib/projects'

import { getLogger } from '../lib/logger'
import type { LedgerNode, LedgerRun, LedgerRunInput } from './ledger'

const log = getLogger('engine/evidence-store')

export interface StoredResult {
  result: GeoResult
  computedAt: number
}

export interface PutOptions {
  /** Null: never served as a cache hit (failed, refused, not cacheable). */
  cacheKey: string | null
  expiresAt: number | null
  now: number
}

export interface EvidenceStore {
  /** A stored result with this cache key that has not expired, newest first. */
  lookup(cacheKey: string, now: number): Promise<StoredResult | null>
  put(result: GeoResult, opts: PutOptions): Promise<void>
  getResult(resultId: string): Promise<StoredResult | null>
  getResults(resultIds: string[]): Promise<Map<string, StoredResult>>
  saveRun(run: LedgerRunInput): Promise<string>
  getRun(runId: string): Promise<LedgerRun | null>
  /** True when `owner` owns (or may open) a run, or a job batch (Q-24), that contains this result. */
  canReadResult(resultId: string, owner: string): Promise<boolean>
}

/** The slice of the Prisma client this store uses, so tests can pass a client on a test schema. */
export interface EvidenceDb {
  result: {
    findFirst(args: any): Promise<any>
    findUnique(args: any): Promise<any>
    findMany(args: any): Promise<any[]>
    upsert(args: any): Promise<any>
  }
  planRun: {
    create(args: any): Promise<any>
    findUnique(args: any): Promise<any>
  }
  planNode: {
    findMany(args: any): Promise<any[]>
  }
  job: {
    findMany(args: any): Promise<any[]>
  }
}

const RETRY_AFTER_MS = 60_000

const parse = (payload: unknown): GeoResult | null => {
  const r = GeoResultSchema.safeParse(payload)
  return r.success ? r.data : null
}

const toStored = (row: any): StoredResult | null => {
  const result = parse(row.payload)
  return result ? { result, computedAt: new Date(row.computedAt).getTime() } : null
}

const toNode = (n: any): LedgerNode => ({
  idx: n.idx, op: n.op, version: n.version, args: n.args, dependsOn: n.dependsOn,
  inputsHash: n.inputsHash, resultId: n.resultId, status: n.status, cached: n.cached,
  startedAt: new Date(n.startedAt).toISOString(), ms: n.ms,
})

export function createEvidenceStore(db: EvidenceDb): EvidenceStore {
  let downUntil = 0
  /** Run a query unless the database was just found unreachable; a failure is logged once per window. */
  async function guarded<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    if (Date.now() < downUntil) return fallback
    try {
      return await fn()
    } catch (err) {
      downUntil = Date.now() + RETRY_AFTER_MS
      log.warn({ what, err: (err as Error)?.message?.split('\n').slice(-2).join(' ') }, 'evidence store unavailable; running without cache and ledger')
      return fallback
    }
  }

  return {
    lookup: (cacheKey, now) => guarded('lookup', async () => {
      const row = await db.result.findFirst({
        where: { cacheKey, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(now) } }] },
        orderBy: { computedAt: 'desc' },
      })
      return row ? toStored(row) : null
    }, null),

    put: (result, o) => guarded('put', async () => {
      const data = {
        inputsHash: result.provenance.inputs_hash,
        cacheKey: o.cacheKey,
        opName: result.op.name,
        opVersion: result.op.version,
        status: result.status,
        payload: result as unknown as Prisma.InputJsonValue,
        computedAt: new Date(o.now),
        expiresAt: o.expiresAt == null ? null : new Date(o.expiresAt),
      }
      await db.result.upsert({ where: { resultId: result.result_id }, create: { resultId: result.result_id, ...data }, update: data })
    }, undefined),

    getResult: async (resultId) => {
      const row = await db.result.findUnique({ where: { resultId } })
      return row ? toStored(row) : null
    },

    getResults: async (resultIds) => {
      const rows = await db.result.findMany({ where: { resultId: { in: [...new Set(resultIds)] } } })
      const out = new Map<string, StoredResult>()
      for (const row of rows) {
        const s = toStored(row)
        if (s) out.set(row.resultId, s)
      }
      return out
    },

    saveRun: (run) => guarded('saveRun', async () => {
      const row = await db.planRun.create({
        data: {
          ownerToken: run.ownerToken,
          query: run.query,
          aoi: run.aoi as Prisma.InputJsonValue,
          focus: run.focus ?? Prisma.DbNull,
          nodes: {
            create: run.nodes.map((n) => ({
              idx: n.idx, op: n.op, version: n.version, args: n.args as Prisma.InputJsonObject, dependsOn: n.dependsOn,
              inputsHash: n.inputsHash, resultId: n.resultId, status: n.status, cached: n.cached,
              startedAt: new Date(n.startedAt), ms: n.ms,
            })),
          },
        },
      })
      return row.id as string
    }, ''),

    getRun: async (runId) => {
      const row = await db.planRun.findUnique({ where: { id: runId }, include: { nodes: { orderBy: { idx: 'asc' } } } })
      if (!row) return null
      return {
        id: row.id, ownerToken: row.ownerToken, query: row.query, aoi: row.aoi,
        focus: row.focus ?? null, createdAt: new Date(row.createdAt).toISOString(),
        nodes: row.nodes.map(toNode),
      } satisfies LedgerRun
    },

    canReadResult: async (resultId, owner) => {
      const nodes = await db.planNode.findMany({ where: { resultId }, select: { run: { select: { ownerToken: true } } } })
      if (nodes.some((n) => canAccessProject(n.run.ownerToken, owner))) return true
      const jobs = await db.job.findMany({ where: { resultId }, select: { batch: { select: { ownerToken: true } } } })
      return jobs.some((j) => canAccessProject(j.batch.ownerToken, owner))
    },
  }
}

/** The app's store on the shared Prisma client. Loaded lazily so importing the executor does not open a database. */
let shared: EvidenceStore | undefined
export async function defaultEvidenceStore(): Promise<EvidenceStore> {
  if (!shared) {
    const { db } = await import('@/lib/db')
    shared = createEvidenceStore(db as unknown as EvidenceDb)
  }
  return shared
}
