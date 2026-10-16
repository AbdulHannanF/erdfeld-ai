import { create } from 'zustand'

import { fetchSceneList, type SceneList, type SceneQuery, type SceneRecord, type SceneRender, type SceneSensor } from '@/lib/scenes-client'

/** The map layer the timeline draws; one id, its tile URL swapped as the frame changes. */
export const TIMELINE_LAYER_ID = 'scene-timeline'

export interface SeriesRow {
  date: string
  value: number
  clear_pct: number
  scene_id: string
  sensor: string
}

export interface SeriesData {
  title: string
  rows: SeriesRow[]
  spec: Record<string, unknown>
  /** The scenes asked for, when the run was for chosen scenes rather than the whole window. */
  resultId: string
}

/** What a list was read for: the area and every choice that shapes the query. Reopening the panel with the same key keeps the list, the position and the chosen scenes. */
export function loadKey(bbox: [number, number, number, number] | null, c: { sensor: string; render: string; from: string; to: string; maxCloud: number }): string {
  return `${bbox?.join(',') ?? ''}|${c.sensor}|${c.render}|${c.from}|${c.to}|${c.maxCloud}`
}

export type TimelineStatus = 'idle' | 'loading' | 'ready' | 'error'
export const SPEEDS = [0.5, 1, 2, 4] as const

interface Choice {
  sensor: SceneSensor
  render: SceneRender
  /** YYYY-MM-DD or '' for the start of the archive. */
  from: string
  /** YYYY-MM-DD or '' for today. */
  to: string
  /** Scene-wide cloud ceiling in %, 100 = every scene. */
  maxCloud: number
}

interface TimelineState {
  panelOpen: boolean
  setPanelOpen: (open: boolean) => void
  choice: Choice
  setChoice: (patch: Partial<Choice>) => void

  list: SceneList | null
  /** The area the list was read for, as its bounding box joined into a string. */
  listKey: string | null
  /** `loadKey` of the query behind `list`. */
  loadedKey: string | null
  status: TimelineStatus
  error: string | null
  progress: { loaded: number; total: number } | null
  load: (bbox: [number, number, number, number]) => Promise<void>

  /** Which scene of `list.scenes` the map shows. */
  index: number
  setIndex: (i: number) => void
  step: (delta: number) => void
  playing: boolean
  setPlaying: (p: boolean) => void
  speed: (typeof SPEEDS)[number]
  setSpeed: (s: (typeof SPEEDS)[number]) => void

  /** Chosen scene ids, in the order they were chosen. */
  selected: string[]
  toggleSelected: (id: string) => void
  setSelected: (ids: string[]) => void
  /** The two scenes shown in the swipe view, earlier first; null when it is not showing scenes. */
  compare: { a: string; b: string } | null
  setCompare: (c: { a: string; b: string } | null) => void

  series: SeriesData | null
  setSeries: (s: SeriesData | null) => void
  /** Forget the list and take the layer off the map. */
  reset: () => void
}

let inflight: AbortController | null = null

export const useTimeline = create<TimelineState>((set, get) => ({
  panelOpen: false,
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  choice: { sensor: 'sentinel-2', render: 'true_colour', from: '', to: '', maxCloud: 100 },
  setChoice: (patch) => set((s) => ({ choice: { ...s.choice, ...patch } })),

  list: null,
  listKey: null,
  loadedKey: null,
  status: 'idle',
  error: null,
  progress: null,
  load: async (bbox) => {
    inflight?.abort()
    const ctl = new AbortController()
    inflight = ctl
    const { choice } = get()
    const q: SceneQuery = { bbox, sensor: choice.sensor, render: choice.render, from: choice.from || undefined, to: choice.to || undefined, maxCloud: choice.maxCloud }
    set({ status: 'loading', error: null, progress: { loaded: 0, total: 0 }, playing: false })
    try {
      const list = await fetchSceneList(q, { signal: ctl.signal, onProgress: (loaded, total) => set({ progress: { loaded, total } }) })
      if (ctl.signal.aborted) return
      // keep the chosen scenes that are still in the list
      const ids = new Set(list.scenes.map((s) => s.id))
      set((s) => ({ list, listKey: bbox.join(','), loadedKey: loadKey(bbox, choice), status: 'ready', progress: null, index: 0, selected: s.selected.filter((id) => ids.has(id)), compare: null }))
    } catch (err) {
      if (ctl.signal.aborted) return
      set({ status: 'error', error: err instanceof Error ? err.message : 'The scene list could not be read.', progress: null })
    }
  },

  index: 0,
  setIndex: (i) => {
    const n = get().list?.scenes.length ?? 0
    set({ index: n === 0 ? 0 : Math.max(0, Math.min(n - 1, Math.round(i))) })
  },
  step: (delta) => get().setIndex(get().index + delta),
  playing: false,
  setPlaying: (playing) => set({ playing }),
  speed: 1,
  setSpeed: (speed) => set({ speed }),

  selected: [],
  toggleSelected: (id) => set((s) => ({ selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id] })),
  setSelected: (selected) => set({ selected }),
  compare: null,
  setCompare: (compare) => set({ compare }),

  series: null,
  setSeries: (series) => set({ series }),
  reset: () => {
    inflight?.abort()
    set({ list: null, listKey: null, loadedKey: null, status: 'idle', error: null, progress: null, index: 0, playing: false, selected: [], compare: null, series: null })
  },
}))

/** The scene on show, or null. */
export function currentScene(s: Pick<TimelineState, 'list' | 'index'>): SceneRecord | null {
  return s.list?.scenes[s.index] ?? null
}
