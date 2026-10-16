/** Starts the job worker once per server process (called from src/instrumentation.ts).
 *
 *  Settings (environment): JOB_WORKER=0 turns it off (e.g. an API-only replica), JOB_CONCURRENCY
 *  (default 2), JOB_POLL_MS (1000), JOB_LEASE_MS (60000: how long a crashed worker's job waits
 *  before another worker takes it), JOB_DRAIN_MS (25000: on SIGTERM/SIGINT, how long running jobs
 *  may finish before they are handed back to the queue).
 *
 *  Shutdown: once the worker runs, SIGTERM and SIGINT drain it instead of killing the process
 *  (see `shutdown`). The handler replaces Next's own signal handler for that process, so Next's
 *  cleanup (which closes the server and exits) is called only after the drain; it is not lost.
 */

import { defaultCaseStore } from '@/app/api/agent/engine/claims/case-store'
import { defaultCatalog } from '@/app/api/agent/engine/claims/loader'
import { defaultEvidenceStore } from '@/app/api/agent/engine/evidence-store'
import { getLogger } from '@/app/api/agent/lib/logger'
import { db } from '@/lib/db'

import { createJobRunner } from './runner'
import { startWorker, type Worker } from './worker'

const log = getLogger('jobs/start')

const KEY = Symbol.for('geoagent.jobWorker')
const HANDLERS_KEY = Symbol.for('geoagent.jobWorkerSignals')
const g = globalThis as unknown as Record<symbol, Worker | boolean | undefined>

const num = (name: string, dflt: number) => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : dflt
}

/** Grace period for running jobs on shutdown. 0 is allowed: hand every running job back at once. */
export function drainMs(): number {
  const raw = process.env.JOB_DRAIN_MS
  const n = Number(raw)
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : 25_000
}

export async function startJobWorker(): Promise<void> {
  if (process.env.JOB_WORKER === '0' || g[KEY]) return
  const evidence = await defaultEvidenceStore()
  g[KEY] = startWorker({
    db,
    run: createJobRunner({ evidence, catalog: defaultCatalog(), cases: await defaultCaseStore() }),
    concurrency: num('JOB_CONCURRENCY', 2),
    pollMs: num('JOB_POLL_MS', 1000),
    leaseMs: num('JOB_LEASE_MS', 60_000),
  })
  installSignalHandlers()
}

/** Renew the leases of the jobs this process is running. Called by the request handlers that follow a
 *  batch: on a host that throttles CPU between requests the worker's own timers do not run, but a
 *  request does, so the lease is extended whenever someone is looking. No-op without a worker. */
export async function renewJobLeases(): Promise<number> {
  const worker = g[KEY] as Worker | undefined
  if (!worker) return 0
  try {
    return await worker.renewLeases()
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'could not renew job leases')
    return 0
  }
}

/** Stop claiming, wait up to `graceMs` for running jobs, hand back the rest. No-op without a worker. */
export async function drainJobWorker(graceMs: number = drainMs()): Promise<void> {
  const worker = g[KEY] as Worker | undefined
  if (!worker) return
  const result = await worker.stop({ graceMs })
  log.info({ ...result, graceMs }, 'job worker drained')
}

type Signal = 'SIGTERM' | 'SIGINT'

/** Take over SIGTERM/SIGINT for this process. Listeners that were already installed (Next's
 *  cleanup) are kept and called after the drain. A second signal during the drain uses the default
 *  action (the process ends at once), because nothing else is listening any more. */
function installSignalHandlers(): void {
  if (g[HANDLERS_KEY]) return
  g[HANDLERS_KEY] = true
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    const earlier = process.listeners(sig) as Array<(s: Signal) => void>
    process.removeAllListeners(sig)
    process.once(sig, () => { void shutdown(sig, earlier) })
  }
}

async function shutdown(sig: Signal, earlier: Array<(s: Signal) => void>): Promise<void> {
  log.info({ signal: sig }, 'shutdown requested: draining the job worker')
  try {
    await drainJobWorker()
  } catch (err) {
    log.error({ err: (err as Error).message }, 'drain failed; jobs will be re-claimed when their leases expire')
  }
  if (earlier.length > 0) for (const listener of earlier) listener(sig)
  else process.exit(sig === 'SIGINT' ? 130 : 143)
}
