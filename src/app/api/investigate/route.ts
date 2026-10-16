/**
 * Autonomous investigator endpoint: validates the request and streams the investigation
 * (../agent/investigator/run.ts) as SSE. The events are typed in ../agent/investigator/events.ts.
 * Transport, abort and heartbeat only, like /api/agent; it shares that route's rate limit and
 * owner handling.
 */

import { NextRequest } from 'next/server'

import { runWithCacheContext } from '../agent/lib/cache'
import { resolveLlmConfig } from '../agent/lib/providers'
import { runInvestigation } from '../agent/investigator/run'
import { getRequestOwner } from '@/lib/auth'
import { BODY_LIMITS, InvestigateRequestSchema, parseBody } from '@/lib/api-schemas'
import { enforceRateLimit } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const limited = await enforceRateLimit(req, 'agent')
  if (limited) return limited
  const parsedBody = await parseBody(req, InvestigateRequestSchema, { max: BODY_LIMITS.investigate })
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data
  const owner = await getRequestOwner(req)

  const startedAt = Date.now()
  const encoder = new TextEncoder()
  let closed = false
  const upstreamAbort = new AbortController()
  if (req.signal) {
    if (req.signal.aborted) upstreamAbort.abort()
    else req.signal.addEventListener('abort', () => { closed = true; upstreamAbort.abort() }, { once: true })
  }

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: string, data: any) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          closed = true
        }
      }
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
        const resolved = resolveLlmConfig({ provider: body.aiProvider, apiKey: body.aiApiKey, baseUrl: body.aiBaseUrl, model: body.aiModel })
        if (!resolved.ok) {
          emit('error', { type: 'error', message: resolved.message, content: resolved.message })
          emit('done', { type: 'done' })
          return
        }
        await runWithCacheContext(
          { abortSignal: upstreamAbort.signal },
          () => runInvestigation({
            aoi: body.aoi,
            question: body.question,
            window: body.window,
            family: body.family,
            owner,
            llm: resolved.config,
            emit: emit as any,
            signal: upstreamAbort.signal,
            startedAt,
          }),
        )
      } finally {
        closed = true
        clearInterval(heartbeat)
        try { controller.close() } catch {}
      }
    },
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
