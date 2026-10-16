import { create } from 'zustand'
import { STORAGE_KEYS, readJson, writeJson } from '@/lib/storage'

/**
 * The batches this browser queued: a tool run from the Processing toolbox, or a claim batch from
 * "Verify a claim". The server owns the truth (`GET /api/jobs/:id`); this keeps the ids so the Jobs
 * tab can list them and the poller can follow them. Only ids, labels and the last state seen are
 * persisted: never results.
 */

export interface JobProgress {
  total: number
  queued: number
  running: number
  done: number
  failed: number
}

export interface TrackedJob {
  idx: number
  op: string
  status: string
  resultId: string | null
  resultStatus: string | null
  error: string | null
  /** Running, but its worker stopped renewing the lease: it is being, or will be, retried. */
  stalled?: boolean
}

export interface TrackedBatch {
  id: string
  label: string
  /** `tool` runs draw their results on the map when finished; `claims` open on their own page. */
  kind: 'tool' | 'claims'
  op?: string
  createdAt: number
  /** Where "Open" goes, for a batch with its own page. */
  href?: string
  state: 'active' | 'finished' | 'missing' | 'error'
  progress?: JobProgress
  jobs?: TrackedJob[]
  /** Set once the results were fetched and drawn, so a reload does not draw them twice. */
  applied?: boolean
  error?: string
}

const MAX_TRACKED = 30

interface JobsState {
  batches: TrackedBatch[]
  hydrate: () => void
  track: (b: Omit<TrackedBatch, 'createdAt' | 'state'> & { state?: TrackedBatch['state'] }) => void
  patch: (id: string, patch: Partial<TrackedBatch>) => void
  remove: (id: string) => void
  clearFinished: () => void
}

function persist(batches: TrackedBatch[]): void {
  writeJson(
    STORAGE_KEYS.jobs,
    batches.map((b) => ({ ...b, jobs: undefined })),
  )
}

export const useJobs = create<JobsState>((set, get) => ({
  batches: [],
  hydrate: () => set({ batches: readJson<TrackedBatch[]>(STORAGE_KEYS.jobs, []).filter((b) => b && typeof b.id === 'string') }),
  track: (b) => {
    const next = [{ ...b, createdAt: Date.now(), state: b.state ?? 'active' } as TrackedBatch, ...get().batches.filter((x) => x.id !== b.id)].slice(0, MAX_TRACKED)
    persist(next)
    set({ batches: next })
  },
  patch: (id, patch) => {
    const next = get().batches.map((b) => (b.id === id ? { ...b, ...patch } : b))
    persist(next)
    set({ batches: next })
  },
  remove: (id) => {
    const next = get().batches.filter((b) => b.id !== id)
    persist(next)
    set({ batches: next })
  },
  clearFinished: () => {
    const next = get().batches.filter((b) => b.state === 'active')
    persist(next)
    set({ batches: next })
  },
}))
