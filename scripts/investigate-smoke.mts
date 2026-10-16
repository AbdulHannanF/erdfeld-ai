/**
 * Live smoke test of the autonomous investigator: three real investigations end to end, over real
 * satellite data and the live Gemini API (no stub, no mocked operation).
 *
 *   GEMINI_API_KEY=... npx vite-node --config vitest.config.ts scripts/investigate-smoke.mts -- \
 *     [--model gemini-3.8-flash] [--only kasur,lahaina,development] [--budget-ms 300000] \
 *     [--no-llm] [--out eval/investigator-smoke]
 *
 * It prints each run's steps (item, operation, value of information, timing), the posterior after
 * every step, the verdict, the corroboration sources and the dossier summary, and writes the
 * non-layer events of each run to `--out/<case>.json` for eval/INVESTIGATOR.md.
 *
 * This is a smoke test of three cases, not an accuracy measurement. The expected answers below are
 * what the case is known to be; the script reports whether the verdict agreed, nothing more.
 *
 * `--no-llm` exercises everything except the model: every model call is replaced by one that
 * fails, so the run shows the engine's own behaviour (catalogue priors, rule sentences, a
 * narrative from recorded results). The vision operation then fails too, since it needs a model.
 * Without GEMINI_API_KEY (and without --no-llm) it exits with a message and does nothing.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const noLlm = flag('no-llm')
const key = process.env.GEMINI_API_KEY?.trim()
if (!key && !noLlm) {
  console.error('GEMINI_API_KEY is not set. This smoke test calls the live Gemini API and needs a key (https://aistudio.google.com/apikey). Nothing was run. Use --no-llm to run the engine without the model.')
  process.exit(2)
}

// Imported after the key check so a missing key fails fast, before the whole tool stack loads.
const { runInvestigation } = await import('../src/app/api/agent/investigator/run')
const { getFamily } = await import('../src/app/api/agent/investigator/catalogue')
const { resolveLlmConfig } = await import('../src/app/api/agent/lib/providers')
const { runWithCacheContext } = await import('../src/app/api/agent/lib/cache')

const box = (w: number, s: number, e: number, n: number) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] })

interface Case {
  id: string
  title: string
  aoi: any
  window: { start: string; end: string }
  question: string
  expected: string
  /** Family hint, used only with --no-llm (a model otherwise picks the family from the question). */
  family: 'water' | 'fire' | 'structures'
  source: string
}

const CASES: Case[] = [
  {
    id: 'kasur',
    title: 'Sutlej near Kasur, Pakistan (Aug-Sep 2025)',
    aoi: box(74.40, 30.95, 74.56, 31.08),
    window: { start: '2025-08-01', end: '2025-09-30' },
    question: 'What happened along the Sutlej here in August and September 2025?',
    expected: 'flood',
    family: 'water',
    source: 'Punjab (Pakistan) river floods of Aug-Sep 2025 on the Sutlej, Ravi and Chenab, widely reported by Pakistan\'s NDMA and the press.',
  },
  {
    id: 'lahaina',
    title: 'Lahaina, Maui (Aug 2023)',
    aoi: box(-156.69, 20.86, -156.66, 20.89),
    window: { start: '2023-08-01', end: '2023-08-31' },
    question: 'What happened in Lahaina in August 2023?',
    expected: 'fire',
    family: 'fire',
    source: 'The Lahaina wildfire of 8 August 2023 (Maui County, Hawaii), documented by Maui Fire Department, NIST and the press.',
  },
  {
    id: 'development',
    title: 'Western Sydney International Airport terminal precinct (2023-2025)',
    aoi: box(150.700, -33.900, 150.730, -33.876),
    window: { start: '2023-06-01', end: '2025-06-01' },
    question: 'Are there new buildings or structures in this area between mid 2023 and mid 2025?',
    expected: 'new structures (construction)',
    family: 'structures',
    source: 'Western Sydney International (Nancy-Bird Walton) Airport, Badgerys Creek NSW: coordinates from Wikipedia ("Western Sydney Airport", -33.888, 150.715); the passenger terminal, apron and landside works were built through 2023-2025 ahead of the planned 2026 opening, per the airport company\'s published construction updates.',
  },
]

const only = arg('only')?.split(',').map((s) => s.trim())
const model = arg('model') ?? 'gemini-3.8-flash'
const budgetMs = Number(arg('budget-ms') ?? process.env.INVESTIGATOR_TIME_BUDGET_MS ?? 300_000)
const outDir = arg('out') ?? 'eval/investigator-smoke'
mkdirSync(outDir, { recursive: true })

const scrub = (s: string) => (key ? s.split(key).join('[redacted]') : s)
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`

const failingLlm = {
  propose: async () => { throw new Error('model disabled (--no-llm)') },
  explainStep: async () => { throw new Error('model disabled (--no-llm)') },
  classifyImagery: async () => { throw new Error('model disabled (--no-llm)') },
  writeNarrative: async () => { throw new Error('model disabled (--no-llm)') },
  searchReports: async () => { throw new Error('model disabled (--no-llm)') },
}

const summary: Array<Record<string, unknown>> = []
for (const c of CASES.filter((x) => !only || only.includes(x.id))) {
  console.log(`\n${'='.repeat(78)}\n${c.title}\nexpected: ${c.expected}\nsource: ${c.source}\n${'='.repeat(78)}`)
  const resolved = resolveLlmConfig({ provider: 'gemini', apiKey: key ?? 'unused', model })
  if (!resolved.ok) { console.error(resolved.message); process.exit(2) }

  const events: Array<{ event: string; data: any; t: number }> = []
  const t0 = Date.now()
  let stepStart = t0
  const emit = (event: string, data: any) => {
    const t = Date.now() - t0
    if (event === 'layer' || event === 'tool_call' || event === 'chart') { events.push({ event, data: event === 'layer' ? { layer_id: data.layer_id, name: data.name, result_id: data.result_id } : { tool_name: data.tool_name, status: data.status, result_id: data.result_id, result_status: data.result_status }, t }); return }
    events.push({ event, data, t })
    if (event === 'discovery') console.log(`  [${sec(t)}] discovery: ${data.cells.map((x: any) => `${x.id}=${x.score ?? 'n/a'}`).join(' ')} -> ${data.chosen_cell}`)
    if (event === 'hypotheses') console.log(`  [${sec(t)}] ${data.family} ${data.window.start}..${data.window.end} (${data.window_source}); priors: ${data.items.map((h: any) => `${h.id}=${h.prior.toFixed(2)}`).join(' ')}${data.rejected_ids.length ? `; rejected ${data.rejected_ids}` : ''}${data.note ? `; note: ${data.note}` : ''}`)
    if (event === 'step') { stepStart = Date.now(); console.log(`  [${sec(t)}] step ${data.n}: ${data.item_id} -> ${data.op} voi=${data.voi} cost~${data.cost_s}s${data.reused ? ' (reused)' : ''}\n      why (${data.why_source}): ${data.why}${data.skipped.length ? `\n      skipped: ${data.skipped.map((s: any) => `${s.item_id} (${s.reason})`).join('; ')}` : ''}`) }
    if (event === 'evidence') console.log(`      -> ${data.status} in ${sec(Date.now() - stepStart)}: ${data.measured ? `${data.feature.name}=${data.feature.value} ${data.feature.unit} [${data.feature.bin}]${data.vision_category ? ` vision=${data.vision_category}` : ''}${data.capped ? ' (LR capped)' : ''}` : `NOT MEASURED: ${data.reason}`}`)
    if (event === 'belief') console.log(`      belief${data.updated ? '' : ' (unchanged)'}: ${data.posterior.map((r: any) => `${r.id}=${r.p.toFixed(3)}`).join(' ')}`)
    if (event === 'verdict') console.log(`  [${sec(t)}] VERDICT: ${data.label} (${data.posterior}) stop=${data.stop_reason}; ops=${data.evidence_ops_run} measured=${data.items_measured} unmeasured=${data.items_unmeasured}${data.evidence_that_would_decide.length ? `\n      would decide: ${data.evidence_that_would_decide.map((m: any) => `${m.item_id} (${m.why_not})`).join('; ')}` : ''}`)
    if (event === 'corroboration') console.log(`  [${sec(t)}] corroboration ${data.status}: ${data.sources.map((s: any) => `${s.publisher} "${s.title}" ${s.date || "undated"} in_window=${s.inWindow} ${s.url}`).join(' | ') || data.note}`)
    if (event === 'dossier') console.log(`  [${sec(t)}] dossier (${data.summary_source}, dropped ${data.sentences_dropped}):\n${data.summary.split('\n').map((l: string) => `      ${l}`).join('\n')}`)
    if (event === 'error') console.log(`  [${sec(t)}] ERROR: ${data.message}`)
  }

  const controller = new AbortController()
  await runWithCacheContext({ abortSignal: controller.signal }, () => runInvestigation({
    aoi: c.aoi, question: c.question, window: c.window,
    // With a model, the family is the model's call; without one it must be given.
    ...(noLlm ? { family: c.family } : {}),
    owner: null, llm: resolved.config, emit: emit as any, signal: controller.signal, budgetMs,
    ...(noLlm ? { deps: { llm: failingLlm } } : {}),
  }))

  const verdict = events.find((e) => e.event === 'verdict')?.data
  const hyp = events.find((e) => e.event === 'hypotheses')?.data
  const row = {
    case: c.id, expected: c.expected, family: hyp?.family ?? null, verdict: verdict?.label ?? null, verdict_id: verdict?.id ?? null,
    posterior: verdict?.posterior ?? null, stop_reason: verdict?.stop_reason ?? null, ops: verdict?.evidence_ops_run ?? null,
    steps: events.filter((e) => e.event === 'step').length, total_s: Number(((Date.now() - t0) / 1000).toFixed(1)),
    corroboration: events.find((e) => e.event === 'corroboration')?.data.status ?? null, model: noLlm ? 'none (--no-llm)' : model,
  }
  summary.push(row)
  writeFileSync(join(outDir, `${c.id}${noLlm ? '-nollm' : ''}.json`), scrub(JSON.stringify({ case: { ...c, aoi: undefined, bbox: c.aoi.coordinates[0] }, budget_ms: budgetMs, row, events }, null, 1)))
  console.log(`  total ${sec(Date.now() - t0)}`)
  void getFamily
}

console.log(`\n${'='.repeat(78)}\nSUMMARY\n${'='.repeat(78)}`)
console.table(summary)
process.exit(0)
