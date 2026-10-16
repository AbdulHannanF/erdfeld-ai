/**
 * qwen3.8's eyes and verdicts.
 *
 * Ollama takes images inline on chat messages, so the same model that judges the
 * text answers also LOOKS at the screenshots. That matters: a UI bug like
 * white-on-white text or a legend overlapping the map is invisible to the DOM
 * and to every assertion you could write against it — it is only visible.
 *
 * Every call returns parsed JSON or an {error} object. Nothing here throws, so a
 * flaky model call degrades one verdict instead of ending the sweep.
 */
import fs from 'fs'

const OLLAMA = process.env.QA_JUDGE_BASE || 'http://127.0.0.1:11434'
const MODEL = process.env.QA_JUDGE_MODEL || 'qwen3.8:27b'
const TIMEOUT = Number(process.env.QA_VISION_TIMEOUT_MS || 600_000)

/** Strip a thinking model's scratchpad, then pull the first JSON object/array. */
export function extractJson(text) {
  let t = String(text ?? '')
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '')
  t = t.replace(/```(?:json)?/gi, '')
  const start = t.search(/[{[]/)
  if (start === -1) return null
  // Walk braces so trailing prose after the JSON can't break the parse.
  const open = t[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < t.length; i++) {
    const c = t[i]
    if (esc) { esc = false; continue }
    if (c === '\\') { esc = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) {
        try { return JSON.parse(t.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

/**
 * One call to qwen. `images` are file paths, read and base64'd here.
 * `think` defaults off: the driving loop makes many calls and reasoning tokens
 * dominate wall-clock; the rubrics are explicit enough not to need it.
 */
export async function ask({ system, user, images = [], think = false, temperature = 0 }) {
  const encoded = []
  for (const p of images) {
    try { encoded.push(fs.readFileSync(p).toString('base64')) } catch { /* missing shot — judge on text */ }
  }

  const body = {
    model: MODEL,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user, ...(encoded.length ? { images: encoded } : {}) },
    ],
    stream: false,
    think,
    options: { temperature, num_ctx: 16384 },
  }

  // Retry: the Ollama host restarted midway through an unattended run and every
  // in-flight verdict came back "fetch failed", losing a whole judging pass.
  // A transient host blip must cost one call, not the entire sweep.
  let lastErr = ''
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT),
      })
      if (!res.ok) {
        lastErr = `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`
      } else {
        const data = await res.json()
        const content = String(data?.message?.content ?? '')
        const parsed = extractJson(content)
        if (parsed) return parsed
        lastErr = `no JSON in reply: ${content.slice(0, 300)}`
      }
    } catch (err) {
      lastErr = `model unreachable: ${err?.message || err}`
    }
    if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 15_000))
  }
  return { error: lastErr }
}

// ---------------------------------------------------------------------------
// Rubrics
// ---------------------------------------------------------------------------

const UI_RUBRIC = `You are a senior QA engineer reviewing a screenshot of a geospatial web app
(dark-themed, split-panel: interactive map on one side, AI chat on the other).

Report ONLY what you can actually SEE in this image. Do not assume a defect you cannot see, and do
not excuse one you can. Look specifically for:
- text that is unreadable: too low contrast, white-on-white, dark-on-dark, or clipped
- elements overlapping, colliding, or spilling outside their container
- content cut off at a panel or viewport edge; horizontal scrollbars
- broken layout: misaligned columns, collapsed panels, giant gaps, squashed controls
- placeholder / debug text visible to a user: "undefined", "NaN", "null", "[object Object]",
  raw markup like [[id#key]], lorem ipsum, or an untranslated key
- empty states that look broken rather than intentional
- a control that is visually present but appears disabled or unusable when it should not be
- anything that would make a user think the app is broken

Severity: "critical" = user cannot complete the task or sees obviously broken output;
"major" = clearly wrong/unprofessional but the task still completes; "minor" = cosmetic polish.

Reply with STRICT JSON only:
{"verdict":"PASS"|"FAIL","looks_like":"<one sentence describing what is on screen>",
 "bugs":[{"severity":"critical"|"major"|"minor","area":"<where>","what":"<what is wrong>","evidence":"<what you see that proves it>"}]}
An empty bugs array with verdict PASS is correct when the screen genuinely looks right.`

/** Judge one screenshot against a stated expectation for that step. */
export async function judgeScreenshot({ stepId, intent, shotPath, note }) {
  const out = await ask({
    system: UI_RUBRIC,
    user: [
      `STEP: ${stepId}`,
      `WHAT THIS SCREEN SHOULD SHOW: ${intent}`,
      note ? `CONTEXT: ${note}` : '',
      'Review the attached screenshot.',
    ].filter(Boolean).join('\n'),
    images: [shotPath],
  })
  return { stepId, intent, shot: shotPath, ...out }
}

const RESULT_RUBRIC = `You are a QA engineer checking how a geospatial AI app RENDERS an answer.
You are given the user's question and a screenshot of the app after it answered.

Judge the PRESENTATION, not the science:
- Is there a visible answer, or is the panel empty / stuck loading / showing an error?
- Are citations rendered as clean pills, or is raw markup like [[result_id#key]] leaking through?
- If the answer includes numbers, are they formatted for a human (units, sensible decimals) rather
  than raw floats like 0.35200000000000004?
- Did a map layer / chart / legend actually appear for a question that should produce one?
- Is any part of the answer visibly truncated, overlapping, or unreadable?
- Does the screen as a whole look like a finished answer a user would trust?

Reply with STRICT JSON only:
{"verdict":"PASS"|"FAIL","rendered":"<what the answer area actually shows, one sentence>",
 "has_visible_answer":true|false,"has_layer_or_chart":true|false,"raw_markup_leaked":true|false,
 "bugs":[{"severity":"critical"|"major"|"minor","area":"<where>","what":"<what is wrong>","evidence":"<what you see>"}]}`

/** Judge how one query's result was rendered on screen. */
export async function judgeRenderedResult({ id, query, intent, shotPath, answerText }) {
  const out = await ask({
    system: RESULT_RUBRIC,
    user: [
      `USER QUESTION: ${query}`,
      `WHAT A CORRECT RENDERING LOOKS LIKE: ${intent}`,
      answerText ? `ANSWER TEXT THE APP PRODUCED (for cross-checking what should be on screen):\n${String(answerText).slice(0, 1500)}` : '',
      'Review the attached screenshot of the app after answering.',
    ].filter(Boolean).join('\n'),
    images: [shotPath],
  })
  return { id, query, shot: shotPath, ...out }
}

const TOOL_RUBRIC = `You are auditing ONE tool of a geospatial data platform. You get the tool name, the
place it was pointed at, what a correct result looks like, and the result it returned.

The platform's central promise is that it never fabricates. Judge against that:

1. HONEST FAILURE. If the data does not exist or the source failed, the result must SAY SO and name
   the reason. A confident number where no data exists is the worst possible outcome — worse than an error.
2. NEGATIVE CONTROLS. Some probes deliberately point at places where the answer is "nothing here"
   (ocean, empty desert). "Zero" is then CORRECT — but it must be a real, explained zero, clearly
   distinguishable from a silent failure. A bare "0 results" with no reason is a FAIL.
3. NO MISLABELLING. Water must not be described as vegetation. A modelled estimate must not be
   presented as a measurement. If a tool fell back to a different source than its headline one, it
   must say which source actually answered.
4. INTERNAL CONSISTENCY. Numbers in one result must not contradict each other — e.g. a pixel count
   that cannot be reconciled with the stated area and resolution, or a stated source in the text that
   differs from the source recorded in the layer's provenance.
5. PLAUSIBLE VALUES. Indices in -1..1, percentages 0..100, temperatures suited to the place and season,
   elevations suited to the terrain.

Reply with STRICT JSON only:
{"verdict":"PASS"|"FAIL","confidence":0.0-1.0,"reason":"<one sentence>",
 "issues":[{"severity":"critical"|"major"|"minor","what":"<what is wrong>"}]}`

/** Judge one live tool result. */
export async function judgeToolResult(probe) {
  const out = await ask({
    system: TOOL_RUBRIC,
    user: [
      `TOOL: ${probe.tool}`,
      `ARGUMENTS: ${JSON.stringify(probe.args)}`,
      `PLACE: ${probe.aoi_label}`,
      `PROBE TYPE: ${probe.kind === 'negative' ? 'NEGATIVE CONTROL — the honest answer may well be "nothing here"' : 'positive — real data should exist here'}`,
      `WHAT A CORRECT RESULT LOOKS LIKE: ${probe.intent}`,
      probe.threw ? `THE TOOL THREW: ${probe.error}` : '',
      `RESULT SUMMARY:\n${String(probe.summary || '(empty)').slice(0, 3500)}`,
      `STRUCTURED VALUES: ${JSON.stringify(probe.summary_data || {}).slice(0, 1200)}`,
      `LAYER PROVENANCE: ${JSON.stringify((probe.layers || []).map((l) => l.provenance)).slice(0, 800)}`,
    ].filter(Boolean).join('\n\n'),
    think: false,
  })
  return { id: probe.id, tool: probe.tool, kind: probe.kind, ...out }
}

const DRIVER_SYSTEM = `You are a QA engineer testing a geospatial web app by actually using it.
You see a screenshot where every interactive element is outlined and labelled with a NUMBER, plus a
list of those numbered elements. Explore like a thorough tester: open panels, toggle controls, try
the things a real user would try, and notice anything broken.

Rules:
- Choose ONE action per turn, using an element NUMBER from the list.
- Prefer elements you have not tried yet. Do not repeat an action that already failed.
- Do not click anything that would obviously navigate away from the app or sign in/out.
- Report every visible defect you notice in "bugs", even when your action succeeds.

Available actions:
  {"action":"click","index":<n>}
  {"action":"type","index":<n>,"text":"<text>"}
  {"action":"key","key":"Enter"|"Escape"}
  {"action":"scroll","direction":"down"|"up"}
  {"action":"wait","seconds":<1-10>}
  {"action":"done"}

Reply with STRICT JSON only:
{"observation":"<what you see now, one sentence>","action":{...},"why":"<what you are testing>",
 "bugs":[{"severity":"critical"|"major"|"minor","area":"<where>","what":"<what is wrong>","evidence":"<what you see>"}]}`

/** One turn of the autonomous exploration loop. */
export async function driveStep({ goal, elements, shotPath, history }) {
  const list = elements
    .map((e) => `${e.index}. <${e.tag}${e.role ? ` role=${e.role}` : ''}> ${JSON.stringify(e.label).slice(0, 90)}`)
    .join('\n')
  const out = await ask({
    system: DRIVER_SYSTEM,
    user: [
      `YOUR GOAL THIS SESSION: ${goal}`,
      history.length ? `ACTIONS YOU ALREADY TOOK:\n${history.slice(-12).join('\n')}` : 'This is your first action.',
      `NUMBERED ELEMENTS ON SCREEN:\n${list}`,
      'Look at the screenshot and choose your next action.',
    ].join('\n\n'),
    images: [shotPath],
  })
  return out
}
