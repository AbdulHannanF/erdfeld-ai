/** Recall of the operation shortlist against the planner evaluation's expected operations, and the prompt-size saving.
 *    npx vite-node --config vitest.config.ts scripts/perf/shortlist-recall.mts */
import '../../eval/planner/env'
import fs from 'node:fs'
import { getToolDefinitions } from '../../src/app/api/agent/engine/registry'
import { shortlistOperations } from '../../src/app/api/agent/engine/shortlist'

const cases = fs.readFileSync('eval/planner/cases.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const full = JSON.stringify(getToolDefinitions()).length
let need = 0
let hit = 0
const misses: string[] = []
let sizeSum = 0
for (const c of cases) {
  const s = shortlistOperations(c.query)
  sizeSum += s.names.length
  const want: string[] = [...(c.expect.must_use ?? []), ...((c.expect.must_use_any ?? []).length ? [c.expect.must_use_any[0]] : [])]
  // must_use_any: at least one of the list is enough
  const anyOk = !(c.expect.must_use_any ?? []).length || c.expect.must_use_any.some((o: string) => s.names.includes(o))
  for (const w of c.expect.must_use ?? []) { need++; if (s.names.includes(w)) hit++; else misses.push(`${c.id}: ${w} missing from [${s.names.join(',')}]`) }
  if (!anyOk) misses.push(`${c.id}: none of ${JSON.stringify(c.expect.must_use_any)} in [${s.names.join(',')}]`)
  void want
}
console.log(`cases ${cases.length}, must_use recall ${hit}/${need}, mean shortlist size ${(sizeSum / cases.length).toFixed(1)} of ${getToolDefinitions().length - 1} operations`)
console.log(`tool declarations: full set ${full} chars (~${Math.round(full / 4)} tokens)`)
const sub = cases.map((c) => JSON.stringify(getToolDefinitions().filter((t: any) => t.function.name === 'submit_plan' || shortlistOperations(c.query).names.includes(t.function.name))).length)
console.log(`shortlisted: mean ${Math.round(sub.reduce((a, b) => a + b, 0) / sub.length)} chars (~${Math.round(sub.reduce((a, b) => a + b, 0) / sub.length / 4)} tokens)`)
for (const m of misses) console.log('MISS', m)
process.exit(0)
