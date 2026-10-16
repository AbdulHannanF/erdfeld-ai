// Summarise a results JSONL: latency stats and a classification of "Unverified statements" lines.
//   node eval/live/analyze.mjs eval/live/results-YYYY-MM-DD.jsonl [--lines]
import { readFileSync } from 'node:fs'
const file = process.argv[2]
const L = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null }

const done = L.filter((r) => r.done)
const tot = done.map((r) => r.t_total_ms / 1000)
const plan = L.filter((r) => r.t_plan_ms != null).map((r) => r.t_plan_ms / 1000)
const first = L.filter((r) => r.t_first_event_ms != null).map((r) => r.t_first_event_ms / 1000)
console.log(JSON.stringify({
  cases: L.length, completed: done.length,
  total_s: { median: q(tot, 0.5), p90: q(tot, 0.9), max: Math.max(...tot) },
  plan_s: { median: q(plan, 0.5), p90: q(plan, 0.9) },
  first_event_s: { median: q(first, 0.5), p90: q(first, 0.9) },
}))

// Classify each flagged line. "percentile" = the only unmatched numbers are percentile ordinals (2nd, 98th, p25...).
const cat = { percentile_ordinal: 0, uncited_figure: 0, mismatch: 0, other: 0 }
const rows = []
let runs = 0, flaggedRuns = 0
for (const r of L) {
  if (r.endpoint !== '/api/agent' || !r.answer) continue
  runs++
  if (!r.unverified) continue
  flaggedRuns++
  for (const line of r.unverified.text.split('\n').slice(2).filter((l) => l.startsWith('- '))) {
    const reason = (line.match(/_\(([^)]*)\)_/) || [])[1] || ''
    const nums = (reason.match(/^[\d.,\s-]+/) || [''])[0].split(',').map((s) => s.trim()).filter(Boolean)
    const pctWords = /\b\d+(?:st|nd|rd|th)\b|percentile|\bp\d{1,2}\b/i.test(line)
    const pctNums = nums.length > 0 && nums.every((n) => ['2', '5', '10', '25', '50', '75', '90', '95', '98'].includes(n))
    const c = pctWords && pctNums ? 'percentile_ordinal' : /has no citation/.test(reason) ? 'uncited_figure' : /does not match/.test(reason) ? 'mismatch' : 'other'
    cat[c]++
    rows.push({ id: r.id, c, reason, line: line.slice(2, 170).replace(/\[\[[^\]]*\]\]/g, '') })
  }
}
console.log(JSON.stringify({ agent_runs_with_answer: runs, runs_with_unverified_block: flaggedRuns, flagged_lines: rows.length, by_class: cat }))
if (process.argv.includes('--lines')) for (const x of rows.filter((x) => x.c !== 'percentile_ordinal')) console.log(`${x.id} [${x.c}] ${x.reason} :: ${x.line}`)
