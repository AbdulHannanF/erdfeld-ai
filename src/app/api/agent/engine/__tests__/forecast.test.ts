import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GeoResultSchema } from '@/lib/geo-result'

import { GeoServiceError, type AnomalyResponse, type BacktestRef, type ForecastResponse, type HistoryPoint } from '../../lib/geo-service'
import { forecastConfidence, resolveForecastWindow } from '../../tools/forecast'
import { getOperation, getToolDefinitions } from '../registry'

const mock = vi.hoisted(() => ({ forecast: vi.fn(), anomaly: vi.fn() }))
vi.mock('../../lib/geo-service', async (orig) => ({ ...(await orig<typeof import('../../lib/geo-service')>()), forecast: mock.forecast, anomaly: mock.anomaly }))

import { runOperation } from '../execute'

const AOI = { type: 'Polygon', coordinates: [[[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]]] }
const NOW = Date.parse('2026-10-12T12:00:00Z')

const BT: BacktestRef = { reference: 'eval/RESULTS.md#timesfm-forecasting-backtest', coverage_p10_p90_pct: 79.4, mae_lead3: 0.061, mae_lead1: 0.05, n: 200, aois: 6 }
const MODEL = { id: 'google/timesfm-2.5-200m-pytorch', revision: '1d952420fba87f3c6dee4f240de0f1a0fbc790e3', method: 'timesfm' as const, license: 'Apache-2.0', load_s: 17.5, infer_s: 1.1 }

const history = (n = 48, imputed: number[] = []): HistoryPoint[] =>
  Array.from({ length: n }, (_, i) => {
    const m = `${2022 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`
    return { month: m, value: 0.5 + 0.2 * Math.sin((i % 12) / 2), valid_pct: 92, imputed: imputed.includes(i) }
  })

const fcOk = (over: Partial<ForecastResponse> = {}): ForecastResponse => ({
  expression: '(nir-red)/(nir+red)', band: 'ndvi', history: history(), kind: 'forecast', note: 'Forecast, not observation',
  forecast: [{ month: '2026-01', p10: 0.31, p50: 0.42, p90: 0.55 }, { month: '2026-02', p10: 0.33, p50: 0.45, p90: 0.58 }],
  model: { ...MODEL, backtest: BT }, imputed_months: [], unfilled_gap_months: 0, history_trimmed_from: null, warnings: [],
  provenance: { item_count: 310, items_digest: 'abcd1234abcd1234', first_item: 'S2A_a', last_item: 'S2B_z', skipped_unreadable_items: 0 },
  timing: { fetch_s: 61, total_s: 63, model_load_s: 17.5, inference_s: 1.1 }, backtest: BT,
  ...over,
})

const anOk = (over: Partial<AnomalyResponse> = {}): AnomalyResponse => ({
  expression: '(nir-red)/(nir+red)', band: 'ndvi', kind: 'anomaly', target_month: '2025-06', history_years: 5,
  observed: 0.28, observed_valid_pct: 88, observed_n_scenes: 4, expected_p10: 0.4, expected_p50: 0.5, expected_p90: 0.6,
  score: -1.9, verdict: 'below_expected', reason: null, warnings: [], history: history(), imputed_months: [],
  model: { ...MODEL, backtest: BT }, provenance: { item_count: 310, items_digest: 'abcd1234abcd1234', first_item: 'S2A_a', last_item: 'S2B_z', skipped_unreadable_items: 0 },
  timing: { fetch_s: 60, total_s: 62, model_load_s: 17.5, inference_s: 1.1 }, backtest: BT,
  ...over,
})

const runF = (args: Record<string, unknown> = { start: '2022-01-01', end: '2025-12-31', horizon_months: 2 }) =>
  runOperation('forecast_index', args, { aoi: AOI, now: NOW })
const runA = (args: Record<string, unknown> = { month: '2025-06' }) => runOperation('detect_anomaly', args, { aoi: AOI, now: NOW })

beforeEach(() => {
  vi.stubEnv('GEO_SERVICE_URL', 'http://127.0.0.1:8101')
  vi.stubEnv('GEO_TIMESFM_FORECAST', '1')
  vi.useFakeTimers({ toFake: ['Date'] }) // the static checks read the clock ("not in the future", "month complete")
  vi.setSystemTime(NOW)
})
afterEach(() => { mock.forecast.mockReset(); mock.anomaly.mockReset(); vi.unstubAllEnvs(); vi.useRealTimers() })

describe('forecast_index', () => {
  it('returns a forecast chart with the p10-p90 band, stats, model provenance and backtest reference', async () => {
    mock.forecast.mockResolvedValue(fcOk())
    const r = await runF()
    expect(GeoResultSchema.safeParse(r).success).toBe(true)
    expect(r.status).toBe('ok')
    expect(mock.forecast.mock.calls[0][0]).toMatchObject({ expression: 'NDVI', history_start: '2022-01-01', history_end: '2025-12-31', horizon_months: 2, geometry: AOI })
    expect(r.summary).toMatch(/Forecast, not an observation/)
    expect(r.summary).toMatch(/0\.42 \(p10 0\.31 to p90 0\.55\)/)
    expect(r.summary).toMatch(/google\/timesfm-2\.5-200m-pytorch @ 1d952420fba8/)
    expect(r.summary).toMatch(/held the observed value 79\.4% of the time/)
    expect(r.charts).toHaveLength(1)
    const spec = JSON.stringify(r.charts![0].spec)
    expect(spec).toMatch(/"y2":\{"field":"p90"\}/)
    expect(spec).toMatch(/strokeDash/)
    expect(r.stats).toMatchObject({ first_p10: 0.31, first_p50: 0.42, first_p90: 0.55, horizon_months: 2, model_revision: MODEL.revision, backtest_coverage_pct: 79.4, confidence: 'medium' })
    expect(r.provenance.items.join(' ')).toMatch(/timesfm-2\.5-200m-pytorch@1d95.*s2-items:abcd1234abcd1234\(310\)/)
    expect(r.uncertainty?.notes.join(' ')).toMatch(/not observation/)
    expect(r.validation.find((c) => c.id === 'imputed_fraction')?.status).toBe('pass')
  })

  it('warns and lowers confidence when many history months were interpolated', async () => {
    mock.forecast.mockResolvedValue(fcOk({ imputed_months: Array.from({ length: 8 }, (_, i) => `2023-0${i + 1}`), history: history(48, [1, 2, 3, 4, 5, 6, 7, 8]) }))
    const r = await runF()
    expect(r.validation.find((c) => c.id === 'imputed_fraction')?.status).toBe('warn')
    expect(r.stats?.confidence).toBe('low')
    expect(r.summary).toMatch(/8 month\(s\) interpolated/)
  })

  it('no recorded backtest means low confidence and an explicit uncalibrated note', async () => {
    mock.forecast.mockResolvedValue(fcOk({ backtest: null, model: { ...MODEL } }))
    const r = await runF()
    expect(r.stats?.confidence).toBe('low')
    expect(r.summary).toMatch(/uncalibrated/)
  })

  it('a 422 insufficient_history is REFUSED with the service reason, no chart', async () => {
    mock.forecast.mockRejectedValue(new GeoServiceError('insufficient_history', 'only 30 months of history from the first observed month (2022-01)', 422))
    const r = await runF()
    expect(r.status).toBe('refused')
    expect(r.summary).toMatch(/too short or too sparse/)
    expect(r.summary).toMatch(/only 30 months/)
    expect(r.charts).toBeUndefined()
    expect(r.layers).toEqual([])
  })

  it('a 502 is failed, worded as a fetch failure rather than no data', async () => {
    mock.forecast.mockRejectedValue(new GeoServiceError('fetch_failed', 'COG read failed', 502))
    const r = await runF()
    expect(r.status).toBe('failed')
    expect(r.summary).toMatch(/fetch failure/)
    expect(r.summary).toMatch(/not an absence of data/)
  })

  it('a timeout or unreachable service is failed too', async () => {
    mock.forecast.mockRejectedValue(new GeoServiceError('timeout', 'no response within 1200000 ms'))
    expect((await runF()).status).toBe('failed')
  })

  describe('static checks refuse before calling the service', () => {
    it.each([
      ['a horizon over 12', { start: '2022-01-01', end: '2025-12-31', horizon_months: 13 }, /horizon_months must be/],
      ['a horizon of 0', { start: '2022-01-01', end: '2025-12-31', horizon_months: 0 }, /horizon_months must be/],
      ['a history under 36 months', { start: '2024-01-01', end: '2025-12-31' }, /at least 36/],
      ['a history over 12 years', { start: '2017-01-01', end: '2030-01-01' }, /./],
      ['an end in the incomplete current month', { start: '2022-01-01', end: '2026-10-05' }, /not complete yet/],
      ['an end in the future', { start: '2022-01-01', end: '2027-01-31' }, /future/],
      ['an invalid date', { start: '2022-13-01', end: '2025-12-31' }, /real YYYY-MM-DD/],
      ['a start before readable data', { start: '2015-01-01', end: '2025-12-31' }, /begins/],
      ['an unknown named index', { expression: 'GREENNESS', start: '2022-01-01', end: '2025-12-31' }, /not a supported index/],
    ])('%s', async (_n, args, msg) => {
      const r = await runF(args)
      expect(r.status).toBe('refused')
      expect(r.summary).toMatch(msg)
      expect(mock.forecast).not.toHaveBeenCalled()
    })
  })

  it('defaults to the last 60 complete months', () => {
    expect(resolveForecastWindow({}, NOW)).toEqual({ start: '2021-10-01', end: '2026-09-30' })
  })
})

describe('detect_anomaly', () => {
  it('reports observed vs the expected range, verdict, chart with the observed point', async () => {
    mock.anomaly.mockResolvedValue(anOk())
    const r = await runA()
    expect(GeoResultSchema.safeParse(r).success).toBe(true)
    expect(r.status).toBe('ok')
    expect(mock.anomaly.mock.calls[0][0]).toMatchObject({ expression: 'NDVI', target_month: '2025-06', history_years: 5, geometry: AOI })
    expect(r.summary).toMatch(/BELOW the expected range/)
    expect(r.summary).toMatch(/Observed:\*\* 0\.28/)
    expect(r.summary).toMatch(/forecast from the 5 years before, not an observation/)
    expect(r.stats).toMatchObject({ verdict: 'below_expected', observed: 0.28, expected_p10: 0.4, expected_p50: 0.5, expected_p90: 0.6, score: -1.9, backtest_coverage_pct: 79.4 })
    const spec = JSON.stringify(r.charts![0].spec)
    expect(spec).toMatch(/"field":"observed"/)
    expect(spec).toMatch(/"type":"rule"/)
    expect(r.provenance.items.join(' ')).toMatch(/s2-items:abcd1234abcd1234\(310\)/)
  })

  it('cannot_determine is a normal answer: no observation is invented, expected range shown for reference only', async () => {
    mock.anomaly.mockResolvedValue(anOk({ observed: null, observed_valid_pct: 4, verdict: 'cannot_determine', score: null, reason: 'no clear observation of 2025-06 covering at least 30% of the AOI' }))
    const r = await runA()
    expect(r.status).toBe('ok')
    expect(r.summary).toMatch(/CANNOT BE DETERMINED/)
    expect(r.summary).toMatch(/no value was estimated/)
    expect(r.stats?.verdict).toBe('cannot_determine')
    expect(r.stats?.observed).toBeUndefined()
    expect(JSON.stringify(r.charts![0].spec)).not.toMatch(/"field":"observed"/)
  })

  it('sparse history comes back as cannot_determine without an expected range', async () => {
    mock.anomaly.mockResolvedValue(anOk({ observed: 0.3, verdict: 'cannot_determine', expected_p10: null, expected_p50: null, expected_p90: null, score: null, history: [], reason: 'history too short or sparse to say what was expected: 31 of 60 months missing' }))
    const r = await runA()
    expect(r.summary).toMatch(/CANNOT BE DETERMINED/)
    expect(r.charts).toBeUndefined()
  })

  it('a service 422 is refused with its reason; a 502 is failed', async () => {
    mock.anomaly.mockRejectedValueOnce(new GeoServiceError('bad_request', 'target_month 2099-01 is in the future', 422))
    const refused = await runA()
    expect(refused.status).toBe('refused')
    expect(refused.summary).toMatch(/target_month 2099-01 is in the future/)
    mock.anomaly.mockRejectedValueOnce(new GeoServiceError('fetch_failed', 'STAC search failed', 502))
    const failed = await runA()
    expect(failed.status).toBe('failed')
    expect(failed.summary).toMatch(/not an absence of data/)
  })

  it('warns on a high imputed fraction', async () => {
    mock.anomaly.mockResolvedValue(anOk({ imputed_months: Array.from({ length: 9 }, (_, i) => `2022-0${i + 1}`), history: history(48, [0, 1, 2, 3, 4, 5, 6, 7, 8]) }))
    expect((await runA()).validation.find((c) => c.id === 'imputed_fraction')?.status).toBe('warn')
  })

  describe('static checks', () => {
    it.each([
      ['a future month', { month: '2026-12' }, /future/],
      ['a malformed month', { month: '2025-6' }, /YYYY-MM/],
      ['a month with no possible history', { month: '2018-06' }, /earliest month that can be judged/],
      ['history_years out of range', { month: '2025-06', history_years: 2 }, /3 to 10/],
    ])('%s', async (_n, args, msg) => {
      const r = await runA(args)
      expect(r.status).toBe('refused')
      expect(r.summary).toMatch(msg)
      expect(mock.anomaly).not.toHaveBeenCalled()
    })
  })
})

describe('confidence', () => {
  it('is medium only with a calibrated backtest and few interpolated months; never high', () => {
    expect(forecastConfidence(BT, 0)).toBe('medium')
    expect(forecastConfidence(BT, 0.2)).toBe('low')
    expect(forecastConfidence({ ...BT, coverage_p10_p90_pct: 55 }, 0)).toBe('low')
    expect(forecastConfidence(null, 0)).toBe('low')
  })
})

describe('registry routing by GEO_SERVICE_URL', () => {
  it('both operations exist only while the geo service is configured', () => {
    expect(getOperation('forecast_index')).toBeDefined()
    expect(getOperation('detect_anomaly')).toBeDefined()
    expect(getToolDefinitions().map((t) => t.function?.name ?? (t as any).name)).toEqual(expect.arrayContaining(['forecast_index', 'detect_anomaly']))
    vi.stubEnv('GEO_SERVICE_URL', '')
    expect(getOperation('forecast_index')).toBeUndefined()
    expect(getOperation('detect_anomaly')).toBeUndefined()
  })

  it('forecast_index is off by default (TimesFM lost the backtest); detect_anomaly stays on', () => {
    vi.stubEnv('GEO_TIMESFM_FORECAST', '')
    expect(getOperation('forecast_index')).toBeUndefined()
    expect(getOperation('detect_anomaly')).toBeDefined()
  })

  it('declares limits, cacheTtl and the forecast-not-observation limitation', () => {
    for (const n of ['forecast_index', 'detect_anomaly']) {
      const op = getOperation(n)!
      expect(op.cacheTtl).toBeDefined()
      expect(op.limits?.maxAreaKm2).toBe(100)
      expect(op.limitations.join(' ')).toMatch(/Forecast, not observation/)
      expect(op.confidence).toMatch(/backtest/)
    }
  })
})
