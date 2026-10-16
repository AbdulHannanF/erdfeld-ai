/** Dataset readers (registry stage 2): one reader per access kind, one interface.
 *
 *  `read(entry, aoi, opts)` either returns real numbers (and a map layer) computed over
 *  the AOI polygon, or says exactly why it cannot: credentials missing, a service that
 *  does not exist here yet, or no data over the AOI. It never returns a made-up figure.
 */

import type { Provenance, ResultLayer, SummaryDatum, ToolOutput } from '../../types'
import type { DatasetEntry } from '../types'

/** The drawn area, in the shape every tool already receives (`ToolCtx`). */
export interface ReaderAoi {
  /** GeoJSON Polygon / MultiPolygon (or a Feature wrapping one). */
  aoi: any
  bbox: [number, number, number, number]
  centroid: { lat: number; lng: number }
  areaKm2: number
}

export interface ReadOpts {
  /** Band / asset / variable name, e.g. "vv", "NDVI", "height". */
  variable?: string
  /** Target date (YYYY-MM-DD): the item closest to it is chosen. */
  date?: string
  start?: string
  end?: string
  /** Build a map layer (default true). */
  render?: boolean
  /** DEMs: also add a hillshade layer. */
  hillshade?: boolean
  /** Lets REST entries run the existing dedicated tools. */
  runTool?: (name: string, args: Record<string, any>) => Promise<ToolOutput>
}

/** ok = real numbers; auth_required / unavailable = a known, stated limitation;
 *  no_coverage = the dataset has nothing over this AOI/time; error = the read failed. */
export type ReadStatus = 'ok' | 'auth_required' | 'unavailable' | 'no_coverage' | 'error'

export interface ClassRow { value: number; name: string; count: number; pct: number }

export interface ReadStats {
  kind: 'continuous' | 'categorical' | 'vector' | 'metadata'
  variable?: string
  unit?: string
  /** Valid pixels (or features) behind the figures. */
  count?: number
  mean?: number
  median?: number
  std?: number
  min?: number
  max?: number
  p2?: number
  p5?: number
  p95?: number
  p98?: number
  classes?: ClassRow[]
  [extra: string]: unknown
}

export interface CoverageInfo {
  /** covered = data found over the AOI; partial = some of it; none = nothing; unknown = not checked. */
  verdict: 'covered' | 'partial' | 'none' | 'unknown'
  /** What the registry entry declares (bbox / time / US-only note). */
  declared: string
  /** What was actually found (items, % of the AOI with valid pixels). */
  found: string
  items_matched?: number
  /** % of the polygon with valid data, when measured. */
  aoi_valid_pct?: number | null
}

export interface ReadResult {
  status: ReadStatus
  /** Markdown the agent relays. Always states the dataset, the date and the limits. */
  summary: string
  stats: ReadStats | null
  layer?: ResultLayer
  layers?: ResultLayer[]
  summary_data: Record<string, SummaryDatum>
  provenance: Provenance | null
  coverage: CoverageInfo
  /** REST entries: the dedicated tool's own result, returned untouched. */
  passthrough?: ToolOutput
  /** Env var / service the read is waiting for (machine-readable). */
  needs?: string
}

export type Reader = (entry: DatasetEntry, aoi: ReaderAoi, opts: ReadOpts) => Promise<ReadResult>
