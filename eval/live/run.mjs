// Live evaluation harness for the deployed Erdfeld AI app. Plain Node, no dependencies.
//
//   node eval/live/run.mjs [--base <url>] [--only id,id] [--out eval/live/results-YYYY-MM-DD.jsonl]
//                          [--pace-s 35] [--timeout-s 300] [--skip-done]
//
// Runs eval/live/cases.json sequentially against POST /api/agent (or /api/investigate), parses the SSE
// stream, and appends one JSON line per case (no secrets: only the fixed x-owner-token label is sent).
import { readFileSync, appendFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = (arg('base', 'https://erdfeld-web-707586221016.us-central1.run.app')).replace(/\/$/, '')
const DATE = new Date().toISOString().slice(0, 10)
const OUT = arg('out', fileURLToPath(new URL(`./results-${DATE}.jsonl`, import.meta.url)))
const PACE_MS = Number(arg('pace-s', '35')) * 1000
const TIMEOUT_MS = Number(arg('timeout-s', '300')) * 1000
const only = arg('only')?.split(',')
const skipDone = process.argv.includes('--skip-done')
const { cases } = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'))

const km2deg = (km, lat) => ({ dLat: km / 110.574, dLon: km / (111.320 * Math.cos((lat * Math.PI) / 180)) })
export function bboxOf(c) {
  if (c.bbox) return c.bbox
  const [lon, lat] = c.center
  const { dLat, dLon } = km2deg(c.side_km / 2, lat)
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat]
}
const polygon = ([w, s, e, n]) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] })
const areaKm2 = ([w, s, e, n]) => (e - w) * 111.32 * Math.cos((((s + n) / 2) * Math.PI) / 180) * (n - s) * 110.574
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function runCase(c) {
  const bbox = bboxOf(c)
  const investigate = c.endpoint === 'investigate'
  const body = investigate
    ? { aoi: polygon(bbox), ...c.body, aiProvider: 'default' }
    : { aoi: polygon(bbox), query: c.query, aiProvider: 'default' }
  const rec = {
    id: c.id, category: c.category, place: c.place, endpoint: investigate ? '/api/investigate' : '/api/agent',
    request: body, area_km2: Number(areaKm2(bbox).toFixed(1)), started: new Date().toISOString(),
    http_status: null, attempts: 0, events: {}, plan: null, plan_refused: [], tool_calls: [], layers: [], charts: [],
    errors: [], notices: [], answer: '', unverified: null, ledger_run_id: null, t_first_event_ms: null, t_plan_ms: null,
    t_total_ms: null, timed_out: false, done: false, extra: {},
  }
  for (let attempt = 1; attempt <= 4; attempt++) {
    rec.attempts = attempt
    const t0 = Date.now()
    const ctl = new AbortController()
    const timer = setTimeout(() => { rec.timed_out = true; ctl.abort() }, TIMEOUT_MS)
    try {
      const res = await fetch(`${BASE}${rec.endpoint}`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-owner-token': `live-eval-${c.id}` }, body: JSON.stringify(body),
      })
      rec.http_status = res.status
      if (res.status === 429) {
        const wait = Math.max(Number(res.headers.get('retry-after')) || 60, 30)
        rec.errors.push(`429 rate limited, retry-after ${wait}s (attempt ${attempt})`)
        clearTimeout(timer); await sleep((wait + 5) * 1000); continue
      }
      if (!res.ok || !res.body) { rec.errors.push(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`); clearTimeout(timer); break }
      const dec = new TextDecoder(); let buf = ''
      const handle = (ev, d) => {
        const now = Date.now() - t0
        if (rec.t_first_event_ms == null) rec.t_first_event_ms = now
        rec.events[ev] = (rec.events[ev] || 0) + 1
        switch (ev) {
          case 'plan': rec.plan = d.steps?.map((s) => ({ id: s.id, tool: s.tool, args: s.args, depends_on: s.depends_on })); if (rec.t_plan_ms == null) rec.t_plan_ms = now; break
          case 'plan_refused': rec.plan_refused.push(...(d.reasons || [])); break
          case 'tool_call': if (d.status !== 'running') rec.tool_calls.push({ tool: d.tool_name, status: d.status, result_status: d.result_status, validation: d.validation, summary: d.result_summary, result_id: d.result_id, summary_data: d.summary_data, step_index: d.step_index }); break
          case 'layer': if (!d.provisional) rec.layers.push({ id: d.layer?.id ?? d.id, name: d.layer?.name ?? d.name, type: d.layer?.type ?? d.type }); break
          case 'chart': rec.charts.push({ id: d.chart_id, title: d.title }); break
          case 'error': rec.errors.push(d.content || d.message); break
          case 'notice': rec.notices.push(d); break
          case 'token': rec.answer += d.content; break
          case 'ledger': rec.ledger_run_id = d.run_id; break
          case 'done': rec.done = true; rec.timings = d.timings; break
          // investigator-only events, kept whole (small)
          case 'verdict': case 'dossier': case 'discovery': case 'corroboration': rec.extra[ev] = d; break
          case 'hypotheses': rec.extra.hypotheses = d; break
          case 'step': (rec.extra.steps ||= []).push({ n: d.n, op: d.op, title: d.title, args: d.args, why: d.why }); break
          case 'evidence': (rec.extra.evidence ||= []).push(d); break
          case 'belief': rec.extra.belief = d; break
        }
      }
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          if (block.startsWith(':')) continue
          let ev = 'message'; let data = ''
          for (const line of block.split('\n')) { if (line.startsWith('event:')) ev = line.slice(6).trim(); else if (line.startsWith('data:')) data += line.slice(5).trim() }
          try { handle(ev, JSON.parse(data)) } catch { rec.errors.push(`unparseable SSE block (${ev})`) }
        }
      }
    } catch (e) {
      rec.errors.push(rec.timed_out ? `client timeout after ${TIMEOUT_MS / 1000}s` : `fetch error: ${e?.cause?.code || e?.message}`)
    }
    clearTimeout(timer)
    rec.t_total_ms = Date.now() - t0
    break
  }
  // Derived: unverified block and its reasons.
  const m = rec.answer.match(/\*\*Unverified statements\.\*\*[\s\S]*$/)
  if (m) rec.unverified = { text: m[0], reasons: [...m[0].matchAll(/_\(([^)]*)\)_/g)].map((x) => x[1]) }
  // Derived: citations resolved against tool results.
  const cites = [...rec.answer.matchAll(/\[\[([^\]#]+)#([^\]]+)\]\]/g)].map((x) => ({ id: x[1], key: x[2] }))
  const byId = new Map(rec.tool_calls.map((t) => [t.result_id, t]))
  rec.citations = { total: cites.length, resolved: cites.filter((x) => { const t = byId.get(x.id); return t && t.summary_data && x.key in t.summary_data }).length }
  return rec
}

const done = new Set()
if (skipDone && existsSync(OUT)) for (const l of readFileSync(OUT, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l); if (r.done && !r.errors.length) done.add(r.id) }
const list = cases.filter((c) => (!only || only.includes(c.id)) && !done.has(c.id))
console.log(`base=${BASE} cases=${list.length} out=${OUT}`)
let nextStart = Date.now()
for (const c of list) {
  const wait = nextStart - Date.now()
  if (wait > 0) await sleep(wait)
  nextStart = Date.now() + PACE_MS
  const rec = await runCase(c)
  appendFileSync(OUT, JSON.stringify(rec) + '\n')
  const tools = rec.tool_calls.map((t) => `${t.tool}:${t.result_status ?? t.status}`).join(',')
  console.log(`${c.id} ${((rec.t_total_ms ?? 0) / 1000).toFixed(0)}s http=${rec.http_status} done=${rec.done} tools=[${tools}] unv=${!!rec.unverified} err=${rec.errors.length}${rec.errors[0] ? ' ' + String(rec.errors[0]).slice(0, 100) : ''}`)
}
