/** Batch input (Q-28): N plots, one claim type, one case per plot, run on the job queue.
 *
 *  Each plot is a `verify_claim` job; the worker's handler runs the same `createCase` the
 *  synchronous POST /api/cases runs. This module queues a batch, reads its state back (job rows
 *  joined to the cases they made) and turns the rows into the export collection. */

import type { PrismaClient } from '@prisma/client'

import type { BatchRow, BatchView, RowStatus } from '@/lib/case-batch'
import { enqueueBatch, batchProgress, type JobItem } from '@/lib/jobs/queue'
import { VERIFY_CLAIM_OP } from '@/lib/jobs/runner'

import type { CaseStore } from './case-store'
import type { RecipeCatalog } from './loader'
import { resolveParams } from './params'
import { recipeKey } from './schema'
import { UnknownClaimType } from './service'

export interface BatchPlotInput {
  name?: string
  geometry: GeoJSON.Geometry
  params?: Record<string, string | number>
}

export interface BatchInput {
  claimType: string
  params: Record<string, string | number>
  label?: string
  plots: BatchPlotInput[]
  owner: string | null
}

export class BatchInputError extends Error {
  constructor(public issues: Array<{ path: string; message: string }>) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join('; '))
  }
}

const MAX_REPORTED = 20

/** Check every plot's parameters against the recipe, then queue one job per plot. Nothing is
 *  queued when any plot is invalid: the issues name the plot by its position. */
export async function enqueueClaimBatch(db: PrismaClient, catalog: RecipeCatalog, input: BatchInput, now = Date.now()): Promise<{ id: string; total: number; recipe: string }> {
  const [id, version] = input.claimType.split('@')
  const recipe = catalog.get(version ? input.claimType : id)
  if (!recipe) throw new UnknownClaimType(`Unknown claim type "${input.claimType}". Available: ${catalog.list().map((r) => `${r.id}@${r.version}`).join(', ') || 'none'}`)
  const ref = recipeKey(recipe)
  const today = new Date(now).toISOString().slice(0, 10)

  const issues: Array<{ path: string; message: string }> = []
  const items: JobItem[] = []
  for (const [i, plot] of input.plots.entries()) {
    const params = { ...input.params, ...(plot.params ?? {}) }
    const r = resolveParams(recipe, params, plot.geometry, today)
    if (!r.ok) {
      for (const m of r.errors) issues.push({ path: `plots.${i}`, message: m })
      continue
    }
    items.push({ op: VERIFY_CLAIM_OP, args: { claim_type: ref, params, name: plot.name ?? `Plot ${i + 1}` }, aoi: plot.geometry })
  }
  if (issues.length) throw new BatchInputError(issues.slice(0, MAX_REPORTED))
  const batchId = await enqueueBatch(db, items, { owner: input.owner, label: input.label ?? `${recipe.title}: ${items.length} plots` })
  return { id: batchId, total: items.length, recipe: ref }
}

export type BatchLookup = { kind: 'not_found' } | { kind: 'ok'; ownerToken: string | null; view: BatchView }

/** A batch's rows, or not_found when the id is unknown or the batch is not a claim batch. The
 *  caller checks ownership (`ownerToken`) before showing anything. */
export async function loadClaimBatch(db: PrismaClient, cases: CaseStore, catalog: RecipeCatalog, id: string): Promise<BatchLookup> {
  const batch = await db.jobBatch.findUnique({ where: { id } })
  if (!batch) return { kind: 'not_found' }
  const [progress, jobs] = await Promise.all([
    batchProgress(db, id),
    db.job.findMany({ where: { batchId: id }, orderBy: { idx: 'asc' }, select: { idx: true, op: true, args: true, aoi: true, status: true, attempts: true, resultId: true, error: true } }),
  ])
  if (jobs.length === 0 || jobs.some((j) => j.op !== VERIFY_CLAIM_OP)) return { kind: 'not_found' }
  const made = new Map((await cases.many(jobs.flatMap((j) => (j.status === 'done' && j.resultId ? [j.resultId] : [])))).map((c) => [c.id, c]))
  const first = jobs[0].args as { claim_type: string }
  const rows: BatchRow[] = jobs.map((j) => {
    const args = j.args as { name?: string }
    const c = j.status === 'done' && j.resultId ? made.get(j.resultId) : undefined
    const missing = j.status === 'done' && !c
    return {
      idx: j.idx, name: args.name ?? `Plot ${j.idx + 1}`,
      status: missing ? 'failed' : (j.status as RowStatus), attempts: j.attempts,
      error: missing ? 'The job finished but its case could not be found.' : j.error,
      geometry: j.aoi as unknown as GeoJSON.Geometry,
      case_id: c?.id ?? null, verdict: c?.verdict ?? null, confidence: c?.confidence ?? null,
      kind: c?.decision.kind ?? null, reason: c?.decision.reason ?? null, recipe: c?.recipe ?? null,
      run_id: c?.runId ?? null, params: c?.params ?? null,
    }
  })
  return {
    kind: 'ok', ownerToken: batch.ownerToken,
    view: {
      id, label: batch.label, created_at: batch.createdAt.toISOString(), claim_type: first.claim_type,
      recipe_title: catalog.get(first.claim_type)?.title ?? null,
      state: progress.queued + progress.running === 0 ? 'finished' : 'active', progress, rows,
    },
  }
}

/** The verdict table as a FeatureCollection of the plots, one row per plot, for the vector-io
 *  exporters. Rows that have no case yet (queued, running, failed) say so in `status` and leave
 *  the verdict empty: nothing is filled in for a plot that was not decided. `result_ids` are the
 *  ledger results the verdict rests on (`;`-separated, in step order). */
export function batchFeatures(rows: BatchRow[], resultIds: Map<string, string[]>): GeoJSON.FeatureCollection {
  const paramKeys = [...new Set(rows.flatMap((r) => Object.keys(r.params ?? {})))]
  return {
    type: 'FeatureCollection',
    features: rows.map((r) => ({
      type: 'Feature',
      geometry: r.geometry,
      properties: {
        plot: r.name, plot_index: r.idx + 1, status: r.status,
        verdict: r.verdict, confidence: r.confidence, abstention_kind: r.verdict === 'cannot_determine' ? r.kind : null,
        reason: r.reason ?? r.error, recipe: r.recipe,
        ...Object.fromEntries(paramKeys.map((k) => [`param_${k}`, r.params?.[k] ?? null])),
        case_id: r.case_id, run_id: r.run_id, result_ids: r.run_id ? (resultIds.get(r.run_id) ?? []).join(';') : null,
      },
    })),
  }
}
