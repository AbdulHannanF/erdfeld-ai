import { create } from 'zustand'
import { STORAGE_KEYS, readStorage, removeStorage, writeJson } from '@/lib/storage'
import { rememberRun } from '@/lib/run-log'
import type { CitableToolResult, CitationValue } from '@/lib/citations'
import type { GeoResultStatus, ValidationCheck } from '@/lib/geo-result'
import type { RasterDescriptor } from '@/lib/raster-style'
import type { ChartItem } from '@/lib/chart-spec'
import type { VectorStyle } from '@/lib/vector-style'

export interface GeoPoint {
  lng: number
  lat: number
}

export interface AOI {
  type: 'Polygon' | 'Rectangle' | 'Circle' | 'Freehand'
  geometry: GeoJSON.Geometry
  center?: GeoPoint
  radiusKm?: number
}

export type LayerPalette =
  | {
      kind: 'gradient'
      stops: Array<{ value: number; color: string; label?: string }>
      min: number
      max: number
      unit?: string
      label?: string
    }
  | {
      kind: 'classes'
      classes: Array<{ color: string; label: string; value?: string | number }>
      unit?: string
      label?: string
    }

export interface MapLayer {
  id: string
  name: string
  type: 'raster' | 'geojson' | '3dtiles' | 'heatmap'
  tileUrl?: string
  geojson?: GeoJSON.FeatureCollection
  visible: boolean
  opacity: number
  color?: string
  bounds?: [number, number, number, number]
  /** For heatmap layers: name of the GeoJSON feature property carrying intensity in 0..1. */
  intensityProperty?: string
  /** Server-generated PNG as base64 string. When present, used as MapLibre ImageSource instead of tileUrl. */
  imageBase64?: string
  /** Where the data came from and how it was computed (from the SSE layer event). */
  provenance?: { source: string; date?: string; method: string; clip: string }
  /** How much to trust this layer's values: high | medium | low. */
  confidence?: 'high' | 'medium' | 'low'
  /** When 'extrusion', MapPanel renders polygons as `fill-extrusion` using `heightProperty`. */
  render?: 'extrusion'
  /** GeoJSON feature property carrying the extrusion height in meters (default 'height'). */
  heightProperty?: string
  /** Color palette describing how to read the values — drives the LayerLegend. */
  palette?: LayerPalette
  /** Generic raster descriptor (kind, acquisition, stretch, colormap, classes). Drives the
   *  raster legend and the colormap / stretch controls, which rewrite `tileUrl` client-side. */
  raster?: RasterDescriptor
  /** Hide raster pixels outside the drawn AOI (world-minus-AOI fill drawn above the raster). */
  aoiMask?: boolean
  /** Data-driven vector styling (graduated / categorical by a feature property). The map
   *  paints it as `step` / `match` expressions and the legend lists its classes. */
  vectorStyle?: VectorStyle
  /** P4.4 — the `result_id` of the tool call that produced this layer. Lets the
   *  agent reuse the layer's data in a later query and cite it via `[[result_id#key]]`. */
  resultId?: string
  /** P4.4 — the tool that produced this layer (e.g. 'fetch_ndvi'). */
  tool?: string
  /** P4.4 — the citable figures from the producing tool, keyed for reuse. */
  summaryData?: Record<string, CitationValue>
  /** P4.4 — signature of the AOI this layer was computed for. The reusable
   *  manifest only includes layers whose `aoiKey` matches the current AOI. */
  aoiKey?: string
  /** P7.3 — set true when this layer's raster tiles fail to load: a 4xx at once (e.g. an
   *  expired Planetary Computer SAS URL, DATA-013), a 5xx / network error after repeated
   *  failures (see `lib/tile-failure.ts`). LayerPanel shows a "not loading" pill + a refresh
   *  action; cleared when a fresh tile URL is set. */
  expired?: boolean
  /** Q-15 — a preview drawn before the tool finished (tiles on a fixed range, statistics still
   *  computing). The tool's final layer event has the same id, replaces it in place and clears
   *  this flag. */
  provisional?: boolean
  /** C2 — honest data tier (free-10m / commercial-submeter / user-upload / unknown),
   *  derived from the source. LayerPanel shows it as a badge. */
  tier?: 'free-10m' | 'commercial-submeter' | 'user-upload' | 'unknown'
  /** C2 — short tier label for the badge (e.g. "Free open data (10 m)"). */
  tierLabel?: string
  /** C2 — representative native resolution in m/pixel (null for vector / N/A). */
  resolutionM?: number | null
  /** Validation outcome of the result that produced this layer (see `ResultVerdict`). A flagged
   *  layer is drawn but labelled, never presented as fine. */
  verdict?: ResultVerdict
}

/** A single scene in a temporal stack, carried by the `temporal_frame` SSE event.
 *  `tileUrl` is a titiler tile template; `bounds` is the STAC scene bbox; `cloud`
 *  is the eo:cloud_cover percentage. The legacy `thumbnail` is kept for back-compat. */
export interface TemporalFrame {
  date: string
  thumbnail?: string
  tileUrl?: string
  imageBase64?: string
  bounds?: [number, number, number, number]
  /** Scene-wide `eo:cloud_cover` from STAC metadata — describes the whole ~110 km
   *  granule, not the drawn AOI. Kept because it is what the catalogue publishes. */
  cloud?: number
  /** Percentage of the DRAWN POLYGON that was clear in this scene, from the per-pixel
   *  quality mask. This is the number that decides whether a frame is usable, and it
   *  routinely disagrees with `cloud` — one sweep reported 29.6% scene cloud beside
   *  94% AOI clear and the pair read as a contradiction. Showing both, labelled,
   *  is the fix. */
  aoiClearPct?: number
}

/** What the executor's validation concluded about a result: its status and the checks that did
 *  not pass. Carried by the tool step and by every layer the result produced. */
export interface ResultVerdict {
  status: GeoResultStatus
  checks: ValidationCheck[]
}

export interface ToolCallStatus {
  toolName: string
  status: 'running' | 'completed' | 'error'
  label: string
  /** Validation outcome once the step finished: `flagged` ran but a check failed, `refused`
   *  never ran because a static check failed. Absent while running. */
  verdict?: ResultVerdict
  /** The content-hash id of the result this step produced (joins the step to its Evidence row). */
  resultId?: string
  /** P7.3 — on error, the truncated upstream error text so the answer can show why. */
  errorText?: string
  /** Audit 2026-06-10 — wall-clock timing for the tool trace (additive). Stamped
   *  by addToolCall on 'running'; durationMs computed by updateToolCall on finish. */
  startedAt?: number
  durationMs?: number
}

/** P4.1 — agent planning. A step's lifecycle in the plan timeline. */
export type PlanStepStatus = 'queued' | 'running' | 'done' | 'error' | 'skipped'

/** Raw plan step as emitted by the `plan` SSE event (no status yet). */
export interface PlanStepInput {
  tool: string
  args?: Record<string, unknown>
  reason?: string
  depends_on?: number[]
  parallel_group?: number
}

/** A plan step with its live execution status, rendered by PlanTimeline. */
export interface PlanStepState extends PlanStepInput {
  status: PlanStepStatus
}

export interface PlanState {
  steps: PlanStepState[]
  /** True while a replan revision is in flight. */
  replanning: boolean
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  toolCalls?: ToolCallStatus[]
  /** P4.2 — snapshot of the tool results this message's citations resolve against.
   *  Captured at finalize so historical messages keep their own provenance even
   *  after a later query clears/repopulates the live `toolResults` slice. */
  toolResults?: Record<string, CitableToolResult>
  /** Vega-Lite charts produced while answering — shown inline under this message. */
  charts?: ChartItem[]
  /** Audit 2026-06-10 — the AOI geometry active when a user message was sent
   *  (additive). Drives the polygon preview thumbnail on user bubbles. */
  aoiGeometry?: GeoJSON.Geometry
}

/** P6.2 — metadata for a read-only shared-project preview (drives the banner). */
export interface PreviewMeta {
  token: string
  name: string
  /** ISO timestamp of the snapshot (project `updatedAt`). */
  updatedAt: string
}

export interface ThinkingToken {
  id: string
  content: string
  timestamp: number
}

export type AnalysisStage = 'idle' | 'receiving' | 'thinking' | 'running_tools' | 'generating_layers' | 'complete' | 'error'

export const APP_VERSION = '1.0.0' as const

export interface Notification {
  id: string
  type: 'tool_complete' | 'layer_added' | 'analysis' | 'system'
  title: string
  description: string
  timestamp: number
  read: boolean
  icon?: string
}

export interface AppSettings {
  // Appearance
  theme: 'light' | 'dark' | 'system'

  // Notifications
  enableNotifications: boolean

  // Map Defaults
  showCoordinates: boolean
  showZoomLevel: boolean

  // Units
  distanceUnit: 'metric' | 'imperial'
  areaUnit: 'metric' | 'imperial'

  // AI Provider
  aiProvider: 'default' | 'openai' | 'ollama' | 'gemini' | 'claude' | 'custom'
  aiApiKey: string
  aiBaseUrl: string
  aiModel: string

  // Custom CV / perception models (Phase 1). A JSON array of model specs:
  //   [{ id, provider: local-onnx|roboflow|hf|custom-http, ref, task, classes,
  //      input_size, profile, license }]
  // Sent with each agent request and merged into the server-side registry, so
  // adding a model needs no redeploy. Validated server-side; parse errors come
  // back as a message rather than failing the query.
  customModels: string
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  enableNotifications: true,
  showCoordinates: true,
  showZoomLevel: true,
  distanceUnit: 'metric',
  areaUnit: 'metric',
  aiProvider: 'default',
  aiApiKey: '',
  aiBaseUrl: '',
  aiModel: '',
  customModels: '',
}

interface AppState {
  /** Load the persisted AOI, chat history, pinned messages and settings. Called once after mount:
   *  the store starts from defaults so the server and the first client render agree. */
  hydrate: () => void

  // AOI
  aoi: AOI | null
  setAoi: (aoi: AOI | null) => void

  // Chat
  messages: ChatMessage[]
  addMessage: (msg: ChatMessage) => void
  updateLastAssistantMessage: (content: string) => void
  clearMessages: () => void

  // Chat history (localStorage persistence)
  chatHistory: Array<{ id: string; messages: ChatMessage[]; timestamp: number; query: string }>
  saveToHistory: () => void
  loadFromHistory: (id: string) => void
  clearHistory: () => void

  // Notifications
  notifications: Notification[]
  addNotification: (notification: Omit<Notification, 'id' | 'timestamp' | 'read'>) => void
  markNotificationRead: (id: string) => void
  clearNotifications: () => void
  unreadCount: number

  /** A status note about the current run, shown beside the question and apart from the answer. */
  runNotice: string | null
  setRunNotice: (note: string | null) => void

  // Thinking trace
  thinkingTokens: ThinkingToken[]
  addThinkingToken: (token: string) => void
  clearThinkingTokens: () => void
  isThinkingExpanded: boolean
  setThinkingExpanded: (expanded: boolean) => void

  // Map layers
  layers: MapLayer[]
  addLayer: (layer: MapLayer) => void
  removeLayer: (id: string) => void
  toggleLayerVisibility: (id: string) => void
  setLayerOpacity: (id: string, opacity: number) => void
  /** Swap a raster layer's tile URL in place (used by the timeline slider to
   *  scrub through temporal NDVI scenes without recreating the whole layer). */
  /** Restyle a raster layer client-side: new tile URL + the matching descriptor. */
  setLayerRasterStyle: (id: string, tileUrl: string, raster: RasterDescriptor) => void
  /** Set (or clear, with undefined) a vector layer's data-driven style. */
  setLayerVectorStyle: (id: string, style: VectorStyle | undefined) => void
  setLayerTileUrl: (id: string, tileUrl: string, name?: string) => void
  /** P7.3 — mark/unmark a layer as having stale (4xx-failed) tiles. */
  setLayerExpired: (id: string, expired: boolean) => void

  // Tool status
  toolCalls: ToolCallStatus[]
  addToolCall: (toolCall: ToolCallStatus) => void
  updateToolCall: (toolName: string, status: 'running' | 'completed' | 'error', errorText?: string, verdict?: ResultVerdict, resultId?: string) => void
  clearToolCalls: () => void

  // Agent plan (P4.1) — the written multi-tool plan + per-step live status
  currentPlan: PlanState | null
  setPlan: (steps: PlanStepInput[], kind: 'plan' | 'replan') => void
  updatePlanStep: (index: number, status: PlanStepStatus) => void
  clearPlan: () => void

  // Tool results (P4.2) — structured `summary_data` keyed by `result_id`, used
  // to resolve `[[result_id#key]]` citation pills in the analysis block.
  toolResults: Record<string, CitableToolResult>
  addToolResult: (result: CitableToolResult) => void
  /** Q-47 — ids of the evidence-ledger runs this session's requests were saved as (`/api/ledger/:id`). */
  ledgerRunIds: string[]
  addLedgerRunId: (id: string) => void
  /** Vega-Lite charts of the current answer (dashboard); snapshotted into the message at finalize. */
  charts: ChartItem[]
  addChart: (chart: ChartItem) => void
  clearCharts: () => void
  /** Feature selected by clicking a chart mark or a map feature (links both). */
  highlight: { layerId: string; fid: number } | null
  setHighlight: (h: { layerId: string; fid: number } | null) => void
  clearToolResults: () => void

  // Connection
  isConnected: boolean
  setConnected: (connected: boolean) => void

  // Loading
  isLoading: boolean
  setLoading: (loading: boolean) => void

  // P7.3 — last query + last agent error, so the chat can offer a single Retry
  // button when the LLM provider call fails (re-sends `lastQuery`).
  lastQuery: string | null
  setLastQuery: (q: string | null) => void
  agentError: string | null
  setAgentError: (msg: string | null) => void

  // Map style
  mapStyle: string
  setMapStyle: (style: string) => void

  // Temporal frames — drives MapTimelineSlider
  temporalFrames: TemporalFrame[]
  addTemporalFrame: (frame: TemporalFrame) => void
  clearTemporalFrames: () => void
  activeFrameIndex: number
  setActiveFrameIndex: (index: number) => void

  // Session stats
  sessionStartTime: number | null
  setSessionStartTime: (time: number | null) => void
  queryCount: number
  incrementQueryCount: () => void
  completedToolCount: number
  incrementCompletedToolCount: () => void

  // Fly-to target for geocoding
  flyToTarget: { lng: number; lat: number; zoom: number } | null
  setFlyToTarget: (target: { lng: number; lat: number; zoom: number } | null) => void

  // P4.3 — clicked-point focus for "what is this?" queries. Ephemeral (not
  // persisted), separate from the drawn AOI so the polygon is never lost.
  pointFocus: { lat: number; lng: number } | null
  setPointFocus: (p: { lat: number; lng: number } | null) => void

  // Keyboard shortcuts cheat sheet
  showShortcuts: boolean
  setShowShortcuts: (show: boolean) => void

  // Map fullscreen
  isMapFullscreen: boolean
  setMapFullscreen: (v: boolean) => void

  // Selected feature for data table
  selectedFeatureIndex: number | null
  setSelectedFeatureIndex: (index: number | null) => void

  // Zoom to feature on map
  zoomToFeature: { layerId: string; featureIndex: number } | null
  setZoomToFeature: (target: { layerId: string; featureIndex: number } | null) => void

  // Analysis stage
  analysisStage: AnalysisStage
  setAnalysisStage: (stage: AnalysisStage) => void

  // Stage at which error occurred (to show error indicator on the right step)
  errorAtStage: AnalysisStage | null
  setErrorAtStage: (stage: AnalysisStage | null) => void

  // App version
  appVersion: string

  // Session reset
  resetSession: () => void

  // P6.1 — saved projects. `currentProjectId` is the id of the loaded/last-saved
  // project (null = unsaved session). `loadProject` restores a project's AOI +
  // layers + chat into the store, mirroring the share-URL restore but DB-driven.
  currentProjectId: string | null
  setCurrentProjectId: (id: string | null) => void
  /** Name of the loaded or last-saved project, for the top bar. */
  projectName: string | null
  setProjectName: (name: string | null) => void
  loadProject: (
    project: {
      id: string
      aoi: AOI | null
      mapStyle: string
      layers: MapLayer[]
      messages: ChatMessage[]
    },
    opts?: { preview?: PreviewMeta },
  ) => void

  // P6.2 — read-only share preview. When a viewer opens a `/share/:token` link,
  // the project loads with `previewMode === true` and `previewMeta` describing
  // the snapshot. The viewer doesn't own it (`currentProjectId` stays null), so
  // the "shared snapshot — fork to edit" banner is shown and saving is blocked
  // until they fork. `exitPreview` dismisses the banner without clearing state.
  previewMode: boolean
  previewMeta: PreviewMeta | null
  exitPreview: () => void

  // Settings
  settings: AppSettings
  updateSettings: (updates: Partial<AppSettings>) => void

  // Command palette
  commandPaletteOpen: boolean
  setCommandPaletteOpen: (open: boolean) => void

  // Settings panel open state — allows the provider banner to open Settings from ChatPanel
  settingsPanelOpen: boolean
  setSettingsPanelOpen: (open: boolean) => void

  // Pinned messages
  pinnedMessageIds: string[]
  pinMessage: (id: string) => void
  unpinMessage: (id: string) => void

  // Active TerraDraw mode (null = static/no drawing)
  activeDrawMode: string | null
  setActiveDrawMode: (mode: string | null) => void

  // Streaming content — updated per token; isolated from messages[] to prevent cascade re-renders
  streamingContent: string
  appendStreamingContent: (chunk: string) => void
  clearStreamingContent: () => void
  mergeStreamingToMessages: () => void

  // fitBounds target — set by agent when a layer is added, consumed by MapPanel
  fitBoundsTarget: [number, number, number, number] | null
  setFitBoundsTarget: (bbox: [number, number, number, number] | null) => void

  // 3D terrain (P2.2). Default off — the 2D draw/measure workflow is unaffected.
  terrainEnabled: boolean
  setTerrainEnabled: (enabled: boolean) => void
  terrainExaggeration: number
  setTerrainExaggeration: (value: number) => void

  // Globe projection (P2.2). Composes with terrain.
  projection: 'mercator' | 'globe'
  setProjection: (projection: 'mercator' | 'globe') => void

  // Atmospheric sky (P2.2). Auto-enabled with globe; can be forced on for terrain too.
  skyEnabled: boolean
  setSkyEnabled: (enabled: boolean) => void

  // Map snapshot provider (P3.7). MapPanel registers a callback that returns
  // the current canvas as a PNG dataURL; the PDF report builder reads it.
  // Ephemeral session state — not persisted.
  mapSnapshotProvider: (() => string | null) | null
  setMapSnapshotProvider: (provider: (() => string | null) | null) => void
}

let thinkingIdCounter = 0

// Safe check for browser environment
const isBrowser = typeof window !== 'undefined'

// Load chat history from localStorage
function loadChatHistory(): Array<{ id: string; messages: ChatMessage[]; timestamp: number; query: string }> {
  if (!isBrowser) return []
  try {
    const stored = readStorage(STORAGE_KEYS.chatHistory)
    if (stored) return JSON.parse(stored)
  } catch {}
  return []
}

// Load pinned messages from localStorage
function loadPinnedMessages(): string[] {
  if (!isBrowser) return []
  try {
    const stored = readStorage(STORAGE_KEYS.pinnedMessages)
    if (stored) return JSON.parse(stored)
  } catch {}
  return []
}

// Load the drawn AOI from localStorage. Measured: after a reload the chat
// messages survived but the AOI was gone, leaving a conversation about an area
// that no longer exists on the map. Persist only the serialisable geometry.
function loadAoi(): AOI | null {
  if (!isBrowser) return null
  try {
    const stored = readStorage(STORAGE_KEYS.aoi)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (parsed && parsed.geometry) return parsed
    }
  } catch {}
  return null
}

// Load settings from localStorage
function loadSettings(): AppSettings {
  if (!isBrowser) return DEFAULT_SETTINGS
  try {
    const stored = readStorage(STORAGE_KEYS.settings)
    if (stored) {
      const parsed = JSON.parse(stored)
      return { ...DEFAULT_SETTINGS, ...parsed }
    }
  } catch {}
  return DEFAULT_SETTINGS
}

export const useStore = create<AppState>((set, get) => ({
  // Persisted state (localStorage) is read in `hydrate`, after mount, never at creation: reading it
  // here made the first client render differ from the server's (React #418 with a saved AOI).
  hydrate: () => set({ aoi: loadAoi(), chatHistory: loadChatHistory(), pinnedMessageIds: loadPinnedMessages(), settings: loadSettings() }),

  // AOI
  aoi: null,
  setAoi: (aoi) => {
    // Persist alongside the state change so a reload keeps the drawn area in
    // sync with the conversation (measured: reload lost the AOI but kept chat).
    try {
      if (aoi) writeJson(STORAGE_KEYS.aoi, aoi)
      else removeStorage(STORAGE_KEYS.aoi)
    } catch {}
    set({ aoi })
  },

  // Chat
  messages: [],
  addMessage: (msg) =>
    set((state) => ({ messages: [...state.messages, msg] })),
  updateLastAssistantMessage: (content) =>
    set((state) => {
      const messages = [...state.messages]
      const lastIdx = messages.findLastIndex((m) => m.role === 'assistant')
      if (lastIdx >= 0) {
        messages[lastIdx] = { ...messages[lastIdx], content }
      }
      return { messages }
    }),
  clearMessages: () => set({ messages: [] }),

  // Chat history
  chatHistory: [],
  saveToHistory: () =>
    set((state) => {
      const msgs = state.messages.filter((m) => m.content)
      if (msgs.length === 0) return state
      const firstUserMsg = msgs.find((m) => m.role === 'user')
      const entry = {
        id: `history-${Date.now()}`,
        messages: msgs,
        timestamp: Date.now(),
        query: firstUserMsg?.content || 'Analysis',
      }
      const newHistory = [entry, ...state.chatHistory].slice(0, 20) // Keep last 20
      writeJson(STORAGE_KEYS.chatHistory, newHistory)
      return { chatHistory: newHistory }
    }),
  loadFromHistory: (id) =>
    set((state) => {
      const entry = state.chatHistory.find((h) => h.id === id)
      if (!entry) return state
      return { messages: [...entry.messages] }
    }),
  clearHistory: () => {
    removeStorage(STORAGE_KEYS.chatHistory)
    return set({ chatHistory: [] })
  },

  runNotice: null,
  setRunNotice: (runNotice) => set({ runNotice }),

  // Thinking trace
  thinkingTokens: [],
  addThinkingToken: (token) =>
    set((state) => ({
      thinkingTokens: [
        ...state.thinkingTokens,
        { id: `think-${++thinkingIdCounter}`, content: token, timestamp: Date.now() },
      ],
    })),
  clearThinkingTokens: () => {
    thinkingIdCounter = 0
    return set({ thinkingTokens: [] })
  },
  isThinkingExpanded: true,
  setThinkingExpanded: (expanded) => set({ isThinkingExpanded: expanded }),

  // Map layers
  layers: [],
  addLayer: (layer) =>
    set((state) => {
      const existing = state.layers.find((l) => l.id === layer.id)
      if (existing) {
        return {
          layers: state.layers.map((l) =>
            // A different tile URL (the final stretch replacing a preview's) is a fresh start for
            // the "tiles not loading" flag.
            l.id === layer.id ? { ...l, ...layer, ...(layer.tileUrl !== l.tileUrl ? { expired: false } : {}) } : l
          ),
        }
      }
      return { layers: [...state.layers, layer] }
    }),
  removeLayer: (id) =>
    set((state) => ({ layers: state.layers.filter((l) => l.id !== id) })),
  toggleLayerVisibility: (id) =>
    set((state) => ({
      layers: state.layers.map((l) =>
        l.id === id ? { ...l, visible: !l.visible } : l
      ),
    })),
  setLayerOpacity: (id, opacity) =>
    set((state) => ({
      layers: state.layers.map((l) =>
        l.id === id ? { ...l, opacity } : l
      ),
    })),
  setLayerRasterStyle: (id, tileUrl, raster) =>
    set((state) => ({
      layers: state.layers.map((l) => (l.id === id ? { ...l, tileUrl, raster, expired: false } : l)),
    })),
  setLayerVectorStyle: (id, style) =>
    set((state) => ({
      layers: state.layers.map((l) => (l.id === id ? { ...l, vectorStyle: style } : l)),
    })),
  setLayerTileUrl: (id, tileUrl, name) =>
    set((state) => ({
      layers: state.layers.map((l) =>
        // A fresh tile URL clears any prior "expired" flag (P7.3).
        l.id === id ? { ...l, tileUrl, expired: false, ...(name ? { name } : {}) } : l
      ),
    })),
  setLayerExpired: (id, expired) =>
    set((state) => ({
      layers: state.layers.map((l) => (l.id === id ? { ...l, expired } : l)),
    })),

  // Tool status
  toolCalls: [],
  addToolCall: (toolCall) =>
    set((state) => {
      const stamped = { ...toolCall, startedAt: toolCall.startedAt ?? Date.now() }
      const existing = state.toolCalls.find((t) => t.toolName === toolCall.toolName)
      if (existing) {
        return {
          toolCalls: state.toolCalls.map((t) =>
            t.toolName === toolCall.toolName ? stamped : t
          ),
        }
      }
      return { toolCalls: [...state.toolCalls, stamped] }
    }),
  updateToolCall: (toolName, status, errorText, verdict, resultId) =>
    set((state) => {
      // Resolve ONE call — the oldest still-running instance of this tool — not
      // every entry that shares its name. A query can run the same tool twice
      // (two NDVI reads for a change comparison, say); marking them all complete
      // on the first result made the second one's chip finish before the tool
      // did, and left the pair's status unable to disagree.
      const target = state.toolCalls.findIndex(
        (t) => t.toolName === toolName && t.status === 'running',
      )
      // No running instance (a duplicate or out-of-order event) — fall back to
      // the last one with this name so the update is never silently dropped.
      const idx = target !== -1
        ? target
        : state.toolCalls.map((t) => t.toolName).lastIndexOf(toolName)
      if (idx === -1) return {}

      return {
        toolCalls: state.toolCalls.map((t, i) =>
          i === idx
            ? {
                ...t,
                status,
                ...(errorText ? { errorText } : {}),
                ...(verdict ? { verdict } : {}),
                ...(resultId ? { resultId } : {}),
                ...(status !== 'running' && t.startedAt != null && t.durationMs == null
                  ? { durationMs: Date.now() - t.startedAt }
                  : {}),
              }
            : t
        ),
      }
    }),
  clearToolCalls: () => set({ toolCalls: [] }),

  // Agent plan (P4.1). The server sends the FULL cumulative step list on each
  // `plan`/`replan` event, so we merge by index — preserving the status of
  // steps that already ran (e.g. across a replan) and queuing the new ones.
  currentPlan: null,
  setPlan: (incoming, kind) =>
    set((state) => {
      const prev = state.currentPlan?.steps ?? []
      const steps: PlanStepState[] = incoming.map((s, i) => ({
        tool: s.tool,
        args: s.args,
        reason: s.reason,
        depends_on: s.depends_on,
        parallel_group: s.parallel_group,
        status:
          i < prev.length && prev[i].tool === s.tool ? prev[i].status : 'queued',
      }))
      return { currentPlan: { steps, replanning: kind === 'replan' } }
    }),
  updatePlanStep: (index, status) =>
    set((state) => {
      if (!state.currentPlan) return {}
      const steps = state.currentPlan.steps.map((s, i) =>
        i === index ? { ...s, status } : s,
      )
      return { currentPlan: { ...state.currentPlan, steps } }
    }),
  clearPlan: () => set({ currentPlan: null }),

  // Tool results (P4.2) — keyed by result_id; cleared on each new query.
  toolResults: {},
  addToolResult: (result) =>
    set((state) => ({
      toolResults: { ...state.toolResults, [result.resultId]: result },
    })),
  clearToolResults: () => set({ toolResults: {} }),
  ledgerRunIds: [],
  addLedgerRunId: (id) => {
    rememberRun(id, get().lastQuery)
    set((state) => ({ ledgerRunIds: state.ledgerRunIds.includes(id) ? state.ledgerRunIds : [...state.ledgerRunIds, id] }))
  },
  charts: [],
  addChart: (chart) =>
    set((state) => ({ charts: [...state.charts.filter((c) => c.id !== chart.id), chart] })),
  clearCharts: () => set({ charts: [] }),
  highlight: null,
  setHighlight: (highlight) => set({ highlight }),

  // Connection
  isConnected: false,
  setConnected: (connected) => set({ isConnected: connected }),

  // Loading
  isLoading: false,
  setLoading: (loading) => set({ isLoading: loading }),

  // P7.3 — retry support
  lastQuery: null,
  setLastQuery: (q) => set({ lastQuery: q }),
  agentError: null,
  setAgentError: (msg) => set({ agentError: msg }),

  // Map style: the basemap in effect. AppShell derives it from the theme and the basemap choice,
  // so it starts neutral and is never taken from a saved project.
  mapStyle: 'dark',
  setMapStyle: (style) => set({ mapStyle: style }),

  // Temporal frames
  temporalFrames: [],
  addTemporalFrame: (frame) =>
    set((state) => ({ temporalFrames: [...state.temporalFrames, frame] })),
  clearTemporalFrames: () => set({ temporalFrames: [], activeFrameIndex: 0 }),
  activeFrameIndex: 0,
  setActiveFrameIndex: (index) => set({ activeFrameIndex: index }),

  // Session stats
  sessionStartTime: null,
  setSessionStartTime: (time) => set({ sessionStartTime: time }),
  queryCount: 0,
  incrementQueryCount: () =>
    set((state) => ({ queryCount: state.queryCount + 1 })),
  completedToolCount: 0,
  incrementCompletedToolCount: () =>
    set((state) => ({ completedToolCount: state.completedToolCount + 1 })),

  // Fly-to target
  flyToTarget: null,
  setFlyToTarget: (target) => set({ flyToTarget: target }),

  // P4.3 — clicked-point focus
  pointFocus: null,
  setPointFocus: (p) => set({ pointFocus: p }),

  // Keyboard shortcuts
  showShortcuts: false,
  setShowShortcuts: (show) => set({ showShortcuts: show }),

  // Map fullscreen
  isMapFullscreen: false,
  setMapFullscreen: (v) => set({ isMapFullscreen: v }),

  // Selected feature
  selectedFeatureIndex: null,
  setSelectedFeatureIndex: (index) => set({ selectedFeatureIndex: index }),

  // Zoom to feature
  zoomToFeature: null,
  setZoomToFeature: (target) => set({ zoomToFeature: target }),

  // Analysis stage
  analysisStage: 'idle',
  setAnalysisStage: (stage) =>
    set((state) => ({
      analysisStage: stage,
      // Capture the current stage when error occurs
      ...(stage === 'error' && state.analysisStage !== 'error'
        ? { errorAtStage: state.analysisStage }
        : {}),
      // Clear errorAtStage when leaving error/idle
      ...(stage !== 'error' && stage !== 'idle' ? { errorAtStage: null } : {}),
    })),

  // Stage at which error occurred
  errorAtStage: null,
  setErrorAtStage: (stage) => set({ errorAtStage: stage }),

  // App version
  appVersion: APP_VERSION,

  // Session reset
  resetSession: () =>
    set({
      messages: [],
      runNotice: null,
      thinkingTokens: [],
      layers: [],
      toolCalls: [],
      currentPlan: null,
      toolResults: {},
      ledgerRunIds: [],
      charts: [],
      highlight: null,
      temporalFrames: [],
      activeFrameIndex: 0,
      // P7.3 — clear any lingering retry banner state on a fresh session.
      agentError: null,
      lastQuery: null,
      sessionStartTime: null,
      queryCount: 0,
      completedToolCount: 0,
      aoi: null,
      isMapFullscreen: false,
      selectedFeatureIndex: null,
      zoomToFeature: null,
      flyToTarget: null,
      pointFocus: null,
      analysisStage: 'idle',
      errorAtStage: null,
      streamingContent: '',
      fitBoundsTarget: null,
      currentProjectId: null,
      projectName: null,
      previewMode: false,
      previewMeta: null,
      // chatHistory is intentionally preserved
    }),

  // P6.1 — saved projects
  currentProjectId: null,
  setCurrentProjectId: (id) => set({ currentProjectId: id }),
  projectName: null,
  setProjectName: (projectName) => set({ projectName }),
  loadProject: (project, opts) =>
    set(() => {
      // Re-seed the citation store so a restored message's `[[id#key]]` pills
      // resolve: snapshot each message's captured toolResults, then fold in any
      // layer that carries its producing result (P4.2/P4.4 linkage).
      const toolResults: Record<string, CitableToolResult> = {}
      for (const m of project.messages) {
        if (m.toolResults) Object.assign(toolResults, m.toolResults)
      }
      for (const l of project.layers) {
        if (l.resultId && l.tool && l.summaryData && !toolResults[l.resultId]) {
          toolResults[l.resultId] = {
            resultId: l.resultId,
            tool: l.tool,
            summaryData: l.summaryData,
            provenance: l.provenance,
            confidence: l.confidence,
          }
        }
      }
      const preview = opts?.preview ?? null
      return {
        // In preview the viewer doesn't own the project — keep currentProjectId
        // null so "Update current" can't target someone else's row; forking
        // mints a fresh owner-scoped copy.
        currentProjectId: preview ? null : project.id,
        previewMode: !!preview,
        previewMeta: preview,
        aoi: project.aoi,
        layers: project.layers,
        messages: project.messages,
        toolResults,
        // Clear transient/streaming state so the restored session is clean.
        streamingContent: '',
        thinkingTokens: [],
        toolCalls: [],
        currentPlan: null,
        temporalFrames: [],
        activeFrameIndex: 0,
        analysisStage: 'idle',
        errorAtStage: null,
        pointFocus: null,
        isLoading: false,
      }
    }),

  // P6.2 — read-only share preview
  previewMode: false,
  previewMeta: null,
  exitPreview: () => set({ previewMode: false, previewMeta: null }),

  // Settings
  notifications: [],
  unreadCount: 0,
  addNotification: (notification) =>
    set((state) => {
      const next: Notification = {
        ...notification,
        id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: Date.now(),
        // Routine run events (a step started or finished, a layer arrived) are listed but are not
        // "unread": the badge counts only what needs the person (errors).
        read: notification.type !== 'system',
      }
      const notifications = [next, ...state.notifications].slice(0, 50)
      return { notifications, unreadCount: notifications.filter((n) => !n.read).length }
    }),
  markNotificationRead: (id) =>
    set((state) => {
      const notifications = state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n))
      return { notifications, unreadCount: notifications.filter((n) => !n.read).length }
    }),
  clearNotifications: () => set({ notifications: [], unreadCount: 0 }),

  settings: DEFAULT_SETTINGS,
  updateSettings: (updates) =>
    set((state) => {
      const newSettings = { ...state.settings, ...updates }
      writeJson(STORAGE_KEYS.settings, newSettings)
      return { settings: newSettings }
    }),

  // Command palette
  commandPaletteOpen: false,
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),

  // Settings panel open state
  settingsPanelOpen: false,
  setSettingsPanelOpen: (open) => set({ settingsPanelOpen: open }),

  // Pinned messages
  pinnedMessageIds: [],
  pinMessage: (id) =>
    set((state) => {
      if (state.pinnedMessageIds.includes(id)) return state
      const newPinned = [...state.pinnedMessageIds, id]
      writeJson(STORAGE_KEYS.pinnedMessages, newPinned)
      return { pinnedMessageIds: newPinned }
    }),
  unpinMessage: (id) =>
    set((state) => {
      const newPinned = state.pinnedMessageIds.filter((pid) => pid !== id)
      writeJson(STORAGE_KEYS.pinnedMessages, newPinned)
      return { pinnedMessageIds: newPinned }
    }),

  // Active TerraDraw mode
  activeDrawMode: null,
  setActiveDrawMode: (mode) => set({ activeDrawMode: mode }),

  // Streaming content
  streamingContent: '',
  appendStreamingContent: (chunk) =>
    set((state) => ({ streamingContent: state.streamingContent + chunk })),
  clearStreamingContent: () => set({ streamingContent: '' }),
  mergeStreamingToMessages: () =>
    set((state) => {
      if (!state.streamingContent) return {}
      const messages = [...state.messages]
      const lastIdx = messages.findLastIndex((m) => m.role === 'assistant')
      if (lastIdx >= 0) {
        // Snapshot the tool results so this message's citation pills stay
        // resolvable after the next query clears the live slice (P4.2).
        messages[lastIdx] = {
          ...messages[lastIdx],
          content: state.streamingContent,
          toolResults: { ...state.toolResults },
          ...(state.charts.length ? { charts: [...state.charts] } : {}),
        }
      }
      return { messages, streamingContent: '' }
    }),

  // fitBounds target
  fitBoundsTarget: null,
  setFitBoundsTarget: (bbox) => set({ fitBoundsTarget: bbox }),

  // 3D terrain — default off
  terrainEnabled: false,
  setTerrainEnabled: (enabled) => set({ terrainEnabled: enabled }),
  terrainExaggeration: 1.4,
  setTerrainExaggeration: (value) => set({ terrainExaggeration: value }),

  // Globe projection — default mercator (flat)
  projection: 'mercator',
  setProjection: (projection) =>
    set((state) => ({
      projection,
      // Globe reads better with the atmosphere on; turning it back to mercator
      // doesn't force sky off (terrain users may still want it).
      ...(projection === 'globe' && !state.skyEnabled ? { skyEnabled: true } : {}),
    })),

  // Sky / atmosphere — default off (subtle, opt-in)
  skyEnabled: false,
  setSkyEnabled: (enabled) => set({ skyEnabled: enabled }),

  // Map snapshot provider — populated by MapPanel on mount, cleared on unmount.
  mapSnapshotProvider: null,
  setMapSnapshotProvider: (provider) => set({ mapSnapshotProvider: provider }),
}))
