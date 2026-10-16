import { STORAGE_KEYS, readJson, writeJson } from '@/lib/storage'

/**
 * The evidence-ledger runs this browser started, newest first. The ledger itself lives on the
 * server and is owner-scoped; there is no endpoint that lists it, so the ids are kept here to make
 * Activity history reachable after a reload. Only the id, the question and the time are stored.
 */
export interface LoggedRun {
  id: string
  query: string | null
  at: number
}

const MAX_RUNS = 50

export function readRuns(): LoggedRun[] {
  return readJson<LoggedRun[]>(STORAGE_KEYS.runs, []).filter((r) => r && typeof r.id === 'string')
}

export function rememberRun(id: string, query: string | null): void {
  const rest = readRuns().filter((r) => r.id !== id)
  writeJson(STORAGE_KEYS.runs, [{ id, query, at: Date.now() }, ...rest].slice(0, MAX_RUNS))
}
