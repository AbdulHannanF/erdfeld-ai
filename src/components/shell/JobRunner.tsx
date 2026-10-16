'use client'

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

import { useAgentWS, type AgentMessage } from '@/hooks/useAgentWS'
import { GeoResultSchema } from '@/lib/geo-result'
import { geoResultMessages, geoResultVizMessages } from '@/lib/layer-event'
import { getOwnerToken } from '@/lib/projects'
import { useJobs, type TrackedBatch, type TrackedJob } from '@/store/useJobs'
import { useStore } from '@/store/useStore'

const POLL_MS = 2500

/** Follows every active batch the browser queued and, for a tool run that finished, fetches the
 *  stored result and draws it through the same path an agent result takes. Renders nothing. */
export default function JobRunner() {
  const { applyAgentMessage } = useAgentWS()
  const apply = useRef(applyAgentMessage)
  useEffect(() => {
    apply.current = applyAgentMessage
  }, [applyAgentMessage])
  const busy = useRef(new Set<string>())

  useEffect(() => {
    useJobs.getState().hydrate()
    const headers = { 'x-owner-token': getOwnerToken() }

    const drawResults = async (b: TrackedBatch, jobs: TrackedJob[]) => {
      for (const j of jobs) {
        if (!j.resultId) continue
        const res = await fetch(`/api/results/${encodeURIComponent(j.resultId)}`, { headers })
        if (!res.ok) continue
        const body = (await res.json()) as { result: unknown }
        const result = GeoResultSchema.parse(body.result)
        for (const msg of [...geoResultMessages(result), ...geoResultVizMessages(result)]) apply.current({ label: b.label, ...msg } as AgentMessage)
        useStore.getState().addMessage({ id: `job-${b.id}-${j.idx}`, role: 'assistant', content: result.summary, timestamp: Date.now() })
        if (result.status === 'refused' || result.status === 'failed') {
          toast.warning(`${b.label}: ${result.status === 'refused' ? 'not run' : 'failed'}`, { description: result.summary.replace(/[*_`]/g, '').slice(0, 160) })
        }
      }
    }

    const tick = async () => {
      for (const b of useJobs.getState().batches) {
        if (b.state !== 'active' || busy.current.has(b.id)) continue
        busy.current.add(b.id)
        try {
          const res = await fetch(`/api/jobs/${encodeURIComponent(b.id)}`, { headers, cache: 'no-store' })
          if (res.status === 404 || res.status === 403) {
            useJobs.getState().patch(b.id, { state: 'missing', error: res.status === 404 ? 'The server no longer has this batch.' : 'This batch belongs to another owner.' })
            continue
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const body = (await res.json()) as { state: 'active' | 'finished'; progress: TrackedBatch['progress']; jobs: TrackedJob[] }
          useJobs.getState().patch(b.id, { progress: body.progress, jobs: body.jobs, state: body.state === 'finished' ? 'finished' : 'active', error: undefined })
          if (body.state === 'finished' && b.kind === 'tool' && !b.applied) {
            useJobs.getState().patch(b.id, { applied: true })
            const failed = body.jobs.find((j) => j.status === 'failed')
            if (failed) toast.error(`${b.label} failed`, { description: failed.error ?? 'The job did not finish.' })
            await drawResults(b, body.jobs)
          }
        } catch (err) {
          useJobs.getState().patch(b.id, { error: err instanceof Error ? err.message : 'could not read the batch' })
        } finally {
          busy.current.delete(b.id)
        }
      }
    }
    void tick()
    const id = window.setInterval(() => void tick(), POLL_MS)
    return () => window.clearInterval(id)
  }, [])

  return null
}
