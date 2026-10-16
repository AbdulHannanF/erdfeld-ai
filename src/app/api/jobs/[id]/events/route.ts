/**
 * Q-24 — progress of a batch as Server-Sent Events.
 *
 *   GET /api/jobs/:id/events   (resume with `Last-Event-ID` or `?after=<id>`)
 *
 * Replays the batch's events from the start (or the cursor), then follows new ones until
 * `batch_done`. Events are rows of `JobEvent`, so any server process can serve any batch and a
 * server restart loses nothing. Same owner scoping as GET /api/jobs/:id.
 */

import { NextRequest, NextResponse } from 'next/server'

import { getRequestOwner } from '@/lib/auth'
import { db } from '@/lib/db'
import { failExhausted } from '@/lib/jobs/queue'
import { renewJobLeases } from '@/lib/jobs/start'
import { canAccessProject } from '@/lib/projects'

export const dynamic = 'force-dynamic'

const POLL_MS = 500
const KEEPALIVE_MS = 15_000

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const batch = await db.jobBatch.findUnique({ where: { id }, select: { ownerToken: true } })
  if (!batch) return NextResponse.json({ error: 'Job batch not found' }, { status: 404 })
  if (!canAccessProject(batch.ownerToken, await getRequestOwner(req))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const start = Number(req.headers.get('last-event-id') ?? req.nextUrl.searchParams.get('after') ?? 0)
  let cursor = Number.isInteger(start) && start > 0 ? start : 0

  const enc = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false
      const close = () => { if (!closed) { closed = true; try { controller.close() } catch { /* already closed */ } } }
      req.signal.addEventListener('abort', close)
      let lastWrite = Date.now()
      try {
        while (!closed) {
          // Following a batch keeps this process's own jobs leased and settles lost ones (see GET /api/jobs/:id).
          await renewJobLeases()
          await failExhausted(db, id)
          const events = await db.jobEvent.findMany({ where: { batchId: id, id: { gt: cursor } }, orderBy: { id: 'asc' }, take: 200 })
          for (const e of events) {
            controller.enqueue(enc.encode(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`))
            cursor = e.id
            lastWrite = Date.now()
            if (e.type === 'batch_done') return close()
          }
          if (events.length === 200) continue
          if (Date.now() - lastWrite > KEEPALIVE_MS) {
            controller.enqueue(enc.encode(': keepalive\n\n'))
            lastWrite = Date.now()
          }
          await new Promise((r) => setTimeout(r, POLL_MS))
        }
      } catch {
        // database unreachable: end the stream; the client resumes from its last id
        close()
      }
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' },
  })
}
