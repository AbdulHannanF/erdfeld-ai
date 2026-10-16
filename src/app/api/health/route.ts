/** P7.2 — health endpoint (replaces the May-18 trivial `{status:'ok'}` stub).
 *
 *  GET /api/health probes what the app depends on, in parallel, each probe with a 2 s timeout:
 *    - `database`  — `SELECT 1` through Prisma. Required: without it nothing can be served.
 *    - `stac`, `overpass` — the public data upstreams the agent calls. `overpass` probes every
 *      mirror `query_osm` fails over to and is `ok` while any one answers.
 *    - `geo`       — the Python geo service's `/health`; `not configured` when GEO_SERVICE_URL is unset.
 *    - `titiler`   — the raster tile server's `/healthz` (TITILER_ENDPOINT, default titiler.xyz).
 *    - `llm`       — client-configured, so never probed (informational Ollama probe if OLLAMA_BASE_URL is set).
 *
 *  Status:
 *    - `down` with HTTP 503 when the database check fails: the app cannot serve.
 *    - `degraded` with HTTP 200 when the database is up and any other dependency is down or erroring.
 *      The app still works through its fallbacks, but something needs attention.
 *    - `ok` with HTTP 200 when every configured dependency responds (`not configured` counts as fine).
 *
 *  In production, a `config` array lists misconfigurations (e.g. no EVIDENCE_SIGNING_KEY) and an
 *  otherwise `ok` status becomes `degraded`.
 *
 *  Each check value is `ok`, `not configured`, `degraded: …` (HTTP 5xx), `down: …` (no answer in time
 *  or a network error) or, for `llm`, `client-configured`. A probe never throws.
 */

import { geoAuthHeaders } from '@/app/api/agent/lib/geo-auth'
import { geoServiceUrl } from '@/app/api/agent/lib/geo-service'
import { getLogger } from '@/app/api/agent/lib/logger'
import { OVERPASS_USER_AGENT, overpassEndpoints } from '@/app/api/agent/lib/overpass'
import { resolveTitilerBase } from '@/app/api/agent/lib/titiler'
import { db } from '@/lib/db'
import { productionConfigProblems } from '@/lib/prod-checks'

export const dynamic = 'force-dynamic'

const log = getLogger('api/health')

const STAC_ENDPOINT = process.env.STAC_ENDPOINT || 'https://earth-search.aws.element84.com/v1'
/** Every probe gives up after this long, so the whole endpoint answers in about 2 s. */
export const PROBE_TIMEOUT_MS = 2000

type CheckResult = 'ok' | string

const errorText = (err: unknown) =>
  (err as Error)?.name === 'TimeoutError' ? 'timeout' : ((err as Error)?.message || 'unreachable').split('\n')[0].slice(0, 200)

/** Reachability probe. Any HTTP response < 500 = reachable (`ok`), or with `requireOk` only a 2xx;
 *  otherwise degraded; network error / timeout = down. Never throws. */
async function ping(name: string, url: string, init?: RequestInit, requireOk = false): Promise<CheckResult> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (res.status >= 500 || (requireOk && !res.ok)) return `degraded: HTTP ${res.status}`
    return 'ok'
  } catch (err) {
    const msg = errorText(err)
    log.warn({ check: name, url, err: msg }, 'health probe failed')
    return `down: ${msg}`
  }
}

/** A minimal Overpass query: cheap, and it confirms the interpreter runs. A mirror counts as up
 *  only on a 2xx to the same User-Agent `query_osm` sends, since a 403 or 429 means it refuses us. */
const OVERPASS_PROBE = `?data=${encodeURIComponent('[out:json][timeout:5];out count;')}`

/** Every Overpass mirror, in parallel. `ok` when any one answers, since `query_osm` then works, so
 *  one public mirror's outage does not mark the app degraded. Otherwise each mirror with its
 *  reason: `degraded` if one answered with an error, `down` if none answered. Never throws. */
async function probeOverpass(): Promise<CheckResult> {
  const endpoints = overpassEndpoints()
  const init = { headers: { 'User-Agent': OVERPASS_USER_AGENT } }
  const results = await Promise.all(endpoints.map((url) => ping('overpass', `${url}${OVERPASS_PROBE}`, init, true)))
  if (results.includes('ok')) return 'ok'
  const reasons = endpoints.map((url, i) => `${url.replace(/^https?:\/\//, '').split('/')[0]} ${results[i].replace(/^(down|degraded):\s*/, '')}`)
  return `${results.some((r) => r.startsWith('degraded')) ? 'degraded' : 'down'}: no mirror answered (${reasons.join('; ')})`
}

/** `SELECT 1` through the Prisma client, with the same timeout. Never throws. */
async function probeDatabase(): Promise<CheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), PROBE_TIMEOUT_MS)
      }),
    ])
    return 'ok'
  } catch (err) {
    const msg = errorText(err)
    log.error({ check: 'database', err: msg }, 'health probe failed')
    return `down: ${msg}`
  } finally {
    clearTimeout(timer)
  }
}

/** Geo service `/health`, only when GEO_SERVICE_URL is set. */
async function probeGeo(): Promise<CheckResult> {
  const base = geoServiceUrl()
  if (!base) return 'not configured'
  // The geo service may sit behind Cloud Run IAM; an unauthenticated probe would read its 403 as "ok".
  const auth = await geoAuthHeaders()
  if (auth === null) return 'down: could not get an ID token for the geo service'
  return ping('geo', `${base.replace(/\/+$/, '')}/health`, { headers: auth })
}

/** Optional Ollama probe — runs only when `OLLAMA_BASE_URL` is set (the provider is
 *  normally client-configured, so the server probes nothing by default). Reports the
 *  installed model list (`/api/tags`), currently-loaded models with their VRAM
 *  footprint (`/api/ps`), and round-trip latency. Never fabricates: any failure is
 *  reported as the literal error. */
async function probeOllama(baseUrl: string): Promise<Record<string, unknown>> {
  const base = baseUrl.replace(/\/+$/, '')
  const started = Date.now()
  try {
    const tagsRes = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!tagsRes.ok) return { status: `down: HTTP ${tagsRes.status}`, endpoint: base }
    const tags = (await tagsRes.json()) as { models?: { name: string }[] }
    const latencyMs = Date.now() - started

    // Loaded models + VRAM (best-effort — older Ollama versions lack /api/ps).
    let loaded: { name: string; vramBytes?: number }[] | undefined
    try {
      const psRes = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      if (psRes.ok) {
        const ps = (await psRes.json()) as { models?: { name: string; size_vram?: number }[] }
        loaded = (ps.models ?? []).map((m) => ({ name: m.name, vramBytes: m.size_vram }))
      }
    } catch {
      // /api/ps unavailable — omit the field rather than inventing it
    }

    return {
      status: 'ok',
      endpoint: base,
      latencyMs,
      models: (tags.models ?? []).map((m) => m.name),
      ...(loaded ? { loaded } : {}),
    }
  } catch (err) {
    const msg = errorText(err)
    log.warn({ check: 'ollama', url: base, err: msg }, 'health probe failed')
    return { status: `down: ${msg}`, endpoint: base }
  }
}

export async function GET() {
  const ollamaBase = process.env.OLLAMA_BASE_URL
  const [database, stac, overpass, geo, titiler, ollama] = await Promise.all([
    probeDatabase(),
    ping('stac', STAC_ENDPOINT),
    probeOverpass(),
    probeGeo(),
    ping('titiler', `${resolveTitilerBase(process.env.TITILER_ENDPOINT)}/healthz`),
    ollamaBase ? probeOllama(ollamaBase) : Promise.resolve(null),
  ])

  // The Ollama probe is informational (opt-in via OLLAMA_BASE_URL) — it does not
  // drag down the aggregate, because the provider is normally client-configured
  // and the data tools work regardless of any one LLM backend.
  let status: 'ok' | 'degraded' | 'down'
  if (database !== 'ok') status = 'down'
  else if ([stac, overpass, geo, titiler].every((c) => c === 'ok' || c === 'not configured')) status = 'ok'
  else status = 'degraded'

  // Production misconfiguration (see lib/prod-checks.ts) is reported, never hidden: `degraded`.
  const configErrors = productionConfigProblems().errors
  if (configErrors.length > 0 && status === 'ok') status = 'degraded'

  return Response.json(
    {
      status,
      ...(configErrors.length > 0 ? { config: configErrors } : {}),
      checks: {
        database,
        stac,
        overpass,
        geo,
        titiler,
        // Informational: the server can't probe a client-configured provider.
        llm: ollama ?? 'client-configured',
      },
      time: new Date().toISOString(),
    },
    { status: status === 'down' ? 503 : 200, headers: { 'Cache-Control': 'no-store' } },
  )
}
