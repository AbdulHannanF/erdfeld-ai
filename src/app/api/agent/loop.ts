/**
 * The agent loop: one request's conversation with the planner model.
 *
 * The model's only action is `submit_plan` (ADR-0001): the engine validates the whole plan, runs
 * its steps in dependency batches and hands back a digest, then the model writes the analysis. A
 * direct call to any other tool is answered with an error that says how to resubmit it as a plan,
 * so there is exactly one path from a model's words to an executed operation.
 *
 * The loop is provider-neutral: it reads `LLMEvent`s and keeps a provider's own turn record
 * (`native`) on the assistant message without looking inside it. It never throws; it ends every
 * run with an `error` or `done` event, and with a message that says what happened when the run
 * produced no answer, ran out of time budget, or was cut off.
 */

import { debugLog } from './lib/debug'
import { extractBboxFromGeojson, getAreaKm2, getBbox } from './lib/geometry'
import { getLogger } from './lib/logger'
import { createProviderStream } from './lib/llm'
import type { LLMEvent } from './lib/llm-adapters'
import type { LlmRequestConfig } from './lib/providers'
import { recordStage, recordToolCall } from './lib/metrics'
import { LAYER_PREVIEW_EVENT } from './lib/layer-preview'
import { layerEventPayload } from '@/lib/layer-event'
import { withTimings } from './lib/timings'
import { MAX_PLAN_STEPS, SUBMIT_PLAN_TOOL, hasCycle, parseSubmitPlan, topoSort, type PlanStep } from './lib/plan'
import { runOperation, type RunEnv } from './engine/execute'
import { defaultEvidenceStore } from './engine/evidence-store'
import { LedgerRecorder } from './engine/ledger'
import { resolveFromNode, validatePlan, withImpliedDeps } from './engine/plan'
import { getToolDefinitions, labelFor, typicalAreaLimitKm2 } from './engine/registry'
import { formatAreaKm2 } from '@/lib/aoi'
import { failingChecks, type GeoResult } from '@/lib/geo-result'
import { MAX_MANIFEST_LAYERS, MAX_SUMMARY_FIELDS } from '@/lib/api-schemas'
import { classifyAoiSize } from '@/lib/aoi-guard'
import type { ManifestLayer, ResultStore } from './lib/types'
import { MAX_FEATURE_ROWS, buildLayerHint, storeManifestLayer, storeResult } from './lib/chart-data'
import { buildCitationHint } from '@/lib/citations'
import { periodDrift } from './engine/period'
import { shortlistOperations } from './engine/shortlist'
import { addUsage, emptyUsage, tokenTotals } from './lib/token-usage'
import { checkAnswerGrounding, groundingFacts, unverifiedNote } from './lib/grounding'
import { buildPrompt } from './prompt'
import { registryFromEnv } from './lib/inference/model-registry'
import { currentModelProfile } from './lib/inference/profile'

const log = getLogger('agent/loop')

/** Model turns per request (a plan, its synthesis, and a few resubmissions or replans). */
const MAX_ITER = 8
/** Steps across a request, replans included. */
const MAX_TOTAL_STEPS = 2 * MAX_PLAN_STEPS

const LANG_NAMES: Record<string, string> = {
  en: 'English', zh: '中文', es: 'Español', fr: 'Français', de: 'Deutsch',
  ja: '日本語', ko: '한국어', ar: 'العربية', ur: 'اردو', hi: 'हिन्दी',
  pt: 'Português', ru: 'Русский',
}

/** Whole-run wall-clock. Measured: a flood question is ~8 s of planning, 100+ s of Sentinel-1 reads
 *  for a season window, then ~10 s of analysis (eval/RESULTS.md), so 100 s cut real questions off. */
const DEFAULT_BUDGET_MS = 240_000
/** Held back for the analysis turn: operations stop this long before the end of the budget, so a
 *  run that is out of time still writes up what it measured instead of ending with nothing. */
const SYNTHESIS_RESERVE_MS = 40_000

/** Wall-clock the run may use, kept under the route's `maxDuration` so it ends on its own terms. */
export function timeBudgetMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.AGENT_TIME_BUDGET_MS)
  return Number.isFinite(n) && n >= 5_000 ? n : DEFAULT_BUDGET_MS
}

export interface AgentRunInput {
  aoi: any
  query: string
  lang?: string
  focus?: { lat: number; lng: number; kind: 'point' }
  /** Layers the client already has for this AOI (validated by the request schema). */
  layers?: Array<Record<string, any>>
  customModels?: unknown
  owner: string | null | undefined
  llm: LlmRequestConfig
  emit: (event: string, data: any) => void
  /** Aborted when the client disconnects. */
  signal: AbortSignal
  startedAt?: number
  budgetMs?: number
}

type ToolCallEvent = Extract<LLMEvent, { type: 'tool_call' }>

export async function runAgent(input: AgentRunInput): Promise<void> {
  const { aoi, query, focus, owner, llm, emit, signal } = input
  const startedAt = input.startedAt ?? Date.now()
  const budgetMs = input.budgetMs ?? timeBudgetMs()
  const deadline = startedAt + budgetMs
  /** Operations may run until here; the rest of the budget is for writing the analysis. */
  const toolDeadline = deadline - Math.min(SYNTHESIS_RESERVE_MS, budgetMs / 4)
  // Aborts every running operation when the tool part of the budget ends. Its own reason (not a
  // timeout) tells the executor the step was cut by the run, not by its own limit.
  const toolsEnd = new AbortController()
  const toolsTimer = setTimeout(() => toolsEnd.abort(new Error('the tool part of the time budget ended')), Math.max(0, toolDeadline - Date.now()))
  const langLabel = LANG_NAMES[(input.lang || 'en').split('-')[0]] || 'English'

  // Models the user registered in Settings travel with the request; a malformed entry is
  // collected as an error rather than failing the whole query.
  const modelRegistry = registryFromEnv(currentModelProfile(), input.customModels)

  // Layer memory: the client sends the layers already on the map for this AOI so the agent
  // reuses their values. The schema bounds every field; the list and each entry are capped here.
  const manifest: ManifestLayer[] = (input.layers ?? []).slice(0, MAX_MANIFEST_LAYERS).map((l) => ({
    result_id: l.result_id,
    tool: l.tool,
    name: l.name ?? l.result_id,
    provenance: l.provenance as ManifestLayer['provenance'],
    confidence: l.confidence as ManifestLayer['confidence'],
    summary_data: l.summary_data
      ? (Object.fromEntries(Object.entries(l.summary_data).slice(0, MAX_SUMMARY_FIELDS)) as ManifestLayer['summary_data'])
      : undefined,
    layer_id: l.layer_id,
    // Scalar feature properties only, so make_chart / style_layer can address a layer from an
    // earlier turn; never rendered into the prompt.
    feature_rows: l.feature_rows?.slice(0, MAX_FEATURE_ROWS),
  }))
  // make_chart / style_layer resolve data by name from this store: the client's reusable layers
  // plus every tool result of this request (added as they finish).
  const resultStore: ResultStore = new Map()
  for (const m of manifest) storeManifestLayer(resultStore, m)
  // Free text a figure in the answer may legitimately come from besides a citation: the question,
  // and for every tool result its summary, provenance, arguments and facts line (see lib/grounding).
  const evidenceTexts: string[] = typeof query === 'string' ? [query] : []

  /** Saves the request's ledger run; replaced once the ledger exists. */
  let saveLedger: () => Promise<void> = async () => {}
  try {
    // AOI size guard: refuse excessive areas outright and warn on large ones before the loop
    // starts, so the user sees why nothing ran (or that it will be slow).
    const aoiSize = classifyAoiSize(getAreaKm2(aoi))
    if (aoiSize.shouldRefuse) {
      emit('error', { type: 'error', content: aoiSize.warning || 'The selected area is too large to analyze.' })
      emit('done', { type: 'done' })
      return
    }
    // Past what the operations' contracts handle well, say so as a status note. It is not answer
    // text ('token' is): the answer must not open with it, nor the refusal.
    const areaKm2 = getAreaKm2(aoi)
    const typicalLimit = typicalAreaLimitKm2()
    if (areaKm2 > typicalLimit) {
      emit('notice', {
        type: 'notice',
        content: `This area (${formatAreaKm2(areaKm2)}) is larger than most operations handle well (about ${Math.round(typicalLimit).toLocaleString('en-US')} km\u00b2). The run may take longer, and some steps may be refused for size.`,
      })
    }

    // Only the operations relevant to the question are described to the model (a deterministic shortlist, no model
    // call): about 4x fewer prompt tokens per turn. If that turn yields no plan, the full set is offered once.
    const allTools = getToolDefinitions()
    const shortlist = shortlistOperations(typeof query === 'string' ? query : '')
    const useShortlist = shortlist.names.length < allTools.length - 1
    let tools = useShortlist ? allTools.filter((t: any) => t.function.name === SUBMIT_PLAN_TOOL || shortlist.names.includes(t.function.name)) : allTools
    let toolsAreFull = !useShortlist
    const messages: any[] = [
      { role: 'system', content: buildPrompt(aoi, input.lang || 'en', focus, manifest, new Date(), useShortlist ? shortlist.names : undefined) },
      { role: 'user', content: query },
    ]
    const usage = { plan: emptyUsage(), synthesis: emptyUsage() }
    emit('zoom_to', { type: 'zoom_to', bbox: getBbox(aoi) })
    emit('manifest', { type: 'manifest', layers: manifest })

    // Every executed operation is kept as evidence and identical ones are served from the store;
    // the request's executed graph is saved as a ledger run when it ends.
    const evidence = await defaultEvidenceStore()
    const ledger = new LedgerRecorder()
    const runEnv: RunEnv = { aoi, question: typeof query === 'string' ? query : undefined, emit, focus, models: modelRegistry, llm, results: resultStore, evidence }
    let ledgerSaved = false
    saveLedger = async () => {
      if (ledgerSaved || ledger.size === 0) return
      ledgerSaved = true
      const runId = await evidence.saveRun({
        ownerToken: owner || null, query: typeof query === 'string' ? query : null, aoi,
        focus: focus ? { lat: focus.lat, lng: focus.lng } : null, nodes: ledger.snapshot,
      })
      if (runId) emit('ledger', { type: 'ledger', run_id: runId })
    }

    /** Every tool this request actually ran, in order, for an honest closing message. */
    const toolsRun: string[] = []
    /** Visible answer characters across the WHOLE request. A run that ends with zero told the user nothing. */
    let visibleAnswerChars = 0
    let refusedReasons: string[] = []
    let budgetExceeded = false
    /** Steps the time budget skipped or stopped; the answer covers only the others. */
    let stepsCut = 0
    /** The whole budget ran out (not only the tool part): the last turn may be cut off. */
    let hardStop = false
    /** The model's last turn that called no tool: the analysis, checked for grounding once written. */
    let finalAnswer = ''
    /** Set once a plan has run: later model turns read its results (see `Phase`). */
    let planRan = false
    /** Wall-clock of the turn that wrote the plan now running, and of the turns that wrote the answer. */
    let planLlmMs = 0
    let planLlmTotalMs = 0
    let synthesisLlmMs = 0

    const overBudget = () => Date.now() >= deadline

    // -- One operation, with its full lifecycle ---------------------------------------------
    // Runs it through the executor and emits tool_call running/completed/error, layers, zoom and
    // charts. `plan` carries the step's own arguments for the ledger.
    const executeAndEmitTool = async (
      toolName: string,
      toolArgs: Record<string, any>,
      stepIndex: number,
      plan: { args: Record<string, unknown>; refBase: number; dependsOn?: number[] },
    ): Promise<{ summary: string; failed: boolean; cvFallbackModel?: string; citationHint: string; facts: string; resultId: string }> => {
      toolsRun.push(toolName)
      emit('tool_call', { type: 'tool_call', tool_name: toolName, status: 'running', label: labelFor(toolName), step_index: stepIndex })

      const toolStartedAt = Date.now()
      const node = ledger.start({ name: toolName }, plan.args, { step: stepIndex, ...plan }, toolStartedAt)
      // A tool may draw its layer before it finishes (`emitPreviewLayer`): that becomes a
      // provisional `layer` event, and the final event for the same id replaces it in place.
      const previewIds = new Set<string>()
      const callEnv: RunEnv = {
        ...runEnv,
        // The operation stops with the client and at the end of the tool part of the budget.
        signal: AbortSignal.any([signal, toolsEnd.signal]),
        emit: (event, data) => {
          if (event === LAYER_PREVIEW_EVENT) {
            previewIds.add(data.layer.id)
            return emit('layer', layerEventPayload(data.layer, { provisional: true, tool: toolName }))
          }
          // A `token` is answer text, and only this loop writes the answer. What an operation
          // says while it works ("Reading 16 scenes...") is progress: it goes to the thinking trace.
          if (event === 'token') return emit('thinking', { type: 'thinking', content: data.content })
          return emit(event, data)
        },
      }
      const { value: result, timings } = await withTimings<GeoResult>(() => runOperation(toolName, toolArgs, callEnv))
      const toolMs = Date.now() - toolStartedAt
      const stageTimings = { ...timings, llm_plan: planLlmMs, total: toolMs }
      for (const [stage, ms] of Object.entries(stageTimings)) recordStage(toolName, stage, ms / 1000)
      ledger.finish(node, result)
      const didNotRun = result.status === 'refused' || result.status === 'failed'
      recordToolCall(toolName, didNotRun ? 'error' : 'success', toolMs / 1000)
      if (didNotRun) log.warn({ tool: toolName, status: result.status }, 'operation did not produce a result')

      // The result_id is the content hash, so it is known only now. The hint tells the model the
      // exact id and field keys it may cite; the structured figures reach the client for the pills.
      const resultId = result.result_id
      const primaryLayer = result.layers[0]
      storeResult(resultStore, resultId, result.op.name, result.stats, result.layers)
      evidenceTexts.push(result.summary, JSON.stringify(result.provenance), JSON.stringify(plan.args), JSON.stringify(toolArgs), groundingFacts(result))
      const hint = buildCitationHint(resultId, result.stats) + buildLayerHint(resultId, resultStore.get(resultId)!)
      const flags = failingChecks(result.validation)
      emit('tool_call', {
        type: 'tool_call', tool_name: toolName, status: didNotRun ? 'error' : 'completed',
        label: `${labelFor(toolName)} ${didNotRun ? '✗' : '✓'}`,
        result_summary: result.summary.slice(0, 120),
        result_id: resultId,
        result_status: result.status,
        validation: flags,
        summary_data: result.stats,
        provenance: primaryLayer?.provenance,
        provenance_items: result.provenance.items,
        confidence: primaryLayer?.confidence,
        timings: stageTimings,
        step_index: stepIndex,
      })

      // Every layer (primary first), then one zoom_to from the primary.
      for (const layerData of result.layers) {
        const layerPayload = layerEventPayload(layerData, {
          provisional: false,
          // Ties the layer back to its tool result so the client can reuse and cite it later.
          result_id: resultId,
          tool: toolName,
          summary_data: result.stats,
          // A flagged result is drawn, but never as fine: the checks travel with the layer.
          result_status: result.status,
          validation: flags,
        })
        debugLog('layer emit:', JSON.stringify(layerPayload).slice(0, 500))
        emit('layer', layerPayload)
      }
      // A preview whose tool then produced no such layer must not be left on the map.
      for (const id of previewIds) {
        if (!result.layers.some((l) => l.id === id)) emit('layer_remove', { type: 'layer_remove', layer_id: id })
      }
      if (result.layers.length > 0) {
        const primary = result.layers[0]
        const layerBbox = primary.bounds
          ?? (primary.geojson ? (extractBboxFromGeojson(primary.geojson) ?? getBbox(aoi)) : getBbox(aoi))
        emit('zoom_to', { type: 'zoom_to', bbox: layerBbox })
      }
      // style_layer restyles an existing layer in place (no new layer event).
      if (result.layer_style) {
        emit('layer_style', { type: 'layer_style', layer_id: result.layer_style.layer_id, vector_style: result.layer_style.style, result_id: resultId })
      }
      // make_chart: one `chart` event per chart; `layer_id` links marks to map features.
      for (const chart of result.charts ?? []) {
        emit('chart', { type: 'chart', chart_id: chart.id, title: chart.title, spec: chart.spec, layer_id: chart.layerId, result_id: resultId })
      }

      // What the model is told about a result that did not pass: it must not present it as fine.
      const drift = periodDrift(typeof query === 'string' ? query : '', result.stats, Date.now())
      const driftNote = drift ? `\n[period: ${drift}. Say so next to the figures and do not present them as covering the stated period.]` : ''
      const verdict = driftNote + (flags.length === 0
        ? ''
        : result.status === 'ok'
          ? `\n[validation warnings: ${flags.map((c) => c.message).join(' | ')}. Mention them with the figures.]`
          : `\n[validation: ${result.status} — ${flags.map((c) => c.message).join(' | ')}. Report this to the user; do not present these figures as reliable.]`)
      return { summary: result.summary, failed: didNotRun, cvFallbackModel: result.cv_fallback_model, citationHint: verdict + hint, facts: groundingFacts(result), resultId }
    }

    // -- Plan executor ----------------------------------------------------------------------
    // Runs `newSteps` in dependency batches (parallel within a batch). `emitBase` is the offset of
    // these steps inside the cumulative plan, so step_index lines up with the PlanTimeline. A
    // step's `{from_node: i}` arguments become the result_id of step i, which finished in an
    // earlier batch. Steps whose dependencies failed, or that the time budget cut off, are
    // reported as skipped, never silently dropped. Returns the per-step digest the model reads.
    const executePlanSteps = async (newSteps: PlanStep[], emitBase: number): Promise<string> => {
      const scheduled = withImpliedDeps(newSteps)
      const batches = topoSort(scheduled) // acyclicity was checked when the plan was accepted
      const lineByLocal: string[] = new Array(newSteps.length).fill('')
      const failedLocal = new Set<number>()
      const resultIdByLocal = new Map<number, string>()

      const skip = (li: number, why: string) => {
        failedLocal.add(li)
        const absIdx = emitBase + li
        ledger.skipped({ name: newSteps[li].tool }, newSteps[li].args, { step: absIdx, refBase: emitBase, dependsOn: newSteps[li].depends_on })
        emit('tool_call', { type: 'tool_call', tool_name: newSteps[li].tool, status: 'skipped', label: `${labelFor(newSteps[li].tool)} (skipped)`, step_index: absIdx })
        lineByLocal[li] = `[skipped] Step ${absIdx} — ${newSteps[li].tool}: ${why}; not executed.`
      }

      for (const batch of batches) {
        if (signal.aborted) break
        const timeUp = Date.now() >= toolDeadline
        if (timeUp) budgetExceeded = true
        const runnable: number[] = []
        for (const li of batch) {
          const deps = scheduled[li].depends_on ?? []
          if (timeUp) { skip(li, 'the time budget ran out'); stepsCut++ }
          else if (deps.some((d) => failedLocal.has(d))) skip(li, 'a dependency failed')
          else runnable.push(li)
        }
        await Promise.all(runnable.map(async (li) => {
          const step = newSteps[li]
          const absIdx = emitBase + li
          const args = resolveFromNode(step.args, (n) => resultIdByLocal.get(n) ?? '')
          const { summary, citationHint, facts, failed, cvFallbackModel, resultId } = await executeAndEmitTool(step.tool, args, absIdx, { args: step.args, refBase: emitBase, dependsOn: scheduled[li].depends_on })
          resultIdByLocal.set(li, resultId)
          if (failed) failedLocal.add(li)
          // Stopped by the end of the tool budget (not by its own limit): the answer will be partial.
          if (failed && Date.now() >= toolDeadline - 50) { budgetExceeded = true; stepsCut++ }
          const reason = step.reason ? ` (${step.reason})` : ''
          let line = `Step ${absIdx} — ${step.tool}${reason}: ${summary.slice(0, 400)}${citationHint}
  ${facts}`
          if (cvFallbackModel) line += `\n  ↳ note: OSM had no data here; CV model "${cvFallbackModel}" could digitize it from imagery if essential.`
          lineByLocal[li] = line
        }))
      }
      return lineByLocal.join('\n')
    }

    // -- The conversation -------------------------------------------------------------------
    let cumulativePlanSteps: PlanStep[] = []

    for (let iter = 0; iter < MAX_ITER; iter++) {
      if (signal.aborted) break
      if (overBudget()) { budgetExceeded = hardStop = true; break }

      let answerContent = ''
      let nativeTurn: unknown
      const toolCalls: ToolCallEvent[] = []
      let finishReason = ''

      const llmStartedAt = Date.now()
      const turnSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - llmStartedAt))])
      try {
        for await (const ev of await createProviderStream(messages, tools, { ...llm, phase: planRan ? 'synthesis' : 'plan' }, turnSignal)) {
          if (ev.type === 'text') {
            answerContent += ev.text
            emit('token', { type: 'token', content: ev.text })
            visibleAnswerChars += ev.text.trim().length
          } else if (ev.type === 'tool_call') toolCalls.push(ev)
          else if (ev.type === 'native') nativeTurn = ev.content
          else if (ev.type === 'usage') addUsage(usage[planRan ? 'synthesis' : 'plan'], ev.usage)
          else finishReason = ev.finishReason
        }
      } catch (err) {
        // The budget, not the client or the provider, ended this turn: stop and say so.
        if (!signal.aborted && overBudget()) { budgetExceeded = hardStop = true; break }
        throw err
      }
      const llmMs = Date.now() - llmStartedAt
      if (toolCalls.length > 0) { planLlmMs = llmMs; planLlmTotalMs += llmMs } else synthesisLlmMs += llmMs

      if (toolCalls.length === 0) finalAnswer = answerContent
      const assistantMsg: any = { role: 'assistant' }
      if (answerContent) assistantMsg.content = answerContent
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }))
      }
      if (nativeTurn !== undefined) assistantMsg.native = nativeTurn

      // The output limit cut the turn off. Say so to the user or the model; never treat it as complete.
      if (finishReason === 'length') {
        log.warn({ toolCalls: toolCalls.length }, 'model output hit the token limit')
        if (toolCalls.length === 0) {
          if (answerContent.trim()) {
            emit('token', { type: 'token', content: "\n\n_The answer was cut off at the model's output limit._" })
            messages.push(assistantMsg)
            break
          }
          messages.push({ role: 'user', content: 'Your last output was cut off at the output limit before it finished. Submit a smaller plan (fewer steps, shorter reasons), or answer more briefly.' })
          continue
        }
      }

      if (toolCalls.length === 0) {
        messages.push(assistantMsg)
        break
      }

      // ---- A turn with tool calls: the plan runs, anything else is answered with an error ----
      messages.push(assistantMsg)
      const planCall = toolCalls.find((tc) => tc.name === SUBMIT_PLAN_TOOL && !tc.argsError)
      const reply = (tc: ToolCallEvent, content: string) => messages.push({ role: 'tool', tool_call_id: tc.id, content })
      const replyToOthers = (planned: ToolCallEvent | undefined) => {
        for (const tc of toolCalls) {
          if (tc === planned) continue
          if (tc.argsError) {
            reply(tc, `Not run: ${tc.argsError}${finishReason === 'length' ? ' (the output was cut off at the token limit)' : ''}. ${tc.name === SUBMIT_PLAN_TOOL ? 'Submit a smaller, valid plan.' : ''}`.trim())
          } else if (tc.name === SUBMIT_PLAN_TOOL) {
            reply(tc, 'Not run: call submit_plan once per turn and alone.')
          } else {
            reply(tc, `Not run: operations run only through submit_plan. Resubmit as submit_plan({"kind":"plan","steps":[{"tool":${JSON.stringify(tc.name)},"args_json":${JSON.stringify(JSON.stringify(tc.args))},"reason":"..."}]}).`)
          }
        }
      }

      if (!planCall) {
        replyToOthers(undefined)
        continue
      }

      const parsed = parseSubmitPlan(planCall.args)
      if (!parsed.ok) {
        reply(planCall, `submit_plan rejected: ${parsed.error}. Submit a corrected plan.`)
        replyToOthers(planCall)
        continue
      }
      const { kind, plan } = parsed.submitted

      // Validate the whole plan before anything runs: operations exist, references point backwards,
      // the graph is acyclic, the request-wide step cap holds and every step's static checks pass.
      // One refusal path with every reason, so the model can replan.
      const reasons: string[] = []
      if (cumulativePlanSteps.length + plan.steps.length > MAX_TOTAL_STEPS && kind === 'replan') {
        reasons.push(`This request already planned ${cumulativePlanSteps.length} steps; at most ${MAX_TOTAL_STEPS} are allowed in total.`)
      }
      if (hasCycle(withImpliedDeps(plan.steps))) reasons.push('The plan has a dependency cycle; steps must form an acyclic graph.')
      const planCheck = reasons.length === 0 ? validatePlan(plan.steps, runEnv) : { ok: false as const, reasons }
      if (!planCheck.ok) {
        emit('plan_refused', { type: 'plan_refused', reasons: planCheck.reasons })
        refusedReasons = planCheck.reasons
        // The shortlist is a convenience: a plan naming an operation it did not offer gets the full set on the retry.
        if (!toolsAreFull && planCheck.reasons.some((r) => /Unknown tool/i.test(r))) { tools = allTools; toolsAreFull = true }
        reply(planCall, `plan_refused — nothing was run:\n${planCheck.reasons.map((r) => `- ${r}`).join('\n')}\nSubmit a corrected plan, or explain to the user why this cannot be done.`)
        replyToOthers(planCall)
        continue
      }

      const emitBase = kind === 'replan' ? cumulativePlanSteps.length : 0
      cumulativePlanSteps = kind === 'replan' ? [...cumulativePlanSteps, ...plan.steps] : plan.steps
      emit('plan', { type: 'plan', kind, steps: cumulativePlanSteps })

      const digest = await executePlanSteps(plan.steps, emitBase)
      reply(planCall, `Plan executed. Results:\n${digest}`)
      replyToOthers(planCall)
      planRan = true
      if (overBudget()) { budgetExceeded = hardStop = true; break }
      messages.push({
        role: 'user',
        content:
          (stepsCut > 0 ? `${stepsCut} step(s) were skipped or stopped at the time budget. Do not call more tools: analyse only the steps that finished, and say plainly what is missing. ` : '') +
          `All planned tools have executed. Now write your structured geospatial analysis in ${langLabel}, ` +
          `following the analysis structure in the rules and citing every figure. Do not call more tools ` +
          `unless essential data is missing; in that case call submit_plan with kind "replan" containing ` +
          `only the additional steps.`,
      })
    }

    // A run must never finish having said nothing, and never hide that it was cut short. This
    // invents no analysis: it reports what the run did and says plainly what is missing.
    if (!signal.aborted) {
      const unverified = finalAnswer ? checkAnswerGrounding(finalAnswer, resultStore, [areaKm2], evidenceTexts) : []
      if (unverified.length > 0) {
        log.info({ sentences: unverified.length }, 'answer has figures without a matching citation')
        emit('token', { type: 'token', content: unverifiedNote(unverified) })
      }
      const ran = [...new Set(toolsRun)]
      const ranText = `${toolsRun.length} tool call${toolsRun.length === 1 ? '' : 's'} (${ran.join(', ')})`
      let closing = ''
      if (budgetExceeded && (visibleAnswerChars === 0 || hardStop)) {
        closing = `**This run stopped at its time budget (${Math.round((deadline - startedAt) / 1000)} s).** ` +
          (toolsRun.length > 0
            ? `It completed ${ranText}; their results are attached above and are real, but the written analysis is incomplete or missing. Ask a narrower question, or one measurement at a time.`
            : `No tools finished, so there is no result. Try a smaller area or a narrower question.`)
      } else if (stepsCut > 0) {
        closing = `_${stepsCut} step${stepsCut === 1 ? ' was' : 's were'} skipped or stopped at the time budget (${Math.round((deadline - startedAt) / 1000)} s), so this analysis covers only the steps that finished._`
      } else if (visibleAnswerChars === 0) {
        closing = toolsRun.length > 0
          ? `**No answer was produced.**\n\nThe analysis ran ${ranText} and their results are attached above, but the model ended the run without writing them up. The tool outputs are real and can be read directly; the narrative is what is missing.\n\nRe-running the same question usually produces the write-up. If it keeps happening, try asking more narrowly, or for one measurement at a time.`
          : refusedReasons.length > 0
            ? `**Nothing was run: the request was refused before execution.**\n\n${refusedReasons.map((r) => `- ${r}`).join('\n')}\n\nThese checks run before any data is fetched. Adjust the request (for example a valid band, a date range that is not in the future, or a smaller area) and ask again.`
            : `**No answer was produced, and no tools were run.**\n\nThe model returned an empty response. Try rephrasing the question, or ask for a specific measurement over the drawn area.`
      }
      if (closing) {
        log.warn({ tools: ran.length, calls: toolsRun.length, budgetExceeded }, 'agent run ended without a complete answer')
        emit('token', { type: 'token', content: (visibleAnswerChars > 0 ? '\n\n' : '') + closing })
      }
    }

    await saveLedger()
    recordStage('_request', 'llm_plan', planLlmTotalMs / 1000)
    recordStage('_request', 'llm_synthesis', synthesisLlmMs / 1000)
    emit('done', { type: 'done', timings: { llm_plan: planLlmTotalMs, llm_synthesis: synthesisLlmMs, total: Date.now() - startedAt }, tokens: tokenTotals(usage), tools_offered: toolsAreFull ? 'all' : shortlist.names.length })
  } catch (error: any) {
    // A client disconnect aborts `signal`, which surfaces here as an AbortError from the model or
    // tool fetches. That is an expected quiet shutdown, not a failure to report.
    if (signal.aborted) {
      log.info('agent loop aborted (client disconnected)')
    } else {
      log.error({ err: error?.message }, 'agent loop error')
      emit('error', { type: 'error', content: error?.message || 'Unknown error' })
      await saveLedger().catch(() => {})
      emit('done', { type: 'done' })
    }
  } finally {
    clearTimeout(toolsTimer)
  }
}

