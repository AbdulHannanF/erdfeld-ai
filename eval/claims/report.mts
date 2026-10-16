/** Score recorded claim runs against the Hansen labels: raw rows to CSV, summary to stdout.
 *
 *    npx vite-node -c vitest.config.ts eval/claims/report.mts -- [--records eval/claims/records-not_cleared_since@1.0.0.jsonl] [--csv eval/claims/results-<date>.csv]
 */

import { readFileSync, writeFileSync } from 'node:fs'

import { byBiome, expectedVerdict, summarize, type Row, type Summary } from './metrics'
import type { LabelledPlot } from './generate'
import type { PlotRecord } from './run.mts'

const arg = (name: string, d: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : d }
const recordsFile = arg('--records', 'eval/claims/records-not_cleared_since@1.0.0.jsonl')
const csvFile = arg('--csv', `eval/claims/results-${new Date().toISOString().slice(0, 10)}.csv`)

const plots = new Map((JSON.parse(readFileSync('eval/claims/plots.json', 'utf8')).plots as LabelledPlot[]).map((p) => [p.id, p]))
const records = readFileSync(recordsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as PlotRecord)
const rows: Row[] = records.map((r) => {
  const p = plots.get(r.id)!
  return { id: r.id, biome: p.biome, label: p.label, split: p.split, verdict: r.verdict, confidence: r.confidence, kind: r.kind }
})

const q = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`
const stat = (r: PlotRecord, node: number, key: string) => (r.nodes[node]?.stats as Record<string, unknown> | null | undefined)?.[key] ?? ''
const header = ['id', 'biome', 'label', 'split', 'loss_frac', 'recipe', 'expected', 'verdict', 'confidence', 'correct', 'rule', 'abstain_kind', 'baseline_median_ndvi', 'baseline_scene', 'after_scene', 'decreased_pct', 'median_delta', 'pixels_clear_both', 'seconds', 'reason']
const lines = [header.join(',')]
for (const r of records) {
  const p = plots.get(r.id)!
  const answered = r.verdict === 'supported' || r.verdict === 'contradicted'
  lines.push([
    r.id, p.biome, p.label, p.split, p.loss_frac, r.recipe, expectedVerdict(p.label), r.verdict, r.confidence ?? '',
    answered ? String(r.verdict === expectedVerdict(p.label)) : '', r.rule, r.kind ?? '',
    stat(r, 0, 'median'), stat(r, 0, 'scene_date'), stat(r, 1, 'date_after'), stat(r, 1, 'decreased_pct'), stat(r, 1, 'median_delta'), stat(r, 1, 'pixels_clear_both'),
    r.seconds, q(r.reason),
  ].map((v, i) => (i === header.length - 1 ? v : String(v).includes(',') ? q(v) : v)).join(','))
}
writeFileSync(csvFile, lines.join('\n') + '\n')

const pct = (v: number | null, d = 1) => (v == null ? 'n/a' : `${(v * 100).toFixed(d)}%`)
const row = (name: string, s: Summary) =>
  `| ${name} | ${s.n} | ${s.answered} | ${pct(s.coverage, 0)} | ${pct(s.abstention_rate, 0)} | ${pct(s.accuracy)}${s.accuracy_ci95 ? ` (${pct(s.accuracy_ci95[0], 0)} to ${pct(s.accuracy_ci95[1], 0)})` : ''} | ${pct(s.loss_recall, 0)} | ${pct(s.stable_recall, 0)} | ${s.ece == null ? 'n/a' : s.ece.toFixed(3)} |`
const head = '| Slice | N | Answered | Coverage | Abstained | Accuracy on answered (95% CI) | Loss called Contradicted | Stable called Supported | ECE |\n|---|---|---|---|---|---|---|---|---|'
const test = rows.filter((r) => r.split === 'test')
console.log(head)
console.log(row('All plots', summarize(rows)))
console.log(row('Test split (held out)', summarize(test)))
console.log(row('Dev split', summarize(rows.filter((r) => r.split === 'dev'))))
for (const [b, s] of Object.entries(byBiome(test))) console.log(row(`Test, ${b}`, s))
const kinds: Record<string, number> = {}
for (const r of rows) if (r.verdict === 'cannot_determine') kinds[r.kind ?? '?'] = (kinds[r.kind ?? '?'] ?? 0) + 1
console.log('\nAbstention kinds (all):', JSON.stringify(kinds))
const rules: Record<string, number> = {}
for (const r of records) rules[r.rule] = (rules[r.rule] ?? 0) + 1
console.log('Rules fired (all):', JSON.stringify(rules))
console.log(`Wrote ${lines.length - 1} rows to ${csvFile}`)
const secs = records.map((r) => r.seconds)
console.log(`Seconds per plot: median ${[...secs].sort((a, b) => a - b)[Math.floor(secs.length / 2)]}, max ${Math.max(...secs)}`)
