// Prints the per-case and per-category tables for eval/LIVE.md from cases.json + grades.json + results.
//   node eval/live/report.mjs eval/live/results-YYYY-MM-DD.jsonl
import { readFileSync } from 'node:fs'
const res = new Map(readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map(JSON.parse).map((r) => [r.id, r]))
const { cases } = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'))
const grades = JSON.parse(readFileSync(new URL('./grades.json', import.meta.url), 'utf8'))
const final = (g) => (g.o === 'F' ? 'FAIL' : g.o === 'Pa' || g.fp ? 'partial' : 'pass')
const outcome = (g) => ({ P: 'pass', Pa: 'partial', F: 'FAIL' })[g.o]
const cat = {}
const rows = []
const all = [...cases.map((c) => ({ id: c.id, category: c.category })), ...['ui01', 'ui02', 'ui03', 'ui04'].map((id) => ({ id, category: 'ui' }))]
for (const c of all) {
  const g = grades[c.id]
  const r = res.get(c.id)
  const k = (cat[c.category] ||= { n: 0, pass: 0, partial: 0, fail: 0, o_pass: 0, o_partial: 0, o_fail: 0 })
  k.n++
  const f = final(g)
  k[f === 'pass' ? 'pass' : f === 'partial' ? 'partial' : 'fail']++
  k[g.o === 'P' ? 'o_pass' : g.o === 'Pa' ? 'o_partial' : 'o_fail']++
  rows.push(`| ${c.id} | ${c.category} | ${r ? (r.t_total_ms / 1000).toFixed(0) + ' s' : ''} | ${outcome(g)} | ${g.fp ? 'yes' : 'no'} | **${f}** | ${g.note.replace(/\|/g, '/')} |`)
}
console.log('| Case | Category | Time | Task outcome | False-positive Unverified | Final | Notes |\n|---|---|---|---|---|---|---|')
console.log(rows.join('\n'))
console.log('\n| Category | Cases | pass | partial | FAIL | (task outcome only: pass / partial / FAIL) |\n|---|---|---|---|---|---|')
let T = { n: 0, pass: 0, partial: 0, fail: 0, o_pass: 0, o_partial: 0, o_fail: 0 }
for (const [name, k] of Object.entries(cat)) {
  console.log(`| ${name} | ${k.n} | ${k.pass} | ${k.partial} | ${k.fail} | ${k.o_pass} / ${k.o_partial} / ${k.o_fail} |`)
  for (const x of Object.keys(T)) T[x] += k[x]
}
console.log(`| **all** | ${T.n} | ${T.pass} | ${T.partial} | ${T.fail} | ${T.o_pass} / ${T.o_partial} / ${T.o_fail} |`)
