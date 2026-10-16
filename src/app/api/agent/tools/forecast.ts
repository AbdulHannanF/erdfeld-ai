/** forecast_index / detect_anomaly — expected-vs-observed NDVI (or another index) from a monthly
 *  Sentinel-2 series, computed by the Python geo service (services/geo/app/forecast.py).
 *
 *  Honesty contract: a forecast is never presented as an observation. Every expected value is a
 *  p10-p50-p90 range, the history that fed it is described (gaps, interpolated months), the model id
 *  and weights revision are recorded, and the accuracy claim is the BACKTEST coverage, not a promise.
 *  Too little history is a refusal with the reason; a failed fetch is `failed`, never "no data".
 */

import { validateVegaLite } from '../lib/chart-data'
import { genId } from '../lib/geometry'
import { anomaly, forecast, GeoServiceError, type AnomalyResponse, type BacktestRef, type ForecastResponse, type HistoryPoint } from '../lib/geo-service'
import { getLogger } from '../lib/logger'
import { toGeometry } from '../lib/pixels'
import { roundSig } from '../lib/raster-render'
import type { SummaryDatum, ToolCtx, ToolOutput } from '../lib/types'
import type { ChartItem } from '@/lib/chart-spec'

const log = getLogger('tools/forecast')

export const FORECAST_INDICES = ['NDVI', 'NDWI', 'NDBI', 'EVI', 'NBR', 'SAVI'] as const
export const MAX_HORIZON_MONTHS = 12
export const MIN_HISTORY_MONTHS = 36
export const MAX_HISTORY_MONTHS = 144
export const DEFAULT_HISTORY_MONTHS = 60
/** Imputed (interpolated) share of the history above which the result carries a warning. */
export const IMPUTED_WARN_FRACTION = 0.1
/** First month the service reads reliably (earlier Earth Search scenes are mostly unreadable JP2). */
export const FORECAST_EARLIEST_MONTH = '2017-01'
const SOURCE = 'Sentinel-2 L2A (AWS Element84 Earth Search), SCL-masked monthly median series via the geo service'

export interface ForecastArgs { expression?: string; start?: string; end?: string; horizon_months?: number }
export interface AnomalyArgs { expression?: string; month: string; history_years?: number }

// ---------------------------------------------------------------- months
const ym = (d: Date) => d.toISOString().slice(0, 7)
export const addMonths = (m: string, k: number): string => {
  const i = Number(m.slice(0, 4)) * 12 + (Number(m.slice(5, 7)) - 1) + k
  return `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`
}
export const monthDiff = (a: string, b: string): number => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)))
export const lastCompleteMonth = (now = Date.now()): string => addMonths(ym(new Date(now)), -1)
const lastDayOf = (m: string): string => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10)

/** The history window: given dates, else the last 60 complete months. */
export function resolveForecastWindow(args: Pick<ForecastArgs, 'start' | 'end'>, now = Date.now()): { start: string; end: string } {
  const end = args.end ?? lastDayOf(lastCompleteMonth(now))
  const start = args.start ?? `${addMonths(end.slice(0, 7), -(DEFAULT_HISTORY_MONTHS - 1))}-01`
  return { start, end }
}

// ---------------------------------------------------------------- shared pieces
const upstream = (e: unknown) => (e instanceof GeoServiceError ? e : null)

/** Service errors -> an honest output. Refusals (bad request, too little history, too large) are
 *  `refused` with the reason; an unreadable data source is `failed`. */
function errorOutput(what: string, e: unknown): ToolOutput {
  const err = upstream(e)
  log.warn({ err: err ? `${err.kind}: ${err.detail}` : String(e) }, `${what} failed`)
  if (err && !err.isUpstreamFailure) {
    const why = err.kind === 'insufficient_history'
      ? `the history is too short or too sparse to ${what === 'detect_anomaly' ? 'say what was expected' : 'forecast honestly'}: ${err.detail}`
      : `the geo service refused the request (${err.kind}: ${err.detail})`
    return { summary: `**${what} did not produce a ${what === 'detect_anomaly' ? 'verdict' : 'forecast'}:** ${why}. Nothing was guessed; ${err.kind === 'insufficient_history' ? 'a longer or less cloudy history, or another area, is needed' : 'adjust the request and retry'}.`, refused: true }
  }
  const why = err ? `${err.kind}: ${err.detail}` : e instanceof Error ? e.message : String(e)
  return { summary: `**Could not read the Sentinel-2 history for ${what}** (${why}). This is a fetch failure of the imagery source or the geo service, not an absence of data. Retry shortly.`, failed: true }
}

/** What "confidence" means here: the backtest coverage of the shipped method, degraded by gappy input.
 *  Never `high`: this is a forecast. */
export function forecastConfidence(bt: BacktestRef | null | undefined, imputedFraction: number): 'medium' | 'low' {
  if (!bt) return 'low'
  const calibrated = bt.coverage_p10_p90_pct >= 70 && bt.coverage_p10_p90_pct <= 90
  return calibrated && imputedFraction <= IMPUTED_WARN_FRACTION ? 'medium' : 'low'
}

const r3 = (v: number) => roundSig(v, 3)
const monthDate = (m: string) => `${m}-01`

function modelLine(m: ForecastResponse['model']): string {
  if (m.method === 'climatology') return 'monthly climatology (mean of the same calendar month in earlier years, t-based 80% prediction interval; chosen because it beat TimesFM 2.5 on our backtest)'
  const t = m.method === 'timesfm' ? ` (load ${m.load_s ?? '?'} s, inference ${m.infer_s ?? '?'} s on CPU)` : ''
  return `${m.id} @ ${m.revision.slice(0, 12)} (${m.license})${t}`
}

function backtestLine(bt: BacktestRef | null | undefined): string {
  return bt
    ? `Backtest (${bt.aois} AOIs, ${bt.n} rolling-origin forecasts 2023-2025): the p10-p90 range held the observed value ${bt.coverage_p10_p90_pct}% of the time (target 80%), 3-month-ahead NDVI MAE ${bt.mae_lead3}; see ${bt.reference}.`
    : 'No backtest is recorded for this method, so the range is uncalibrated: treat it as indicative only.'
}

const SCHEMA = 'https://vega.github.io/schema/vega-lite/v5.json'
const C_HIST = '#64748b'
const C_FC = '#2563eb'
const C_OBS = '#dc2626'
const xAxis = { title: null, format: '%b %Y' }

function checked(spec: Record<string, any>, title: string): ChartItem | null {
  const v = validateVegaLite(spec)
  if (!v.ok) {
    log.warn({ error: v.error }, 'forecast chart rejected')
    return null
  }
  return { id: `chart-${genId()}`, title, spec }
}

/** History line (observed months solid, interpolated ones hollow), p10-p90 band, p50 line. */
export function forecastChart(index: string, history: HistoryPoint[], fc: ForecastResponse['forecast']): ChartItem | null {
  const hist = history.filter((h) => h.value != null).map((h) => ({ month: monthDate(h.month), value: h.value, kind: h.imputed ? 'Interpolated (gap <= 2 months)' : 'Observed' }))
  const rows = fc.map((f) => ({ month: monthDate(f.month), p10: f.p10, p50: f.p50, p90: f.p90 }))
  if (hist.length < 2 || rows.length < 1) return null
  const x = { field: 'month', type: 'temporal', axis: xAxis }
  const y = (field: string, title?: string) => ({ field, type: 'quantitative', scale: { zero: false }, axis: { title: title ?? null } })
  const spec = {
    $schema: SCHEMA,
    data: { values: [] },
    layer: [
      { data: { values: hist }, mark: { type: 'line', color: C_HIST, strokeWidth: 1.5 }, encoding: { x, y: y('value', index) } },
      {
        data: { values: hist.filter((h) => h.kind !== 'Observed') },
        mark: { type: 'point', color: C_HIST, filled: false, size: 40 },
        encoding: { x, y: y('value', index), tooltip: [{ field: 'month', type: 'temporal', title: 'Month' }, { field: 'value', type: 'quantitative', title: 'Interpolated', format: '.3f' }] },
      },
      {
        data: { values: rows }, mark: { type: 'area', color: C_FC, opacity: 0.2 },
        encoding: { x, y: y('p10', index), y2: { field: 'p90' } },
      },
      {
        data: { values: rows }, mark: { type: 'line', color: C_FC, strokeDash: [5, 3], strokeWidth: 2, point: { filled: true, size: 30 } },
        encoding: {
          x, y: y('p50', index),
          tooltip: [{ field: 'month', type: 'temporal', title: 'Month' }, { field: 'p10', type: 'quantitative', title: 'p10', format: '.3f' }, { field: 'p50', type: 'quantitative', title: 'p50 (forecast)', format: '.3f' }, { field: 'p90', type: 'quantitative', title: 'p90', format: '.3f' }],
        },
      },
    ],
  }
  return checked(spec, `${index}: history and forecast (dashed = forecast median, band = p10-p90)`)
}

/** Recent history, the expected p10-p90 range and median for the target month, and the observed value. */
export function anomalyChart(index: string, a: AnomalyResponse): ChartItem | null {
  const recent = a.history.filter((h) => h.value != null).slice(-36).map((h) => ({ month: monthDate(h.month), value: h.value }))
  if (recent.length < 2 || a.expected_p10 == null || a.expected_p50 == null || a.expected_p90 == null) return null
  const t = monthDate(a.target_month)
  const exp = [{ month: t, p10: a.expected_p10, p50: a.expected_p50, p90: a.expected_p90 }]
  const x = { field: 'month', type: 'temporal', axis: xAxis }
  const y = (field: string, title?: string) => ({ field, type: 'quantitative', scale: { zero: false }, axis: { title: title ?? null } })
  const layer: Record<string, any>[] = [
    { data: { values: recent }, mark: { type: 'line', color: C_HIST, strokeWidth: 1.5 }, encoding: { x, y: y('value', index) } },
    { data: { values: exp }, mark: { type: 'rule', color: C_FC, strokeWidth: 8, opacity: 0.35 }, encoding: { x, y: y('p10', index), y2: { field: 'p90' }, tooltip: [{ field: 'p10', type: 'quantitative', format: '.3f', title: 'Expected p10' }, { field: 'p90', type: 'quantitative', format: '.3f', title: 'Expected p90' }] } },
    { data: { values: exp }, mark: { type: 'tick', color: C_FC, thickness: 2, size: 18 }, encoding: { x, y: y('p50', index), tooltip: [{ field: 'p50', type: 'quantitative', format: '.3f', title: 'Expected median (forecast)' }] } },
  ]
  if (a.observed != null) {
    layer.push({ data: { values: [{ month: t, observed: a.observed }] }, mark: { type: 'point', color: C_OBS, filled: true, size: 90 }, encoding: { x, y: y('observed', index), tooltip: [{ field: 'observed', type: 'quantitative', format: '.3f', title: 'Observed' }] } })
  }
  return checked({ $schema: SCHEMA, data: { values: [] }, layer }, `${index} ${a.target_month}: observed (red) vs expected range (blue, p10-p90)`)
}

// ---------------------------------------------------------------- forecast_index
export async function runForecastIndex(ctx: ToolCtx, args: ForecastArgs): Promise<ToolOutput> {
  const geometry = toGeometry(ctx.aoi)
  if (!geometry) return { summary: 'A polygon AOI is required (draw a polygon, rectangle, or circle).' }
  const index = (args.expression ?? 'NDVI').trim()
  const { start, end } = resolveForecastWindow(args)
  const horizon = args.horizon_months ?? 6
  ctx.emit?.('token', { type: 'token', content: `Reading the monthly ${index} history ${start} to ${end} and forecasting ${horizon} month(s)... (the first run for an area reads years of Sentinel-2 scenes and can take several minutes)\n` })

  let res: ForecastResponse
  try {
    res = await forecast({ geometry, expression: index, history_start: start, history_end: end, horizon_months: horizon, interval: 'month' })
  } catch (e) {
    return errorOutput('forecast_index', e)
  }

  const observedMonths = res.history.filter((h) => h.value != null && !h.imputed).length
  const imputedFraction = res.history.length ? res.imputed_months.length / res.history.length : 0
  const bt = res.backtest ?? res.model.backtest ?? null
  const confidence = forecastConfidence(bt, imputedFraction)
  const first = res.forecast[0]
  const last = res.forecast[res.forecast.length - 1]
  const line = (f: ForecastResponse['forecast'][number]) => `${f.month}: ${r3(f.p50)} (p10 ${r3(f.p10)} to p90 ${r3(f.p90)})`

  const lines = [
    `**Forecast, not an observation.** Expected ${index} over ${ctx.areaKm2.toFixed(1)} km² (drawn polygon) for the next ${res.forecast.length} month(s), as median with an 80% range (p10 to p90):`,
    ...res.forecast.map((f) => `- ${line(f)}`),
    '',
    `**Built from:** ${res.history.length} months of Sentinel-2 history (${res.history[0]?.month} to ${res.history[res.history.length - 1]?.month}): ${observedMonths} months with a clear observation (spatial median of the cloud-masked monthly composite), ${res.imputed_months.length} month(s) interpolated${res.imputed_months.length ? ` (${res.imputed_months.join(', ')}; gaps of at most 2 months only)` : ''}${res.unfilled_gap_months ? `, ${res.unfilled_gap_months} month(s) in longer gaps left unfilled` : ''}. ${res.provenance.item_count} scenes.`,
    `**Model:** ${modelLine(res.model)}.`,
    `**Calibration:** ${backtestLine(bt)} The range is an expectation, not a guarantee; weather, harvest or land-use change can leave it.`,
  ]
  for (const w of res.warnings) lines.push(`- ${w}`)

  const summary_data: Record<string, SummaryDatum> = {
    history_months: res.history.length,
    observed_months: observedMonths,
    imputed_months: res.imputed_months.length,
    imputed_fraction_pct: Number((imputedFraction * 100).toFixed(1)),
    horizon_months: res.forecast.length,
    first_forecast_month: first.month,
    first_p10: r3(first.p10), first_p50: r3(first.p50), first_p90: r3(first.p90),
    last_forecast_month: last.month,
    last_p10: r3(last.p10), last_p50: r3(last.p50), last_p90: r3(last.p90),
    model_id: res.model.id,
    model_revision: res.model.revision,
    confidence,
    area_km2: Number(ctx.areaKm2.toFixed(1)),
  }
  if (bt) { summary_data.backtest_coverage_pct = bt.coverage_p10_p90_pct; summary_data.backtest_mae_lead3 = bt.mae_lead3 }
  if (res.timing.model_load_s != null) summary_data.model_load_s = res.timing.model_load_s
  if (res.timing.inference_s != null) summary_data.inference_s = res.timing.inference_s

  const chart = forecastChart(index.toUpperCase(), res.history, res.forecast)
  return {
    summary: lines.join('\n'),
    summary_data,
    ...(chart ? { charts: [chart] } : {}),
    provenance_items: [`${res.model.id}@${res.model.revision}`, `s2-items:${res.provenance.items_digest}(${res.provenance.item_count})`],
    sources: [SOURCE, `${res.model.id}@${res.model.revision} (${res.model.license})`],
    uncertainty: {
      notes: [
        'Forecast, not observation: values for months that have not happened are expectations from past seasonality, not measurements.',
        backtestLine(bt),
        ...(res.imputed_months.length ? [`${res.imputed_months.length} history month(s) were linearly interpolated across gaps of at most 2 months and are not observations.`] : []),
        ...res.warnings,
      ],
      ranges: { first_month_p10_p90: [first.p10, first.p90], last_month_p10_p90: [last.p10, last.p90] },
    },
  }
}

// ---------------------------------------------------------------- detect_anomaly
const VERDICT_TEXT: Record<AnomalyResponse['verdict'], string> = {
  within_expected: 'WITHIN the expected range',
  below_expected: 'BELOW the expected range',
  above_expected: 'ABOVE the expected range',
  cannot_determine: 'CANNOT BE DETERMINED',
}

export async function runDetectAnomaly(ctx: ToolCtx, args: AnomalyArgs): Promise<ToolOutput> {
  const geometry = toGeometry(ctx.aoi)
  if (!geometry) return { summary: 'A polygon AOI is required (draw a polygon, rectangle, or circle).' }
  const index = (args.expression ?? 'NDVI').trim()
  const years = args.history_years ?? 5
  ctx.emit?.('token', { type: 'token', content: `Comparing observed ${index} for ${args.month} with the range expected from the ${years} years before... (the first run for an area can take several minutes)\n` })

  let res: AnomalyResponse
  try {
    res = await anomaly({ geometry, expression: index, target_month: args.month, history_years: years })
  } catch (e) {
    return errorOutput('detect_anomaly', e)
  }

  const bt = res.backtest ?? res.model.backtest ?? null
  const imputedFraction = res.history.length ? res.imputed_months.length / res.history.length : 0
  const confidence = forecastConfidence(bt, imputedFraction)
  const sources = [SOURCE, `${res.model.id}@${res.model.revision} (${res.model.license})`]
  const provenance_items = [`${res.model.id}@${res.model.revision}`, `s2-items:${res.provenance.items_digest}(${res.provenance.item_count})`]

  if (res.verdict === 'cannot_determine') {
    const lines = [`**${index} for ${res.target_month}: ${VERDICT_TEXT.cannot_determine}.** ${res.reason ?? ''}`]
    if (res.expected_p50 != null) lines.push(`For reference only, the expected range from the history is ${r3(res.expected_p50)} (p10 ${r3(res.expected_p10!)} to p90 ${r3(res.expected_p90!)}); there is no observation to compare with it.`)
    lines.push('Cannot determine is an answer, not an error: no value was estimated or filled in.')
    const chart = anomalyChart(index.toUpperCase(), res)
    return {
      summary: lines.join('\n'),
      summary_data: { verdict: res.verdict, target_month: res.target_month, history_years: res.history_years, confidence: 'low', model_id: res.model.id, model_revision: res.model.revision, area_km2: Number(ctx.areaKm2.toFixed(1)), ...(res.expected_p50 != null ? { expected_p10: r3(res.expected_p10!), expected_p50: r3(res.expected_p50), expected_p90: r3(res.expected_p90!) } : {}) },
      ...(chart ? { charts: [chart] } : {}),
      provenance_items, sources,
      uncertainty: { notes: [res.reason ?? 'cannot determine', backtestLine(bt), ...res.warnings] },
    }
  }

  const obs = res.observed!
  const lines = [
    `**${index} for ${res.target_month} is ${VERDICT_TEXT[res.verdict]}.**`,
    `- **Observed:** ${r3(obs)} (spatial median of the cloud-masked monthly composite, ${res.observed_valid_pct}% of the AOI clear${res.observed_n_scenes != null ? `, ${res.observed_n_scenes} scene day(s)` : ''}).`,
    `- **Expected** (forecast from the ${res.history_years} years before, not an observation): ${r3(res.expected_p50!)}, 80% range ${r3(res.expected_p10!)} to ${r3(res.expected_p90!)}.`,
    `- **Position:** ${res.score != null ? `${res.score >= 0 ? '+' : ''}${res.score} sigma-equivalent from the expected median (|score| above 1.28 = outside the range)` : 'range too narrow to score'}. A value outside the range is a statement about this history, not by itself proof of a cause.`,
    `**Model:** ${modelLine(res.model)}. **Calibration:** ${backtestLine(bt)}`,
    ...res.warnings.map((w) => `- ${w}`),
  ]
  const chart = anomalyChart(index.toUpperCase(), res)
  const summary_data: Record<string, SummaryDatum> = {
    verdict: res.verdict,
    target_month: res.target_month,
    observed: r3(obs),
    expected_p10: r3(res.expected_p10!), expected_p50: r3(res.expected_p50!), expected_p90: r3(res.expected_p90!),
    history_years: res.history_years,
    imputed_months: res.imputed_months.length,
    imputed_fraction_pct: Number((imputedFraction * 100).toFixed(1)),
    model_id: res.model.id, model_revision: res.model.revision,
    confidence,
    area_km2: Number(ctx.areaKm2.toFixed(1)),
  }
  if (res.score != null) summary_data.score = res.score
  if (bt) { summary_data.backtest_coverage_pct = bt.coverage_p10_p90_pct; summary_data.backtest_mae_lead1 = bt.mae_lead1 ?? bt.mae_lead3 }
  if (res.timing.model_load_s != null) summary_data.model_load_s = res.timing.model_load_s
  if (res.timing.inference_s != null) summary_data.inference_s = res.timing.inference_s
  return {
    summary: lines.join('\n'),
    summary_data,
    ...(chart ? { charts: [chart] } : {}),
    provenance_items, sources,
    uncertainty: {
      notes: [
        'The expected range is a forecast from past seasonality, not an observation; the observed value is the only measurement.',
        backtestLine(bt),
        ...(res.imputed_months.length ? [`${res.imputed_months.length} history month(s) were interpolated across gaps of at most 2 months.`] : []),
        ...res.warnings,
      ],
      ranges: { expected_p10_p90: [res.expected_p10!, res.expected_p90!] },
    },
  }
}
