#!/usr/bin/env node
/**
 * P7.1 — SSE-contract smoke test.
 *
 * Drives the real `/api/agent` SSE route end-to-end with a deterministic offline
 * stub LLM (provider "stub", enabled by AGENT_ALLOW_STUB=1) so the agentic loop
 * runs without any network call or real model. It asserts the streamed event
 * sequence still honors the contract the frontend depends on:
 *
 *     plan → tool_call(running) → tool_call(completed) → layer → token → done
 *
 * (zoom_to / manifest / cache_hit and extra token chunks may interleave — we
 * assert presence + the key orderings, not an exact frame-by-frame snapshot.)
 *
 * Modes:
 *   - Attach:  SMOKE_BASE_URL=http://localhost:3000 node scripts/sse-smoke-test.mjs
 *              (uses an already-running dev server — fastest for local re-runs)
 *   - Spawn:   node scripts/sse-smoke-test.mjs
 *              (spawns `next dev` on SMOKE_PORT, waits for it, tears it down)
 *
 * Exit code 0 = contract held, 1 = violated / server never came up.
 */

import { spawn } from 'node:child_process'

const PORT = Number(process.env.SMOKE_PORT || 3210)
const ATTACH_URL = process.env.SMOKE_BASE_URL
const BASE_URL = ATTACH_URL || `http://localhost:${PORT}`
const READY_TIMEOUT_MS = Number(process.env.SMOKE_READY_TIMEOUT_MS || 120_000)

// A minimal valid AOI polygon (a small square) — enough for getBbox(aoi).
const AOI = {
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'Polygon',
    coordinates: [[[-0.01, -0.01], [0.01, -0.01], [0.01, 0.01], [-0.01, 0.01], [-0.01, -0.01]]],
  },
}

const REQUEST_BODY = {
  aoi: AOI,
  query: 'smoke test: render a layer',
  lang: 'en',
  aiProvider: 'stub',
}

function log(...args) {
  console.log('[sse-smoke]', ...args)
}

/** POST /api/agent and return the ordered list of { event, data } parsed from the SSE body. */
async function collectSseEvents(baseUrl) {
  const res = await fetch(`${baseUrl}/api/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(REQUEST_BODY),
  })
  if (!res.ok) throw new Error(`POST /api/agent returned HTTP ${res.status}`)
  if (!res.body) throw new Error('no response body from /api/agent')

  const events = []
  const decoder = new TextDecoder()
  let buffer = ''

  const flushFrame = (frame) => {
    const lines = frame.split('\n')
    let event = 'message'
    let dataStr = ''
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataStr += line.slice(5).trim()
    }
    if (!dataStr) return
    let data
    try { data = JSON.parse(dataStr) } catch { data = { raw: dataStr } }
    events.push({ event, data })
  }

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let sep
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      if (frame.trim()) flushFrame(frame)
    }
  }
  if (buffer.trim()) flushFrame(buffer)
  return events
}

/** Assert the SSE contract over the collected events. Throws on the first violation. */
function assertContract(events) {
  const names = events.map((e) => e.event)
  log('event sequence:', names.join(' → '))

  const fail = (msg) => { throw new Error(`SSE contract violated: ${msg}\n  got: [${names.join(', ')}]`) }

  const planIdx = names.indexOf('plan')
  if (planIdx === -1) fail('no `plan` event emitted')

  const runningIdx = events.findIndex((e) => e.event === 'tool_call' && e.data?.status === 'running')
  if (runningIdx === -1) fail('no `tool_call` with status "running"')

  const completedIdx = events.findIndex((e) => e.event === 'tool_call' && e.data?.status === 'completed')
  if (completedIdx === -1) fail('no `tool_call` with status "completed"')

  const layerIdx = names.indexOf('layer')
  if (layerIdx === -1) fail('no `layer` event emitted')

  if (!names.includes('token')) fail('no `token` event emitted')

  const doneIdx = names.lastIndexOf('done')
  if (doneIdx === -1) fail('no `done` event emitted')
  if (doneIdx !== names.length - 1) fail('`done` was not the final event')

  // Orderings the frontend relies on.
  if (!(planIdx < runningIdx)) fail('`plan` must precede the first `tool_call`')
  if (!(runningIdx < completedIdx)) fail('`tool_call running` must precede `tool_call completed`')
  if (!(completedIdx < layerIdx)) fail('`layer` must follow the completed `tool_call`')
  if (!(layerIdx < doneIdx)) fail('`done` must follow `layer`')

  // The stub plans render_to_map — confirm the layer is really the one we drove.
  const layer = events[layerIdx].data
  if (!layer?.layer_id) fail('`layer` event missing layer_id')

  log('OK — contract held (plan, tool_call running/completed, layer, token, done in order)')
}

async function waitForReady(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastErr
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl, { method: 'GET' })
      // Any HTTP response means the server is accepting connections.
      if (res.status > 0) return
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`server at ${baseUrl} not ready within ${timeoutMs}ms (${lastErr?.message ?? 'no response'})`)
}

async function main() {
  let child
  try {
    if (!ATTACH_URL) {
      log(`spawning \`next dev\` on port ${PORT} (AGENT_ALLOW_STUB=1)…`)
      child = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
        env: { ...process.env, AGENT_ALLOW_STUB: '1' },
        stdio: ['ignore', 'inherit', 'inherit'],
        shell: true,
      })
      child.on('exit', (code) => {
        if (code && code !== 0) log(`dev server exited early with code ${code}`)
      })
      await waitForReady(BASE_URL, READY_TIMEOUT_MS)
      log('server is up')
    } else {
      log(`attaching to ${BASE_URL} (expects AGENT_ALLOW_STUB=1 on that server)`)
    }

    const events = await collectSseEvents(BASE_URL)
    assertContract(events)
    log('PASS')
    return 0
  } catch (err) {
    console.error('[sse-smoke] FAIL:', err?.message || err)
    return 1
  } finally {
    if (child && !child.killed) {
      child.kill('SIGTERM')
      // Give it a moment, then force-kill the process tree if still alive.
      await new Promise((r) => setTimeout(r, 1500))
      if (!child.killed) child.kill('SIGKILL')
    }
  }
}

main().then((code) => process.exit(code))
