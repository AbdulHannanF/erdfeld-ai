/**
 * A headless stand-in for useAgentWS: POSTs the SAME payload shape the browser
 * sends and parses the SAME SSE contract, so anything it observes is something a
 * real user could observe. Returns a structured record rather than rendering.
 */

const BASE = process.env.QA_APP_BASE || 'http://localhost:3000'

/** Run one agent query end-to-end. Never throws — failures come back as fields. */
export async function runAgentQuery({ aoi, query, lang = 'en', layers = [], timeoutMs = 420_000 }) {
  const t0 = Date.now()
  const rec = {
    query,
    lang,
    ok: false,
    http: null,
    ttft_ms: null,
    total_ms: null,
    answer: '',
    thinking_chars: 0,
    events: {},
    tools: [],
    plan: null,
    layers: [],
    citations: [],
    weather: false,
    air_quality: false,
    temporal_frames: 0,
    errors: [],
    transport_error: null,
  }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)

  try {
    const res = await fetch(`${BASE}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aoi, query, lang, layers }),
      signal: ac.signal,
    })
    rec.http = res.status
    if (!res.ok) {
      rec.transport_error = `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`
      rec.total_ms = Date.now() - t0
      return rec
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      // SSE frames are separated by a blank line; keep the trailing partial.
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''

      for (const frame of frames) {
        let event = 'message'
        const dataLines = []
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
          // ':' comment lines are the heartbeat — ignored, as a real SSE parser does.
        }
        if (!dataLines.length) continue

        let data
        try { data = JSON.parse(dataLines.join('\n')) } catch { continue }
        rec.events[event] = (rec.events[event] || 0) + 1

        switch (event) {
          case 'token': {
            const text = typeof data === 'string' ? data : (data?.content ?? data?.text ?? '')
            if (text) {
              if (rec.ttft_ms === null) rec.ttft_ms = Date.now() - t0
              rec.answer += text
            }
            break
          }
          case 'thinking':
            rec.thinking_chars += String(data?.content ?? data ?? '').length
            break
          case 'tool_call':
            // The route emits `tool_name` (see route.ts emit('tool_call', …)).
            // Reading `tool`/`name` here silently produced undefined for every
            // call, so the judge was told "no tools ran" while citations proved
            // otherwise. Keep the fallbacks, but `tool_name` is the contract.
            rec.tools.push({
              tool: data?.tool_name ?? data?.tool ?? data?.name,
              status: data?.status,
              label: data?.label,
              error: data?.error,
              result_id: data?.result_id,
              result_summary: data?.result_summary,
            })
            break
          case 'plan':
            rec.plan = Array.isArray(data?.steps)
              ? data.steps.map((s) => ({ id: s.id, tool: s.tool, depends_on: s.depends_on }))
              : data
            break
          case 'layer':
            rec.layers.push({
              tool: data?.tool,
              name: data?.name,
              type: data?.type,
              result_id: data?.result_id ?? data?.resultId,
              provenance: data?.provenance,
              confidence: data?.confidence,
            })
            break
          case 'weather': rec.weather = true; break
          case 'air_quality': rec.air_quality = true; break
          case 'temporal_frame': rec.temporal_frames++; break
          case 'error': rec.errors.push(String(data?.message ?? data?.error ?? JSON.stringify(data)).slice(0, 300)); break
          case 'done': rec.ok = true; break
        }
      }
    }
  } catch (err) {
    rec.transport_error = String(err?.name === 'AbortError' ? `client timeout after ${timeoutMs}ms` : err?.message || err)
  } finally {
    clearTimeout(timer)
  }

  rec.total_ms = Date.now() - t0
  rec.citations = [...new Set([...rec.answer.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]))]
  return rec
}
