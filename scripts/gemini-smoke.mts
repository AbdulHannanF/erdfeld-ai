/**
 * Live smoke test of the Gemini path through the real agent loop (no stub, no mocks).
 *
 *   GEMINI_API_KEY=... npx vite-node --config vitest.config.ts scripts/gemini-smoke.mts -- [--models gemini-3.8-flash,gemma-4-31b-it] [--only 1,4]
 *
 * Runs five representative questions (flood, NDVI, a claim, a refusal, a cannot-determine case)
 * and prints, for each: the plan the model submitted, the tools that ran with their timings, and
 * the answer. The tools fetch real satellite data, so a run takes minutes and uses free-tier
 * quota. Without GEMINI_API_KEY it exits with a message and does nothing.
 */

const key = process.env.GEMINI_API_KEY?.trim()
if (!key) {
  console.error('GEMINI_API_KEY is not set. This smoke test calls the live Gemini API and needs a key (https://aistudio.google.com/apikey). Nothing was run.')
  process.exit(2)
}

// Imported after the key check so a missing key fails fast, before the whole tool stack loads.
const { runAgent } = await import('../src/app/api/agent/loop')
const { resolveLlmConfig } = await import('../src/app/api/agent/lib/providers')

const box = (w: number, s: number, e: number, n: number) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] })

const QUESTIONS = [
  { id: 1, kind: 'flood', query: 'How much of this area flooded during the 2024 monsoon (June to September)? How many buildings were affected?', aoi: box(91.84, 24.88, 91.90, 24.93) },
  { id: 2, kind: 'ndvi', query: 'What was the average NDVI of this area in July 2024, and how green is it?', aoi: box(36.80, -1.30, 36.83, -1.27) },
  { id: 3, kind: 'claim', query: 'Claim to check: "Over 20% of the tree cover in this area was lost between 2020 and 2023." Is that supported by the data?', aoi: box(-62.40, -9.60, -62.35, -9.55) },
  { id: 4, kind: 'refusal', query: 'Show me band B99 of the latest Sentinel-2 image of this area.', aoi: box(36.80, -1.30, 36.83, -1.27) },
  { id: 5, kind: 'cannot-determine', query: 'What was the exact wheat yield in tonnes for the fields in this area last year?', aoi: box(-93.62, 42.02, -93.58, 42.05) },
]

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const models = (arg('models') ?? process.env.GEOAGENT_MODEL_GEMINI ?? '').split(',').map((m) => m.trim()).filter(Boolean)
if (models.length === 0) models.push('') // '' = the configured default
const only = arg('only')?.split(',').map(Number)

const scrub = (s: string) => s.split(key).join('[redacted]')
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`

let failures = 0
for (const model of models) {
  const resolved = resolveLlmConfig({ provider: 'gemini', apiKey: key, model: model || undefined })
  if (!resolved.ok) { console.error(resolved.message); process.exit(2) }
  console.log(`\n${'='.repeat(78)}\nMODEL ${model || '(default)'}  fallbacks: ${process.env.GEOAGENT_MODEL_GEMINI_FALLBACKS ?? '(default chain)'}\n${'='.repeat(78)}`)

  for (const q of QUESTIONS.filter((x) => !only || only.includes(x.id))) {
    const events: Array<{ event: string; data: any }> = []
    const t0 = Date.now()
    console.log(`\n--- Q${q.id} [${q.kind}] ${q.query}`)
    await runAgent({
      aoi: q.aoi, query: q.query, lang: 'en', owner: null, llm: resolved.config,
      signal: new AbortController().signal,
      emit: (event, data) => events.push({ event, data }),
    })
    const of = (name: string) => events.filter((e) => e.event === name).map((e) => e.data)

    for (const p of of('plan')) {
      console.log(`plan (${p.kind}): ${p.steps.map((s: any, i: number) => `${i}:${s.tool}`).join(', ')}`)
    }
    for (const r of of('plan_refused')) console.log(`plan refused: ${r.reasons.join(' | ')}`)
    for (const t of of('tool_call').filter((x) => x.status !== 'running')) {
      console.log(`tool ${t.tool_name} -> ${t.status}${t.result_status ? `/${t.result_status}` : ''} ${t.timings?.total != null ? sec(t.timings.total) : ''} ${t.result_summary ?? ''}`)
    }
    const err = of('error')[0]
    if (err) { failures++; console.log(`ERROR: ${scrub(String(err.content))}`) }
    const done = of('done')[0]
    // `token` events are the answer; operation progress arrives as `thinking` events.
    const answer = scrub(of('token').map((t) => t.content).join('')).trim()
    const progress = of('thinking').map((t) => String(t.content).trim()).filter(Boolean)
    if (progress.length) console.log(`progress (${progress.length}, not in the answer): ${progress.slice(0, 3).join(' | ')}${progress.length > 3 ? ' | ...' : ''}`)
    console.log(`timings: total ${sec(Date.now() - t0)}${done?.timings ? `, plan-llm ${sec(done.timings.llm_plan)}, synthesis-llm ${sec(done.timings.llm_synthesis)}` : ''}`)
    console.log(`answer (${answer.length} chars):\n${answer.slice(0, 1800)}${answer.length > 1800 ? '\n[...]' : ''}`)
    if (!answer && !err) { failures++; console.log('NO ANSWER') }
  }
}
process.exit(failures ? 1 : 0)
