/** Run a claim recipe on the labelled plots and record, for each, the verdict and the figures it
 *  rested on (so the decision can be re-evaluated offline without the network).
 *
 *    NODE_USE_ENV_PROXY=1 npx vite-node -c vitest.config.ts eval/claims/run.mts -- [--recipe not_cleared_since@1.0.0]
 *       [--split dev|test|all] [--limit 200] [--concurrency 4] [--budget-min 60]
 *       [--plots eval/claims/plots.json] [--out eval/claims/records-<recipe>.jsonl]
 *
 *  Resumable: plots already in the output file are skipped. Stops starting new plots when the
 *  wall-clock budget is spent, and reports how many it did run.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs'

import { loadRecipes } from '../../src/app/api/agent/engine/claims/loader'
import { runClaim, toNodeRecord } from '../../src/app/api/agent/engine/claims/run'
import type { NodeRecord } from '../../src/app/api/agent/engine/claims/rule'
import type { LabelledPlot } from './generate'

/** The claim every plot is tested with: not cleared since this date, checked up to AS_OF. A
 *  "loss" plot lost its tree cover in 2021-2023, a "stable" plot in no year. */
export const CLAIM = { date: '2020-07-31', as_of: '2024-07-31' }

export interface PlotRecord {
  id: string
  recipe: string
  verdict: string
  confidence: number | null
  rule: string
  kind?: string
  reason: string
  nodes: NodeRecord[]
  seconds: number
  error?: string
}

const arg = (name: string, d?: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : d }

async function main() {
  const catalog = loadRecipes()
  const recipeRef = arg('--recipe', 'not_cleared_since')!
  const recipe = catalog.get(recipeRef)
  if (!recipe) throw new Error(`no recipe ${recipeRef}`)
  const split = arg('--split', 'all')!
  const limit = Number(arg('--limit', '250'))
  const conc = Number(arg('--concurrency', '4'))
  const budgetMs = Number(arg('--budget-min', '60')) * 60_000
  const out = arg('--out', `eval/claims/records-${recipe.id}@${recipe.version}.jsonl`)!
  const all = (JSON.parse(readFileSync(arg('--plots', 'eval/claims/plots.json')!, 'utf8')).plots as LabelledPlot[])
    .filter((p) => split === 'all' || p.split === split)
  const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id as string) : [])
  const queue = all.filter((p) => !done.has(p.id)).slice(0, Math.max(0, limit - done.size))
  const started = Date.now()
  let n = 0
  console.error(`${recipe.id}@${recipe.version}: ${queue.length} plots to run (${done.size} already recorded), concurrency ${conc}, budget ${budgetMs / 60000} min`)

  const worker = async () => {
    for (;;) {
      if (Date.now() - started > budgetMs) return
      const plot = queue.shift()
      if (!plot) return
      const t0 = Date.now()
      let rec: PlotRecord
      try {
        const o = await runClaim(recipe, CLAIM, { geometry: plot.geometry })
        rec = {
          id: plot.id, recipe: o.recipe, verdict: o.decision.verdict, confidence: o.decision.confidence, rule: o.decision.rule,
          ...(o.decision.kind ? { kind: o.decision.kind } : {}), reason: o.decision.reason,
          nodes: o.nodes.map((nd, i) => toNodeRecord(i, nd.op, o.results.find((r) => r.result_id === nd.resultId) ?? null)),
          seconds: Math.round((Date.now() - t0) / 1000),
        }
      } catch (err) {
        rec = { id: plot.id, recipe: `${recipe.id}@${recipe.version}`, verdict: 'error', confidence: null, rule: 'error', reason: (err as Error).message, nodes: [], seconds: Math.round((Date.now() - t0) / 1000), error: (err as Error).message }
      }
      appendFileSync(out, JSON.stringify(rec) + '\n')
      n++
      console.error(`[${n}] ${plot.id} (${plot.label}) -> ${rec.verdict}${rec.confidence != null ? ` ${rec.confidence}` : ''} ${rec.rule} ${rec.seconds}s`)
    }
  }
  await Promise.all(Array.from({ length: conc }, worker))
  console.error(`ran ${n} plots in ${Math.round((Date.now() - started) / 60000)} min; ${queue.length} left unrun`)
}

main()
