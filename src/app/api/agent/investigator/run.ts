/**
 * The autonomous investigator: one request's run from an area (and maybe a question) to a verdict
 * and a dossier.
 *
 * Division of labour. The model triages (which catalogue hypotheses, what priors), words one
 * sentence per step, reads a picture into one of the catalogue's categories, writes the dossier
 * from recorded results, and (in a separate grounded call) finds reports for context. The
 * engine does everything that produces a number: it picks each step by value of information
 * (`select.ts`), runs it through the one executor (`runOperation`), reads the measured feature
 * (`features.ts`), updates belief in log-odds from the catalogue's likelihoods (`belief.ts`),
 * decides when to stop and what the verdict is (`stop.ts`). Every executed operation is a
 * ledger node, so the run's bundle, re-run and PDF work like any other.
 *
 * It never throws: every run ends with `done`, after an `error` event if something failed.
 */

import { classifyAoiSize } from '@/lib/aoi-guard'
import { layerEventPayload } from '@/lib/layer-event'
import { geoResultMessages } from '@/lib/layer-event'
import type { GeoResult } from '@/lib/geo-result'

import { runOperation, type RunEnv } from '../engine/execute'
import { defaultEvidenceStore, type EvidenceStore } from '../engine/evidence-store'
import { canonicalJson } from '../engine/hash'
import { LedgerRecorder } from '../engine/ledger'
import { getOperation, labelFor } from '../engine/registry'
import { getAreaKm2, getBbox } from '../lib/geometry'
import { registryFromEnv } from '../lib/inference/model-registry'
import { currentModelProfile } from '../lib/inference/profile'
import { LAYER_PREVIEW_EVENT } from '../lib/layer-preview'
import { runWithCacheContext } from '../lib/cache'
import { getLogger } from '../lib/logger'
import type { LlmRequestConfig } from '../lib/providers'
import { scrubSecret } from '../lib/providers'
import {
  CALIBRATION_NOTE, binCount, binLabel, binOf, getFamily, observesWindow,
  type EvidenceItem, type Family, type FamilyId,
} from './catalogue'
import { entropy, proposePriors, top, updateBeliefs, type Posterior } from './belief'
import { corroborate } from './corroborate'
import { rank, scanCells, splitCells, SCAN_MEASURE, SCAN_THRESHOLD, type Cell } from './discovery'
import type {
  Bbox, BeliefRow, DossierEvidenceRow, InvestigateEmit, StepEvent, StopReasonName, VerdictEvent,
} from './events'
import { readFeature, unusableReason } from './features'
import { GeminiInvestigatorLlm, type InvestigatorLlm, type NarrativeRecord, type Proposal } from './llm'
import { checkNarrative, citableIndex, templateNarrative } from './narrative'
import { MIN_VOI_BITS, selectNext, whatWouldDecide, type Facts, type OpInfo, type Situation } from './select'
import { decide, shouldStop, timeBudgetMs } from './stop'

const log = getLogger('investigator/run')

const DAY_MS = 86_400_000
/** Longest the display-only sentence may delay a step. */
const DEFAULT_WINDOW_DAYS = 120
/** An operation started inside the time budget may run this long past it before it is cut off. */
const OP_GRACE_MS = 60_000
const MIN_OP_MS = 10_000
const MAX_WINDOW_DAYS = 5 * 366

export interface InvestigatorDeps {
  llm: InvestigatorLlm
  runOp: (name: string, args: Record<string, any>, env: RunEnv) => Promise<GeoResult>
  opInfo: (op: string) => OpInfo
  evidence: () => Promise<EvidenceStore>
  now: () => number
}

export interface InvestigateInput {
  aoi: any
  question?: string
  window?: { start: string; end: string }
  family?: FamilyId
  owner: string | null | undefined
  /** Provider settings of the request; the vision operation reads them too. */
  llm: LlmRequestConfig
  emit: InvestigateEmit
  signal: AbortSignal
  startedAt?: number
  budgetMs?: number
  deps?: Partial<InvestigatorDeps>
}

export function registryOpInfo(name: string): OpInfo {
  const op = getOperation(name)
  return { available: !!op, earliest: op?.limits?.earliest, maxAreaKm2: op?.limits?.maxAreaKm2, typicalSeconds: op?.cost.typicalSeconds ?? 0 }
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Fill `{{window.*}}` tokens in an item's argument template. */
export function resolveArgs(template: Record<string, string | number | boolean>, window: { start: string; end: string }, now: number): Record<string, string | number | boolean> {
  const tokens: Record<string, string | number> = {
    '{{window.start}}': window.start,
    '{{window.end}}': window.end,
    '{{window.end_month}}': window.end.slice(0, 7),
    '{{window.days_to_now}}': Math.max(1, Math.ceil((now - Date.parse(window.end)) / DAY_MS) + 1),
  }
  return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, typeof v === 'string' && v in tokens ? tokens[v] : v]))
}

/** A calendar date, or a month or year widened to its first or last day. */
export function normaliseDate(text: string, edge: 'start' | 'end'): string | null {
  const t = text.trim()
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  if (m) return Number.isNaN(Date.parse(t)) ? null : t
  m = /^(\d{4})-(\d{2})$/.exec(t)
  if (m) {
    const mo = Number(m[2])
    if (mo < 1 || mo > 12) return null
    return edge === 'start' ? `${m[1]}-${m[2]}-01` : iso(Date.UTC(Number(m[1]), mo, 0))
  }
  m = /^(\d{4})$/.exec(t)
  if (m) return edge === 'start' ? `${m[1]}-01-01` : `${m[1]}-12-31`
  return null
}

export interface WindowChoice { window: { start: string; end: string }; source: 'request' | 'model' | 'default'; note?: string }

/** The window to investigate: the request's, else the model's reading of the question, else the
 *  last 120 days. An end in the future is moved to today; an impossible one falls back. */
export function chooseWindow(requested: { start: string; end: string } | undefined, proposed: { start: string; end: string } | undefined, now: number): WindowChoice {
  const today = iso(now)
  const fallback = (note?: string): WindowChoice => ({ window: { start: iso(now - DEFAULT_WINDOW_DAYS * DAY_MS), end: today }, source: 'default', note })
  const check = (w: { start: string; end: string } | undefined): { start: string; end: string } | string | null => {
    if (!w) return null
    const start = normaliseDate(w.start, 'start')
    let end = normaliseDate(w.end, 'end')
    if (!start || !end) return 'a window date is not a valid date'
    if (end > today) end = today
    if (start >= end) return 'the window must start before it ends and not be in the future'
    if ((Date.parse(end) - Date.parse(start)) / DAY_MS > MAX_WINDOW_DAYS) return 'the window is longer than five years'
    return { start, end }
  }
  const req = check(requested)
  if (req && typeof req !== 'string') return { window: req, source: 'request' }
  const model = check(proposed)
  if (model && typeof model !== 'string') return { window: model, source: 'model' }
  const why = typeof req === 'string' ? `The requested window was not usable (${req}). ` : typeof model === 'string' ? `The model's window was not usable (${model}). ` : ''
  return fallback(`${why}The last ${DEFAULT_WINDOW_DAYS} days are used.`)
}

/** A short, honest reason optical imagery is blocked, or null when the result shows no cloud limit. */
export function cloudLimit(item: EvidenceItem, result: GeoResult, reason: string | null): string | null {
  if (item.sensor !== 'optical') return null
  const s = result.stats ?? {}
  if (typeof s.valid_pixel_pct === 'number' && s.valid_pixel_pct < 40) return `only ${s.valid_pixel_pct}% of pixels were clear`
  if (typeof s.aoi_cloud_pct === 'number' && s.aoi_cloud_pct > 60) return `${s.aoi_cloud_pct}% of the area was under cloud`
  if (reason && /cloud|clear|valid pixel|masked/i.test(reason)) return reason.slice(0, 160)
  return null
}

const fmtValue = (v: number | string) => (typeof v === 'number' ? String(Number(v.toPrecision(4))) : v)

const scalarStats = (stats: GeoResult['stats']): Record<string, number | string> => {
  const out: Record<string, number | string> = {}
  for (const [k, v] of Object.entries(stats ?? {})) {
    if ((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 60)) out[k] = v
    if (Object.keys(out).length >= 60) break
  }
  return out
}

const stripDataUrl = (b64?: string) => (b64 ? b64.replace(/^data:image\/\w+;base64,/, '') : undefined)

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface Outcome {
  step: number
  item: EvidenceItem
  result: GeoResult
  measured: boolean
  reason?: string
  value?: number | string
  field?: string
  bin?: string
  visionCategory?: string
}

export async function runInvestigation(input: InvestigateInput): Promise<void> {
  const { emit, signal } = input
  const now = input.deps?.now ?? Date.now
  const startedAt = input.startedAt ?? now()
  const budgetMs = input.budgetMs ?? timeBudgetMs()
  const llmKey = input.llm.apiKey
  const opInfo = input.deps?.opInfo ?? registryOpInfo
  const runOp = input.deps?.runOp ?? runOperation

  let saveLedger: () => Promise<string | null> = async () => null
  try {
    // ---- guard ------------------------------------------------------------------------------
    const areaTotal = getAreaKm2(input.aoi)
    const size = classifyAoiSize(areaTotal)
    if (size.shouldRefuse) {
      emit('error', { type: 'error', message: size.warning || 'The selected area is too large to investigate.' , content: size.warning || 'The selected area is too large to investigate.'  })
      emit('done', { type: 'done' })
      return
    }
    emit('zoom_to', { type: 'zoom_to', bbox: getBbox(input.aoi) })

    let llm: InvestigatorLlm
    if (input.deps?.llm) llm = input.deps.llm
    else if (input.llm.provider === 'gemini' || !input.llm.provider) llm = new GeminiInvestigatorLlm({ apiKey: input.llm.apiKey, model: input.llm.model, signal })
    else {
      emit('error', { type: 'error', message: `The investigator needs a Gemini key (the provider is ${input.llm.provider}). Choose Gemini in Settings, or set GEMINI_API_KEY on the server.` , content: `The investigator needs a Gemini key (the provider is ${input.llm.provider}). Choose Gemini in Settings, or set GEMINI_API_KEY on the server.`  })
      emit('done', { type: 'done' })
      return
    }

    const evidence = await (input.deps?.evidence ?? defaultEvidenceStore)()
    const ledger = new LedgerRecorder()
    const today = iso(now())
    const hint = input.family
    let aoi = input.aoi
    let question = input.question?.trim() || undefined
    let notes: string[] = []

    const models = registryFromEnv(currentModelProfile())
    const baseEnv = (forAoi: any, quiet = false): RunEnv => ({
      aoi: forAoi,
      models,
      llm: input.llm,
      evidence,
      emit: quiet ? () => {} : (event, data) => {
        if (event === 'token') return // progress prose of the operations is not part of this stream
        if (event === LAYER_PREVIEW_EVENT) emit('layer', layerEventPayload(data.layer, { provisional: true, tool: String(data.layer?.id ?? 'preview') }))
        else (emit as any)(event, data)
      },
    })

    const tryPropose = async (q: string | undefined, areaForPrompt: any, window?: { start: string; end: string }): Promise<Proposal | null> => {
      try {
        return await llm.propose({ question: q, familyHint: hint, bbox: getBbox(areaForPrompt), areaKm2: getAreaKm2(areaForPrompt), today, window })
      } catch (err: any) {
        if (signal.aborted) throw err
        const msg = scrubSecret(String(err?.message ?? err), llmKey).slice(0, 200)
        notes.push(`The model could not triage the question (${msg}); catalogue defaults are used.`)
        log.warn({ err: msg }, 'triage failed')
        return null
      }
    }

    const discover = async (window: { start: string; end: string }): Promise<{ cell: Cell & { score: number | null } } | null> => {
      const wc = { window }
      const cells = splitCells(aoi)
      const scanArgs = (w: { start: string; end: string }) => ({ operation: 'change', index: 'NDVI', date: w.start, date2: w.end, threshold: SCAN_THRESHOLD })
      const scored = await scanCells(cells, (cell) => runOp('analyze_raster', scanArgs(wc.window), baseEnv(cell.aoi, true)), signal)
      const ranked = rank(scored)
      const best = ranked.filter((c) => c.rank === 1)[0]
      emit('discovery', { type: 'discovery', measure: SCAN_MEASURE, window: wc.window, cells: ranked, chosen: best ? ranked.indexOf(best) : -1, chosen_cell: best?.id ?? null })
      if (cells.length > 0) {
        emit('layer', layerEventPayload({
          id: 'discovery-cells', name: 'Discovery scan: share of pixels changed', type: 'geojson', bounds: getBbox(aoi),
          geojson: {
            type: 'FeatureCollection',
            features: scored.map((c) => ({ type: 'Feature' as const, properties: { cell: c.id, score: c.score, rank: ranked.find((r) => r.id === c.id)?.rank ?? null }, geometry: c.aoi })),
          },
          provenance: { source: 'Erdfeld discovery scan (Sentinel-2 L2A)', date: wc.window.end, method: SCAN_MEASURE, clip: 'polygon' },
          confidence: 'low',
        }, { provisional: false, tool: 'discovery_scan' }))
      }
      if (!best) {
        emit('error', { type: 'error', message: `The discovery scan could not score any of the ${cells.length} cell${cells.length === 1 ? '' : 's'} (${ranked.map((c) => `${c.id}: ${c.reason ?? 'no score'}`).slice(0, 3).join('; ')}). Nothing was investigated; this is a failure to read the imagery, not a finding that nothing changed.` , content: `The discovery scan could not score any of the ${cells.length} cell${cells.length === 1 ? '' : 's'} (${ranked.map((c) => `${c.id}: ${c.reason ?? 'no score'}`).slice(0, 3).join('; ')}). Nothing was investigated; this is a failure to read the imagery, not a finding that nothing changed.`  })
        emit('done', { type: 'done' })
        return null
      }
      return { cell: scored.find((c) => c.id === best.id)! }
    }


    // ---- triage and discovery -----------------------------------------------------------------
    let proposal: Proposal | null = !question && !hint ? null : await tryPropose(question, aoi, input.window)
    const wc = chooseWindow(input.window, proposal && proposal.windowStart && proposal.windowEnd ? { start: proposal.windowStart, end: proposal.windowEnd } : undefined, now())
    const window = wc.window
    if (wc.note) notes.push(wc.note)
    let discoveryMs: number | undefined
    const needsDiscovery = !hint && (!question || (proposal !== null && !proposal.hasSpecificEvent))
    if (needsDiscovery) {
      const t = now()
      const chosen = await discover(window)
      discoveryMs = now() - t
      if (!chosen) return
      aoi = chosen.cell.aoi
      const asked = question?.trim()
      question = `${asked ? `${asked} ` : ''}Something changed in this area: ${(chosen.cell.score! * 100).toFixed(1)}% of the clear pixels changed in NDVI by more than ${SCAN_THRESHOLD} between ${window.start} and ${window.end}. What is the most likely explanation?`
      proposal = await tryPropose(question, aoi, window)
      notes.push(`No specific event was named, so the area was scanned and cell ${chosen.cell.id} (the largest share of changed pixels) is investigated.`)
    }

    // ---- family, window, priors ---------------------------------------------------------------
    const familyId: FamilyId | null = hint ?? proposal?.family ?? null
    const family: Family | undefined = familyId ? getFamily(familyId) : undefined
    if (!family) {
      emit('error', { type: 'error', message: 'The question could not be matched to a hypothesis family and no family was given. Say whether it is about water, vegetation loss, fire or new structures.' + (notes.length ? ` (${notes.join(' ')})` : '') , content: 'The question could not be matched to a hypothesis family and no family was given. Say whether it is about water, vegetation loss, fire or new structures.' + (notes.length ? ` (${notes.join(' ')})` : '')  })
      emit('done', { type: 'done' })
      return
    }
    const priorResult = proposePriors(proposal?.hypotheses ?? [], family.hypotheses)
    const labels = Object.fromEntries(family.hypotheses.map((h) => [h.id, h.label]))
    let posterior: Posterior = priorResult.priors
    emit('hypotheses', {
      type: 'hypotheses', family: family.id, family_title: family.title, window, window_source: wc.source,
      items: Object.entries(posterior).map(([id, prior]) => ({ id, label: labels[id], family: family.title, prior })),
      rejected_ids: priorResult.rejected, clamped_ids: priorResult.clamped, used_default_priors: priorResult.usedDefaults,
      ...(notes.length ? { note: notes.join(' ') } : {}),
      calibration_note: CALIBRATION_NOTE,
    })

    // ---- the investigation loop ---------------------------------------------------------------
    const investigationStart = now()
    const area = getAreaKm2(aoi)
    const env = baseEnv(aoi)
    const facts: Facts = { opticalBlocked: false }
    const done = new Set<string>()
    const executed = new Map<string, GeoResult>()
    const outcomes: Outcome[] = []
    const history = [top(posterior)]
    const lastSkipped = new Map<string, string>()
    /** Results of operations cut off at the time budget's grace limit. */
    const cutOff = new Set<string>()
    let opsRun = 0
    let measured = 0
    let windowMeasured = 0
    let step = 0
    let stop: StopReasonName = 'no_informative_evidence'

    const situation = (): Situation => ({ window, areaKm2: area, now: now(), facts, opInfo })
    const argsOf = (item: EvidenceItem) => resolveArgs(item.args, window, now())
    const runKeyOf = (item: EvidenceItem) => `${item.op}:${canonicalJson(argsOf(item))}`
    const rows = (p: Posterior, prev: Posterior): BeliefRow[] =>
      Object.entries(p).map(([id, v]) => ({ id, label: labels[id], p: v, delta: v - (prev[id] ?? v) })).sort((a, b) => b.p - a.p)

    /** Read the item's feature from a result and place it on the item's scale. */
    const measure = async (item: EvidenceItem, result: GeoResult): Promise<Omit<Outcome, 'step' | 'item' | 'result'> & { derivation?: string }> => {
      if (item.feature === 'vision') {
        const unusable = unusableReason(result)
        if (unusable) return { measured: false, reason: unusable }
        try {
          const category = await llm.classifyImagery({ item, imageBase64: stripDataUrl(result.layers.find((l) => l.imageBase64)?.imageBase64), description: result.summary })
          const bin = binOf(item.scale, category)
          if (bin < 0) return { measured: false, reason: `the model answered "${category}", which is not one of the catalogue's categories` }
          return { measured: true, value: category, field: 'scene_date', derivation: 'a vision model chose this category from the catalogue list', bin: binLabel(item.scale, bin), visionCategory: category }
        } catch (err: any) {
          if (signal.aborted) throw err
          return { measured: false, reason: `the picture could not be classified (${scrubSecret(String(err?.message ?? err), llmKey).slice(0, 160)})` }
        }
      }
      const f = readFeature(item.feature, result)
      if (!f.ok) return { measured: false, reason: cutOff.has(result.result_id) ? `stopped at the time budget before it finished: ${f.reason}` : f.reason }
      const bin = binOf(item.scale, f.value)
      if (bin < 0) return { measured: false, reason: `the value ${fmtValue(f.value)} is outside the scale of ${item.feature}` }
      return { measured: true, value: f.value, field: f.field, derivation: f.derivation, bin: binLabel(item.scale, bin) }
    }

    for (;;) {
      const selection = selectNext(family, posterior, done, new Set(executed.keys()), runKeyOf, situation())
      for (const s of selection.skipped) lastSkipped.set(s.item_id, s.reason)
      const reason = shouldStop({
        posterior, history, measured, windowMeasured, opsRun, elapsedMs: now() - startedAt, budgetMs,
        bestVoi: selection.chosen?.voi ?? 0, minVoi: MIN_VOI_BITS, aborted: signal.aborted,
      })
      // An item that only reads a result already in hand costs nothing, so it is read even once a
      // budget is spent; every other reason to stop is final.
      const free = selection.candidates.find((c) => c.costS === 0)
      const spent = reason === 'op_budget' || reason === 'time_budget'
      if (reason && !(spent && free)) { stop = reason; break }
      const pick = spent && free ? free : selection.chosen!
      const item = pick.item
      step++

      // The sentence is for display only; a slow or failed model never delays or changes the step.
      const leading = rows(posterior, posterior).slice(0, 3).map((r) => ({ label: r.label, p: r.p }))
      // The reason is a sentence built from the numbers that drove the choice (belief, value of information,
      // the runner-up, what was skipped); a model call per step added latency and tokens and no information.
      const lead = leading.slice(0, 2).map((l) => `${l.label} ${(l.p * 100).toFixed(0)}%`).join(', ')
      const runnerUp = selection.candidates[1]
      let why = `${lead ? `Leading: ${lead}. ` : ''}${item.title} is next: it is expected to remove ${pick.voi.toFixed(2)} bits of uncertainty${runnerUp ? ` (next best: ${runnerUp.item.title}, ${runnerUp.voi.toFixed(2)} bits)` : ''} and would settle ${item.decides}.`
      const opticalSkip = selection.skipped.find((s) => family.items.find((i) => i.id === s.item_id)?.sensor === 'optical' && facts.opticalBlocked)
      if (item.sensor === 'radar' && opticalSkip) why += ` Optical imagery is skipped: ${opticalSkip.reason}.`
      const whySource: StepEvent['why_source'] = 'rule'

      const args = argsOf(item)
      const key = runKeyOf(item)
      const reused = executed.has(key)
      emit('step', {
        type: 'step', n: step, item_id: item.id, title: item.title, op: item.op, args, why, why_source: whySource,
        voi: Number(pick.voi.toFixed(4)), cost_s: pick.costS, reused,
        considered: selection.candidates.slice(0, 4).map((c) => ({ item_id: c.item.id, voi: Number(c.voi.toFixed(4)), cost_s: c.costS })),
        skipped: selection.skipped,
      })

      // -- run (or reuse) the operation through the one executor
      let result = executed.get(key)
      if (!result) {
        opsRun++
        emit('tool_call', { type: 'tool_call', tool_name: item.op, status: 'running', label: labelFor(item.op), step_index: step - 1 })
        const node = ledger.start({ name: item.op }, args as Record<string, unknown>)
        // No operation runs unbounded: past the budget it gets a short grace, then its fetches are cancelled.
        const cap = AbortSignal.timeout(Math.max(MIN_OP_MS, budgetMs + OP_GRACE_MS - (now() - startedAt)))
        const opSignal = AbortSignal.any([signal, cap])
        result = await runWithCacheContext({ abortSignal: opSignal }, () => runOp(item.op, args, env))
        if (cap.aborted && !signal.aborted) cutOff.add(result.result_id)
        ledger.finish(node, result)
        executed.set(key, result)
        for (const msg of geoResultMessages(result)) (emit as any)(msg.type, { ...msg, step_index: msg.type === 'tool_call' ? step - 1 : undefined })
        for (const chart of result.charts ?? []) emit('chart', { type: 'chart', chart_id: chart.id, title: chart.title, spec: chart.spec, layer_id: chart.layerId, result_id: result.result_id })
      }
      done.add(item.id)

      // -- read the measurement
      const out = await measure(item, result)
      outcomes.push({ step, ...out, item, result })
      const blockedBy = cloudLimit(item, result, out.measured ? null : out.reason ?? null) ?? (out.visionCategory === 'cloud_or_shadow_dominates' || out.visionCategory === 'cloud_or_haze_dominates' ? 'the picture is dominated by cloud, shadow or haze' : null)
      if (blockedBy && !facts.opticalBlocked) { facts.opticalBlocked = true; facts.opticalBlockedReason = blockedBy }

      const prev = posterior
      if (out.measured) {
        const hyps = family.hypotheses.filter((h) => h.id in posterior)
        const bin = binOf(item.scale, out.value!)
        const upd = updateBeliefs(posterior, hyps, item, bin)
        posterior = upd.posterior
        measured++
        if (observesWindow(item)) windowMeasured++
        history.push(top(posterior))
        emit('evidence', {
          type: 'evidence', n: step, item_id: item.id, op: item.op, resultId: result.result_id, status: result.status,
          summary: result.summary.replace(/\*+/g, '').replace(/\s+/g, ' ').slice(0, 220), measured: true,
          features: typeof out.value === 'number' && Number.isFinite(out.value) ? { [item.feature]: out.value } : {},
          feature: { name: item.feature, value: out.value!, unit: item.scale.kind === 'cuts' ? item.scale.unit : 'category', field: out.field!, derivation: out.derivation!, bin: out.bin! },
          likelihood_ratios: Object.fromEntries(Object.entries(upd.ratios).map(([k, v]) => [k, Number(v.toFixed(3))])),
          capped: upd.capped, ...(out.visionCategory ? { vision_category: out.visionCategory } : {}), ...(item.caveat ? { caveat: item.caveat } : {}),
        })
      } else {
        emit('evidence', {
          type: 'evidence', n: step, item_id: item.id, op: item.op, resultId: result.result_id, status: result.status,
          summary: result.summary.replace(/\*+/g, '').replace(/\s+/g, ' ').slice(0, 220), measured: false, features: {}, reason: out.reason,
          ...(item.caveat ? { caveat: item.caveat } : {}),
        })
      }
      emit('belief', { type: 'belief', n: step, updated: out.measured, posteriors: { ...posterior }, posterior: rows(posterior, prev), leading: top(posterior).id, entropy_bits: Number(entropy(posterior).toFixed(4)) })
    }

    if (signal.aborted) return

    // ---- verdict --------------------------------------------------------------------------------
    const unmeasured = outcomes.filter((o) => !o.measured).length
    const verdictCore = decide(posterior, windowMeasured)
    const whyNot = (item: EvidenceItem): string | null => {
      const o = outcomes.find((x) => x.item.id === item.id)
      if (o) return o.measured ? null : `could not be measured: ${o.reason}`
      const ok = lastSkipped.get(item.id)
      if (ok) return ok
      return stop === 'op_budget' || stop === 'time_budget' ? `not reached before the ${stop === 'op_budget' ? 'operation' : 'time'} budget ended` : 'not run'
    }
    const missing = whatWouldDecide(family, posterior, whyNot)
    const sorted = rows(posterior, posterior)
    const lead = sorted[0]
    const runnerUp = sorted[1]
    const verdictLabel = verdictCore.kind === 'hypothesis' ? labels[verdictCore.id] : 'Cannot determine'
    const verdict: VerdictEvent = {
      type: 'verdict', kind: verdictCore.kind,
      id: verdictCore.kind === 'hypothesis' ? verdictCore.id : null,
      decidingEvidence: verdictCore.kind === 'hypothesis' ? outcomes.filter((o) => o.measured).map((o) => o.step) : [],
      label: verdictLabel,
      posterior: Number((verdictCore.kind === 'hypothesis' ? verdictCore.posterior : lead.p).toFixed(4)),
      runner_up: runnerUp ? { id: runnerUp.id, label: runnerUp.label, p: Number(runnerUp.p.toFixed(4)) } : null,
      stop_reason: stop, evidence_ops_run: opsRun, items_measured: measured, items_unmeasured: unmeasured,
      evidence_that_would_decide: missing.map((m) => ({ ...m, voi: Number(m.voi.toFixed(4)) })),
      calibration_note: measured > 0 && windowMeasured === 0
        ? `${CALIBRATION_NOTE} Nothing measured here observed the window itself (only baselines, archives or quality checks), so no event is confirmed.`
        : CALIBRATION_NOTE,
    }
    emit('verdict', verdict)
    const investigationMs = now() - investigationStart

    // ---- corroboration and narrative (independent calls, run together) -------------------------
    // The subject is a short event name, not the catalogue's definition: it becomes a web-search query
    // ("Wildfire or burn scar Lahaina August 2023"), and a paragraph of definition made the search tool
    // go unused (3 of 4 live investigations returned no grounded page).
    const subject = verdictCore.kind === 'hypothesis'
      ? labels[verdictCore.id]
      : sorted.slice(0, 2).map((r) => r.label).join(' or ')
    const place = proposal?.place ?? ''
    const bbox = getBbox(aoi) as Bbox
    const t1 = now()
    const corroP = corroborate(llm, { subject, place, bbox, window }).then((c) => { emit('corroboration', { type: 'corroboration', ...c }); return c })

    const records: NarrativeRecord[] = outcomes.map((o) => ({
      result_id: o.result.result_id, item: o.item.title, op: o.item.op, status: o.result.status, measured: o.measured,
      ...(o.measured ? {
        reading: `${o.item.title}: ${o.item.feature} was ${fmtValue(o.value!)}${o.item.scale.kind === 'cuts' ? ` ${o.item.scale.unit}` : ''} (${o.bin}) [[${o.result.result_id}#${o.field}]].`,
      } : { reason: o.reason }),
      citable: scalarStats(o.result.stats),
      ...(o.item.caveat ? { caveat: o.item.caveat } : {}),
    }))
    const verdictText = verdictCore.kind === 'hypothesis' ? `Most likely explanation: ${verdictLabel}.` : 'Cannot determine.'
    const narrativeP = (async () => {
      if (records.length === 0) return { text: templateNarrative(verdictText, records, family.limits), source: 'recorded-results' as const, dropped: 0 }
      const index = citableIndex(records)
      try {
        let draft = await llm.writeNarrative({ verdictText, question, place, window, records, limits: family.limits })
        let check = checkNarrative(draft, index)
        if (!check.ok) {
          draft = await llm.writeNarrative({ verdictText, question, place, window, records, limits: family.limits, feedback: check.offending })
          check = checkNarrative(draft, index)
        }
        if (check.cleaned.length >= 40) return { text: check.cleaned, source: 'model' as const, dropped: check.offending.length }
      } catch (err: any) {
        if (signal.aborted) throw err
        log.warn({ err: scrubSecret(String(err?.message ?? err), llmKey).slice(0, 200) }, 'narrative failed; using recorded results')
      }
      return { text: templateNarrative(verdictText, records, family.limits), source: 'recorded-results' as const, dropped: 0 }
    })()
    const [corro, narrative] = await Promise.all([corroP, narrativeP])
    const corroborationMs = now() - t1

    // ---- ledger and dossier -----------------------------------------------------------------------
    let runId: string | null = null
    saveLedger = async () => {
      if (ledger.size === 0) return null
      const id = await evidence.saveRun({
        ownerToken: input.owner || null,
        query: question ?? `Investigate ${family.title}`,
        aoi, focus: null, nodes: ledger.snapshot,
      })
      if (id) emit('ledger', { type: 'ledger', run_id: id })
      return id || null
    }
    runId = await saveLedger()

    const evidenceRows: DossierEvidenceRow[] = outcomes.map((o) => ({
      item_id: o.item.id, title: o.item.title, op: o.item.op, result_id: o.result.result_id, measured: o.measured,
      value: o.measured ? o.value! : null, field: o.measured ? o.field! : null,
      unit: o.item.scale.kind === 'cuts' ? o.item.scale.unit : 'category', bin: o.measured ? o.bin! : null, reason: o.measured ? null : o.reason ?? null,
    }))
    emit('dossier', {
      type: 'dossier', summary: narrative.text, summary_source: narrative.source, sentences_dropped: narrative.dropped,
      family: family.id, window, bbox, final_posterior: rows(posterior, posterior), evidence: evidenceRows,
      skipped: [...lastSkipped].filter(([id]) => !done.has(id)).map(([item_id, reason]) => ({ item_id, reason })),
      limits: [...family.limits, CALIBRATION_NOTE],
      corroboration: { role: corro.role, status: corro.status, query: corro.query, sources: corro.sources, note: corro.note },
      tokens: llm.usage?.() ?? null,
      timings_ms: { total: now() - startedAt, ...(discoveryMs !== undefined ? { discovery: discoveryMs } : {}), investigation: investigationMs, corroboration: corroborationMs },
      runId: runId ?? '',
    })
    emit('done', { type: 'done' })
  } catch (error: any) {
    if (signal.aborted) {
      log.info('investigation aborted (client disconnected)')
      return
    }
    const msg = scrubSecret(String(error?.message ?? 'Unknown error'), input.llm.apiKey)
    log.error({ err: msg }, 'investigation error')
    emit('error', { type: 'error', message: msg , content: msg  })
    await saveLedger().catch(() => null)
    emit('done', { type: 'done' })
  }
}
