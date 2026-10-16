/**
 * PHASE E — qwen3.8 renders verdicts on everything collected.
 *
 * Runs LAST and alone, so qwen stays resident in VRAM instead of trading places
 * with gemma4 on every call (both models are ~16 GB on the same box; interleaving
 * them turned each request into a cold model load).
 *
 * The self-check runs FIRST and gates the rest: a judge that cannot separate a
 * known-good answer from a known-bad one is not evidence of anything, so if it
 * scores too low the run records that fact instead of reporting green.
 *
 * Resumable — verdicts already in qa-out/verdicts.jsonl are skipped.
 */
import fs from 'fs'
import path from 'path'
import { selfCheckJudge, judge } from './judge.mjs'
import { judgeToolResult, judgeScreenshot, judgeRenderedResult } from './vision.mjs'

const OUT = path.resolve(process.cwd(), 'qa-out')
const VERDICTS = path.join(OUT, 'verdicts.jsonl')

const readJsonl = (f) => {
  const p = path.join(OUT, f)
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
}

const done = new Set(readJsonl('verdicts.jsonl').map((v) => `${v.phase}:${v.id}`))
const emit = (phase, id, payload) => {
  fs.appendFileSync(VERDICTS, JSON.stringify({ phase, id, ...payload }) + '\n')
  done.add(`${phase}:${id}`)
}
const skip = (phase, id) => done.has(`${phase}:${id}`)

const only = (process.env.QA_JUDGE_ONLY || '').split(',').filter(Boolean)
const want = (phase) => !only.length || only.includes(phase)

// ---------------------------------------------------------------------------
// 0. Gate: can the judge tell good from bad at all?
// ---------------------------------------------------------------------------
if (want('selfcheck') && !skip('selfcheck', 'judge')) {
  const sc = await selfCheckJudge()
  emit('selfcheck', 'judge', { passed: sc.passed, total: sc.total, results: sc.results.map((r) => ({ name: r.name, expect: r.expect, got: r.got, ok: r.ok, reason: r.reason })) })
  if (sc.passed < sc.total - 1) {
    console.error(`\n!! judge scored ${sc.passed}/${sc.total} — verdicts below are NOT trustworthy`)
  }
}

// ---------------------------------------------------------------------------
// 1. Tool probes
// ---------------------------------------------------------------------------
if (want('tools')) {
  const probes = readJsonl('tools.jsonl')
  console.log(`\n=== judging ${probes.length} tool probes`)
  let n = 0
  for (const p of probes) {
    n++
    if (skip('tools', p.id)) continue
    const v = await judgeToolResult(p)
    emit('tools', p.id, { tool: p.tool, kind: p.kind, verdict: v.verdict, reason: v.reason, issues: v.issues, flags: p.flags, error: v.error })
    console.log(`  [${n}/${probes.length}] ${String(v.verdict || 'ERR').padEnd(5)} ${p.id}${v.error ? ` (${String(v.error).slice(0, 60)})` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// 2. End-to-end agent answers
// ---------------------------------------------------------------------------
if (want('e2e')) {
  const runs = readJsonl('e2e.jsonl')
  console.log(`\n=== judging ${runs.length} agent answers`)
  for (const r of runs) {
    if (skip('e2e', r.id)) continue
    const note = [
      `This AOI is: ${r.aoi_label}.`,
      `What a correct answer looks like: ${r.intent}`,
      r.kind === 'trap' ? 'NOTE: this is a deliberate trap — the honest answer may be a refusal.' : '',
      r.transport_error ? `Transport problem: ${r.transport_error}` : '',
    ].filter(Boolean).join(' ')
    const v = await judge({ question: r.query, answer: r.answer, tools: r.toolNames || [], note })
    emit('e2e', r.id, {
      kind: r.kind, verdict: v.verdict, reason: v.reason, issues: v.issues, error: v.error,
      tools: r.toolNames, citations: (r.citations || []).length, chars: r.answerChars, ms: r.total_ms,
    })
    console.log(`  ${String(v.verdict || 'ERR').padEnd(5)} ${r.id}`)
  }
}

// ---------------------------------------------------------------------------
// 3. UI screenshots — the vision pass
// ---------------------------------------------------------------------------
if (want('ui')) {
  const steps = readJsonl('ui-journey-steps.jsonl').filter((s) => s.shot && fs.existsSync(s.shot))
  console.log(`\n=== judging ${steps.length} UI screenshots`)
  for (const s of steps) {
    if (skip('ui', s.id)) continue
    const v = await judgeScreenshot({ stepId: s.id, intent: s.intent, shotPath: s.shot })
    emit('ui', s.id, { verdict: v.verdict, looks_like: v.looks_like, bugs: v.bugs, error: v.error, shot: s.shot })
    console.log(`  ${String(v.verdict || 'ERR').padEnd(5)} ${s.id}${v.bugs?.length ? ` — ${v.bugs.length} bug(s)` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// 4. Rendered results — how each kind of answer LOOKS
// ---------------------------------------------------------------------------
if (want('gallery')) {
  const gal = readJsonl('ui-gallery.jsonl').filter((g) => g.id && !g.id.startsWith('fatal'))
  console.log(`\n=== judging ${gal.length} rendered results`)
  for (const g of gal) {
    if (skip('gallery', g.id)) continue
    if (!g.shot || !fs.existsSync(g.shot)) { emit('gallery', g.id, { verdict: 'FAIL', reason: 'no screenshot captured', error: g.error }); continue }
    const v = await judgeRenderedResult({ id: g.id, query: g.query, intent: g.intent, shotPath: g.shot, answerText: g.answerTail })
    emit('gallery', g.id, {
      verdict: v.verdict, rendered: v.rendered, has_visible_answer: v.has_visible_answer,
      has_layer_or_chart: v.has_layer_or_chart, raw_markup_leaked: v.raw_markup_leaked,
      bugs: v.bugs, error: v.error, shot: g.shot,
      harness: { drawn: g.drawn, areaKm2: g.areaKm2, areaSane: g.areaSane, finished: g.finished, answerMs: g.answerMs },
    })
    console.log(`  ${String(v.verdict || 'ERR').padEnd(5)} ${g.id}${v.bugs?.length ? ` — ${v.bugs.length} bug(s)` : ''}`)
  }
}

console.log(`\nverdicts → ${VERDICTS}`)
