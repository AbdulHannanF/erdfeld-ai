/** Planner evaluation CLI.
 *
 *  Live, plan-only (the model's first turn is recorded and scored; nothing is executed):
 *    GEMINI_API_KEY=... npx vite-node -c vitest.config.ts eval/planner/run.mts -- --live --provider gemini --model gemini-3.8-flash
 *    options: --only fl01,rf03   --concurrency 3   --thinking low|medium|high
 *  Replay a recording offline with the current validator, scorer and cases (no key):
 *    npx vite-node -c vitest.config.ts eval/planner/run.mts -- --replay eval/planner/recordings/<file>.jsonl [--verbose]
 *  Pin the replayed scores as the CI baseline:
 *    ... --replay <file> --write-baseline
 */

import './env'

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'

import {
  PLANNER_DIR, RECORDINGS_DIR, AS_OF, callLive, ci, loadAois, loadCases, loadRecording, mapLimit, metaFor, pct, recordingName,
  replayAll, requestFor, scoreOutcome, summarize, type CaseScore, type RecordedTurn,
} from './lib'

const flag = (n: string) => process.argv.includes(`--${n}`)
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }

function print(scores: CaseScore[], verbose: boolean) {
  for (const s of scores) {
    if (s.status !== 'scored') { console.log(`${s.status.toUpperCase().padEnd(7)} ${s.id} ${s.query.slice(0, 70)}${s.note ? `  (${s.note})` : ''}`); continue }
    if (!s.passed || verbose) {
      console.log(`${s.passed ? 'pass   ' : 'FAIL   '} ${s.id} [${s.behaviour}: ${(s.tools ?? []).join(', ') || '-'}] ${s.query.slice(0, 70)}`)
      for (const c of s.checks.filter((k) => verbose || !k.ok)) console.log(`          ${c.ok ? 'ok ' : 'NO '} ${c.type}: ${c.detail.slice(0, 160)}`)
    }
  }
  const sum = summarize(scores)
  console.log(`\noverall ${sum.overall.passed}/${sum.overall.n} = ${pct(sum.overall)} (95% interval ${ci(sum.overall)}); provider errors ${sum.errors}, missing ${sum.missing}, stale ${sum.stale}`)
  console.log('by check: ' + Object.entries(sum.checks).map(([k, r]) => `${k} ${r.passed}/${r.n}`).join(', '))
  console.log('by family: ' + Object.entries(sum.families).map(([k, r]) => `${k} ${r.passed}/${r.n}`).join(', '))
}

async function main(): Promise<number> {
  const replay = arg('replay')
  if (replay) {
    const rec = loadRecording(path.resolve(replay))
    const scores = replayAll(rec)
    console.log(`replay of ${path.relative(process.cwd(), rec.file)} (${rec.meta.provider} ${rec.meta.model}, recorded ${rec.meta.recorded_at}, ${rec.meta.mode})`)
    print(scores, flag('verbose'))
    if (flag('write-baseline')) {
      const cases = Object.fromEntries(scores.filter((s) => s.status === 'scored').map((s) => [s.id, s.passed]))
      writeFileSync(path.join(PLANNER_DIR, 'baseline.json'), JSON.stringify({ recording: path.relative(path.resolve(PLANNER_DIR, '../..'), rec.file).split(path.sep).join('/'), cases }, null, 2) + '\n')
      console.log('wrote baseline.json')
    }
    return 0
  }

  if (!flag('live')) { console.error('Pass --live (needs a key) or --replay <recording>.'); return 2 }
  const provider = arg('provider') ?? 'gemini'
  const model = arg('model')
  const apiKey = process.env[provider === 'gemini' ? 'GEMINI_API_KEY' : `${provider.toUpperCase()}_API_KEY`]?.trim()
  if (!apiKey && provider !== 'ollama') { console.error(`No ${provider} key in the environment. Nothing was run.`); return 2 }
  if (arg('thinking')) process.env.GEOAGENT_GEMINI_THINKING_PLAN = arg('thinking')

  const only = arg('only')?.split(',')
  const cases = loadCases().filter((c) => !only || only.includes(c.id))
  const aois = loadAois()
  const cfg = { provider, model, apiKey }
  mkdirSync(RECORDINGS_DIR, { recursive: true })
  const thinking = process.env.GEOAGENT_GEMINI_THINKING_PLAN ?? process.env.GEOAGENT_GEMINI_THINKING
  const file = path.join(RECORDINGS_DIR, recordingName(provider, `${model ?? 'default'}${thinking ? `-think-${thinking}` : ''}`, AS_OF))
  writeFileSync(file, JSON.stringify(metaFor(cfg, cases.length)) + '\n')

  console.log(`live plan-only run: ${cases.length} cases on ${provider} ${model ?? '(default)'}, thinking(plan)=${process.env.GEOAGENT_GEMINI_THINKING_PLAN ?? process.env.GEOAGENT_GEMINI_THINKING ?? 'default'}`)
  const scores = await mapLimit(cases, Number(arg('concurrency') ?? 3), async (c) => {
    const req = requestFor(c, aois)
    const { outcome, latency_ms } = await callLive(req, cfg)
    const turn: RecordedTurn = { kind: 'turn', case_id: c.id, request_sha: req.sha, outcome, latency_ms }
    appendFileSync(file, JSON.stringify(turn) + '\n')
    return scoreOutcome(c, outcome, aois[c.aoi].geometry)
  })
  const lat = (await Promise.resolve(loadRecording(file))).turns
  const ms = [...lat.values()].map((t) => t.latency_ms ?? 0).sort((a, b) => a - b)
  print(scores, flag('verbose'))
  console.log(`plan latency: median ${(ms[Math.floor(ms.length / 2)] / 1000).toFixed(1)} s, max ${(ms[ms.length - 1] / 1000).toFixed(1)} s`)
  console.log(`recording: ${path.relative(process.cwd(), file)}`)
  return 0
}

process.exit(await main())
