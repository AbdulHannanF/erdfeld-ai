/** Reading the job queue's Server-Sent Events (GET /api/jobs/:id/events) with `fetch`, because
 *  `EventSource` cannot send the `x-owner-token` header that scopes a batch to its owner. */

export interface JobStreamEvent {
  id: number | null
  type: string
  data: any
}

/** Split an SSE text buffer into complete events and the unfinished remainder. Comments
 *  (keepalives) are dropped. */
export function parseSse(buffer: string): { events: JobStreamEvent[]; rest: string } {
  const parts = buffer.split('\n\n')
  const rest = parts.pop() ?? ''
  const events: JobStreamEvent[] = []
  for (const block of parts) {
    let id: number | null = null
    let type = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) id = Number(line.slice(3).trim())
      else if (line.startsWith('event:')) type = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trim())
    }
    if (!data.length) continue
    try {
      events.push({ id: Number.isFinite(id) ? id : null, type, data: JSON.parse(data.join('\n')) })
    } catch { /* a malformed event is skipped */ }
  }
  return { events, rest }
}

/** Follow a batch until `batch_done`, the stream ending, or `signal` aborting. Resolves with the
 *  id of the last event seen (to resume from) and whether the batch finished. Rejects when the
 *  stream cannot be opened. */
export async function followJobEvents(
  batchId: string, headers: Record<string, string>, onEvent: (e: JobStreamEvent) => void, signal: AbortSignal, after = 0,
): Promise<{ last: number; done: boolean }> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(batchId)}/events?after=${after}`, { headers, signal })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let last = after
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return { last, done: false }
    buf += dec.decode(value, { stream: true })
    const { events, rest } = parseSse(buf)
    buf = rest
    for (const e of events) {
      if (e.id != null) last = e.id
      onEvent(e)
      if (e.type === 'batch_done') return { last, done: true }
    }
  }
}
