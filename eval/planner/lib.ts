/** Planner evaluation: cases, a plan-only model call, recording / replay and scoring.
 *
 *  What is measured is the FIRST model turn of the agent loop: the same system prompt and tool
 *  definitions the loop sends, the case's question, and what comes back (a `submit_plan`, direct
 *  tool calls, or plain text). The plan goes through the real static `validatePlan`; nothing is
 *  executed and no satellite data is fetched, so a run costs only model tokens.
 *
 *  Ported from the earlier harness (docs/wip/plannereval.patch), minus its route refactor and
 *  raw-byte recordings: a recording here is the decoded turn (text, tool calls), which is what the
 *  scorer reads. Replay re-scores recorded turns with the CURRENT validator, scorer and cases, so
 *  CI can catch a code change that breaks a plan the model made, without a key.
 *
 *  Honesty rules: a provider error is an error and leaves the rates, never a miss; a recording
 *  whose request no longer matches the current prompt and tools is flagged stale.
 */

import './env'

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { DATE_KEYS } from '../../src/app/api/agent/engine/operation'
import { validatePlan } from '../../src/app/api/agent/engine/plan'
import { getToolDefinitions, listOperations } from '../../src/app/api/agent/engine/registry'
import type { LLMEvent } from '../../src/app/api/agent/lib/llm-adapters'
import { createProviderStream } from '../../src/app/api/agent/lib/llm'
import { SUBMIT_PLAN_TOOL, parseSubmitPlan, type PlanStep } from '../../src/app/api/agent/lib/plan'
import type { ManifestLayer } from '../../src/app/api/agent/lib/types'
import { buildPrompt } from '../../src/app/api/agent/prompt'

export const PLANNER_DIR = path.resolve(__dirname)
export const RECORDINGS_DIR = path.join(PLANNER_DIR, 'recordings')

/** The date every case is written against: the prompt's "Current date" and the validator's clock. */
export const AS_OF = '2026-10-13'
export const AS_OF_DATE = new Date(`${AS_OF}T12:00:00Z`)

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/** A plain value is compared for equality (strings without case, arrays in order); an object of
 *  `$` operators is one of the matchers below. */
export type ArgMatcher =
  | string | number | boolean | unknown[]
  | { $any_of?: unknown[]; $len?: number; $contains?: string; $matches?: string; $gte?: number; $lte?: number; $present?: boolean; $absent?: boolean }

export interface Expect {
  /** Every one of these operations appears in the plan. */
  must_use?: string[]
  /** At least one of these appears. */
  must_use_any?: string[]
  /** None of these appears ("the NIR band, not NDVI"). */
  must_not_use?: string[]
  /** Per operation: at least one step of it satisfies every argument matcher. */
  args?: Record<string, Record<string, ArgMatcher>>
  /** Every explicit date argument lies inside [from, to], and there is at least one. */
  date_window_within?: [string, string]
  /** The right behaviour is to decline: no tool calls and an explanation, a plan the static
   *  validator refuses, or a plan made only of `or_use` operations (an honest redirect). */
  expect_refusal?: boolean
  or_use?: string[]
  /** Answer from the Layer Manifest: no tool calls at all. */
  expect_no_tools?: boolean
  max_steps?: number
}

export interface PlannerCase {
  id: string
  family: string
  aoi: string
  query: string
  /** Layers already on the map (the prompt's Layer Manifest). */
  manifest?: ManifestLayer[]
  expect: Expect
  /** Why the expectation is what it is. */
  note?: string
}

export function loadCases(file = path.join(PLANNER_DIR, 'cases.jsonl')): PlannerCase[] {
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
    try {
      return JSON.parse(l) as PlannerCase
    } catch (e: any) {
      throw new Error(`${file}:${i + 1}: ${e.message}`)
    }
  })
}

export function loadAois(): Record<string, { label: string; geometry: any }> {
  return JSON.parse(readFileSync(path.join(PLANNER_DIR, 'aois.json'), 'utf8')).aois
}

export const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** The request the loop would send for this case's first turn. */
export function requestFor(c: PlannerCase, aois = loadAois()) {
  const aoi = aois[c.aoi]
  if (!aoi) throw new Error(`case ${c.id}: unknown AOI "${c.aoi}"`)
  const messages = [
    { role: 'system', content: buildPrompt(aoi.geometry, 'en', undefined, c.manifest, AS_OF_DATE) },
    { role: 'user', content: c.query },
  ]
  const tools = getToolDefinitions()
  return { messages, tools, sha: sha(JSON.stringify({ messages, tools })) }
}

// ---------------------------------------------------------------------------
// The model's first turn, live or recorded
// ---------------------------------------------------------------------------

export interface Outcome {
  text: string
  toolCalls: Array<{ id: string; name: string; args: Record<string, any>; argsError?: string }>
  finishReason: string
  error?: string
}

export interface ProviderConfig { provider: string; model?: string; apiKey?: string; baseUrl?: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One plan-only call through the real provider path (retries, fallbacks and thinking config are the loop's own). */
export async function callLive(req: { messages: any[]; tools: any[] }, cfg: ProviderConfig, timeoutMs = 90_000): Promise<{ outcome: Outcome; latency_ms: number }> {
  const started = Date.now()
  const out: Outcome = { text: '', toolCalls: [], finishReason: '' }
  try {
    const stream = await createProviderStream(req.messages, req.tools, { ...cfg, phase: 'plan' }, AbortSignal.timeout(timeoutMs))
    for await (const ev of stream as AsyncIterable<LLMEvent>) {
      if (ev.type === 'text') out.text += ev.text
      else if (ev.type === 'tool_call') out.toolCalls.push({ id: ev.id, name: ev.name, args: ev.args, ...(ev.argsError ? { argsError: ev.argsError } : {}) })
      else if (ev.type === 'done') out.finishReason = ev.finishReason
    }
  } catch (e: any) {
    out.error = String(e?.message ?? e)
    if (cfg.apiKey) out.error = out.error.split(cfg.apiKey).join('[redacted]')
  }
  return { outcome: out, latency_ms: Date.now() - started }
}

/** Run `fn` over `items` with at most `n` in flight; results keep the input order. */
export async function mapLimit<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
      await sleep(0)
    }
  }))
  return out
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

export interface RecordingMeta {
  kind: 'meta'
  v: 1
  provider: string
  model: string
  recorded_at: string
  as_of: string
  mode: 'plan-only'
  /** Cases answered when the recording was made. */
  cases: number
  /** Operations registered when it was made. */
  ops: string[]
}

export interface RecordedTurn {
  kind: 'turn'
  case_id: string
  /** Hash of the request (system prompt + tools + question) the model saw. */
  request_sha: string
  outcome: Outcome
  latency_ms?: number
}

export interface Recording { file: string; meta: RecordingMeta; turns: Map<string, RecordedTurn> }

export function loadRecording(file: string): Recording {
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  const meta = JSON.parse(lines[0]) as RecordingMeta
  if (meta.kind !== 'meta') throw new Error(`${file}: first line must be the meta line`)
  const turns = new Map<string, RecordedTurn>()
  for (const l of lines.slice(1)) {
    const t = JSON.parse(l) as RecordedTurn
    turns.set(t.case_id, t)
  }
  return { file, meta, turns }
}

export function listRecordings(dir = RECORDINGS_DIR): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(dir, f)) : []
}

export const recordingName = (provider: string, model: string, date: string) => `${provider}-${model.replace(/[^A-Za-z0-9._-]+/g, '_')}-${date}.jsonl`

export function metaFor(cfg: ProviderConfig, nCases: number): RecordingMeta {
  return {
    kind: 'meta', v: 1, provider: cfg.provider, model: cfg.model ?? 'default', recorded_at: new Date().toISOString(),
    as_of: AS_OF, mode: 'plan-only', cases: nCases, ops: listOperations().map((o) => o.name),
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export const CHECK_TYPES = ['no_direct', 'plan_valid', 'op_choice', 'args', 'dates', 'refusal', 'steps', 'reuse'] as const
export type CheckType = (typeof CHECK_TYPES)[number]
export interface CheckResult { type: CheckType; ok: boolean; detail: string }

export interface CaseScore {
  id: string
  family: string
  query: string
  status: 'scored' | 'error' | 'missing'
  /** What the model did: plan | direct (tool calls without submit_plan) | declined (text only) | empty. */
  behaviour?: 'plan' | 'direct' | 'declined' | 'empty'
  tools?: string[]
  checks: CheckResult[]
  passed: boolean
  stale?: boolean
  note?: string
}

const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v)

function deepEq(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEq(x, b[i]))
  return lower(a) === lower(b)
}

export function matches(actual: unknown, m: ArgMatcher): boolean {
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    const ops = m as Record<string, any>
    if (ops.$absent) return actual === undefined || actual === null
    if (ops.$present && (actual === undefined || actual === null)) return false
    if (ops.$any_of && !ops.$any_of.some((x: unknown) => matches(actual, x as ArgMatcher))) return false
    if (ops.$contains !== undefined) {
      const needle = String(ops.$contains).toLowerCase()
      if (Array.isArray(actual) ? !actual.some((x) => String(x).toLowerCase() === needle) : !String(actual ?? '').toLowerCase().includes(needle)) return false
    }
    if (ops.$matches !== undefined && !new RegExp(ops.$matches, 'i').test(String(actual ?? ''))) return false
    if (ops.$len !== undefined && !(Array.isArray(actual) && actual.length === ops.$len)) return false
    if (ops.$gte !== undefined && !(typeof actual === 'number' && actual >= ops.$gte)) return false
    if (ops.$lte !== undefined && !(typeof actual === 'number' && actual <= ops.$lte)) return false
    return true
  }
  return deepEq(actual, m)
}

/** Explicit calendar dates in a step's arguments. */
export function datesOf(args: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const k of DATE_KEYS) {
    const v = args[k]
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) out.push(v)
  }
  return out
}

/** The model's first turn reduced to the steps it asked for. */
export function stepsOf(o: Outcome): { behaviour: NonNullable<CaseScore['behaviour']>; steps: PlanStep[]; malformed?: string } {
  const plan = o.toolCalls.find((t) => t.name === SUBMIT_PLAN_TOOL)
  if (plan) {
    if (plan.argsError) return { behaviour: 'plan', steps: [], malformed: `submit_plan arguments unreadable: ${plan.argsError}` }
    const parsed = parseSubmitPlan(plan.args)
    if (!parsed.ok) return { behaviour: 'plan', steps: [], malformed: `submit_plan rejected: ${parsed.error}` }
    return { behaviour: 'plan', steps: parsed.submitted.plan.steps }
  }
  if (o.toolCalls.length) return { behaviour: 'direct', steps: o.toolCalls.map((t) => ({ tool: t.name, args: t.args, reason: '' })) }
  return { behaviour: o.text.trim() ? 'declined' : 'empty', steps: [] }
}

export function scoreOutcome(c: PlannerCase, o: Outcome, aoiGeometry: any): CaseScore {
  const e = c.expect
  const base = { id: c.id, family: c.family, query: c.query }
  if (o.error) return { ...base, status: 'error', checks: [], passed: false, note: o.error.slice(0, 200) }

  const { behaviour, steps, malformed } = stepsOf(o)
  const checks: CheckResult[] = []
  const push = (type: CheckType, ok: boolean, detail: string) => checks.push({ type, ok, detail })
  const tools = steps.map((s) => s.tool)

  push('no_direct', behaviour !== 'direct', behaviour === 'direct' ? `called ${tools.join(', ')} directly instead of through submit_plan` : 'no direct tool call')

  const validation = steps.length ? validatePlan(steps, { aoi: aoiGeometry, question: c.query, now: AS_OF_DATE.getTime() }) : null
  const valid = !!validation?.ok
  const declined = behaviour === 'declined'
  const refusedByValidator = steps.length > 0 && !valid

  if (e.expect_refusal) {
    const redirect = valid && !!e.or_use?.length && tools.every((t) => e.or_use!.includes(t))
    const how = declined ? 'the model declined' : redirect ? `the model redirected to ${tools.join(', ')}` : refusedByValidator ? `the static validator refused it: ${validation && !validation.ok ? validation.reasons[0] : ''}` : ''
    push('refusal', !!how, how || (behaviour === 'empty' ? 'empty response (no refusal, no plan)' : malformed ?? `planned ${tools.join(', ')} instead of declining`))
  } else if (e.expect_no_tools) {
    push('reuse', steps.length === 0 && !malformed && behaviour !== 'empty', steps.length ? `called ${tools.join(', ')} although the Layer Manifest holds the figure` : 'answered from the manifest')
  } else {
    push('refusal', !declined, declined ? 'declined a request that has an answer' : 'did not decline')
    push('plan_valid', valid && !malformed, malformed ?? (behaviour === 'empty' ? 'empty response' : declined ? 'no plan (declined)' : valid ? 'passes static validation' : validation && !validation.ok ? validation.reasons.join(' | ') : 'no plan'))
  }

  if (!e.expect_refusal && !e.expect_no_tools) {
    for (const op of e.must_use ?? []) push('op_choice', tools.includes(op), tools.includes(op) ? `uses ${op}` : `does not use ${op} (used: ${tools.join(', ') || 'nothing'})`)
    if (e.must_use_any) {
      const hit = e.must_use_any.filter((g) => tools.includes(g))
      push('op_choice', hit.length > 0, hit.length ? `uses ${hit.join(', ')}` : `uses none of ${e.must_use_any.join(' / ')} (used: ${tools.join(', ') || 'nothing'})`)
    }
    for (const op of e.must_not_use ?? []) push('op_choice', !tools.includes(op), tools.includes(op) ? `uses ${op}, which it must not` : `avoids ${op}`)
    for (const [op, want] of Object.entries(e.args ?? {})) {
      const cand = steps.filter((s) => s.tool === op)
      const wrong: string[] = []
      const ok = cand.some((s) => {
        const miss = Object.entries(want).filter(([k, m]) => !matches(s.args[k], m)).map(([k]) => `${k}=${JSON.stringify(s.args[k])}`)
        if (miss.length) wrong.push(miss.join(', '))
        return miss.length === 0
      })
      push('args', ok, ok ? `${op} arguments match` : cand.length ? `${op}: wrong ${wrong.join(' ; ')}` : `${op} not called`)
    }
    if (e.date_window_within) {
      const [lo, hi] = e.date_window_within
      const dates = steps.flatMap((s) => datesOf(s.args))
      const outside = dates.filter((d) => d < lo || d > hi)
      push('dates', dates.length > 0 && outside.length === 0, dates.length === 0 ? `no explicit date (wanted within ${lo}..${hi})` : outside.length ? `${outside.join(', ')} outside ${lo}..${hi}` : `dates ${dates.join(', ')} within ${lo}..${hi}`)
    }
    if (e.max_steps != null) push('steps', steps.length > 0 && steps.length <= e.max_steps, `${steps.length} step(s), at most ${e.max_steps}`)
  }

  return { ...base, status: 'scored', behaviour, tools, checks, passed: checks.every((x) => x.ok) }
}

/** Score every case against a recording with the current code. Cases the recording lacks are `missing`. */
export function replayAll(rec: Recording, cases = loadCases()): CaseScore[] {
  const aois = loadAois()
  return cases.map((c) => {
    const turn = rec.turns.get(c.id)
    if (!turn) return { id: c.id, family: c.family, query: c.query, status: 'missing' as const, checks: [], passed: false }
    return { ...scoreOutcome(c, turn.outcome, aois[c.aoi].geometry), stale: turn.request_sha !== requestFor(c, aois).sha }
  })
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export interface Rate { passed: number; n: number }
export interface Summary {
  overall: Rate
  checks: Record<string, Rate>
  families: Record<string, Rate>
  errors: number
  missing: number
  stale: number
}

export function summarize(scores: CaseScore[]): Summary {
  const s: Summary = { overall: { passed: 0, n: 0 }, checks: {}, families: {}, errors: 0, missing: 0, stale: 0 }
  for (const c of scores) {
    if (c.status === 'error') { s.errors++; continue }
    if (c.status === 'missing') { s.missing++; continue }
    if (c.stale) s.stale++
    s.overall.n++
    if (c.passed) s.overall.passed++
    const f = (s.families[c.family] ??= { passed: 0, n: 0 })
    f.n++
    if (c.passed) f.passed++
    for (const k of c.checks) {
      const r = (s.checks[k.type] ??= { passed: 0, n: 0 })
      r.n++
      if (k.ok) r.passed++
    }
  }
  return s
}

/** Wilson 95% interval: with ~40 cases the interval is the honest number. */
export function wilson({ passed, n }: Rate): [number, number] {
  if (n === 0) return [0, 1]
  const z = 1.96, p = passed / n, d = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / d
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
  return [Math.max(0, centre - half), Math.min(1, centre + half)]
}

export const pct = (r: Rate) => (r.n ? `${((100 * r.passed) / r.n).toFixed(0)}%` : 'n/a')
export const ci = (r: Rate) => { const [a, b] = wilson(r); return r.n ? `${(a * 100).toFixed(0)}–${(b * 100).toFixed(0)}%` : 'n/a' }

/** Regression gate on a replay: a case that passed in the baseline must still pass. */
export interface Baseline { recording: string; cases: Record<string, boolean> }

export function regressions(scores: CaseScore[], baseline: Baseline): string[] {
  return scores
    .filter((c) => baseline.cases[c.id] === true && !(c.status === 'scored' && c.passed))
    .map((c) => `${c.id} passed in the baseline and now ${c.status === 'scored' ? `fails: ${c.checks.find((k) => !k.ok)?.detail}` : c.status} [${c.query}]`)
}
