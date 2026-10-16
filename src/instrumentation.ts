/** Runs once when the Next server starts. The job worker (Q-24) lives in the server process by
 *  default: it works with `next dev`, `next start` and the standalone output alike, a restart of
 *  the server is a restart of the worker (leases hand its jobs to the next one), and replicas
 *  share the queue. Where CPU is throttled between requests (Cloud Run), run it with
 *  `--no-cpu-throttling`, or set JOB_WORKER=0 on the web service and run a second service for it. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { assertProductionConfig } = await import('./lib/prod-checks')
  const { getLogger } = await import('./app/api/agent/lib/logger')
  // Throws (the server does not start) on AGENT_ALLOW_STUB=1 in production.
  for (const problem of assertProductionConfig()) getLogger('startup').error(problem)
  const { startJobWorker } = await import('./lib/jobs/start')
  await startJobWorker()
}
