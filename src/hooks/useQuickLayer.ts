'use client'

import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { useAgentWS, type AgentMessage } from '@/hooks/useAgentWS'
import { apiErrorMessage } from '@/lib/api-errors'
import { GeoResultSchema } from '@/lib/geo-result'
import { geoResultMessages } from '@/lib/layer-event'
import { QUICK_LAYERS, type QuickLayerId } from '@/lib/quick-layers'
import { useStore } from '@/store/useStore'

/** One-click layers with no LLM round-trip (Q-15). Posts the drawn AOI to `/api/quick-layer`,
 *  which runs the registered operation through the engine executor, and draws the returned
 *  `GeoResult` through the same store path an agent result takes (`applyAgentMessage`), so the
 *  validation verdict, provenance and citable figures behave identically. */
export function useQuickLayer() {
  const { applyAgentMessage } = useAgentWS()
  const [running, setRunning] = useState<QuickLayerId | null>(null)

  const run = useCallback(async (id: QuickLayerId) => {
    const aoi = useStore.getState().aoi
    if (!aoi?.geometry || running) return
    const { label, operation } = QUICK_LAYERS[id]
    setRunning(id)
    applyAgentMessage({ type: 'tool_call', tool_name: operation, status: 'running', label })
    try {
      const res = await fetch('/api/quick-layer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: id, aoi: aoi.geometry }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        throw new Error(apiErrorMessage(err, `HTTP ${res.status}`))
      }
      const result = GeoResultSchema.parse(await res.json())
      for (const msg of geoResultMessages(result)) applyAgentMessage({ label, ...msg } as AgentMessage)
      // The summary is the tool's own wording (figures, caveats, refusal reasons); no model rewrites it.
      useStore.getState().addMessage({
        id: `quick-${Date.now()}`,
        role: 'assistant',
        content: result.summary,
        timestamp: Date.now(),
      })
      if (result.status === 'refused' || result.status === 'failed') {
        toast.warning(`${label}: ${result.status === 'refused' ? 'not run' : 'failed'}`, { description: result.summary.replace(/[*_`]/g, '').slice(0, 160) })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'request failed'
      applyAgentMessage({ type: 'tool_call', tool_name: operation, status: 'error', label, result_summary: message })
      toast.error(`${label} failed`, { description: message })
    } finally {
      setRunning(null)
    }
  }, [applyAgentMessage, running])

  return { run, running }
}
