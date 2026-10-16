/** Weather + air quality tools — Open-Meteo (no key). Cached 10 minutes. */

import { fetchFailureNote } from '../lib/fetch-failure'
import { cachedFetchJson, fetchWithRetry } from '../lib/cache'
import { genId } from '../lib/geometry'
import {
  aggregateDailyToMonthly,
  computeAnomalies,
  computeAnomalyHeadline,
  getMonthlyClimatology,
  getRecentMonths,
  identifyRainySeason,
  PRECIP_GRADIENT_PALETTE,
  signCHIRPSRaster,
  type MonthClimate,
} from '../lib/precipitation'
import type { ResultLayer, SummaryDatum, ToolCtx, ToolOutput } from '../lib/types'

async function cachedOpenMeteo(url: string, timeoutMs = 10000): Promise<any> {
  return cachedFetchJson(`open-meteo:${url}`, { source: 'open-meteo' }, async () => {
    const res = await fetchWithRetry(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`)
    return res.json()
  })
}

/** Open-Meteo ERA5 daily variables `fetch_weather_history` can return, and how a month is summarised. */
export const WEATHER_VARIABLES = {
  temperature_2m_mean: { agg: 'mean', unit: '°C', noun: 'mean temperature' },
  temperature_2m_max: { agg: 'max', unit: '°C', noun: 'daily maximum temperature' },
  temperature_2m_min: { agg: 'min', unit: '°C', noun: 'daily minimum temperature' },
  precipitation_sum: { agg: 'sum', unit: 'mm', noun: 'precipitation' },
} as const
export type WeatherVariable = keyof typeof WEATHER_VARIABLES
export const DEFAULT_WEATHER_VARIABLES: WeatherVariable[] = ['temperature_2m_mean', 'precipitation_sum']
/** A window up to this long is returned day by day; longer ones are rolled up to months. */
const DAILY_WINDOW_DAYS = 62
/** ERA5 trails the present by about five days; the last days of a window to "today" come back empty. */
export const ERA5_LAG_DAYS = 5
export const MAX_WEATHER_WINDOW_DAYS = 3660

const DAY_MS = 86_400_000
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const dayMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`)

/** The ERA5 variable a free-text dataset variable ("temperature_2m_max", "rain", "max temperature") means. */
export function weatherVariablesFor(text: string | undefined): WeatherVariable[] | undefined {
  const t = (text ?? '').toLowerCase()
  if (!t) return undefined
  if ((Object.keys(WEATHER_VARIABLES) as WeatherVariable[]).includes(t as WeatherVariable)) return [t as WeatherVariable]
  if (/max|hot|heat/.test(t)) return ['temperature_2m_max']
  if (/min|cold|frost/.test(t)) return ['temperature_2m_min']
  if (/rain|precip|snow/.test(t)) return ['precipitation_sum']
  if (/temp/.test(t)) return ['temperature_2m_mean']
  return undefined
}

/** `fetch_weather_history`: ERA5 daily weather at the AOI centroid for any past window (default: the last 12 months). */
export async function fetchWeatherHistory(ctx: ToolCtx, args: Record<string, any> = {}): Promise<ToolOutput> {
  const { centroid } = ctx
  const today = new Date()
  const hasStart = typeof args.start === 'string' && args.start !== ''
  const hasEnd = typeof args.end === 'string' && args.end !== ''
  const endDate: string = hasEnd ? args.end : isoDay(today.getTime())
  const startDate: string = hasStart ? args.start : hasEnd
    ? isoDay(dayMs(endDate) - 365 * DAY_MS)
    : new Date(today.getFullYear() - 1, today.getMonth(), 1).toISOString().slice(0, 10)
  const spanDays = Math.round((dayMs(endDate) - dayMs(startDate)) / DAY_MS) + 1
  if (!(spanDays >= 1)) return { summary: '`start` must be on or before `end`.', refused: true }
  if (spanDays > MAX_WEATHER_WINDOW_DAYS) {
    return { summary: `The window is ${spanDays} days; the limit is ${MAX_WEATHER_WINDOW_DAYS} (about 10 years). Ask for a shorter period.`, refused: true }
  }

  const variables: WeatherVariable[] = Array.isArray(args.variables) && args.variables.length
    ? args.variables.filter((v: string): v is WeatherVariable => v in WEATHER_VARIABLES)
    : DEFAULT_WEATHER_VARIABLES
  const wantDaily = args.daily === true || (args.daily !== false && spanDays <= DAILY_WINDOW_DAYS)
  const threshold = Number.isFinite(Number(args.threshold)) && args.threshold !== null && args.threshold !== '' ? Number(args.threshold) : null

  // Open-Meteo's archive API rejects `monthly=` (HTTP 400); fetch `daily=` and roll up to calendar months here.
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${centroid.lat.toFixed(4)}&longitude=${centroid.lng.toFixed(4)}&start_date=${startDate}&end_date=${endDate}&daily=${variables.join(',')}&timezone=UTC`
  let wData: any
  try {
    wData = await cachedOpenMeteo(url, 15000)
  } catch (err: any) {
    return { summary: `Open-Meteo weather archive failed: ${err.message}. The ERA5 service may be temporarily unavailable.`, failed: true }
  }
  const daily = wData.daily
  if (!daily?.time?.length) {
    return { summary: `Open-Meteo returned no daily data for ${centroid.lat.toFixed(4)}°N, ${centroid.lng.toFixed(4)}°E, ${startDate} to ${endDate}.` }
  }
  const times: string[] = daily.time
  const series = (v: WeatherVariable): (number | null)[] => (daily[v] ?? []).map((x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null))

  const sd: Record<string, SummaryDatum> = {
    window_start: startDate,
    window_end: endDate,
    days_in_window: spanDays,
  }
  const lines: string[] = []
  const withData = Math.max(...variables.map((v) => series(v).filter((x) => x != null).length))
  sd.days_with_data = withData

  for (const v of variables) {
    const vals = series(v)
    const spec = WEATHER_VARIABLES[v]
    const present = vals.map((x, i) => ({ x, d: times[i] })).filter((p): p is { x: number; d: string } => p.x != null)
    if (present.length === 0) { lines.push(`- ${spec.noun}: no values in this window.`); continue }
    const sum = present.reduce((s, p) => s + p.x, 0)
    const hi = present.reduce((a, b) => (b.x > a.x ? b : a))
    const lo = present.reduce((a, b) => (b.x < a.x ? b : a))
    if (v === 'precipitation_sum') {
      sd.total_precip_mm = Number(sum.toFixed(1))
      if (spanDays >= 360) sd.annual_precip_mm = Number(sum.toFixed(0))
      sd.wettest_day_mm = Number(hi.x.toFixed(1))
      sd.wettest_day = hi.d
      sd.rain_days_ge_1mm = present.filter((p) => p.x >= 1).length
      lines.push(`- **Precipitation:** ${sum.toFixed(0)} mm in ${present.length} days; wettest day ${hi.x.toFixed(1)} mm on ${hi.d}; ${sd.rain_days_ge_1mm} days with at least 1 mm.`)
    } else if (v === 'temperature_2m_max') {
      sd.hottest_day_c = Number(hi.x.toFixed(1))
      sd.hottest_day = hi.d
      sd.mean_daily_max_c = Number((sum / present.length).toFixed(1))
      lines.push(`- **Daily maximum temperature:** mean ${(sum / present.length).toFixed(1)} °C; hottest day ${hi.x.toFixed(1)} °C on ${hi.d}.`)
    } else if (v === 'temperature_2m_min') {
      sd.coldest_night_c = Number(lo.x.toFixed(1))
      sd.coldest_night = lo.d
      sd.mean_daily_min_c = Number((sum / present.length).toFixed(1))
      lines.push(`- **Daily minimum temperature:** mean ${(sum / present.length).toFixed(1)} °C; coldest night ${lo.x.toFixed(1)} °C on ${lo.d}.`)
    } else {
      sd.mean_temp_c = Number((sum / present.length).toFixed(1))
      lines.push(`- **Mean temperature:** ${(sum / present.length).toFixed(1)} °C.`)
    }
    // The count behind "how many days exceeded N": the first requested variable, strictly above the threshold.
    if (threshold != null && v === variables[0]) {
      const above = present.filter((p) => p.x > threshold).length
      sd.threshold_value = threshold
      sd.threshold_variable = v
      sd.days_above_threshold = above
      lines.push(`- **Days above ${threshold} ${spec.unit}:** ${above} of ${present.length} days with data.`)
    }
    const seriesKey = (kind: 'daily' | 'monthly') => (v === 'precipitation_sum' ? `${kind}_precip_mm` : `${kind}_${v}`)
    if (wantDaily) sd[seriesKey('daily')] = present.map((p) => ({ label: p.d, value: Number(p.x.toFixed(1)) }))
    else {
      const monthly = aggregateDailyToMonthly(times, vals, spec.agg)
      sd[seriesKey('monthly')] = monthly.time.map((t, i) => ({ label: t.slice(0, 7), value: Number((monthly.values[i] ?? 0).toFixed(1)) }))
    }
  }

  let table: string[]
  if (wantDaily) {
    table = times.map((t, i) => `${t}: ${variables.map((v) => {
      const x = series(v)[i]
      return x == null ? 'N/A' : `${x.toFixed(1)} ${WEATHER_VARIABLES[v].unit}`
    }).join(', ')}`)
  } else {
    const cols = variables.map((v) => aggregateDailyToMonthly(times, series(v), WEATHER_VARIABLES[v].agg))
    table = cols[0].time.map((t, i) => `${t.slice(0, 7)}: ${variables.map((v, k) => {
      const x = cols[k].values[i]
      const how = WEATHER_VARIABLES[v].agg
      return x == null ? 'N/A' : `${x.toFixed(1)} ${WEATHER_VARIABLES[v].unit}${how === 'max' ? ' (hottest day)' : how === 'min' ? ' (coldest night)' : how === 'sum' ? ' (total)' : ' (mean)'}`
    }).join(', ')}`)
  }
  const tail = dayMs(endDate) > today.getTime() - ERA5_LAG_DAYS * DAY_MS
    ? `\n_ERA5 trails the present by about ${ERA5_LAG_DAYS} days, so the last days of this window may be empty (${spanDays - withData} of ${spanDays} days have no value)._`
    : ''
  return {
    summary: `Historical weather (Open-Meteo ERA5) for ${centroid.lat.toFixed(4)}°N, ${centroid.lng.toFixed(4)}°E, **${startDate} to ${endDate}** (${spanDays} days, ${wantDaily ? 'daily' : 'by month'}):\n\n${table.join('\n')}\n\n${lines.join('\n')}${tail}\n\nData: Open-Meteo ERA5 reanalysis (real archive data).`,
    summary_data: sd,
    sources: ['Open-Meteo ERA5 archive (reanalysis, about 25 km grid)'],
    uncertainty: { notes: ['ERA5 reanalysis at the AOI centroid on a roughly 25 km grid: a regional signal, not a station measurement. Daily extremes are those of the grid cell, usually milder than a station inside a city.'] },
  }
}

// ---------------------------------------------------------------------------
// P3.10 — Precipitation history & rainfall raster
// ---------------------------------------------------------------------------

/** Fetch 30-year ERA5 monthly climatology + recent anomalies for the AOI centroid.
 *  Optionally fetches a CHIRPS monthly rainfall raster via Planetary Computer STAC.
 *  Free, no API key. Open-Meteo ERA5 + CHIRPS v2.0 (UC Santa Barbara). */
export async function fetchPrecipitationHistory(
  ctx: ToolCtx,
  args: Record<string, any>,
): Promise<ToolOutput> {
  const { centroid, bbox, emit } = ctx
  const monthsBack = Math.min(60, Math.max(1, Number(args.months_back ?? 24)))
  const includeRaster = args.include_raster !== false

  emit?.('token', { type: 'token', content: 'Fetching 30-year precipitation climatology (Open-Meteo ERA5 1991–2020)...\n' })

  let climatology: MonthClimate[]
  try {
    climatology = await getMonthlyClimatology(centroid.lat, centroid.lng)
  } catch (err: any) {
    return {
      summary: [
        `**Precipitation History — failed**`,
        '',
        fetchFailureNote('the Open-Meteo ERA5 archive', err),
        'If this persists for an AOI centred offshore, note ERA5 has no land-grid cell there.',
        '',
        '**Alternatives:**',
        '- Move the AOI centroid over land and re-run.',
        '- Use \`fetch_weather_history\` for monthly or daily temperature + precipitation for a chosen period.',
      ].join('\n'),
    }
  }

  emit?.('token', { type: 'token', content: `Fetching last ${monthsBack} months and computing anomalies...\n` })

  let anomalyLines = ''
  let headline = ''
  try {
    const recent = await getRecentMonths(centroid.lat, centroid.lng, monthsBack)
    const anomalies = computeAnomalies(recent.time, recent.precip, climatology)
    headline = computeAnomalyHeadline(anomalies)

    const rows = anomalies
      .slice(-24) // cap table at 24 rows to stay readable
      .map(a => {
        const sign = a.delta >= 0 ? '+' : ''
        const emoji = a.flag === 'wet' ? '🔵' : a.flag === 'dry' ? '🟠' : '⚪'
        return `| ${a.yearMonth} | ${a.actual} mm | ${a.climatologyMean} mm | ${sign}${a.pct}% ${emoji} |`
      })
      .join('\n')

    if (rows) {
      anomalyLines = [
        '',
        '### Recent monthly anomalies (vs 1991–2020 ERA5 climatology)',
        '| Month | Actual | Clim. mean | Anomaly |',
        '|---|---|---|---|',
        rows,
        '',
        '_🔵 wet (>+20%) · 🟠 dry (<−20%) · ⚪ normal_',
      ].join('\n')
    }
  } catch {
    // anomaly section is optional — skip on error
  }

  const annualMean = Math.round(climatology.reduce((s, m) => s + m.mean, 0))
  const rainySeason = identifyRainySeason(climatology)

  const climRows = climatology
    .map(m => `| ${m.name} | ${m.mean} mm | ${m.p10}–${m.p90} mm |`)
    .join('\n')

  // Optional CHIRPS raster
  let rasterLayer: ResultLayer | undefined
  if (includeRaster) {
    emit?.('token', { type: 'token', content: 'Fetching CHIRPS monthly rainfall raster (Planetary Computer STAC)...\n' })
    try {
      const chirps = await signCHIRPSRaster(bbox)
      if (chirps) {
        const [minLng, minLat, maxLng, maxLat] = bbox
        rasterLayer = {
          id: genId(),
          name: `Rainfall — CHIRPS ${chirps.date}`,
          type: 'raster',
          tileUrl: chirps.tileUrl,
          bounds: [minLng, minLat, maxLng, maxLat],
          provenance: {
            source: 'CHIRPS Monthly v2.0 (UC Santa Barbara Climate Hazards Center COG) + titiler',
            date: chirps.date,
            method: 'COG tile rendered with blues gradient (0–400 mm/month); AOI bbox clip',
            clip: 'bbox',
          },
          confidence: 'high',
          palette: { ...PRECIP_GRADIENT_PALETTE, min: chirps.min, max: chirps.max },
        }
      }
    } catch {
      // raster path optional — graceful degradation
    }
  }

  const rasterNote = !rasterLayer && includeRaster
    ? '\n\n_The CHIRPS monthly rainfall map could not be added: no recent CHIRPS file could be reached at the Climate Hazards Center (data.chc.ucsb.edu). The ERA5 statistics above are unaffected._'
    : ''

  const summary = [
    `**Precipitation History — ${centroid.lat.toFixed(4)}°N, ${centroid.lng.toFixed(4)}°E**`,
    `*(ERA5 centroid point · 1991–2020 climatology · CHIRPS raster: whole-map tiles)*`,
    '',
    headline ? `### Recent anomaly\n${headline}` : '',
    anomalyLines,
    '',
    '### 30-year monthly climatology (ERA5 1991–2020)',
    `**Annual total (mean):** ${annualMean} mm/year`,
    `**Rainy season months:** ${rainySeason}`,
    '',
    '| Month | Mean | 10th–90th percentile |',
    '|---|---|---|',
    climRows,
    '',
    `*Data: Open-Meteo ERA5 reanalysis (free, no key) + CHIRPS v2.0 via the Climate Hazards Center (free, no key).*`,
    rasterNote,
  ].filter(Boolean).join('\n')

  return {
    summary,
    summary_data: {
      annual_mean_mm: annualMean,
      rainy_season: rainySeason,
      ...(headline ? { recent_anomaly: headline } : {}),
      monthly_climatology_mm: climatology.map((m) => ({ label: m.name, value: Math.round(m.mean) })),
    },
    layer: rasterLayer,
    // The figures are ERA5 whether or not the map layer exists: name the source on the result itself.
    sources: ['Open-Meteo ERA5 archive (reanalysis, about 25 km grid; 1991-2020 climatology)'],
    uncertainty: { notes: ['ERA5 grid cell at the AOI centroid (about 25 km), not an area average or a station.'] },
  }
}
