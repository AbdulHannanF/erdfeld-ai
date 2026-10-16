/** Shared pieces of the readers: coverage pre-check, honest (non-numeric) results, statistics. */

import { percentile } from '../../raster-render'
import type { AuthKind, DatasetEntry } from '../types'
import { formatResolution, formatTemporal } from '../format'
import { overlapsTime } from '../search'
import { AUTH_ENV } from './routing'
import type { CoverageInfo, ReadOpts, ReaderAoi, ReadResult, ReadStats, ReadStatus } from './types'

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** The generic `api-key` kind covers several services; each names its own variable. */
const API_KEY_ENV: Record<string, string> = { gfw: 'GFW_API_KEY', 'nasa-firms': 'FIRMS_MAP_KEY' }

export function authToken(kind: AuthKind, source?: string): { have: boolean; env: string; value?: string } {
  const names = kind === 'api-key' && source && API_KEY_ENV[source] ? [API_KEY_ENV[source]] : AUTH_ENV[kind]
  for (const name of names) {
    const v = process.env[name]?.trim()
    if (v) return { have: true, env: name, value: v }
  }
  return { have: false, env: names[0] }
}

export const AUTH_HELP: Record<AuthKind, string> = {
  earthdata: 'a free NASA Earthdata token (EARTHDATA_TOKEN): create one at https://urs.earthdata.nasa.gov/profile (Generate Token)',
  earthengine: 'Earth Engine credentials (GEE_KEY_FILE pointing at a service-account key, or GEE_SERVICE_ACCOUNT_KEY)',
  copernicus: 'a Copernicus Data Space token or S3 keys (CDSE_TOKEN): free account at https://dataspace.copernicus.eu',
  opentopography: 'an OpenTopography API key (OPENTOPO_API_KEY): free at https://portal.opentopography.org/requestService?service=api',
  'api-key': 'a free API key for this service',
}

// ---------------------------------------------------------------------------
// Coverage pre-check (registry entry only: no network)
// ---------------------------------------------------------------------------

/** United States and territories, as coarse boxes. 3DEP lidar exists nowhere else, and the
 *  catalogs declare a box that also swallows Canada and Mexico (so a declared extent is not proof). */
const US_BOXES: Array<[number, number, number, number]> = [
  [-125, 24, -66.9, 49.5], // contiguous
  [-170, 51, -129, 71.6], // Alaska
  [-161, 18.5, -154.5, 22.5], // Hawaii
  [-68, 17.5, -64.4, 18.7], // Puerto Rico, USVI
  [144, 13, 146, 21], // Guam, N. Mariana
  [-171, -15, -168, -14], // American Samoa
]

const US_ONLY = /(^|:)(3dep|lidar-ept)|^usgs-3dep:/i

export function isUsOnly(entry: DatasetEntry): boolean {
  return US_ONLY.test(entry.id) || entry.source === 'usgs-3dep'
}

function boxesIntersect(a: number[], b: number[]): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

function intersectsDeclared(entry: DatasetEntry, bbox: number[]): boolean {
  if (entry.spatial.global) return true
  const [w, s, e, n] = entry.spatial.bbox
  if (!(s <= bbox[3] && n >= bbox[1])) return false
  return w <= e ? (w <= bbox[2] && e >= bbox[0]) : (w <= bbox[2] || e >= bbox[0])
}

export function declaredExtent(entry: DatasetEntry): string {
  const b = entry.spatial.bbox.map((x) => +x.toFixed(2)).join(', ')
  return `${entry.spatial.global ? 'global' : `bbox [${b}]`}${isUsOnly(entry) ? ', United States only' : ''}; ${formatTemporal(entry)}`
}

/** Refuse fast, from the registry entry alone, when the AOI/time cannot have data. */
export function coveragePrecheck(entry: DatasetEntry, aoi: ReaderAoi, opts: ReadOpts): { reason: string } | null {
  if (!intersectsDeclared(entry, aoi.bbox)) {
    return { reason: `The AOI lies outside the dataset's declared extent (${declaredExtent(entry)}).` }
  }
  if (isUsOnly(entry) && !US_BOXES.some((b) => boxesIntersect(b, aoi.bbox))) {
    return { reason: `${entry.title} covers the United States and its territories only; this AOI is outside it. (The catalog's declared bbox is wider than the data: a declared extent is not coverage.)` }
  }
  const t = { start: opts.start ?? opts.date, end: opts.end ?? opts.date }
  if ((t.start || t.end) && !overlapsTime(entry, t)) {
    return { reason: `The requested period (${t.start ?? '..'} to ${t.end ?? '..'}) is outside the dataset's temporal extent (${formatTemporal(entry)}).` }
  }
  return null
}

export function noCoverageResult(entry: DatasetEntry, aoi: ReaderAoi, reason: string, extra = ''): ReadResult {
  return honest(entry, 'no_coverage', {
    headline: `No data for "${entry.title}" over this AOI`,
    body: [reason, extra].filter(Boolean),
    coverage: { verdict: 'none', declared: declaredExtent(entry), found: reason },
    summary_data: { read: 'no_coverage', dataset: entry.id },
  })
}

// ---------------------------------------------------------------------------
// Honest results
// ---------------------------------------------------------------------------

export function datasetInfo(entry: DatasetEntry): string {
  const prov = entry.providers.slice(0, 3).join(', ')
  return (
    `**Dataset:** ${entry.title} (\`${entry.id}\`)${prov ? ` · ${prov}` : ''} · licence ${entry.license} · ` +
    `${formatResolution(entry.resolution_m)} · ${formatTemporal(entry)}\n` +
    `**Access:** ${entry.access.kind} · ${entry.access.url}`
  )
}

export function honest(
  entry: DatasetEntry,
  status: Exclude<ReadStatus, 'ok'>,
  o: {
    headline: string
    body: string[]
    needs?: string
    coverage?: CoverageInfo
    summary_data?: ReadResult['summary_data']
  },
): ReadResult {
  const summary =
    `**${o.headline}.**\n\n${o.body.join('\n\n')}\n\n${datasetInfo(entry)}\n\n` +
    `_No statistic is reported: an empty answer here means the dataset could not be read, not that the measured value is zero._`
  return {
    status,
    summary,
    stats: null,
    summary_data: { read: status, dataset: entry.id, ...(o.needs ? { needs: o.needs } : {}), ...(o.summary_data ?? {}) },
    provenance: null,
    coverage: o.coverage ?? { verdict: 'unknown', declared: declaredExtent(entry), found: 'not read' },
    ...(o.needs ? { needs: o.needs } : {}),
  }
}

export function authRequiredResult(entry: DatasetEntry, kind: AuthKind, found: string, extraBody: string[] = []): ReadResult {
  const t = authToken(kind, entry.source)
  return honest(entry, 'auth_required', {
    headline: `"${entry.title}" requires ${AUTH_HELP[kind].split(' (')[0]}`,
    body: [
      `Reading this dataset needs ${AUTH_HELP[kind]}. ${t.have ? '' : `\`${t.env}\` is not set on this deployment.`}`,
      ...(found ? [found] : []),
      ...extraBody,
    ],
    needs: t.env,
    coverage: { verdict: 'unknown', declared: declaredExtent(entry), found: found || 'not searched' },
    summary_data: { auth_kind: kind },
  })
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Mean, spread and percentiles of finite values. Null when there are none. */
export function describe(values: ArrayLike<number>): Required<Pick<ReadStats, 'count' | 'mean' | 'median' | 'std' | 'min' | 'max' | 'p2' | 'p5' | 'p95' | 'p98'>> | null {
  let n = 0
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) n++
  if (n === 0) return null
  const sorted = new Float64Array(n)
  let k = 0
  let sum = 0
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) { sorted[k++] = values[i]; sum += values[i] }
  sorted.sort()
  const mean = sum / n
  let ss = 0
  for (let i = 0; i < n; i++) ss += (sorted[i] - mean) ** 2
  return {
    count: n, mean, median: percentile(sorted, 50), std: Math.sqrt(ss / n), min: sorted[0], max: sorted[n - 1],
    p2: percentile(sorted, 2), p5: percentile(sorted, 5), p95: percentile(sorted, 95), p98: percentile(sorted, 98),
  }
}

export const r = (x: number, d = 3): number => Number(x.toFixed(d))

export function fmtDate(s: unknown): string {
  return typeof s === 'string' ? s.slice(0, 10) : ''
}

/** "2026-10-05" -> ms; null when unparsable. */
export function dayMs(s: unknown): number | null {
  if (typeof s !== 'string' || !s) return null
  const t = Date.parse(s.length === 4 ? `${s}-07-01` : s)
  return Number.isFinite(t) ? t : null
}
