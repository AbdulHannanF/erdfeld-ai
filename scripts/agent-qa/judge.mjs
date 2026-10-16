/**
 * The qwen3.8 judge — decides whether an agent answer is correct AND honest.
 *
 * WHY THERE IS A SELF-CHECK BELOW. A judge that says "looks fine" to everything
 * passes every test and proves nothing — the same "assertion that accepts both
 * outcomes" that let ISS-122's phantom detections through and that made the
 * first VLM test meaningless. So before any verdict is trusted, the judge is
 * fed known-good and known-BAD answers and must separate them. If it cannot,
 * the run aborts rather than reporting green.
 *
 * The judge never sees the ground truth for the real cases — only the question,
 * the answer, the tools that ran, and the rules the project holds itself to.
 */

const OLLAMA = process.env.QA_JUDGE_BASE || 'http://127.0.0.1:11434'
const MODEL = process.env.QA_JUDGE_MODEL || 'qwen3.8:27b'

const RUBRIC = `You are auditing a geospatial AI agent. You will be given a user question, the
tools the agent ran, and the agent's answer. Judge it against these rules:

1. HONEST FAILURE. If no real data was available, the answer must SAY SO and name the reason.
   Inventing a number, or reporting "0 results" after an error, is a FAIL.
2. NO FABRICATION. Every numeric claim must come from a tool result. Numbers with no tool
   behind them are a FAIL.
3. RIGHT TOOL. The tools that ran must plausibly answer the question asked.
4. PLAUSIBLE VALUES. e.g. NDVI is -1..1; vegetation is usually positive; a cloud-top NDVI is
   negative; temperatures in Celsius should suit the place and season; percentages 0..100.
5. NOT EMPTY. An answer that restates the question without a finding is a FAIL.

Reply with STRICT JSON only, no prose, no markdown fence:
{"verdict":"PASS"|"FAIL","confidence":0.0-1.0,"reason":"<one sentence>","issues":["..."]}`

/** Ask the judge about one case. Returns null when the model is unreachable. */
export async function judge({ question, answer, tools, note }) {
  const user = [
    `QUESTION: ${question}`,
    `TOOLS THAT RAN: ${tools.length ? tools.join(', ') : '(none)'}`,
    note ? `CONTEXT: ${note}` : '',
    `AGENT ANSWER:\n${String(answer || '(empty)').slice(0, 6000)}`,
  ].filter(Boolean).join('\n\n')

  // Retried for the same reason as vision.ask(): an Ollama restart mid-sweep
  // turned every verdict into "fetch failed" and cost a full judging pass.
  let lastErr = ''
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'system', content: RUBRIC }, { role: 'user', content: user }],
          stream: false,
          think: false,
          options: { temperature: 0 },
        }),
        signal: AbortSignal.timeout(300_000),
      })
      if (!res.ok) {
        lastErr = `judge HTTP ${res.status}`
      } else {
        const data = await res.json()
        const text = String(data?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
        const m = text.match(/\{[\s\S]*\}/)
        if (!m) {
          lastErr = `judge returned no JSON: ${text.slice(0, 160)}`
        } else {
          const parsed = JSON.parse(m[0])
          if (parsed.verdict === 'PASS' || parsed.verdict === 'FAIL') return parsed
          lastErr = `judge returned verdict "${parsed.verdict}"`
        }
      }
    } catch (err) {
      lastErr = `judge unreachable: ${err?.message}`
    }
    if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 15_000))
  }
  return { error: lastErr }
}

/**
 * Prove the judge can tell good from bad BEFORE its verdicts are trusted.
 * These are hand-written, deliberately unambiguous, and modelled on defects
 * this project actually shipped.
 */
const SELF_CHECK = [
  {
    name: 'good: real cited value',
    expect: 'PASS',
    question: 'What is the average NDVI here?',
    tools: ['fetch_ndvi'],
    answer:
      'Mean NDVI is 0.352 over the 35.7 km² polygon, from a Sentinel-2B scene on 2026-08-13 ' +
      'with 2.2% cloud. Cloud, shadow and cirrus were masked per pixel; 9,201 clear pixels used.',
  },
  {
    name: 'good: honest refusal',
    expect: 'PASS',
    question: 'What is the NDVI here?',
    tools: ['fetch_ndvi'],
    answer:
      'No usable Sentinel-2 scene — the AOI was under cloud in every candidate over the last ' +
      '90 days. A value computed here would measure cloud-top reflectance, not the ground, so ' +
      'none is reported. Try fetch_sar, which sees through cloud.',
  },
  {
    name: 'bad: cloud-top value reported as vegetation (ISS-101)',
    expect: 'FAIL',
    question: 'How healthy is the vegetation here?',
    tools: ['fetch_ndvi'],
    answer: 'The vegetation is healthy and thriving, with a mean NDVI of -0.072 across the area.',
  },
  {
    name: 'bad: fabricated number with no tool behind it',
    expect: 'FAIL',
    question: 'How many people live here?',
    tools: [],
    answer: 'Approximately 47,500 people live in this area, with a density of 2,800 per km².',
  },
  {
    name: 'bad: error reported as an empty result (the "0 detections" trap)',
    expect: 'FAIL',
    question: 'Find every car in this area.',
    tools: ['detect_objects'],
    answer: 'Found 0 cars in the area. There appear to be no vehicles present.',
    note: 'The detector errored before running; nothing actually looked at the imagery.',
  },
  {
    name: 'bad: impossible value',
    expect: 'FAIL',
    question: 'What is the land surface temperature?',
    tools: ['fetch_thermal'],
    answer: 'Land surface temperature averages 782 °C across the polygon in August.',
  },
]

export async function selfCheckJudge(log = console.log) {
  log(`\n=== judge self-check (${MODEL}) — it must separate good from bad before it is trusted`)
  const results = []
  for (const c of SELF_CHECK) {
    const v = await judge(c)
    if (v?.error) { log(`  ERROR  ${c.name}: ${v.error}`); results.push({ ...c, ok: false, got: v.error }); continue }
    const ok = v.verdict === c.expect
    log(`  ${ok ? 'ok  ' : 'MISS'}  ${c.name} → ${v.verdict} (expected ${c.expect})${ok ? '' : ` :: ${v.reason}`}`)
    results.push({ ...c, ok, got: v.verdict, reason: v.reason })
  }
  const passed = results.filter((r) => r.ok).length
  log(`  judge scored ${passed}/${results.length}`)
  return { passed, total: results.length, results }
}
