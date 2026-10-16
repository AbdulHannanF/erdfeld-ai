import type { GeoResult } from '@/lib/geo-result'

import type { EvidenceStore, PutOptions, StoredResult } from '../evidence-store'
import type { LedgerRun, LedgerRunInput } from '../ledger'

/** In-memory EvidenceStore for tests of the executor and the re-run. */
export function memoryStore() {
  const rows = new Map<string, StoredResult & { cacheKey: string | null; expiresAt: number | null }>()
  const runs = new Map<string, LedgerRun>()
  const puts: Array<{ result: GeoResult; opts: PutOptions }> = []
  const store: EvidenceStore = {
    async lookup(cacheKey, now) {
      return [...rows.values()].filter((r) => r.cacheKey === cacheKey && (r.expiresAt == null || r.expiresAt > now)).sort((a, b) => b.computedAt - a.computedAt)[0] ?? null
    },
    async put(result, opts) {
      puts.push({ result, opts })
      rows.set(result.result_id, { result, computedAt: opts.now, cacheKey: opts.cacheKey, expiresAt: opts.expiresAt })
    },
    async getResult(id) { return rows.get(id) ?? null },
    async getResults(ids) { return new Map(ids.flatMap((i) => (rows.has(i) ? [[i, rows.get(i)!] as const] : []))) },
    async saveRun(run: LedgerRunInput) {
      const id = `run${runs.size + 1}`
      runs.set(id, { ...run, id, createdAt: new Date(0).toISOString() })
      return id
    },
    async getRun(id) { return runs.get(id) ?? null },
    async canReadResult() { return true },
  }
  return { store, rows, runs, puts }
}
