/** Shared types for the agent's tool layer. */

import type { RasterDescriptor } from '@/lib/raster-style'
import type { ChartItem } from '@/lib/chart-spec'
import type { LegendItem, VectorStyle } from '@/lib/vector-style'

export type Confidence = 'high' | 'medium' | 'low'

export interface Provenance {
  /** Human-readable data source (e.g. "Sentinel-2 L2A + OpenStreetMap"). */
  source: string
  /** ISO date of the most relevant observation, if applicable. */
  date?: string
  /** Short description of the computation method. */
  method: string
  /** Spatial clip applied when computing statistics. */
  clip: 'polygon' | 'bbox' | 'point' | 'centroid' | 'polygon (display mask)'
  /** Honest note about what this data tier can and cannot answer (e.g. "10 m:
   *  functional type only — not species"). Set by the inference gateway via
   *  assessResolution(); the agent quotes it verbatim (Rule 19). */
  resolution_limit?: string
}

/** Continuous gradient palette (NDVI/DEM/thermal/SAR rasters). Stops are anchored
 *  to real values in `[min, max]` so the legend can be drawn from the same data. */
export interface GradientPalette {
  kind: 'gradient'
  stops: Array<{ value: number; color: string; label?: string }>
  min: number
  max: number
  unit?: string
  /** Short label describing the variable (e.g. "NDVI", "Elevation"). */
  label?: string
}

/** Discrete class palette (building type, SAR class, land-cover class). */
export interface ClassesPalette {
  kind: 'classes'
  classes: Array<{ color: string; label: string; value?: string | number }>
  unit?: string
  label?: string
}

export type LayerPalette = GradientPalette | ClassesPalette

export interface ResultLayer {
  id: string
  name: string
  type: 'raster' | 'geojson' | '3dtiles' | 'heatmap'
  tileUrl?: string
  geojson?: any
  bounds?: [number, number, number, number]
  /** For heatmap: name of the feature property carrying the intensity (0..1). */
  intensityProperty?: string
  /** Server-generated PNG as base64. When set, rendered as MapLibre ImageSource (no tile seams). */
  imageBase64?: string
  /** Where the data came from and how it was computed. */
  provenance?: Provenance
  /** How much to trust this layer's values. */
  confidence?: Confidence
  /** Render flag: when 'extrusion' and type==='geojson' with polygons, MapPanel renders as `fill-extrusion`. */
  render?: 'extrusion'
  /** GeoJSON feature property carrying the extrusion height in meters. Defaults to 'height'. */
  heightProperty?: string
  /** Color palette describing how to render the values — used by the LayerLegend component. */
  palette?: LayerPalette
  /** Generic raster descriptor — see `lib/raster-style.ts`. Preferred over `palette` for
   *  tile rasters: the client draws the legend and restyling controls from it. */
  raster?: RasterDescriptor
  /** Hide raster pixels outside the drawn AOI (client draws a world-minus-AOI mask). */
  aoiMask?: boolean
  /** Colour features by a property (graduated / categorical) — see `lib/vector-style.ts`.
   *  The client builds the MapLibre expression and legend from the layer's own data. */
  vectorStyle?: VectorStyle
  /** `false` adds the layer to the map switched off (e.g. a "before" comparison scene). Default on. */
  defaultVisible?: boolean
}

/** A series of labeled numeric points — when a `summary_data` field holds one of
 *  these, the chat auto-renders a small inline bar chart (P4.2). */
export type SummaryArray = Array<{ label: string; value: number }>

/** One citable figure from a tool result. Scalars cite as `[[result_id#key]]`;
 *  arrays additionally auto-chart in the chat. */
export type SummaryDatum = number | string | SummaryArray

/** What a tool implementation returns. The executor (`engine/execute.ts`) turns it into the one
 *  `GeoResult` every consumer sees; tools never build a GeoResult themselves. */
export interface ToolOutput {
  summary: string
  /** Primary layer for the tool. */
  layer?: ResultLayer
  /** Additional layers (e.g. a colored bbox fallback or a DEM bbox under a heatmap).
   *  Emitted alongside the primary layer. */
  layers?: ResultLayer[]
  cv_fallback_recommended?: boolean
  suggested_cv_model?: string
  /** P4.2 — structured figures already present in `summary`, keyed for citation.
   *  Pull values straight from the summary string; never invent new ones. The
   *  agent cites these as `[[<result_id>#<key>]]`; array values auto-chart. */
  summary_data?: Record<string, SummaryDatum>
  /** Vega-Lite charts for this answer (shown in the analysis dashboard and inline in chat).
   *  Built by `make_chart` from this request's own results — never from typed-in numbers. */
  charts?: ChartItem[]
  /** `style_layer` — restyle an EXISTING layer; emitted as a `layer_style` SSE event. */
  layer_style?: { layer_id: string; style: VectorStyle; legend: LegendItem[] }
  /** Ids of the data items actually read (scene ids, dataset ids, release tags). Only what the
   *  tool knows — never guessed. They feed the content hash, so a re-run on a newer scene is a
   *  different result. */
  provenance_items?: string[]
  /** Data sources behind figures that have no layer to carry a `Provenance` (stats-only tools). */
  sources?: string[]
  /** Caveats and ranges beyond what the summary already says. */
  uncertainty?: { notes: string[]; ranges?: Record<string, [number, number]> }
  /** The upstream could not be reached or read. A fetch failure, not an absence of data. */
  failed?: boolean
  /** The operation declined to answer (e.g. history too short to forecast): a refusal with a reason, not a failure. */
  refused?: boolean
}

/** P4.4 — one entry in the "layer memory" manifest: a layer already computed for
 *  the current AOI this session. Sent by the client with each query and rendered
 *  into the system prompt so the agent can reuse the values instead of recomputing.
 *  Mirrors the citable fields of the tool result that produced the layer. */
export interface ManifestLayer {
  result_id: string
  tool: string
  name: string
  provenance?: Provenance
  confidence?: Confidence
  summary_data?: Record<string, SummaryDatum>
  /** Client layer id, so `style_layer` / `make_chart` can address the layer's features. */
  layer_id?: string
  /** Feature properties of the layer (capped), as the client holds them. */
  feature_rows?: Array<Record<string, string | number | boolean | null>>
}

/** What `make_chart` / `style_layer` can resolve by name: every result of this request
 *  plus the reusable layers the client sent. Keyed by `result_id`. */
export interface StoredResult {
  tool: string
  summary_data?: Record<string, SummaryDatum>
  /** Layers with feature properties (index in `rows` = the map feature's id). */
  layers: Array<{ id: string; name: string; rows: Array<Record<string, any>> }>
}
export type ResultStore = Map<string, StoredResult>

/** Callback used by tools to emit SSE events out-of-band (e.g. progress tokens). */
export type EmitFn = (event: string, data: any) => void

/** P4.3 — a clicked map point the agent should focus on. When present, the
 *  dispatcher swaps the AOI for a small circle around this point so tools sample
 *  here, and the prompt biases toward point-friendly tools. */
export interface PointFocus {
  lat: number
  lng: number
  kind: 'point'
}

/** Context shared across every tool invocation — built once per call by the dispatcher. */
export interface ToolCtx {
  aoi: any
  bbox: [number, number, number, number]
  centroid: { lat: number; lng: number }
  areaKm2: number
  emit?: EmitFn
  /** P4.3 — set when the user clicked a point ("what is this?"). Tools that
   *  support point queries read this; the dispatcher also clips the AOI to a
   *  ~200 m circle around it. */
  focus?: PointFocus
  /** Recursive dispatcher — used by digitize_features. */
  runTool: (toolName: string, args: Record<string, any>) => Promise<ToolOutput>
  /** Phase 1 — models available for this request: built-ins + `GEOAGENT_MODELS`
   *  + anything the user registered in Settings, already filtered by the box's
   *  hardware profile. Absent only in legacy call paths that predate it. */
  models?: import('./inference/model-registry').ModelRegistry
  /** Phase 2.5 — the AI provider settings this request already carries, so the
   *  VLM inspection path can reuse a vision-capable provider the user has
   *  configured instead of demanding a second one. Never logged; carries the
   *  user's key. Absent in legacy call paths and in tests. */
  llm?: import('./vision/vlm').RequestLlmConfig
  /** Results addressable by `make_chart` / `style_layer` (absent in legacy call paths). */
  results?: ResultStore
  /** Aborts when the client leaves, the run's time budget ends or this operation exceeds its own
   *  timeout. The executor stops waiting at that point whatever the operation does; passing it to
   *  fetches and loops lets the work stop too. */
  signal?: AbortSignal
}

export type GeomHint = 'Point' | 'LineString' | 'Polygon'
export interface OsmEntry { tags: string[]; geom: GeomHint; color: string; label?: string }
