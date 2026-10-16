/** Forecast and anomaly operations: expected-vs-observed monthly Sentinel-2 index, run by the Python
 *  geo service (services/geo/app/forecast.py). Present only while GEO_SERVICE_URL is configured, like
 *  `composite`. The result is a FORECAST with a p10-p90 range, never an observation. */

import { z } from 'zod'

import type { ValidationCheck } from '@/lib/geo-result'

import { isGeoServiceConfigured } from '../../lib/geo-service'
import {
  FORECAST_EARLIEST_MONTH, FORECAST_INDICES, IMPUTED_WARN_FRACTION, MAX_HISTORY_MONTHS, MAX_HORIZON_MONTHS, MIN_HISTORY_MONTHS,
  addMonths, lastCompleteMonth, monthDiff, resolveForecastWindow, runDetectAnomaly, runForecastIndex,
} from '../../tools/forecast'
import { DAY, HOUR, defineOperation, type AnyOperation } from '../operation'
import { fail, pass, warn } from '../validate'

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const indexCheck = (expression?: string): ValidationCheck[] => {
  const e = expression?.trim()
  // Named indices are checked here; a band-math formula is validated by the service (422 -> refused).
  return e && !(FORECAST_INDICES as readonly string[]).includes(e.toUpperCase()) && /^[A-Za-z]+$/.test(e)
    ? [fail('static', 'expression', `"${e}" is not a supported index. Use one of ${FORECAST_INDICES.join(', ')} or a band-math formula such as "(B08-B04)/(B08+B04)".`)]
    : []
}

const imputedCheck = (output: { summary_data?: Record<string, unknown> }): ValidationCheck[] => {
  const d = output.summary_data
  const pct = d?.imputed_fraction_pct
  if (typeof pct !== 'number') return []
  return pct > IMPUTED_WARN_FRACTION * 100
    ? [warn('dynamic', 'imputed_fraction', `${pct}% of the history months were interpolated across gaps (warn above ${IMPUTED_WARN_FRACTION * 100}%): the forecast leans on filled values, so its range is less trustworthy.`)]
    : [pass('dynamic', 'imputed_fraction', `${pct}% of the history months were interpolated (warn above ${IMPUTED_WARN_FRACTION * 100}%).`)]
}

const LIMITATIONS = [
  'Forecast, not observation: the expected values are extrapolated from past seasonality of the same area; they say what the history makes likely, not what happened or will happen. Drought, flooding, harvest timing, a land-use change or a trend break leave the range.',
  'The series is the spatial median over the AOI of a cloud-masked monthly composite (Sentinel-2 L2A). A month counts as observed only if at least 30% of the AOI had a clear observation; gaps of at most 2 months are linearly interpolated and flagged, longer gaps are left open, and the operation refuses with fewer than 36 months of history, more than 25% missing months, or no clear observation in the last 2 months.',
  `Monthly cadence, an AOI of at most 100 km², history from ${FORECAST_EARLIEST_MONTH} (earlier scenes are not readable); the first call for an area reads years of scenes and can take minutes, a repeat is served from cache.`,
  'A mixed AOI (field plus town, forest plus crop) is summarised by one median, which can hide opposite changes inside it.',
]
const CONFIDENCE = 'medium: the shipped method\'s p10-p90 range held the observed value 70-90% of the time on the backtest (eval/RESULTS.md) AND at most 10% of the history months were interpolated; low otherwise (no backtest, miscalibrated, or gappy input). Never high: it is a forecast. The percentage reported is measured backtest coverage across the backtest AOIs, not a guarantee for this one.'

/** TimesFM was not better than monthly climatology on our backtest (eval/RESULTS.md), so the forecast
 *  operation is off unless GEO_TIMESFM_FORECAST=1 (and the service runs with GEO_TIMESFM=1). */
export const isForecastEnabled = (): boolean => isGeoServiceConfigured() && process.env.GEO_TIMESFM_FORECAST === '1'

export const forecastOps: AnyOperation[] = [
  defineOperation({
    name: 'forecast_index',
    label: 'Forecasting the index from its monthly history...',
    version: '1.0.0',
    description: 'FORECAST (not observation) of a vegetation / spectral index for the next 1-12 months over the AOI, from its monthly Sentinel-2 history (default 5 years, minimum 36 months). Returns, per future month, a median and an 80% range (p10 to p90) as a chart plus numbers. Use for "what would NDVI be next month / this season", "expected greenness". It REFUSES when the history is too short or too sparse. For "is this month unusual?" use detect_anomaly; for what the index WAS, use composite / fetch_temporal_stack. Always state that the numbers are a forecast with a range.',
    params: z.object({
      expression: z.string().optional().describe(`Index to forecast: ${FORECAST_INDICES.join(', ')} (default NDVI) or band math over Sentinel-2 bands.`),
      start: z.string().optional().describe(`YYYY-MM-DD first day of the history (default: 60 months before the end). At least ${MIN_HISTORY_MONTHS} months are needed.`),
      end: z.string().optional().describe('YYYY-MM-DD last day of the history; must be within a COMPLETE month (default: end of last month). The forecast starts the month after.'),
      horizon_months: z.number().int().optional().describe(`Months to forecast, 1-${MAX_HORIZON_MONTHS} (default 6). Accuracy falls with the horizon.`),
    }),
    output: 'chart',
    sensors: ['sentinel-2-l2a'],
    resolution_m: 20,
    limits: { maxAreaKm2: 100, earliest: `${FORECAST_EARLIEST_MONTH}-01`, needsDates: true },
    // History is closed (explicit `end` older than 45 days) -> the answer cannot change; otherwise per day.
    cacheTtl: { liveMs: 6 * HOUR, settledMs: 30 * DAY },
    cost: { typicalSeconds: 300 },
    limitations: LIMITATIONS,
    confidence: CONFIDENCE,
    staticChecks: (ctx, args) => {
      const checks: ValidationCheck[] = [...indexCheck(args.expression)]
      const h = args.horizon_months
      if (h != null && (!Number.isInteger(h) || h < 1 || h > MAX_HORIZON_MONTHS)) checks.push(fail('static', 'horizon', `horizon_months must be a whole number from 1 to ${MAX_HORIZON_MONTHS} (got ${h}); a longer forecast is not supported because its range is not trustworthy.`))
      else checks.push(pass('static', 'horizon', `Horizon ${h ?? 6} month(s) (limit ${MAX_HORIZON_MONTHS}).`))
      const { start, end } = resolveForecastWindow(args)
      const valid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
      if (valid(start) && valid(end) && start <= end) {
        const last = lastCompleteMonth()
        if (end.slice(0, 7) > last) checks.push(fail('static', 'history_complete', `\`end\` (${end}) is in a month that is not complete yet; the latest usable history end is ${new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)), 0)).toISOString().slice(0, 10)}.`))
        const months = monthDiff(start.slice(0, 7), end.slice(0, 7)) + 1
        if (months < MIN_HISTORY_MONTHS) checks.push(fail('static', 'history_length', `The history ${start}..${end} is ${months} months; at least ${MIN_HISTORY_MONTHS} (3 years) are required to learn the seasonal cycle. Move \`start\` earlier.`))
        else if (months > MAX_HISTORY_MONTHS) checks.push(fail('static', 'history_length', `The history ${start}..${end} is ${months} months; at most ${MAX_HISTORY_MONTHS} (12 years).`))
        else checks.push(pass('static', 'history_length', `History of ${months} months (${MIN_HISTORY_MONTHS}-${MAX_HISTORY_MONTHS} allowed).`))
      }
      return checks
    },
    dynamicChecks: (output) => [
      ...imputedCheck(output),
      ...(['first_p10', 'last_p90'].some((k) => typeof output.summary_data?.[k] === 'number' && Math.abs(output.summary_data[k] as number) > 1.5)
        ? [warn('dynamic', 'forecast_range', 'A forecast bound lies outside the physical range of a normalised index; treat the range as unreliable.')]
        : []),
    ],
    run: (ctx, args) => runForecastIndex(ctx, args),
    enabled: isForecastEnabled,
  }),

  defineOperation({
    name: 'detect_anomaly',
    label: 'Comparing the observed month with its expected range...',
    version: '1.0.0',
    description: 'Is a given month UNUSUAL for this area? Forecasts the index for `month` from the preceding years of monthly Sentinel-2 history (default 5), then compares it with the OBSERVED value for that month. Returns observed, expected median and 80% range (p10 to p90), and a verdict: within_expected, below_expected, above_expected or cannot_determine (no clear observation that month, or history too short or sparse). Use for "is this September greener/browner than normal", "was vegetation unusual in <month>", "expected vs observed NDVI". The expected value is a forecast; say so and quote the range.',
    params: z.object({
      month: z.string().describe('YYYY-MM, the month to judge. Must not be in the future; the current month is judged on the scenes so far.'),
      expression: z.string().optional().describe(`Index: ${FORECAST_INDICES.join(', ')} (default NDVI) or band math.`),
      history_years: z.number().int().optional().describe('Years of history before the month used for the expectation, 3-10 (default 5).'),
    }),
    output: 'chart',
    sensors: ['sentinel-2-l2a'],
    resolution_m: 20,
    limits: { maxAreaKm2: 100, earliest: `${FORECAST_EARLIEST_MONTH}-01`, needsDates: true },
    // `month` is not a generic date key, so there is no settled window: cache per day only.
    cacheTtl: { liveMs: 6 * HOUR },
    cost: { typicalSeconds: 300 },
    limitations: [
      ...LIMITATIONS,
      'The verdict compares one observed month against a 80% range, so about 1 month in 5 falls outside it by chance; "below" or "above" is a flag to look closer, not a diagnosis of drought, damage or change.',
    ],
    confidence: CONFIDENCE,
    staticChecks: (ctx, args) => {
      const checks: ValidationCheck[] = [...indexCheck(args.expression)]
      if (!MONTH.test(args.month)) return [...checks, fail('static', 'month', `\`month\` must be YYYY-MM, got "${args.month}".`)]
      const now = new Date().toISOString().slice(0, 7)
      if (args.month > now) checks.push(fail('static', 'month_not_future', `\`month\` (${args.month}) is in the future (this month is ${now}); there is nothing observed to compare. Use forecast_index for the future.`))
      else if (args.month < addMonths(FORECAST_EARLIEST_MONTH, MIN_HISTORY_MONTHS)) checks.push(fail('static', 'month_history', `\`month\` (${args.month}) leaves under ${MIN_HISTORY_MONTHS} months of readable history (data from ${FORECAST_EARLIEST_MONTH}); the earliest month that can be judged is ${addMonths(FORECAST_EARLIEST_MONTH, MIN_HISTORY_MONTHS)}.`))
      else checks.push(pass('static', 'month', `${args.month} is a past month with enough possible history.`))
      const y = args.history_years
      if (y != null && (!Number.isInteger(y) || y < 3 || y > 10)) checks.push(fail('static', 'history_years', 'history_years must be a whole number from 3 to 10.'))
      return checks
    },
    dynamicChecks: (output) => imputedCheck(output),
    run: (ctx, args) => runDetectAnomaly(ctx, args),
    enabled: isGeoServiceConfigured,
  }),
]
