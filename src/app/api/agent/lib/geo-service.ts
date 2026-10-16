/** Client for the Python geo service (services/geo): cloud-masked composites, time series, zonal stats.
 *
 *  Honesty contract: a failed upstream fetch is a typed `GeoServiceError` with
 *  `kind: 'fetch_failed'`, never an empty result; "no scenes" comes back as a normal response with
 *  `item_count: 0`, `id: null` and an explicit `message`. */

import { Agent } from 'undici'

import { geoAuthHeaders } from './geo-auth'

export type GeoErrorKind =
  | 'not_configured' // GEO_SERVICE_URL unset
  | 'fetch_failed' // service answered 502: Earth Search / COG read failed upstream
  | 'bad_request' // 422
  | 'insufficient_history' // 422: forecast refused, history too short or too sparse (a refusal, not a failure)
  | 'too_large' // 413
  | 'not_found' // 404 (e.g. composite id evicted from the cache)
  | 'timeout' // no answer within the client timeout
  | 'unreachable' // network error talking to the service itself
  | 'http_error' // anything else non-2xx

export class GeoServiceError extends Error {
  constructor(
    public readonly kind: GeoErrorKind,
    public readonly detail: string,
    public readonly status?: number,
  ) {
    super(`geo-service ${kind}: ${detail}`)
    this.name = 'GeoServiceError'
  }
  /** True when the data source (not our request) failed: report "fetch failed", not "no data". */
  get isUpstreamFailure(): boolean {
    return this.kind === 'fetch_failed' || this.kind === 'timeout' || this.kind === 'unreachable'
  }
}

export interface GeoAoi {
  /** [west, south, east, north], EPSG:4326. Provide exactly one of bbox / geometry. */
  bbox?: [number, number, number, number]
  geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon
}

interface SearchParams extends GeoAoi {
  start: string // YYYY-MM-DD
  end: string // YYYY-MM-DD, inclusive
  collection?: 'sentinel-2-l2a'
  /** Scene-level eo:cloud_cover upper bound (%). Pixel masking happens regardless. */
  max_cloud?: number
  /** Metres. Service default 10. */
  resolution?: number
  /** SCL classes treated as clear. Service default [4,5,6,7,11]. */
  scl_keep?: number[]
}

/** Provide exactly one of `bands` (Earth Search keys or B02..B12) or `expression` (NDVI|NDWI|NDBI|EVI|NBR|SAVI or a formula). */
export type CompositeRequest = SearchParams & ({ bands: string[]; expression?: never } | { expression: string; bands?: never })

export interface BandStats {
  min: number | null
  max: number | null
  mean: number | null
  p2: number | null
  p98: number | null
  n: number
}

export interface CompositeResponse {
  /** null when nothing was produced (no scenes, or everything masked); see `message`. */
  id: string | null
  items: string[]
  item_count: number
  valid_pixel_pct: number | null
  message: string | null
  cached: boolean
  scene_days?: number
  bands?: string[]
  expression?: string | null
  stats?: Record<string, BandStats>
  valid_obs_per_pixel?: { mean: number; min: number; max: number }
  bounds?: [number, number, number, number]
  crs?: string
  resolution?: number
  scl_keep?: number[]
  created?: string
  tile_url_template?: string
  download_url?: string
}

export type TimeseriesRequest = SearchParams & { interval?: 'scene' | 'month' } &
  ({ band: string; expression?: never } | { expression: string; band?: never })

export interface TimeseriesPoint {
  /** YYYY-MM-DD (solar day) for interval=scene, YYYY-MM for interval=month. */
  date: string
  item_ids: string[]
  n_scenes?: number
  /** null when no AOI pixel was clear on that date (never 0). */
  mean: number | null
  median: number | null
  valid_pct: number
  n_valid: number
}

export interface TimeseriesResponse {
  series: TimeseriesPoint[]
  interval: 'scene' | 'month'
  item_count: number
  items: string[]
  message: string | null
  band?: string
  expression?: string | null
}

export type ZonalStat = 'mean' | 'median' | 'min' | 'max' | 'sum' | 'count' | 'stdev' | 'variance' | 'valid_pct'

export interface ZonalRequest {
  features: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>
  /** Composite id from `composite()`. */
  source: string
  stats?: ZonalStat[]
}

export interface ZonalResponse {
  source: string
  bands: string[]
  feature_count: number
  results: Array<{
    index: number
    id: string | number | null
    properties: Record<string, unknown>
    /** band -> stat -> value (null when no valid pixel). */
    stats: Record<string, Partial<Record<ZonalStat, number | null>>>
  }>
  note: string
}

export interface CallOptions {
  /** Default 120 s: a cold composite over ~10 scenes takes ~10-15 s; long ranges take longer. */
  timeoutMs?: number
  signal?: AbortSignal
}

export function geoServiceUrl(): string | null {
  const u = process.env.GEO_SERVICE_URL?.trim()
  return u ? u.replace(/\/+$/, '') : null
}

export function isGeoServiceConfigured(): boolean {
  return geoServiceUrl() !== null
}

/** fetch's default dispatcher gives up waiting for response headers after 300 s, but a cold
 *  5-year series or forecast can take longer. The call's own AbortSignal is the timeout. */
const longCallDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 })

const KIND_BY_ERROR: Record<string, GeoErrorKind> = {
  fetch_failed: 'fetch_failed',
  bad_request: 'bad_request',
  insufficient_history: 'insufficient_history',
  too_large: 'too_large',
  not_found: 'not_found',
}

async function call<T>(method: 'GET' | 'POST', path: string, body: unknown, opts: CallOptions = {}): Promise<T> {
  const base = geoServiceUrl()
  if (!base) throw new GeoServiceError('not_configured', 'GEO_SERVICE_URL is not set')
  const timeoutMs = opts.timeoutMs ?? 120_000
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout
  const auth = await geoAuthHeaders()
  if (auth === null) throw new GeoServiceError('unreachable', 'could not get a Google ID token for the geo service (GEO_SERVICE_AUDIENCE is set)')
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { ...auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      // @ts-expect-error -- Node's fetch accepts an undici dispatcher; the DOM RequestInit type does not list it.
      dispatcher: longCallDispatcher,
    })
  } catch (e) {
    if (timeout.aborted) throw new GeoServiceError('timeout', `no response within ${timeoutMs} ms`)
    if (opts.signal?.aborted) throw e
    throw new GeoServiceError('unreachable', e instanceof Error ? e.message : String(e))
  }
  const text = await res.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  if (!res.ok) {
    const j = (json ?? {}) as { error?: string; detail?: unknown }
    const detail = typeof j.detail === 'string' ? j.detail : text.slice(0, 300) || res.statusText
    throw new GeoServiceError(KIND_BY_ERROR[j.error ?? ''] ?? 'http_error', detail, res.status)
  }
  if (json === undefined) throw new GeoServiceError('http_error', 'non-JSON response from geo service', res.status)
  return json as T
}

/** Cloud-masked median composite (SCL-masked, clipped to the AOI), persisted as a COG by the service. */
export function composite(req: CompositeRequest, opts?: CallOptions): Promise<CompositeResponse> {
  return call('POST', '/composite', req, opts)
}

/** Per-scene or per-month masked mean/median/valid_pct over the AOI. */
export function timeseries(req: TimeseriesRequest, opts?: CallOptions): Promise<TimeseriesResponse> {
  return call('POST', '/timeseries', req, opts)
}

/** Per-feature statistics of a previously computed composite (exactextract, coverage-weighted). */
export function zonal(req: ZonalRequest, opts?: CallOptions): Promise<ZonalResponse> {
  return call('POST', '/zonal', req, opts)
}

export interface ForecastModel {
  /** `google/timesfm-2.5-200m-pytorch` or `monthly-climatology`. */
  id: string
  /** Hugging Face commit sha of the weights (TimesFM) or the method version. */
  revision: string
  method: 'timesfm' | 'climatology'
  license: string
  load_s?: number | null
  infer_s?: number | null
}

/** Measured accuracy of the method on the committed backtest (eval/RESULTS.md); null when never measured. */
export interface BacktestRef {
  reference: string
  coverage_p10_p90_pct: number
  mae_lead3: number
  mae_lead1?: number
  n: number
  aois: number
}

export interface SeriesProvenance {
  item_count: number
  items_digest: string
  first_item: string | null
  last_item: string | null
  skipped_unreadable_items: number
}

export interface HistoryPoint {
  month: string
  /** null = no clear observation and not filled (gap longer than 2 months). */
  value: number | null
  valid_pct: number
  /** Filled by linear interpolation across a gap of at most 2 months: NOT an observation. */
  imputed: boolean
}

export interface ForecastTiming {
  fetch_s: number
  total_s: number
  model_load_s?: number | null
  inference_s?: number | null
}

export type ForecastRequest = GeoAoi & {
  expression?: string
  history_start: string
  history_end: string
  horizon_months?: number
  interval?: 'month'
  resolution?: number
}

export interface ForecastResponse {
  expression: string | null
  band: string
  history: HistoryPoint[]
  forecast: Array<{ month: string; p10: number; p50: number; p90: number }>
  kind: 'forecast'
  note: string
  model: ForecastModel & { backtest?: BacktestRef | null }
  imputed_months: string[]
  unfilled_gap_months: number
  history_trimmed_from: string | null
  warnings: string[]
  provenance: SeriesProvenance
  timing: ForecastTiming
  backtest: BacktestRef | null
}

export type AnomalyRequest = GeoAoi & {
  expression?: string
  /** YYYY-MM */
  target_month: string
  history_years?: number
  resolution?: number
}

export type AnomalyVerdict = 'within_expected' | 'below_expected' | 'above_expected' | 'cannot_determine'

export interface AnomalyResponse {
  expression: string | null
  band: string
  kind: 'anomaly'
  target_month: string
  history_years: number
  observed: number | null
  observed_valid_pct: number
  observed_n_scenes?: number
  expected_p10: number | null
  expected_p50: number | null
  expected_p90: number | null
  /** (observed - p50) / sigma, sigma from the p10-p90 width; |score| > 1.28 = outside the 80% range. */
  score: number | null
  verdict: AnomalyVerdict
  reason: string | null
  warnings: string[]
  history: HistoryPoint[]
  imputed_months: string[]
  model: ForecastModel & { backtest?: BacktestRef | null }
  provenance: SeriesProvenance
  timing: ForecastTiming
  backtest: BacktestRef | null
}

/** Monthly forecast with p10/p50/p90. Refuses (422 `insufficient_history`) on short or sparse history. */
export function forecast(req: ForecastRequest, opts?: CallOptions): Promise<ForecastResponse> {
  return call('POST', '/forecast', req, { timeoutMs: 1_200_000, ...opts })
}

/** Observed month vs the range expected from the history before it. */
export function anomaly(req: AnomalyRequest, opts?: CallOptions): Promise<AnomalyResponse> {
  return call('POST', '/anomaly', req, { timeoutMs: 1_200_000, ...opts })
}
