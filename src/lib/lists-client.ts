import { getOwnerToken } from '@/lib/projects'
import type { JobProgress } from '@/store/useJobs'

/**
 * Client for the two owner-scoped list endpoints, `GET /api/ledger` (runs) and `GET /api/jobs`
 * (batches). The server is the truth; when it answers that it has no database (or cannot be
 * reached) the caller falls back to what this browser remembers in localStorage.
 */

export interface RunSummary {
  id: string
  query: string | null
  createdAt: string
  nodeCount: number
  operations: string[]
}

export interface BatchSummary {
  id: string
  label: string | null
  createdAt: string
  state: 'active' | 'finished'
  progress: JobProgress
  ops: string[]
  kind: 'tool' | 'claims'
}

export type ListResult<T> = { ok: true; items: T[]; nextCursor: string | null } | { ok: false; reason: 'no_database' | 'unreachable' }

async function list<T>(path: string, key: 'runs' | 'batches', cursor: string | undefined, limit: number, signal?: AbortSignal): Promise<ListResult<T>> {
  try {
    const qs = new URLSearchParams({ limit: String(limit) })
    if (cursor) qs.set('cursor', cursor)
    const res = await fetch(`${path}?${qs}`, { headers: { 'x-owner-token': getOwnerToken() }, cache: 'no-store', signal })
    if (res.status === 503) return { ok: false, reason: 'no_database' }
    if (!res.ok) return { ok: false, reason: 'unreachable' }
    const body = (await res.json()) as Record<string, unknown>
    return { ok: true, items: (body[key] as T[]) ?? [], nextCursor: (body.nextCursor as string | null) ?? null }
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
}

export const fetchRuns = (cursor?: string, limit = 15, signal?: AbortSignal) => list<RunSummary>('/api/ledger', 'runs', cursor, limit, signal)
export const fetchBatches = (cursor?: string, limit = 30, signal?: AbortSignal) => list<BatchSummary>('/api/jobs', 'batches', cursor, limit, signal)
