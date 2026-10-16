/**
 * Fold every artefact of the sweep into one compact digest.
 *
 * The raw record is several megabytes of JSON and screenshots; this is the view
 * a human (or the orchestrating model) reads to write the final report, so it
 * keeps verdicts, reasons and defects, and throws away everything restateable.
 */
import fs from 'fs'
import path from 'path'

const OUT = path.resolve(process.cwd(), 'qa-out')
const read = (f) => {
  const p = path.join(OUT, f)
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

const verdicts = read('verdicts.jsonl')
const byPhase = (p) => verdicts.filter((v) => v.phase === p)
const tools = read('tools.jsonl')
const e2e = read('e2e.jsonl')
const gallery = read('ui-gallery.jsonl')
const explore = read('ui-explore.jsonl')
const journeySteps = read('ui-journey-steps.jsonl')

const L = []
const say = (s = '') => L.push(s)

// ---- integrity gates ------------------------------------------------------
say('# QA SWEEP DIGEST')
say('')
say('## 0. Judge integrity (do the verdicts below mean anything?)')
const sc = byPhase('selfcheck')[0]
if (sc) {
  say(`text judge: ${sc.passed}/${sc.total}`)
  sc.results.filter((r) => !r.ok).forEach((r) => say(`  MISS: ${r.name} → ${r.got} (expected ${r.expect}) :: ${r.reason || ''}`))
} else say('text judge: NOT RUN')
const vc = byPhase('visioncheck')[0]
if (vc) {
  say(`vision judge: ${vc.passed}/${vc.total}`)
  vc.results.filter((r) => !r.ok).forEach((r) => say(`  MISS: ${r.name} → ${r.got} (expected ${r.expect})`))
} else say('vision judge: NOT RUN')

// ---- phase B --------------------------------------------------------------
const tv = byPhase('tools')
say('')
say(`## 1. Tool layer — ${tools.length} live probes, ${tv.length} judged`)
const tFail = tv.filter((v) => v.verdict === 'FAIL')
const tErr = tv.filter((v) => v.error)
say(`PASS ${tv.filter((v) => v.verdict === 'PASS').length} · FAIL ${tFail.length} · judge-error ${tErr.length}`)
say(`threw: ${tools.filter((t) => t.threw).length} · mechanical flags: ${tools.filter((t) => t.flags?.length).length}`)
if (tFail.length) {
  say('')
  say('FAILING PROBES:')
  for (const f of tFail) {
    const probe = tools.find((t) => t.id === f.id) || {}
    say(`  [${f.kind}] ${f.id} (${f.tool})`)
    say(`      why: ${f.reason}`)
    for (const i of f.issues || []) say(`      - ${typeof i === 'string' ? i : `${i.severity}: ${i.what}`}`)
    if (probe.flags?.length) say(`      mechanical: ${probe.flags.join(', ')}`)
    say(`      said: ${String(probe.summary || '').replace(/\s+/g, ' ').slice(0, 220)}`)
  }
}
const flagged = tools.filter((t) => t.flags?.length)
if (flagged.length) {
  say('')
  say('MECHANICAL FLAGS (deterministic, independent of the judge):')
  flagged.forEach((t) => say(`  ${t.id.padEnd(22)} ${t.flags.join(', ')}`))
}

// ---- phase C --------------------------------------------------------------
const ev = byPhase('e2e')
say('')
say(`## 2. Agent reasoning — ${e2e.length} end-to-end runs, ${ev.length} judged`)
if (ev.length) {
  const judged = ev.filter((v) => !v.error && v.verdict)
  const traps = judged.filter((v) => v.kind === 'trap')
  say(`judged ${judged.length}/${ev.length} (judge errors: ${ev.length - judged.length})`)
  say(`PASS ${judged.filter((v) => v.verdict === 'PASS').length} · FAIL ${judged.filter((v) => v.verdict === 'FAIL').length}`)
  say(`honesty traps: ${traps.filter((t) => t.verdict === 'PASS').length}/${traps.length} passed`)
  for (const v of ev) {
    const run = e2e.find((r) => r.id === v.id) || {}
    // An unreachable judge is NOT a failing app — never let one masquerade as the other.
    const mark = v.error ? 'ERR ' : v.verdict === 'PASS' ? 'pass' : 'FAIL'
    say(`  ${mark} [${v.kind}] ${v.id} — tools=[${(v.tools || []).join(',') || 'none'}] cites=${v.citations} ${Math.round((v.ms || 0) / 1000)}s`)
    if (v.error) { say(`      judge error: ${String(v.error).slice(0, 120)}`); continue }
    if (v.verdict !== 'PASS') {
      say(`      why: ${v.reason}`)
      for (const i of v.issues || []) say(`      - ${typeof i === 'string' ? i : `${i.severity}: ${i.what}`}`)
      say(`      said: ${String(run.answer || '').replace(/\s+/g, ' ').slice(0, 300)}`)
    }
  }
}

// ---- UI screenshots -------------------------------------------------------
const uv = byPhase('ui')
say('')
say(`## 3. UI screenshots — ${uv.length} judged`)
for (const v of uv) {
  say(`  ${v.verdict === 'PASS' ? 'pass' : 'FAIL'} ${v.id}: ${v.looks_like || ''}`)
  for (const b of v.bugs || []) say(`      [${b.severity}] ${b.area}: ${b.what} — ${b.evidence}`)
}

// ---- rendered results -----------------------------------------------------
const gv = byPhase('gallery')
say('')
say(`## 4. Rendered results — ${gv.length} judged`)
for (const v of gv) {
  const h = v.harness || {}
  say(`  ${v.verdict === 'PASS' ? 'pass' : 'FAIL'} ${v.id} — answer=${v.has_visible_answer} layer/chart=${v.has_layer_or_chart} rawMarkup=${v.raw_markup_leaked} aoi=${h.areaKm2 ?? '?'}km² ${Math.round((h.answerMs || 0) / 1000)}s`)
  if (v.rendered) say(`      shows: ${v.rendered}`)
  for (const b of v.bugs || []) say(`      [${b.severity}] ${b.area}: ${b.what} — ${b.evidence}`)
}

// ---- autonomous exploration ----------------------------------------------
say('')
const steps = explore.filter((e) => e.step)
say(`## 5. Autonomous exploration — ${steps.length} steps by qwen`)
const failedActions = steps.filter((s) => s.executed && !s.executed.ok)
say(`actions attempted ${steps.length} · failed ${failedActions.length}`)
const allBugs = []
steps.forEach((s) => (s.bugs || []).forEach((b) => allBugs.push({ ...b, step: s.step, session: s.session })))
const seen = new Set()
for (const b of allBugs) {
  const k = `${b.severity}|${(b.what || '').slice(0, 70)}`
  if (seen.has(k)) continue
  seen.add(k)
  say(`  [${b.severity}] (${b.session} step ${b.step}) ${b.area}: ${b.what} — ${b.evidence}`)
}
if (failedActions.length) {
  say('  failed interactions:')
  failedActions.forEach((s) => say(`    step ${s.step} ${JSON.stringify(s.action)} → ${s.executed.reason}`))
}
explore.filter((e) => e.kind === 'session-defects').forEach((d) => {
  say(`  ${d.session}: pageErrors=${d.pageErrors.length} consoleErrors=${d.consoleErrors.length} httpErrors=${d.httpErrors.length}`)
})

// ---- cross-cutting runtime defects ---------------------------------------
say('')
say('## 6. Runtime defects observed by the browser (not opinions)')
const journeyJson = fs.existsSync(path.join(OUT, 'ui-journey.json'))
  ? JSON.parse(fs.readFileSync(path.join(OUT, 'ui-journey.json'), 'utf8')) : null
const httpAll = []
if (journeyJson) httpAll.push(...journeyJson.defects.httpErrors)
gallery.forEach((g) => httpAll.push(...(g.defects?.httpErrors || [])))
explore.filter((e) => e.kind === 'session-defects').forEach((d) => httpAll.push(...(d.httpErrors || [])))
const hostCount = {}
httpAll.forEach((h) => {
  try { const u = new URL(h.url.startsWith('http') ? h.url : `http://x/${h.url}`); hostCount[`${u.host} ${h.status}`] = (hostCount[`${u.host} ${h.status}`] || 0) + 1 } catch {}
})
Object.entries(hostCount).sort((a, b) => b[1] - a[1]).slice(0, 12)
  .forEach(([k, n]) => say(`  ${String(n).padStart(4)}×  ${k}`))
const sampleTile = httpAll.find((h) => /titiler|cog|tiles/i.test(h.url))
if (sampleTile) say(`  sample failing tile URL: ${sampleTile.url.slice(0, 190)}`)

const pageErrs = []
if (journeyJson) pageErrs.push(...journeyJson.defects.pageErrors)
gallery.forEach((g) => pageErrs.push(...(g.defects?.pageErrors || [])))
say(`  uncaught page errors: ${pageErrs.length}`)
;[...new Set(pageErrs)].slice(0, 6).forEach((e) => say(`    ${String(e).slice(0, 160)}`))

// ---- harness-level observations ------------------------------------------
say('')
say('## 7. Harness observations (facts about the app the runner had to work around)')
gallery.forEach((g) => {
  if (g.areaSane === false) say(`  ${g.id}: AOI measured ${g.areaKm2} km² — app accepted an implausible area without warning`)
  if (g.asked === false) say(`  ${g.id}: could not submit the question (${g.askError})`)
  if (g.finished === false) say(`  ${g.id}: answer never completed within the timeout`)
  if (g.error) say(`  ${g.id}: run error ${g.error}`)
})
journeySteps.filter((s) => s.id?.startsWith('fatal')).forEach((s) => say(`  journey fatal: ${s.error}`))

const text = L.join('\n')
fs.writeFileSync(path.join(OUT, 'digest.md'), text)
console.log(text)
