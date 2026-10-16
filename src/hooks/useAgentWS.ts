'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useStore, type MapLayer, type ResultVerdict } from '@/store/useStore'
import type { ValidationCheck } from '@/lib/geo-result'
import { toast } from 'sonner'
import { aoiSignature } from '@/lib/aoi'
import { apiErrorMessage } from '@/lib/api-errors'
import { getOwnerToken } from '@/lib/projects'
import { applyVizEvent, manifestFeatures } from '@/lib/viz-events'

// Toggle to true (or use a `?debug` query flag) to surface verbose layer-event logs.
const DEBUG_AGENT = false

/**
 * useAgentWS - Hook for communicating with the Erdfeld AI backend
 * 
 * Uses Server-Sent Events (SSE) via the Next.js API route /api/agent
 * to communicate with the agentic loop. Supports abort/cancel.
 */

export interface AgentMessage {
  type: 'thinking' | 'tool_call' | 'layer' | 'chart' | 'layer_style' | 'token' | 'temporal_frame' | 'done' | 'error' | 'zoom_to' | 'plan' | 'plan_refused' | 'manifest' | 'cache_hit' | 'ledger' | 'layer_remove' | 'notice'
  [key: string]: any
}

/** The validation outcome the server attaches to a tool step or layer (`result_status` +
 *  `validation`): only worth keeping when something did not pass. */
function verdictOf(data: AgentMessage): ResultVerdict | undefined {
  const checks: ValidationCheck[] = Array.isArray(data.validation) ? data.validation : []
  if (!data.result_status || (data.result_status === 'ok' && checks.length === 0)) return undefined
  return { status: data.result_status, checks }
}

export function useAgentWS() {
  const setConnected = useStore((s) => s.setConnected)
  const aoi = useStore((s) => s.aoi)
  const setLoading = useStore((s) => s.setLoading)
  const addThinkingToken = useStore((s) => s.addThinkingToken)
  const clearThinkingTokens = useStore((s) => s.clearThinkingTokens)
  const addToolCall = useStore((s) => s.addToolCall)
  const updateToolCall = useStore((s) => s.updateToolCall)
  const clearToolCalls = useStore((s) => s.clearToolCalls)
  const setPlan = useStore((s) => s.setPlan)
  const updatePlanStep = useStore((s) => s.updatePlanStep)
  const clearPlan = useStore((s) => s.clearPlan)
  const addToolResult = useStore((s) => s.addToolResult)
  const clearToolResults = useStore((s) => s.clearToolResults)
  const addLayer = useStore((s) => s.addLayer)
  const addMessage = useStore((s) => s.addMessage)
  const appendStreamingContent = useStore((s) => s.appendStreamingContent)
  const clearStreamingContent = useStore((s) => s.clearStreamingContent)
  const mergeStreamingToMessages = useStore((s) => s.mergeStreamingToMessages)
  const addTemporalFrame = useStore((s) => s.addTemporalFrame)
  const isConnected = useStore((s) => s.isConnected)
  const setSessionStartTime = useStore((s) => s.setSessionStartTime)
  const incrementQueryCount = useStore((s) => s.incrementQueryCount)
  const incrementCompletedToolCount = useStore((s) => s.incrementCompletedToolCount)
  const saveToHistory = useStore((s) => s.saveToHistory)
  const addNotification = useStore((s) => s.addNotification)
  const setAnalysisStage = useStore((s) => s.setAnalysisStage)
  const setFitBoundsTarget = useStore((s) => s.setFitBoundsTarget)

  // AbortController for cancelling in-flight requests
  const abortControllerRef = useRef<AbortController | null>(null)

  // Mark as connected since SSE is stateless (always available). Done in an effect
  // (not during render) so the hook is safe to call from more than one component
  // (e.g. ChatPanel + LayerPanel) without a setState-in-render warning (P7.3).
  useEffect(() => {
    setConnected(true)
  }, [setConnected])

  /** Cancel the current in-flight analysis */
  const cancelAnalysis = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
      // Measured: clicking stop left the spinner running for 5s+ because the
      // AbortError path in the stream loop was the only place state got cleared,
      // and it raced the reader. Clear synchronously here too, and MERGE (not
      // clear) the streaming buffer so the partial answer stays visible.
      mergeStreamingToMessages()
      setLoading(false)
      setAnalysisStage('idle')
      toast.info('Analysis cancelled')
    }
  }, [setLoading, setAnalysisStage, mergeStreamingToMessages])

  const sendQuery = useCallback(
    (query: string) => {
      const currentAoi = useStore.getState().aoi
      if (!currentAoi) return

      // Cancel any existing request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }

      const abortController = new AbortController()
      abortControllerRef.current = abortController

      // 1. Set loading
      setLoading(true)
      setAnalysisStage('receiving')

      // P7.3 — remember this query and clear any prior error so the retry banner
      // (shown by ChatPanel on an `error` event) reflects only the current attempt.
      useStore.getState().setLastQuery(query)
      useStore.getState().setAgentError(null)

      // 2. Set session start time on first query
      const currentSessionStartTime = useStore.getState().sessionStartTime
      if (!currentSessionStartTime) {
        setSessionStartTime(Date.now())
      }

      // 3. Increment query count
      incrementQueryCount()

      // 4. Clear previous thinking tokens, tool calls, plan, streaming buffer, and temporal frames
      clearThinkingTokens()
      useStore.getState().setRunNotice(null)
      clearToolCalls()
      clearPlan()
      clearToolResults()
      useStore.getState().clearCharts()
      clearStreamingContent()
      useStore.getState().clearTemporalFrames()

      // 5. Add user message (with the active AOI geometry so the bubble can show
      // a polygon preview thumbnail even after the AOI changes)
      addMessage({
        id: `user-${Date.now()}`,
        role: 'user',
        content: query,
        timestamp: Date.now(),
        aoiGeometry: currentAoi.geometry,
      })

      // 6. Add empty assistant message (to be filled with tokens)
      addMessage({
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
      })

      // 7. Send query via SSE
      const { aiProvider, aiApiKey, aiBaseUrl, aiModel, customModels } = useStore.getState().settings
      // P4.3 — if the user clicked a point ("what is this?"), attach it and clear
      // it so the next query reverts to the drawn AOI. The polygon AOI is never lost.
      const pointFocus = useStore.getState().pointFocus
      const focus = pointFocus
        ? { lat: pointFocus.lat, lng: pointFocus.lng, kind: 'point' as const }
        : undefined
      if (pointFocus) useStore.getState().setPointFocus(null)

      // P4.4 — layer memory. Build a manifest of layers already on the map for
      // THIS AOI (matched by signature, so a redrawn AOI clears it) so the agent
      // can reuse their values instead of recomputing. Dedupe by result_id
      // (keep most recent), and re-seed the toolResults slice so `[[id#key]]`
      // citations to a reused layer still resolve even when the tool isn't re-run.
      const currentAoiKey = aoiSignature(currentAoi)
      const byResultId = new Map<string, MapLayer>()
      for (const l of useStore.getState().layers) {
        if (l.resultId && l.tool && (l.aoiKey === currentAoiKey || l.tool === 'user_upload')) byResultId.set(l.resultId, l)
      }
      const manifestLayers = Array.from(byResultId.values()).map((l) => ({
        result_id: l.resultId as string,
        tool: l.tool as string,
        name: l.name,
        provenance: l.provenance,
        confidence: l.confidence,
        summary_data: l.summaryData,
        ...manifestFeatures(l),
      }))
      for (const m of manifestLayers) {
        if (m.summary_data && Object.keys(m.summary_data).length > 0) {
          useStore.getState().addToolResult({
            tool: m.tool,
            resultId: m.result_id,
            summaryData: m.summary_data,
            provenance: m.provenance,
            confidence: m.confidence,
          })
        }
      }

      const payload = {
        aoi: currentAoi.geometry,
        query,
        focus,
        layers: manifestLayers,
        lang: navigator.language,
        aiProvider: aiProvider !== 'default' ? aiProvider : undefined,
        // Empty when the server holds the key (Settings leaves the field blank): omitted, not sent.
        aiApiKey: aiApiKey?.trim() || undefined,
        aiBaseUrl: aiBaseUrl || undefined,
        aiModel: aiModel || undefined,
        // Phase 1 — user-registered perception models travel with the request,
        // the same way the AI-provider settings do.
        customModels: customModels?.trim() || undefined,
      }

      // Use fetch with streaming to receive SSE events
      fetch('/api/agent', {
        method: 'POST',
        // the owner token scopes the run's ledger entry to this person (Activity history lists it)
        headers: { 'Content-Type': 'application/json', 'x-owner-token': getOwnerToken() },
        body: JSON.stringify(payload),
        signal: abortController.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: 'Unknown error' }))
            toast.error('Agent Error', { description: apiErrorMessage(errorData, 'Failed to process query') })
            setLoading(false)
            setAnalysisStage('error')
            return
          }

          const reader = response.body?.getReader()
          if (!reader) {
            toast.error('Connection Error', { description: 'No response stream' })
            setLoading(false)
            setAnalysisStage('error')
            return
          }

          const decoder = new TextDecoder()
          let buffer = ''

          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              buffer += decoder.decode(value, { stream: true })

              // Parse SSE events - each event ends with blank line
              const eventBlocks = buffer.split('\n\n')
              // Keep the last incomplete block in the buffer
              buffer = eventBlocks.pop() || ''

              for (const block of eventBlocks) {
                const lines = block.split('\n')
                let currentEvent = ''
                let currentData = ''

                for (const line of lines) {
                  if (line.startsWith('event: ')) {
                    currentEvent = line.slice(7).trim()
                  } else if (line.startsWith('data: ')) {
                    currentData = line.slice(6)
                  }
                }

                if (currentEvent && currentData) {
                  try {
                    const data = JSON.parse(currentData) as AgentMessage
                    handleAgentMessage(data)
                  } catch (e) {
                    // Skip malformed events
                  }
                }
              }
            }
          } catch (streamErr: any) {
            if (streamErr?.name === 'AbortError') {
              // Deliberate cancel: keep the partial answer (merge, don't clear)
              // and mark the run cancelled, not errored — the user chose to stop.
              mergeStreamingToMessages()
              useStore.getState().setAgentError(null)
              setLoading(false)
              setAnalysisStage('idle')
              return
            }
            mergeStreamingToMessages()
            useStore.getState().setAgentError(streamErr?.message || 'Stream interrupted')
            toast.error('Stream Error', { description: streamErr?.message || 'Stream interrupted' })
            setLoading(false)
            setAnalysisStage('error')
            return
          } finally {
            reader.cancel().catch(() => {})
          }

          // Merge any remaining streaming content then mark complete
          mergeStreamingToMessages()
          setLoading(false)
          setAnalysisStage('complete')
          // Reset to idle after a short delay so the user sees "Complete"
          setTimeout(() => setAnalysisStage('idle'), 2000)
          // Save conversation to history
          saveToHistory()
        })
        .catch((error) => {
          if (error.name === 'AbortError') {
            // Deliberate cancel: preserve the partial answer and don't surface
            // a failure banner for the user's own stop action.
            mergeStreamingToMessages()
            useStore.getState().setAgentError(null)
            setLoading(false)
            setAnalysisStage('idle')
            return
          }
          useStore.getState().setAgentError(error.message || 'Connection error')
          toast.error('Connection Error', { description: error.message })
          setLoading(false)
          setAnalysisStage('error')
        })
    },
    [] // No reactive dependencies - use store.getState() for current values
  )

  function handleAgentMessage(data: AgentMessage) {
    const notificationsEnabled = useStore.getState().settings.enableNotifications
    const notify = (n: Parameters<typeof addNotification>[0]) => {
      if (notificationsEnabled) addNotification(n)
    }

    switch (data.type) {
      case 'thinking':
        addThinkingToken(data.content)
        setAnalysisStage('thinking')
        break

      case 'tool_call':
        setAnalysisStage('running_tools')
        // Plan-driven steps carry a step_index → reflect status in the PlanTimeline.
        if (typeof data.step_index === 'number') {
          const planStatus =
            data.status === 'running' ? 'running'
            : data.status === 'completed' ? 'done'
            : data.status === 'skipped' ? 'skipped'
            : 'error'
          updatePlanStep(data.step_index, planStatus)
        }
        if (data.status === 'running') {
          addToolCall({
            toolName: data.tool_name,
            status: data.status,
            label: data.label,
          })
          notify({
            type: 'analysis',
            title: `Running: ${data.label || data.tool_name}`,
            description: `Tool ${data.tool_name} has started processing`,
          })
        } else if (data.status === 'completed') {
          updateToolCall(data.tool_name, 'completed', undefined, verdictOf(data), data.result_id)
          incrementCompletedToolCount()
          // P4.2 — record structured figures so `[[result_id#key]]` pills resolve.
          if (data.result_id && data.summary_data && typeof data.summary_data === 'object') {
            addToolResult({
              tool: data.tool_name,
              resultId: data.result_id,
              summaryData: data.summary_data,
              provenance: data.provenance,
              confidence: data.confidence,
            })
          }
          notify({
            type: 'tool_complete',
            title: `Completed: ${data.label || data.tool_name}`,
            description: `Tool ${data.tool_name} finished successfully`,
          })
        } else if (data.status === 'error') {
          // P7.3 — carry the upstream error text so ToolStatus can show why it failed.
          // A refused step never ran: show the failed checks, which say why in full.
          const verdict = verdictOf(data)
          const why = verdict?.checks.filter((c) => c.status === 'fail').map((c) => c.message).join(' ')
          updateToolCall(data.tool_name, 'error', why || data.result_summary, verdict, data.result_id)
          notify({
            type: 'system',
            title: `Error: ${data.label || data.tool_name}`,
            description: `Tool ${data.tool_name} encountered an error`,
          })
        }
        // 'skipped' status only updates the plan timeline (handled above)
        break

      case 'plan':
        if (Array.isArray(data.steps)) {
          setPlan(data.steps, data.kind === 'replan' ? 'replan' : 'plan')
          setAnalysisStage('running_tools')
        }
        break

      case 'layer':
        if (DEBUG_AGENT) console.log('layer event received:', JSON.stringify(data).slice(0, 500))
        setAnalysisStage('generating_layers')
        addLayer({
          id: data.layer_id,
          name: data.name || data.layer_id,
          type: data.layer_type,
          tileUrl: data.tile_url,
          geojson: data.geojson,
          visible: data.default_visible !== false,
          opacity: 0.75,
          bounds: data.bounds,
          intensityProperty: data.intensity_property,
          imageBase64: data.image_base64,
          provenance: data.provenance,
          confidence: data.confidence,
          tier: data.tier,
          tierLabel: data.tier_label,
          resolutionM: data.resolution_m,
          render: data.render,
          heightProperty: data.height_property,
          palette: data.palette,
          raster: data.raster,
          aoiMask: data.aoi_mask,
          vectorStyle: data.vector_style,
          // P4.4 — tag the layer so it can be reused/cited in later queries for
          // the same AOI. aoiKey is computed from the AOI live at add time.
          resultId: data.result_id,
          tool: data.tool,
          summaryData: data.summary_data,
          aoiKey: aoiSignature(useStore.getState().aoi),
          verdict: verdictOf(data),
          provisional: data.provisional === true,
        })
        if (data.provisional === true) break // the final event for this layer notifies
        notify({
          type: 'layer_added',
          title: `Layer added: ${data.name || data.layer_id}`,
          description: `${data.layer_type} layer has been added to the map`,
        })
        break

      case 'layer_remove':
        // A preview was drawn but the tool's final result carries no such layer (it failed or was
        // refused after the scene was chosen): take the preview down rather than leave it up.
        if (typeof data.layer_id === 'string') useStore.getState().removeLayer(data.layer_id)
        break

      case 'chart':
      case 'layer_style':
        // Vega-Lite chart for this answer / in-place restyle of an existing layer.
        applyVizEvent(data)
        break

      case 'token': {
        appendStreamingContent(data.content)
        break
      }

      // A status note about the run (an area past what the operations handle well). Not answer text.
      case 'notice':
        if (typeof data.content === 'string') useStore.getState().setRunNotice(data.content)
        break

      case 'temporal_frame':
        addTemporalFrame({
          date: data.date,
          thumbnail: data.thumbnail,
          tileUrl: data.tile_url,
          imageBase64: data.image_base64,
          bounds: data.bounds,
          cloud: typeof data.cloud === 'number' ? data.cloud : undefined,
          aoiClearPct: typeof data.aoi_clear_pct === 'number' ? data.aoi_clear_pct : undefined,
        })
        break

      case 'done':
        mergeStreamingToMessages()
        setLoading(false)
        // Settle any chip still showing 'running'. A tool that starts but never
        // gets a terminal event — the loop finishes first, or the stream ends
        // mid-tool — otherwise spins forever next to a completed answer, which
        // reads as "still working" long after the run is over. The run is over,
        // so nothing may still claim to be in progress.
        useStore.getState().toolCalls
          .filter((t) => t.status === 'running')
          .forEach((t) => updateToolCall(t.toolName, 'error', 'No result reported before the run ended'))
        notify({
          type: 'analysis',
          title: 'Analysis complete',
          description: 'The geospatial analysis has finished processing',
        })
        break

      case 'error':
        // P7.3 — record the error so ChatPanel can offer a single Retry button
        // that re-sends `lastQuery`.
        useStore.getState().setAgentError(data.content || 'Analysis error')
        toast.error('Agent Error', { description: data.content })
        setLoading(false)
        setAnalysisStage('error')
        notify({
          type: 'system',
          title: 'Analysis error',
          description: data.content || 'An unexpected error occurred during analysis',
        })
        break

      case 'plan_refused':
        // The whole plan failed static validation before anything ran; the model is told why and
        // replans, so the user only needs to know that nothing was run.
        toast.warning('Plan refused before running', { description: Array.isArray(data.reasons) ? data.reasons.join(' ') : undefined })
        break

      case 'zoom_to':
        if (Array.isArray(data.bbox) && data.bbox.length === 4) {
          setFitBoundsTarget(data.bbox as [number, number, number, number])
        }
        break

      case 'manifest':
        // P4.4 — server echo of the reusable-layer manifest it was given (info
        // only). The "reusable" pill is derived live from the store's layers, so
        // nothing to do here; kept as an explicit no-op for contract clarity.
        break

      case 'ledger':
        // Q-47 — the request's executed graph was saved; the export fetches it by this id.
        if (typeof data.run_id === 'string') useStore.getState().addLedgerRunId(data.run_id)
        break

      case 'cache_hit':
        // P5.1 — server-side cache telemetry, emitted only under DEBUG_AGENT.
        // Info-only; explicit no-op so the contract stays documented.
        break

    }
  }

  /** Applies one agent message (an SSE event, or one built from a `GeoResult`) to the store. */
  return { sendQuery, cancelAnalysis, isConnected, applyAgentMessage: handleAgentMessage }
}
