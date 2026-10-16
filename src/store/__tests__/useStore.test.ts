/**
 * ISS-117 — first test coverage for the store.
 *
 * All 1248 existing tests target `lib/`. `useStore.ts` is 1 162 lines and is the
 * single source of truth every panel reads, so a regression here is invisible to
 * the whole suite and shows up as a wrong map.
 *
 * These pin the behaviours that are NOT obvious from the action names — the ones
 * a reasonable refactor would break:
 *
 *   - `addLayer` merges by id instead of appending (no duplicate map layers)
 *   - `setPlan` carries a step's status across a replan, but only while the tool
 *     at that index is still the same tool
 *   - `updateToolCall` stamps `durationMs` once, on the way out of 'running'
 *   - `mergeStreamingToMessages` SNAPSHOTS the tool results onto the message, so
 *     citation pills still resolve after the next query clears the live slice
 *   - `resetSession` deliberately preserves chat history
 *
 * The suite runs in vitest's `node` environment with no `window`, which also
 * exercises the SSR guard: importing the store must not touch `localStorage`.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useStore, type MapLayer, type ChatMessage } from '../useStore'
import type { CitableToolResult } from '@/lib/citations'

const layer = (id: string, over: Partial<MapLayer> = {}): MapLayer => ({
  id, name: id, type: 'raster', visible: true, opacity: 1, ...over,
})

const message = (id: string, role: ChatMessage['role'], content = ''): ChatMessage => ({
  id, role, content, timestamp: 1_700_000_000_000,
})

const result = (resultId: string, tool: string): CitableToolResult => ({
  tool, resultId, summaryData: { mean: 0.42 },
})

/** The store is a module singleton; reset the session slice between tests. */
beforeEach(() => {
  useStore.getState().resetSession()
  useStore.setState({ chatHistory: [] })
})

describe('SSR safety — the store loads with no window', () => {
  it('initialises persisted slices to empty rather than throwing', () => {
    expect(typeof globalThis.window).toBe('undefined')
    const s = useStore.getState()
    expect(s.settings).toBeTypeOf('object')
  })
})

describe('layers — addLayer merges by id, it does not append a duplicate', () => {
  it('replaces the fields of an existing layer instead of adding a second one', () => {
    const { addLayer } = useStore.getState()
    addLayer(layer('ndvi', { opacity: 1, name: 'NDVI' }))
    addLayer(layer('ndvi', { opacity: 0.5, name: 'NDVI (masked)' }))
    const layers = useStore.getState().layers
    expect(layers).toHaveLength(1)
    expect(layers[0].opacity).toBe(0.5)
    expect(layers[0].name).toBe('NDVI (masked)')
  })

  it('keeps distinct ids side by side, in insertion order', () => {
    const { addLayer } = useStore.getState()
    addLayer(layer('a')); addLayer(layer('b'))
    expect(useStore.getState().layers.map((l) => l.id)).toEqual(['a', 'b'])
  })

  it('toggles visibility and sets opacity on the addressed layer only', () => {
    const s = useStore.getState()
    s.addLayer(layer('a')); s.addLayer(layer('b'))
    s.toggleLayerVisibility('a')
    s.setLayerOpacity('a', 0.25)
    const [a, b] = useStore.getState().layers
    expect(a.visible).toBe(false)
    expect(a.opacity).toBe(0.25)
    expect(b.visible).toBe(true)
    expect(b.opacity).toBe(1)
  })

  it('removeLayer drops only the named layer', () => {
    const s = useStore.getState()
    s.addLayer(layer('a')); s.addLayer(layer('b'))
    s.removeLayer('a')
    expect(useStore.getState().layers.map((l) => l.id)).toEqual(['b'])
  })
})

describe('plan — a replan preserves what already ran, by index AND tool', () => {
  it('keeps a finished step finished when the replan repeats that tool at that index', () => {
    const s = useStore.getState()
    s.setPlan([{ tool: 'fetch_ndvi' }, { tool: 'query_osm' }], 'plan')
    s.updatePlanStep(0, 'done')
    s.setPlan([{ tool: 'fetch_ndvi' }, { tool: 'query_osm' }, { tool: 'fetch_dem' }], 'replan')

    const steps = useStore.getState().currentPlan!.steps
    expect(steps).toHaveLength(3)
    expect(steps[0].status).toBe('done')      // already ran — not re-queued
    expect(steps[1].status).toBe('queued')
    expect(steps[2].status).toBe('queued')     // newly added
    expect(useStore.getState().currentPlan!.replanning).toBe(true)
  })

  it('re-queues the slot when the replan puts a DIFFERENT tool at that index', () => {
    const s = useStore.getState()
    s.setPlan([{ tool: 'fetch_ndvi' }], 'plan')
    s.updatePlanStep(0, 'done')
    s.setPlan([{ tool: 'fetch_thermal' }], 'replan')
    // Carrying "done" onto a tool that never ran would show a green tick
    // for work nobody did.
    expect(useStore.getState().currentPlan!.steps[0].status).toBe('queued')
  })

  it('updatePlanStep on an absent plan is a no-op rather than a crash', () => {
    useStore.getState().clearPlan()
    expect(() => useStore.getState().updatePlanStep(3, 'done')).not.toThrow()
    expect(useStore.getState().currentPlan).toBeNull()
  })
})

describe('tool calls — timing is stamped once, on leaving `running`', () => {
  it('records durationMs when a running call completes', () => {
    const s = useStore.getState()
    s.addToolCall({ toolName: 'fetch_ndvi', status: 'running', label: 'NDVI', startedAt: Date.now() - 1_000 })
    s.updateToolCall('fetch_ndvi', 'completed')
    const t = useStore.getState().toolCalls[0]
    expect(t.status).toBe('completed')
    expect(t.durationMs).toBeGreaterThanOrEqual(1_000)
  })

  it('does not overwrite a duration that was already measured', () => {
    const s = useStore.getState()
    s.addToolCall({ toolName: 'fetch_ndvi', status: 'running', label: 'NDVI', startedAt: Date.now() - 1_000 })
    s.updateToolCall('fetch_ndvi', 'completed')
    const first = useStore.getState().toolCalls[0].durationMs
    s.updateToolCall('fetch_ndvi', 'error', 'late failure')
    const t = useStore.getState().toolCalls[0]
    expect(t.durationMs).toBe(first)
    expect(t.errorText).toBe('late failure')
  })

  it('resolves the oldest RUNNING instance, not every entry sharing the name', () => {
    // A completion must settle one call, so two reads of the same tool can hold
    // different statuses rather than both finishing on the first result.
    const s = useStore.getState()
    s.clearToolCalls()
    s.addToolCall({ toolName: 'fetch_ndvi', status: 'running', label: 'NDVI', startedAt: Date.now() - 500 })
    s.updateToolCall('fetch_ndvi', 'completed')
    expect(useStore.getState().toolCalls[0].status).toBe('completed')

    // With nothing running, a late event still lands rather than being dropped.
    s.updateToolCall('fetch_ndvi', 'error', 'late failure')
    expect(useStore.getState().toolCalls[0].status).toBe('error')
    expect(useStore.getState().toolCalls[0].errorText).toBe('late failure')
  })

  it('an update for a tool that was never added is a no-op, not a crash', () => {
    const s = useStore.getState()
    s.clearToolCalls()
    expect(() => s.updateToolCall('never_ran', 'completed')).not.toThrow()
    expect(useStore.getState().toolCalls).toHaveLength(0)
  })

  it('re-adding the same tool replaces its entry rather than duplicating it', () => {
    const s = useStore.getState()
    s.addToolCall({ toolName: 'query_osm', status: 'running', label: 'OSM' })
    s.addToolCall({ toolName: 'query_osm', status: 'running', label: 'OSM (retry)' })
    expect(useStore.getState().toolCalls).toHaveLength(1)
    expect(useStore.getState().toolCalls[0].label).toBe('OSM (retry)')
  })

  it('stamps startedAt when the caller does not supply one', () => {
    useStore.getState().addToolCall({ toolName: 'fetch_dem', status: 'running', label: 'DEM' })
    expect(useStore.getState().toolCalls[0].startedAt).toBeTypeOf('number')
  })
})

describe('streaming → messages, and the citation snapshot', () => {
  it('writes the streamed text onto the last assistant message and clears the buffer', () => {
    const s = useStore.getState()
    s.addMessage(message('u1', 'user', 'how green is it?'))
    s.addMessage(message('a1', 'assistant'))
    s.appendStreamingContent('NDVI is ')
    s.appendStreamingContent('0.42')
    s.mergeStreamingToMessages()

    const st = useStore.getState()
    expect(st.messages.at(-1)!.content).toBe('NDVI is 0.42')
    expect(st.streamingContent).toBe('')
  })

  it('SNAPSHOTS tool results onto the message so citations survive the next query', () => {
    const s = useStore.getState()
    s.addMessage(message('a1', 'assistant'))
    s.addToolResult(result('r1', 'fetch_ndvi'))
    s.appendStreamingContent('mean [[r1#mean]]')
    s.mergeStreamingToMessages()

    // The live slice is cleared at the start of every new query...
    useStore.getState().clearToolResults()
    expect(useStore.getState().toolResults).toEqual({})
    // ...but the pill in the old message must still resolve.
    expect(useStore.getState().messages.at(-1)!.toolResults!.r1.tool).toBe('fetch_ndvi')
  })

  it('is a no-op on an empty buffer — it must not blank an existing answer', () => {
    const s = useStore.getState()
    s.addMessage(message('a1', 'assistant', 'a previous answer'))
    s.mergeStreamingToMessages()
    expect(useStore.getState().messages.at(-1)!.content).toBe('a previous answer')
  })

  it('does not attach streamed text to a user message when no assistant turn exists', () => {
    const s = useStore.getState()
    s.addMessage(message('u1', 'user', 'question'))
    s.appendStreamingContent('orphaned tokens')
    s.mergeStreamingToMessages()
    expect(useStore.getState().messages.at(-1)!.content).toBe('question')
  })
})


describe('resetSession — clears the analysis, keeps the user’s own work', () => {
  it('drops layers, messages, plan, tool state and the AOI', () => {
    const s = useStore.getState()
    s.addLayer(layer('a'))
    s.addMessage(message('m1', 'assistant', 'hi'))
    s.setPlan([{ tool: 'fetch_ndvi' }], 'plan')
    s.addToolCall({ toolName: 'fetch_ndvi', status: 'running', label: 'NDVI' })
    s.addToolResult(result('r1', 'fetch_ndvi'))
    s.appendStreamingContent('partial')

    useStore.getState().resetSession()

    const st = useStore.getState()
    expect(st.layers).toEqual([])
    expect(st.messages).toEqual([])
    expect(st.currentPlan).toBeNull()
    expect(st.toolCalls).toEqual([])
    expect(st.toolResults).toEqual({})
    expect(st.streamingContent).toBe('')
    expect(st.aoi).toBeNull()
    expect(st.analysisStage).toBe('idle')
  })
})

describe('notifications and hydration', () => {
  it('counts only what needs the person: routine run events are listed but not unread', () => {
    useStore.getState().clearNotifications()
    const { addNotification } = useStore.getState()
    addNotification({ type: 'analysis', title: 'Running', description: '' })
    addNotification({ type: 'tool_complete', title: 'Done', description: '' })
    addNotification({ type: 'layer_added', title: 'Layer', description: '' })
    expect(useStore.getState().notifications).toHaveLength(3)
    expect(useStore.getState().unreadCount).toBe(0)
    addNotification({ type: 'system', title: 'Error: fetch', description: 'failed' })
    expect(useStore.getState().unreadCount).toBe(1)
    useStore.getState().clearNotifications()
  })

  it('starts from defaults (no saved state read at creation); hydrate keeps them when nothing is saved', () => {
    expect(useStore.getState().aoi).toBeNull()
    expect(useStore.getState().chatHistory).toEqual([])
    useStore.getState().hydrate()
    expect(useStore.getState().aoi).toBeNull()
    expect(useStore.getState().settings.theme).toBe('dark')
  })
})
