/** Precipitation climatology + anomaly helpers and CHIRPS raster path.
 *  Data sources: Open-Meteo ERA5 archive (free, no key) + CHIRPS monthly COGs from the Climate Hazards Center (free, no key).
 */

import { cachedFetchJson } from './cache'
import { TITILER_BASE } from './titiler'
import type { GradientPalette } from './types'

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export const PRECIP_GRADIENT_PALETTE: GradientPalette = {
  kind: 'gradient',
  label: 'Rainfall',
  unit: 'mm/month',
  min: 0,
  max: 400,
  stops: [
    { value: 0,   color: '#f7fbff', label: 'dry (0 mm)' },
    { value: 50,  color: '#c6dbef', label: '50 mm' },
    { value: 100, color: '#6baed6', label: '100 mm' },
    { value: 200, color: '#2171b5', label: '200 mm' },
    { value: 400, color: '#084594', label: '400+ mm' },
  ],
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

export interface MonthClimate {
  month: number  // 1–12
  name: string
  mean: number   // mm/month (ERA5 30-yr mean)
  p10: number    // 10th percentile
  p90: number    // 90th percentile
}

export interface PrecipAnomaly {
  yearMonth: string          // 'YYYY-MM'
  actual: number             // mm
  climatologyMean: number    // mm
  delta: number              // actual − climatologyMean
  pct: number                // delta / climatologyMean * 100 (0 if mean < 1 mm)
  flag: 'wet' | 'dry' | 'normal'
}

// ---------------------------------------------------------------------------
// Open-Meteo ERA5 helpers
// ---------------------------------------------------------------------------

const ARCHIVE_BASE = 'https://archive-api.open-meteo.com/v1/archive'

/**
 * Roll an Open-Meteo *daily* series up into calendar-month buckets.
 *
 * Open-Meteo's archive API no longer accepts a `monthly=` aggregation parameter
 * (it 400s: "Cannot initialize ForecastVariableMonthly from invalid String value
 * precipitation_sum"), so we request `daily=` and aggregate here. `sum` totals the
 * month (precipitation); `mean` averages it (temperature). Days with a null/NaN
 * value are skipped; a month with no valid samples yields a null. Output timestamps
 * are `YYYY-MM-01` so existing `slice(0,7)` / `slice(5,7)` consumers keep working.
 * Pure — exported for testing.
 */
export function aggregateDailyToMonthly(
  time: string[],
  values: (number | null)[],
  mode: 'sum' | 'mean' | 'max' | 'min',
): { time: string[]; values: (number | null)[] } {
  const order: string[] = []
  const buckets = new Map<string, number[]>()
  for (let i = 0; i < time.length; i++) {
    const ym = String(time[i]).slice(0, 7)
    if (!buckets.has(ym)) { buckets.set(ym, []); order.push(ym) }
    const v = values[i]
    if (v != null && Number.isFinite(v)) buckets.get(ym)!.push(v)
  }
  const outTime: string[] = []
  const outValues: (number | null)[] = []
  for (const ym of order) {
    const vals = buckets.get(ym)!
    outTime.push(`${ym}-01`)
    if (vals.length === 0) { outValues.push(null); continue }
    const total = vals.reduce((s, v) => s + v, 0)
    const agg = mode === 'sum' ? total : mode === 'max' ? Math.max(...vals) : mode === 'min' ? Math.min(...vals) : total / vals.length
    outValues.push(Math.round(agg * 10) / 10)
  }
  return { time: outTime, values: outValues }
}

async function fetchEra5Monthly(
  lat: number,
  lng: number,
  startDate: string,
  endDate: string,
  cacheKey: string,
  ttlMs: number,
): Promise<{ time: string[]; precip: (number | null)[] }> {
  // `daily=` (rolled up to months below), not `monthly=` — see aggregateDailyToMonthly.
  const url = `${ARCHIVE_BASE}?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&start_date=${startDate}&end_date=${endDate}&daily=precipitation_sum&timezone=UTC`
  const data = await cachedFetchJson(cacheKey, ttlMs, async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(25000) })
    if (!res.ok) throw new Error(`Open-Meteo archive HTTP ${res.status}`)
    return res.json()
  })
  const daily = (data as any).daily
  if (!daily?.time?.length) throw new Error('Open-Meteo returned no daily data for this location')
  const monthly = aggregateDailyToMonthly(
    daily.time as string[],
    daily.precipitation_sum as (number | null)[],
    'sum',
  )
  if (!monthly.time.length) throw new Error('Open-Meteo returned no monthly data for this location')
  return { time: monthly.time, precip: monthly.values }
}

/** Fetch 30-year (1991–2020) monthly climatology from ERA5. Cached 24 h. */
export async function getMonthlyClimatology(lat: number, lng: number): Promise<MonthClimate[]> {
  const { time, precip } = await fetchEra5Monthly(
    lat, lng,
    '1991-01-01', '2020-12-31',
    `precip-clim:${lat.toFixed(3)}:${lng.toFixed(3)}`,
    24 * 60 * 60 * 1000,
  )
  return buildClimatology(time, precip)
}

/** Build a 12-element climatology array from ERA5 monthly time series.
 *  Exported for testing; pure function (no network calls). */
export function buildClimatology(
  time: string[],
  precip: (number | null)[],
): MonthClimate[] {
  const byMonth: Record<number, number[]> = {}
  for (let m = 1; m <= 12; m++) byMonth[m] = []

  for (let i = 0; i < time.length; i++) {
    const v = precip[i]
    const m = parseInt(time[i].slice(5, 7), 10)
    if (!isNaN(m) && v != null && v >= 0) byMonth[m].push(v)
  }

  return Array.from({ length: 12 }, (_, idx) => {
    const m = idx + 1
    const vals = [...byMonth[m]].sort((a, b) => a - b)
    const n = vals.length
    const mean = n ? vals.reduce((s, v) => s + v, 0) / n : 0
    const p10 = n > 1 ? vals[Math.max(0, Math.floor(n * 0.1))] : (vals[0] ?? 0)
    const p90 = n > 1 ? vals[Math.min(n - 1, Math.floor(n * 0.9))] : (vals[n - 1] ?? 0)
    return {
      month: m,
      name: MONTH_NAMES[idx],
      mean: Math.round(mean * 10) / 10,
      p10: Math.round(p10 * 10) / 10,
      p90: Math.round(p90 * 10) / 10,
    }
  })
}

/** Fetch recent monthly precipitation (from `monthsBack` months ago to last complete month).
 *  Cached 30 min. Current month is excluded (may be incomplete). */
export async function getRecentMonths(
  lat: number,
  lng: number,
  monthsBack: number,
): Promise<{ time: string[]; precip: number[] }> {
  const today = new Date()
  // Go back far enough to cover monthsBack complete months plus a buffer
  const startYear = today.getFullYear() - Math.ceil(monthsBack / 12) - 1
  const startDate = `${startYear}-01-01`
  const endDate = today.toISOString().slice(0, 10)

  const { time, precip } = await fetchEra5Monthly(
    lat, lng,
    startDate, endDate,
    `precip-recent:${lat.toFixed(3)}:${lng.toFixed(3)}:${monthsBack}`,
    30 * 60 * 1000,
  )

  // Drop the current month if it's still in progress
  let times = time as string[]
  let precips = (precip as (number | null)[]).map(v => v ?? 0)
  const nowYM = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
  if (times.length && times[times.length - 1]?.slice(0, 7) >= nowYM) {
    times = times.slice(0, -1)
    precips = precips.slice(0, -1)
  }

  // Trim to the last `monthsBack` complete months
  if (times.length > monthsBack) {
    times = times.slice(times.length - monthsBack)
    precips = precips.slice(precips.length - monthsBack)
  }

  return { time: times, precip: precips }
}

// ---------------------------------------------------------------------------
// Pure analytics helpers
// ---------------------------------------------------------------------------

/** Compute per-month anomalies relative to the 30-year climatology.
 *  Flag: 'wet' if actual > climatologyMean × 1.2; 'dry' if < × 0.8; else 'normal'. */
export function computeAnomalies(
  time: string[],
  precip: number[],
  climatology: MonthClimate[],
): PrecipAnomaly[] {
  return time.map((t, i) => {
    const month = parseInt(t.slice(5, 7), 10)
    const clim = climatology[month - 1] ?? climatology[0]
    const actual = precip[i] ?? 0
    const delta = actual - clim.mean
    const pct = clim.mean >= 1 ? Math.round((delta / clim.mean) * 100) : 0
    const flag: 'wet' | 'dry' | 'normal' =
      pct > 20 ? 'wet' : pct < -20 ? 'dry' : 'normal'
    return {
      yearMonth: t.slice(0, 7),
      actual: Math.round(actual * 10) / 10,
      climatologyMean: clim.mean,
      delta: Math.round(delta * 10) / 10,
      pct,
      flag,
    }
  })
}

/** Identify rainy season months: those with mean precipitation ≥ 1.5× the annual monthly average.
 *  Returns a human-readable summary string. */
export function identifyRainySeason(climatology: MonthClimate[]): string {
  const annualSum = climatology.reduce((s, m) => s + m.mean, 0)
  const monthlyAvg = annualSum / 12
  const threshold = monthlyAvg * 1.5

  const rainy = climatology
    .filter(m => m.mean >= threshold && m.mean > 0)
    .sort((a, b) => b.mean - a.mean)

  if (!rainy.length || monthlyAvg < 1) {
    return 'No clear rainy season — precipitation is relatively uniform year-round or very low'
  }
  return rainy.map(m => `${m.name} (${m.mean} mm)`).join(', ')
}

/** Build a one-sentence headline from the anomaly array. */
export function computeAnomalyHeadline(anomalies: PrecipAnomaly[]): string {
  if (!anomalies.length) return 'No recent data available.'

  const totalActual = anomalies.reduce((s, a) => s + a.actual, 0)
  const totalClim = anomalies.reduce((s, a) => s + a.climatologyMean, 0)
  const overallPct = totalClim >= 1
    ? Math.round(((totalActual - totalClim) / totalClim) * 100)
    : 0
  const dryCount = anomalies.filter(a => a.flag === 'dry').length
  const wetCount = anomalies.filter(a => a.flag === 'wet').length

  const direction =
    overallPct > 20 ? `**${Math.abs(overallPct)}% wetter** than the climatological average` :
    overallPct < -20 ? `**${Math.abs(overallPct)}% drier** than the climatological average` :
    `near the climatological average (${overallPct > 0 ? '+' : ''}${overallPct}%)`

  const from = anomalies[0].yearMonth
  const to = anomalies[anomalies.length - 1].yearMonth
  return `Last ${anomalies.length} months (${from} to ${to}): ${direction}. ${dryCount} below-normal month${dryCount !== 1 ? 's' : ''}, ${wetCount} above-normal month${wetCount !== 1 ? 's' : ''}.`
}

// ---------------------------------------------------------------------------
// CHIRPS monthly rainfall raster (Climate Hazards Center cloud-optimised GeoTIFFs)
// ---------------------------------------------------------------------------

export interface ChirpsRaster {
  tileUrl: string
  date: string  // 'YYYY-MM'
  min: number
  max: number
}

const CHIRPS_COG = (ym: string) => `https://data.chc.ucsb.edu/products/CHIRPS-2.0/global_monthly/cogs/chirps-v2.0.${ym.replace('-', '.')}.cog`
/** CHIRPS trails the present by about 2-3 months, so probe from last month back this many months. */
const CHIRPS_MAX_LOOKBACK = 6

/** The most recent CHIRPS v2.0 monthly raster, rendered through titiler. CHIRPS is not in the Planetary Computer
 *  catalogue (the earlier `chirps-monthly` collection does not exist there, which is why the map layer was always
 *  missing); the Climate Hazards Center publishes each month as a public COG. Null when none of the last months
 *  can be reached. `now` is injectable for tests. */
export async function signCHIRPSRaster(_bbox: number[], now: Date = new Date()): Promise<ChirpsRaster | null> {
  const latest = await cachedFetchJson(`chirps-latest:${now.getUTCFullYear()}-${now.getUTCMonth()}`, 6 * 3600e3, async () => {
    for (let back = 1; back <= CHIRPS_MAX_LOOKBACK; back++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
      const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
      try {
        const res = await fetch(CHIRPS_COG(ym), { method: 'HEAD', signal: AbortSignal.timeout(8000) })
        if (res.ok) return ym
      } catch {
        // an unreachable host is the same as a missing month for this probe; the next month is tried
      }
    }
    return ''
  })
  if (!latest) return null
  // .png not @1x.png: titiler v2 route is /{z}/{x}/{y}.{format} (the @1x scale suffix 422s).
  const tileUrl = `${TITILER_BASE}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${encodeURIComponent(CHIRPS_COG(latest))}&rescale=0,400&colormap_name=blues&return_mask=true`
  return { tileUrl, date: latest, min: 0, max: 400 }
}
