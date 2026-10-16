/**
 * Erdfeld AI agent endpoint: validates the request and streams the agent loop (./loop.ts) as SSE.
 * Keep this file thin: transport, abort and heartbeat only.
 */

import { NextRequest } from 'next/server'

import { runWithCacheContext } from './lib/cache'
import { runAgent } from './loop'
import { getLogger } from './lib/logger'
import { resolveLlmConfig } from './lib/providers'
import { getRequestOwner } from '@/lib/auth'
import { AgentRequestSchema, BODY_LIMITS, parseBody } from '@/lib/api-schemas'
import { enforceRateLimit } from '@/lib/rate-limit'

const log = getLogger('agent/route')

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const limited = await enforceRateLimit(req, 'agent')
  if (limited) return limited
  const parsedBody = await parseBody(req, AgentRequestSchema, { max: BODY_LIMITS.agent })
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data
  const owner = await getRequestOwner(req)

  const startedAt = Date.now()
  const encoder = new TextEncoder()
  // Request-scoped abort. The SSE stream's `cancel()` fires when the client disconnects (the
  // browser AbortController, a closed tab, a navigation); aborting here propagates into every
  // upstream fetch (the model stream, and `fetchWithRetry` via the cache context) so we stop
  // hitting free APIs for a reader that has gone away.
  let closed = false
  const upstreamAbort = new AbortController()
  // Next.js also exposes the connection's abort on `req.signal`.
  if (req.signal) {
    if (req.signal.aborted) upstreamAbort.abort()
    else req.signal.addEventListener('abort', () => { closed = true; upstreamAbort.abort() }, { once: true })
  }

  const stream = new ReadableStream({
    async start(controller) {
      // The client must always get a terminal event: `done`, preceded by `error` when the run failed.
      // Tracked here and enforced in `finally`, so no path (a throw outside the loop, an abort that is
      // not a client disconnect, an early return) can end the stream silently. A process crash cannot
      // be caught; map_flood and the Overture reads are memory-bounded so that none is expected.
      let doneSent = false
      let errorSent = false
      const emit = (event: string, data: any) => {
        if (event === 'done') doneSent = true
        else if (event === 'error') errorSent = true
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          closed = true
        }
      }

      // SSE heartbeat: a comment line every 15 s so the connection carries bytes while the model
      // is silent (a cold Ollama load can take ~45 s, and proxies like nginx drop idle streams at
      // 60 s). Comments are ignored by SSE parsers.
      const heartbeat = setInterval(() => {
        if (closed) { clearInterval(heartbeat); return }
        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`))
        } catch {
          closed = true
          clearInterval(heartbeat)
        }
      }, 15_000)

      try {
        // Provider, key, base URL and model: the request's choices, the server's default provider
        // and the server-held keys (see lib/providers.ts).
        const resolved = resolveLlmConfig({ provider: body.aiProvider, apiKey: body.aiApiKey, baseUrl: body.aiBaseUrl, model: body.aiModel })
        if (!resolved.ok) {
          emit('error', { type: 'error', content: resolved.message })
          emit('done', { type: 'done' })
          return
        }
        await runWithCacheContext(
          {
            // Info-only cache telemetry, emitted under DEBUG_AGENT so it never reaches users by default.
            onCacheHit: (key, source) => {
              if (process.env.DEBUG_AGENT) emit('cache_hit', { type: 'cache_hit', source: source ?? null, key: key.slice(0, 80) })
            },
            abortSignal: upstreamAbort.signal,
          },
          () => runAgent({
            aoi: body.aoi,
            query: body.query,
            lang: body.lang,
            focus: body.focus ? { lat: body.focus.lat, lng: body.focus.lng, kind: 'point' as const } : undefined,
            layers: body.layers,
            customModels: body.customModels,
            owner,
            llm: resolved.config,
            emit,
            signal: upstreamAbort.signal,
            startedAt,
          }),
        )
      } catch (error: any) {
        if (!upstreamAbort.signal.aborted) {
          log.error({ err: error?.message }, 'agent request failed outside the loop')
          emit('error', { type: 'error', content: error?.message || 'Unknown error' })
        }
      } finally {
        if (!doneSent) {
          if (!errorSent) emit('error', { type: 'error', content: 'The run ended before it produced a result. Please try again.' })
          emit('done', { type: 'done' })
        }
        closed = true
        clearInterval(heartbeat)
        try { controller.close() } catch {}
      }
    },
    // Fired by the platform when the client disconnects: abort every in-flight upstream fetch and
    // stop the loop instead of finishing work nobody will read.
    cancel() {
      closed = true
      upstreamAbort.abort()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
