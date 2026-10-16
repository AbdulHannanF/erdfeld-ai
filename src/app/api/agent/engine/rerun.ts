/** Re-execute a ledger node by node and say, for each, whether the stored result reproduced
 *  (Q-47). Cached results are bypassed (`cache: 'refresh'`): a re-run that read the cache would
 *  prove nothing. Models and LLM settings are not stored in the ledger (no secrets are kept), so
 *  an operation that needs them is reported as not re-run, never as reproduced. */

import type { GeoResult } from '@/lib/geo-result'

import { runOperation, type RunEnv } from './execute'
import type { EvidenceStore } from './evidence-store'
import { compareRerun, type LedgerRun, type RerunNode } from './ledger'
import { resolveFromNode } from './plan'

export interface RerunReport {
  runId: string
  /** Every node that ran reproduced its stored result. */
  reproduced: boolean
  nodes: RerunNode[]
}

export async function rerunLedger(
  run: Pick<LedgerRun, 'id' | 'aoi' | 'focus' | 'nodes'>,
  evidence: EvidenceStore,
  env: Pick<RunEnv, 'now' | 'models' | 'llm'> = {},
): Promise<RerunReport> {
  const originals = await evidence.getResults(run.nodes.flatMap((n) => (n.resultId ? [n.resultId] : [])))
  const fresh = new Map<number, GeoResult>()
  const nodes: RerunNode[] = []
  for (const node of [...run.nodes].sort((a, b) => a.idx - b.idx)) {
    const original = node.resultId ? originals.get(node.resultId)?.result ?? null : null
    const upstream = node.dependsOn.map((d) => fresh.get(d))
    const blocked = node.status === 'skipped' || upstream.some((r) => !r || r.status === 'failed' || r.status === 'refused')
    if (blocked) {
      nodes.push(compareRerun(node, original, null))
      continue
    }
    const args = resolveFromNode(node.args, (n) => fresh.get(n)?.result_id ?? '')
    const result = await runOperation(node.op, args as Record<string, any>, {
      ...env,
      aoi: run.aoi,
      focus: run.focus ? { ...run.focus, kind: 'point' as const } : undefined,
      evidence,
      cache: 'refresh',
    })
    fresh.set(node.idx, result)
    nodes.push(compareRerun(node, original, result))
  }
  const ran = nodes.filter((n) => n.outcome !== 'not_run')
  return { runId: run.id, reproduced: ran.length > 0 && nodes.every((n) => n.outcome === 'reproduced'), nodes }
}

