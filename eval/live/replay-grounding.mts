/** Replays the grounding check over the live evaluation's recorded answers.
 *
 *    npx vite-node --config vitest.config.ts eval/live/replay-grounding.mts
 *
 *  Evidence per run is rebuilt from the record: every tool call's summary_data, its (120-character)
 *  summary, the plan's arguments and the question. The record does NOT keep the full tool summaries,
 *  provenance or facts lines the live check sees, so a figure that only appears there stays flagged
 *  in this replay: the count is an upper bound on what the live check flags. */
import fs from 'node:fs'
import turfArea from '@turf/area'
import { checkAnswerGrounding } from '../../src/app/api/agent/lib/grounding'

const rows = fs.readFileSync('eval/live/results-2026-10-15.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l))
let runs = 0
let oldFlaggedRuns = 0
let oldLines = 0
let newFlaggedRuns = 0
let newLines = 0
for (const r of rows) {
  if (r.endpoint !== '/api/agent' || !r.answer) continue
  runs++
  const oldBlock = r.unverified?.text ? r.unverified.text.split('\n').filter((l: string) => l.startsWith('- ')).length : 0
  if (oldBlock) { oldFlaggedRuns++; oldLines += oldBlock }
  const store = new Map<string, any>()
  const texts: string[] = [r.request?.query ?? '', JSON.stringify(r.plan ?? '')]
  for (const t of r.tool_calls ?? []) {
    if (t.result_id) store.set(t.result_id, { tool: t.tool, summary_data: t.summary_data, layers: [] })
    texts.push(t.summary ?? '')
  }
  const answer = String(r.answer).split('**Unverified statements.**')[0]
  const flagged = checkAnswerGrounding(answer, store, [turfArea({ type: 'Feature', properties: {}, geometry: r.request.aoi } as any) / 1e6], texts)
  if (flagged.length) { newFlaggedRuns++; newLines += flagged.length }
  for (const f of flagged) console.log(`${r.id} | ${f.sentence.replace(/\[\[[^\]]*\]\]/g, '').slice(0, 220)} | ${f.reason}`)
}
console.log(JSON.stringify({ runs, old: { flaggedRuns: oldFlaggedRuns, lines: oldLines }, replay: { flaggedRuns: newFlaggedRuns, lines: newLines } }))
