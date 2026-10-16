/** P7.2 — Prometheus metrics exposition.
 *
 *  GET /api/metrics returns process-local counters in Prometheus text format:
 *    - geoagent_tool_calls_total{tool,status}        (counter)
 *    - geoagent_tool_duration_seconds{tool}          (histogram)
 *    - geoagent_stage_duration_seconds{tool,stage}   (histogram)
 *    - geoagent_cache_hits_total{source}             (counter)
 *    - geoagent_cache_misses_total{source}           (counter)
 *    - geoagent_inflight_requests                    (gauge)
 *
 *  Counters are in-memory and reset on restart (no PII in labels). Scrape with
 *  Prometheus or `curl … | promtool check metrics`.
 *
 *  Access: open when METRICS_TOKEN is unset (local dev, a private network). When it is set, the
 *  request must send `Authorization: Bearer <METRICS_TOKEN>`, else 401. Set it on any public
 *  deployment.
 */

import { timingSafeEqual } from 'node:crypto'

import { getCacheStatsBySource, getInflightCount } from '../agent/lib/cache'
import { getStageMetrics, getToolMetrics, renderPrometheus } from '../agent/lib/metrics'

export const dynamic = 'force-dynamic'

function authorized(req: Request, token: string | undefined): boolean {
  if (!token) return true
  const m = /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')
  if (!m) return false
  const a = Buffer.from(m[1])
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function GET(req: Request) {
  if (!authorized(req, process.env.METRICS_TOKEN?.trim())) {
    return new Response('unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' } })
  }
  const body = renderPrometheus(getToolMetrics(), getCacheStatsBySource(), getInflightCount(), getStageMetrics())
  return new Response(body, {
    status: 200,
    headers: {
      // Prometheus text exposition format v0.0.4.
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
