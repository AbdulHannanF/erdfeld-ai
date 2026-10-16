/** Retrieval evaluation over the committed snapshot.
 *
 *  `eval/registry-questions.json`   - the tuning set (search rules and synonyms were
 *                                      developed against it).
 *  `eval/registry-questions-holdout.json` - written afterwards and never used to tune.
 *
 *  Metric: hit@5 = at least one of the top five results is an acceptable dataset
 *  (primary id, or any merged alternate route, matching an id/glob in `acceptable`).
 *  Per-theme numbers are printed on every run; measured results live in eval/RESULTS.md.
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandEntry, type RegistrySnapshot } from '../compact'
import { hitAtK, isAcceptable, perTheme, type EvalQuestion } from '../eval'
import { GOLDEN } from '../golden'
import { RegistryIndex } from '../search'
import { THEMES } from '../types'

const ROOT = path.resolve(__dirname, '../../../../../../..')
const load = (f: string): EvalQuestion[] => JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', f), 'utf8'))

const snap: RegistrySnapshot = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../snapshot.json'), 'utf8'))
const entries = snap.entries.map(expandEntry)
const index = new RegistryIndex(entries, GOLDEN)

function run(questions: EvalQuestion[]) {
  const results = questions.map((q) => {
    const t0 = performance.now()
    const r = index.search(q.q, { aoi: q.aoi, time: q.time, limit: 8 })
    const ms = performance.now() - t0
    return { q, hit: hitAtK(r.hits.map((h) => h.entry), q.acceptable, 5), ms, top: r.hits.slice(0, 5).map((h) => h.entry.id) }
  })
  const hits = results.filter((r) => r.hit).length
  return { results, hits, rate: hits / results.length, themes: perTheme(results.map((r) => ({ theme: r.q.theme, hit: r.hit }))) }
}

function report(title: string, out: ReturnType<typeof run>) {
  const lines = out.themes.map((t) => `  ${t.theme.padEnd(15)} ${t.hits}/${t.n}  ${(t.hits / t.n).toFixed(2)}`)
  console.log(`\n${title}: hit@5 = ${out.hits}/${out.results.length} = ${out.rate.toFixed(3)}\n${lines.join('\n')}`)
  for (const r of out.results.filter((x) => !x.hit)) console.log(`  MISS [${r.q.theme}] ${r.q.q}\n        top5: ${r.top.join(' | ')}`)
}

describe('eval fixture', () => {
  const tuning = load('registry-questions.json')

  it('has at least 80 questions covering every theme', () => {
    expect(tuning.length).toBeGreaterThanOrEqual(80)
    const covered = new Set(tuning.map((q) => q.theme))
    for (const t of THEMES) expect(covered.has(t), `no question for theme ${t}`).toBe(true)
  })

  it('every question has ground truth that exists in the registry', () => {
    for (const q of [...tuning, ...load('registry-questions-holdout.json')]) {
      expect(q.acceptable.length, q.q).toBeGreaterThan(0)
      expect(entries.some((e) => isAcceptable(e, q.acceptable)), `no acceptable dataset in registry for: ${q.q}`).toBe(true)
    }
  })

  it('acceptable lists are tight: no catch-all globs', () => {
    for (const q of [...tuning, ...load('registry-questions-holdout.json')]) {
      for (const p of q.acceptable) {
        expect(/^[a-z0-9-]+:\*+$/.test(p) && !['opentopography:*'].includes(p), `catch-all glob "${p}" in: ${q.q}`).toBe(false)
        const matches = entries.filter((e) => isAcceptable(e, [p])).length
        expect(matches, `pattern "${p}" matches too much (${matches}) in: ${q.q}`).toBeLessThanOrEqual(4400)
      }
    }
  })
})

describe('retrieval quality', () => {
  it('tuning set: hit@5 >= 0.90 overall', () => {
    const out = run(load('registry-questions.json'))
    report('Tuning set', out)
    expect(out.rate).toBeGreaterThanOrEqual(0.9)
  })

  it('tuning set: no theme collapses (every theme >= 0.5)', () => {
    const out = run(load('registry-questions.json'))
    for (const t of out.themes) expect(t.hits / t.n, `theme ${t.theme}`).toBeGreaterThanOrEqual(0.5)
  })

  it('hold-out set (never tuned against): hit@5 >= 0.85', () => {
    const out = run(load('registry-questions-holdout.json'))
    report('Hold-out set', out)
    expect(out.rate).toBeGreaterThanOrEqual(0.85)
  })

  // p95, not max: one GC pause or a loaded CI runner can stall a single query; the budget is about search cost.
  it('p95 latency is under 50 ms', () => {
    const all = run([...load('registry-questions.json'), ...load('registry-questions-holdout.json')])
    const times = all.results.map((r) => r.ms).sort((a, b) => a - b)
    console.log(`\nLatency over ${times.length} queries: p50 ${times[Math.floor(times.length / 2)].toFixed(2)} ms, p95 ${times[Math.floor(times.length * 0.95)].toFixed(2)} ms, max ${times[times.length - 1].toFixed(2)} ms`)
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(50)
  })
})
