/** The evidence ledger (Q-47, ADR-0001 §6): the executed plan graph of one request, with the
 *  content hashes that link every node to its stored `GeoResult`.
 *
 *  Pure: no database, no I/O. `LedgerRecorder` collects nodes while a request runs; the route
 *  persists the finished run through an `EvidenceStore` (see `evidence-store.ts`). `compareRerun`
 *  says, node by node, whether a re-execution reproduced the stored result and, when it did
 *  not, why.
 */

import type { GeoResult } from '@/lib/geo-result'

import { canonicalJson } from './hash'
import { referencedNodes, resolveFromNode } from './plan'

export type NodeStatus = GeoResult['status'] | 'skipped'

export interface LedgerNode {
  /** Position in the run, in the order the nodes started. Other nodes refer to this. */
  idx: number
  op: string
  version: string
  /** The arguments as the plan gave them, except that plan references are written `${node:<idx>}`
   *  with the idx of another node of this run, so a re-run can resolve them to new result ids. */
  args: Record<string, unknown>
  dependsOn: number[]
  inputsHash: string | null
  resultId: string | null
  status: NodeStatus
  /** Served from the result cache: nothing was recomputed for this request. */
  cached: boolean
  startedAt: string
  ms: number
}

export interface LedgerRun {
  id: string
  ownerToken: string | null
  query: string | null
  aoi: unknown
  focus: { lat: number; lng: number } | null
  createdAt: string
  nodes: LedgerNode[]
}

/** What a run needs besides its nodes to be persisted and re-executed. */
export interface LedgerRunInput {
  ownerToken: string | null
  query: string | null
  aoi: unknown
  focus: { lat: number; lng: number } | null
  nodes: LedgerNode[]
}

export class LedgerRecorder {
  private nodes: LedgerNode[] = []
  /** Plan step index (absolute, across replans) to node idx. */
  private nodeOfStep = new Map<number, number>()

  /** Start a node. `plan` is present for a step of a submitted plan: its step index, the index
   *  its local `from_node` references count from, and the arguments exactly as the plan wrote
   *  them. Returns the node idx. */
  start(op: { name: string; version?: string }, args: Record<string, unknown>, plan?: { step: number; refBase: number; dependsOn?: number[] }, now = Date.now()): number {
    const idx = this.nodes.length
    const toNode = (local: number) => this.nodeOfStep.get((plan?.refBase ?? 0) + local)
    const stored = plan ? resolveFromNode(args, (n) => `\${node:${toNode(n) ?? -1}}`) : args
    const deps = plan
      ? [...new Set([...(plan.dependsOn ?? []), ...referencedNodes(args)])].map(toNode).filter((n): n is number => n != null)
      : []
    this.nodes.push({
      idx, op: op.name, version: op.version ?? '', args: stored, dependsOn: deps.sort((a, b) => a - b),
      inputsHash: null, resultId: null, status: 'failed', cached: false, startedAt: new Date(now).toISOString(), ms: 0,
    })
    if (plan) this.nodeOfStep.set(plan.step, idx)
    return idx
  }

  /** A node that was never run because something it depends on did not produce a result. */
  skipped(op: { name: string; version?: string }, args: Record<string, unknown>, plan: { step: number; refBase: number; dependsOn?: number[] }, now = Date.now()): number {
    const idx = this.start(op, args, plan, now)
    this.nodes[idx].status = 'skipped'
    return idx
  }

  finish(idx: number, result: GeoResult, now = Date.now()): void {
    const n = this.nodes[idx]
    n.version = result.op.version
    n.inputsHash = result.provenance.inputs_hash
    n.resultId = result.result_id
    n.status = result.status
    n.cached = result.provenance.cached === true
    n.ms = Math.max(0, now - Date.parse(n.startedAt))
  }

  get snapshot(): LedgerNode[] {
    return this.nodes.map((n) => ({ ...n }))
  }

  get size(): number {
    return this.nodes.length
  }
}

// ---------------------------------------------------------------------------
// Export shape
// ---------------------------------------------------------------------------

/** A node as exported: the graph plus, for each result, what it was built from. */
export interface LedgerExportNode extends LedgerNode {
  provenance: { sources: string[]; items: string[]; method: string; date?: string } | null
  computedAt: string | null
  stats: GeoResult['stats'] | null
}

export interface LedgerExport {
  runId: string
  createdAt: string
  query: string | null
  aoi: unknown
  focus: { lat: number; lng: number } | null
  nodes: LedgerExportNode[]
}

/** The ledger of a run with each node's provenance joined in from its stored result. */
export function toLedgerExport(run: LedgerRun, results: Map<string, { result: GeoResult; computedAt: number }>): LedgerExport {
  return {
    runId: run.id,
    createdAt: run.createdAt,
    query: run.query,
    aoi: run.aoi,
    focus: run.focus,
    nodes: run.nodes.map((n) => {
      const stored = n.resultId ? results.get(n.resultId) : undefined
      const p = stored?.result.provenance
      return {
        ...n,
        provenance: p ? { sources: p.sources, items: p.items, method: p.method, ...(p.date ? { date: p.date } : {}) } : null,
        computedAt: stored ? new Date(stored.computedAt).toISOString() : null,
        stats: stored?.result.stats ?? null,
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// Re-run comparison
// ---------------------------------------------------------------------------

export interface RerunNode {
  idx: number
  op: string
  originalResultId: string | null
  newResultId: string | null
  outcome: 'reproduced' | 'changed' | 'not_run'
  /** Why, in words; always present unless the result reproduced with identical figures. */
  reason?: string
  /** Data items in the original result and not in the new one, and the reverse. */
  itemsRemoved?: string[]
  itemsAdded?: string[]
}

const sameStats = (a: GeoResult['stats'], b: GeoResult['stats']) => canonicalJson(a ?? null) === canonicalJson(b ?? null)

/** Compare a re-executed node to the stored original.
 *  - same `result_id` and same figures: reproduced;
 *  - same `inputs_hash` but a different `result_id`: the data items read differ (new or removed
 *    scenes, a new release), and they are listed;
 *  - a different `inputs_hash`: an upstream node changed, so this one was asked something else;
 *  - same `result_id` but different figures: same inputs and same data, yet another answer
 *    (a non-deterministic operation or changed code); reported, never glossed over. */
export function compareRerun(node: LedgerNode, original: GeoResult | null, fresh: GeoResult | null): RerunNode {
  const base = { idx: node.idx, op: node.op, originalResultId: node.resultId }
  if (!fresh) return { ...base, newResultId: null, outcome: 'not_run', reason: 'The node was not re-executed (its upstream did not produce a result).' }
  const out = { ...base, newResultId: fresh.result_id }
  if (fresh.status === 'failed' || fresh.status === 'refused') {
    return { ...out, outcome: 'not_run', reason: `Re-execution ${fresh.status}: ${fresh.summary.slice(0, 200)}` }
  }
  if (!original) return { ...out, outcome: 'changed', reason: 'The original result is not in the store, so only the new id can be reported.' }
  if (fresh.result_id === original.result_id) {
    return sameStats(original.stats, fresh.stats)
      ? { ...out, outcome: 'reproduced' }
      : { ...out, outcome: 'changed', reason: 'Same inputs and same data items, but the figures differ: the operation is not deterministic or its code changed.' }
  }
  if (fresh.provenance.inputs_hash !== original.provenance.inputs_hash) {
    return { ...out, outcome: 'changed', reason: 'The inputs differ: an upstream node produced a different result.' }
  }
  const before = new Set(original.provenance.items)
  const after = new Set(fresh.provenance.items)
  const itemsRemoved = [...before].filter((i) => !after.has(i))
  const itemsAdded = [...after].filter((i) => !before.has(i))
  return { ...out, outcome: 'changed', itemsRemoved, itemsAdded, reason: 'The same request now reads different data items (see itemsAdded / itemsRemoved).' }
}
