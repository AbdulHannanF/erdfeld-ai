/** Run one claimed job. Operation jobs go through the engine executor, the same code path as an
 *  interactive request, so the result is kept by content hash in the evidence store (Q-47) like
 *  any other. `verify_claim` jobs (batch input, Q-28) run a claim recipe through the same code the
 *  synchronous POST /api/cases uses (`createCase`) and keep a Case. */

import { runOperation } from '@/app/api/agent/engine/execute'
import type { EvidenceStore } from '@/app/api/agent/engine/evidence-store'
import { resolveOperation } from '@/app/api/agent/engine/registry'
import { storeResult } from '@/app/api/agent/lib/chart-data'
import type { ResultStore } from '@/app/api/agent/lib/types'
import type { CaseStore } from '@/app/api/agent/engine/claims/case-store'
import type { RecipeCatalog } from '@/app/api/agent/engine/claims/loader'
import { ClaimInputError, UnknownClaimType, createCase } from '@/app/api/agent/engine/claims/service'

import type { ClaimedJob, Failure, Outcome } from './queue'

export type JobRunner = (job: ClaimedJob) => Promise<({ ok: true } & Outcome) | ({ ok: false } & Failure)>

/** The `op` of a batch-input job: its `args` are `{ claim_type, params, name? }` and its `aoi` the plot. */
export const VERIFY_CLAIM_OP = 'verify_claim'

const RESULT_ID = /\br_[0-9a-f]{16}\b/g

/** The results an operation that works on existing results (`make_chart`, `style_layer`) may use,
 *  as the store an agent run would have built: `args.result_id` plus any result id its other
 *  arguments name (a chart spec references `<result_id>#<key>`). Loaded from the evidence store,
 *  and only those the job's owner may read; an id that is unknown or not theirs is simply absent,
 *  so the operation refuses with the list of what it can see. */
export async function loadInputResults(evidence: EvidenceStore, args: Record<string, unknown>, owner: string | null): Promise<ResultStore> {
  const ids = new Set<string>(JSON.stringify(args).match(RESULT_ID) ?? [])
  if (typeof args.result_id === 'string' && args.result_id) ids.add(args.result_id)
  const store: ResultStore = new Map()
  if (ids.size === 0) return store
  const found = await evidence.getResults([...ids])
  for (const [id, stored] of found) {
    if (owner && !(await evidence.canReadResult(id, owner))) continue
    storeResult(store, id, stored.result.op.name, stored.result.stats, stored.result.layers)
  }
  return store
}

/** What the executor produced, as a job outcome:
 *  - `failed` (an upstream could not be read, an operation threw): worth another attempt;
 *  - `ok`, `flagged` (checks raised flags, kept with them) and `refused` (the request itself is
 *    invalid, retrying cannot change that): the job is done and the result says which. */
export function createOperationRunner(evidence: EvidenceStore): JobRunner {
  return async (job) => {
    const results = resolveOperation(job.op, job.args)?.op.inputResult
      ? await loadInputResults(evidence, job.args, job.owner)
      : undefined
    const result = await runOperation(job.op, job.args, { aoi: job.aoi, evidence, results })
    // The executor keeps results best effort; a job must not point at a result that is not there.
    if (!(await evidence.getResult(result.result_id))) {
      return { ok: false, error: 'The result could not be stored in the evidence store.' }
    }
    if (result.status === 'failed') {
      return { ok: false, error: result.summary.replace(/\s+/g, ' ').slice(0, 500), resultId: result.result_id, resultStatus: result.status }
    }
    return { ok: true, resultId: result.result_id, resultStatus: result.status }
  }
}

/** A claim job is done when it stored a case. An upstream that could not be read is not an error
 *  here: the evaluator turns it into Cannot determine (fetch_failed), which is the case to keep.
 *  Only a run that threw (database down, a bug) is an attempt that failed and is retried; invalid
 *  parameters or a recipe that no longer exists cannot get better, so they fail at once. The job's
 *  `resultId` is the case id and `resultStatus` its verdict. */
export function createClaimRunner(deps: { catalog: RecipeCatalog; evidence: EvidenceStore; cases: CaseStore }): JobRunner {
  return async (job) => {
    try {
      const args = job.args as { claim_type: string; params?: Record<string, unknown> }
      const made = await createCase(deps, {
        claimType: args.claim_type, params: args.params ?? {}, geometry: job.aoi as GeoJSON.Geometry, owner: job.owner, jobId: job.id,
      })
      return { ok: true, resultId: made.id, resultStatus: made.verdict }
    } catch (err) {
      if (err instanceof ClaimInputError || err instanceof UnknownClaimType) return { ok: false, error: err.message.slice(0, 500), retryable: false }
      throw err
    }
  }
}

/** Dispatch on the job's `op`. */
export function createJobRunner(deps: { catalog: RecipeCatalog; evidence: EvidenceStore; cases: CaseStore }): JobRunner {
  const operation = createOperationRunner(deps.evidence)
  const claim = createClaimRunner(deps)
  return (job) => (job.op === VERIFY_CLAIM_OP ? claim(job) : operation(job))
}
