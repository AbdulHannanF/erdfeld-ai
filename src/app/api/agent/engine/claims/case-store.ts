/** Persistence of cases (Q-27) behind Prisma: plain columns plus jsonb, like the ledger. */

import type { Prisma } from '@prisma/client'

import type { Decided } from './rule'
import type { ParamValues } from './params'
import type { Verdict } from './schema'

export interface CaseRecord {
  id: string
  ownerToken: string | null
  claimType: string
  recipe: string
  geometry: GeoJSON.Geometry
  params: ParamValues
  verdict: Verdict
  confidence: number | null
  decision: Pick<Decided, 'rule' | 'reason' | 'kind' | 'inputs'>
  runId: string | null
  /** The queue job that made it (batch input); null for a case made by the API directly. */
  jobId: string | null
  createdAt: string
}

export type NewCase = Omit<CaseRecord, 'id' | 'createdAt' | 'jobId'> & { jobId?: string | null }

export interface CaseDb {
  case: {
    create(args: any): Promise<any>
    findUnique(args: any): Promise<any>
    findFirst(args: any): Promise<any>
    findMany(args: any): Promise<any[]>
  }
}

const toRecord = (row: any): CaseRecord => ({
  id: row.id, ownerToken: row.ownerToken, claimType: row.claimType, recipe: row.recipe,
  geometry: row.geometry, params: row.params, verdict: row.verdict, confidence: row.confidence,
  decision: row.decision, runId: row.runId, jobId: row.jobId ?? null, createdAt: new Date(row.createdAt).toISOString(),
})

export interface CaseStore {
  create(c: NewCase): Promise<CaseRecord>
  get(id: string): Promise<CaseRecord | null>
  /** The case a ledger run belongs to, if it is a claim run. */
  byRun(runId: string): Promise<CaseRecord | null>
  /** The case a queue job already made, if any (a job re-run after a crash must not make a second). */
  byJob(jobId: string): Promise<CaseRecord | null>
  /** Cases by id, in no particular order; unknown ids are absent. */
  many(ids: string[]): Promise<CaseRecord[]>
}

export function createCaseStore(db: CaseDb): CaseStore {
  return {
    create: async (c) => toRecord(await db.case.create({
      data: {
        ownerToken: c.ownerToken, claimType: c.claimType, recipe: c.recipe,
        geometry: c.geometry as unknown as Prisma.InputJsonValue, params: c.params as Prisma.InputJsonValue,
        verdict: c.verdict, confidence: c.confidence, decision: c.decision as unknown as Prisma.InputJsonValue, runId: c.runId, jobId: c.jobId ?? null,
      },
    })),
    get: async (id) => {
      const row = await db.case.findUnique({ where: { id } })
      return row ? toRecord(row) : null
    },
    byRun: async (runId) => {
      const row = await db.case.findFirst({ where: { runId }, orderBy: { createdAt: 'desc' } })
      return row ? toRecord(row) : null
    },
    byJob: async (jobId) => {
      const row = await db.case.findFirst({ where: { jobId } })
      return row ? toRecord(row) : null
    },
    many: async (ids) => (ids.length ? (await db.case.findMany({ where: { id: { in: ids } } })).map(toRecord) : []),
  }
}

let shared: CaseStore | undefined
export async function defaultCaseStore(): Promise<CaseStore> {
  if (!shared) {
    const { db } = await import('@/lib/db')
    shared = createCaseStore(db as unknown as CaseDb)
  }
  return shared
}
