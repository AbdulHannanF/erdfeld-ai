'use client'

import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { INITIAL_INVESTIGATION, foldEvents, reduceInvestigation, type InvestigationState } from '@/components/investigate/state'
import { INVESTIGATION_FIXTURES, type FixtureName } from '@/components/investigate/fixtures'
import { AGENT_PASSTHROUGH, parseInvestigationEvent, type InvestigationEvent } from '@/lib/investigation-events'
import { useStore } from '@/store/useStore'
import type { AgentMessage } from '@/hooks/useAgentWS'
import { getOwnerToken } from '@/lib/projects'
import { prefersReducedMotion } from '@/components/map/layers'

type Action = { type: 'event'; event: InvestigationEvent } | { type: 'reset' } | { type: 'fail'; message: string } | { type: 'start' }

function reduce(state: InvestigationState, a: Action): InvestigationState {
  switch (a.type) {
    case 'reset': return INITIAL_INVESTIGATION
    case 'start': return { ...INITIAL_INVESTIGATION, status: 'running' }
    case 'fail': return { ...state, status: 'error', error: a.message }
    case 'event': return reduceInvestigation(state, a.event)
  }
}

export type InvestigationSource = 'live' | 'fixture' | null

/**
 * Runs an investigation and folds its events into board state. `run` streams `POST /api/investigate`
 * (server-sent events, see lib/investigation-events.ts); `replay` plays a recorded fixture through
 * the same reducer, one event at a time, so the board can be seen working without the service.
 * `source` says which of the two the board is showing, so a replay is never mistaken for a result.
 */
export function useInvestigation(applyAgentMessage?: (m: AgentMessage) => void) {
  const [state, dispatch] = useReducer(reduce, INITIAL_INVESTIGATION)
  const [source, setSource] = useState<InvestigationSource>(null)
  const abort = useRef<AbortController | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stop = useCallback(() => {
    abort.current?.abort()
    abort.current = null
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }, [])

  useEffect(() => stop, [stop])

  const reset = useCallback(() => {
    stop()
    setSource(null)
    dispatch({ type: 'reset' })
  }, [stop])

  const replay = useCallback(
    (name: FixtureName) => {
      stop()
      setSource('fixture')
      dispatch({ type: 'start' })
      const events = INVESTIGATION_FIXTURES[name]
      const gap = prefersReducedMotion() ? 0 : 650
      let i = 0
      const next = () => {
        if (i >= events.length) return
        dispatch({ type: 'event', event: events[i++] })
        timer.current = setTimeout(next, gap)
      }
      next()
    },
    [stop],
  )

  const run = useCallback(
    async (aoi: GeoJSON.Geometry, question?: string) => {
      stop()
      setSource('live')
      dispatch({ type: 'start' })
      useStore.getState().clearThinkingTokens()
      const ctl = new AbortController()
      abort.current = ctl
      try {
        const res = await fetch('/api/investigate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-owner-token': getOwnerToken() },
          body: JSON.stringify({ aoi, question: question || undefined }),
          signal: ctl.signal,
        })
        if (res.status === 404 || res.status === 501) {
          dispatch({ type: 'fail', message: 'The investigation service is not available on this server yet. A recorded example can show how the board works.' })
          return
        }
        if (!res.ok || !res.body) {
          dispatch({ type: 'fail', message: `The investigation could not start (HTTP ${res.status}).` })
          return
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let got = false
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let cut: number
          while ((cut = buf.search(/\r?\n\r?\n/)) >= 0) {
            const block = buf.slice(0, cut)
            buf = buf.slice(cut).replace(/^\r?\n\r?\n/, '')
            let name = ''
            const data: string[] = []
            for (const line of block.split(/\r?\n/)) {
              if (line.startsWith('event:')) name = line.slice(6).trim()
              else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
            }
            if ((AGENT_PASSTHROUGH as readonly string[]).includes(name)) {
              // Layers, charts, zoom and ledger ids from the run's operations: the map and the
              // citation pills take them exactly as they take them from /api/agent.
              try {
                applyAgentMessage?.({ ...JSON.parse(data.join('\n')), type: name } as AgentMessage)
                got = true
              } catch {
                // a malformed passthrough event is dropped
              }
              continue
            }
            const event = parseInvestigationEvent(name, data.join('\n'))
            if (event) {
              got = true
              dispatch({ type: 'event', event })
            }
          }
        }
        if (!got) dispatch({ type: 'fail', message: 'The investigation ended without reporting anything.' })
      } catch (e) {
        if ((e as Error)?.name !== 'AbortError') dispatch({ type: 'fail', message: 'The investigation stream was interrupted.' })
      }
    },
    [stop],
  )

  return { state, source, run, replay, stop, reset, fold: foldEvents }
}
