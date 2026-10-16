/**
 * PHASE C — the agent's judgement, over the real SSE contract.
 *
 * Phase B proves the tools return good data. This proves the AGENT picks the
 * right ones and reports them honestly — including the cases where the honest
 * answer is "I can't tell you that", which is where a fluent model is most
 * likely to invent something.
 *
 * Runs through /api/agent, so gemma4 does the reasoning exactly as it would for
 * a user. Resumable via qa-out/e2e.jsonl.
 */
import fs from 'fs'
import path from 'path'
import { runAgentQuery } from './sse-client.mjs'
 
import { AOIS, E2E_SCENARIOS } from './probes.mjs'

const OUT = path.resolve(process.cwd(), 'qa-out')
const JSONL = path.join(OUT, 'e2e.jsonl')
fs.mkdirSync(OUT, { recursive: true })

const done = new Set(
  fs.existsSync(JSONL)
    ? fs.readFileSync(JSONL, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).id)
    : [],
)

let n = 0
for (const s of E2E_SCENARIOS) {
  n++
  if (done.has(s.id)) { console.log(`skip ${s.id}`); continue }
  const aoi = AOIS[s.aoi]
  process.stdout.write(`[${n}/${E2E_SCENARIOS.length}] ${s.id.padEnd(22)} `)

  const res = await runAgentQuery({ aoi: aoi.geom, query: s.query, lang: s.lang || 'en' })
  const rec = {
    id: s.id, kind: s.kind, aoi: s.aoi, aoi_label: aoi.label, query: s.query,
    intent: s.intent, lang: s.lang || 'en',
    ok: res.ok, http: res.http, transport_error: res.transport_error,
    ttft_ms: res.ttft_ms, total_ms: res.total_ms,
    tools: res.tools, toolNames: [...new Set(res.tools.map((t) => t.tool).filter(Boolean))],
    plan: res.plan, layers: res.layers, citations: res.citations,
    errors: res.errors, events: res.events,
    answer: res.answer,
    answerChars: res.answer.length,
  }
  fs.appendFileSync(JSONL, JSON.stringify(rec) + '\n')
  console.log(
    `${res.ok ? 'done' : 'INCOMPLETE'} ${(res.total_ms / 1000).toFixed(0)}s ` +
    `tools=[${rec.toolNames.join(',') || '-'}] chars=${rec.answerChars} cites=${rec.citations.length}` +
    `${res.transport_error ? ' ERR=' + res.transport_error.slice(0, 60) : ''}`,
  )
}

console.log(`\nphase C complete → ${JSONL}`)
