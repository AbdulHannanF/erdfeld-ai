/** geoparquet reader (Overture Maps): buildings, places, transportation, addresses, divisions.
 *
 *  Pure JS (hyparquet), server-only: the release's STAC collection lists the parquet files with
 *  their footprints, the parquet footer is read with HTTP range requests, row groups are pruned by
 *  the `bbox.*` column statistics, and only the matching rows are decoded. No DuckDB, no native
 *  binary. Features are capped (20 000) with an honest note.
 */

import turfArea from '@turf/area'
import { fetchWithRetry, getRequestAbortSignal } from '../../cache'
import { genId, haversineKm, pointInAoi } from '../../geometry'
import { getLogger } from '../../logger'
import { toGeometry } from '../../pixels'
import type { Provenance, ResultLayer } from '../../types'
import type { VectorStyle } from '@/lib/vector-style'
import type { DatasetEntry } from '../types'
import { declaredExtent, describe, honest, noCoverageResult, r } from './common'
import type { ClassRow, ReadOpts, ReaderAoi, ReadResult, ReadStats } from './types'

const log = getLogger('registry/readers/overture')

export const MAX_FEATURES = 20_000
const STAC_ROOT = 'https://stac.overturemaps.org'

interface ThemeSpec { theme: string; type: string; columns: string[]; maxAreaKm2: number; label: string }

const THEMES: Record<string, ThemeSpec> = {
  buildings: { theme: 'buildings', type: 'building', columns: ['id', 'geometry', 'bbox', 'height', 'num_floors', 'class', 'subtype'], maxAreaKm2: 30, label: 'buildings' },
  places: { theme: 'places', type: 'place', columns: ['id', 'geometry', 'bbox', 'names', 'categories', 'confidence'], maxAreaKm2: 400, label: 'places' },
  transportation: { theme: 'transportation', type: 'segment', columns: ['id', 'geometry', 'bbox', 'class', 'subtype', 'names'], maxAreaKm2: 100, label: 'road/rail segments' },
  addresses: { theme: 'addresses', type: 'address', columns: ['id', 'geometry', 'bbox', 'number', 'street', 'postcode'], maxAreaKm2: 30, label: 'addresses' },
  divisions: { theme: 'divisions', type: 'division_area', columns: ['id', 'geometry', 'bbox', 'names', 'subtype', 'class'], maxAreaKm2: 5000, label: 'administrative areas' },
}

export function overtureSpec(entry: DatasetEntry): ThemeSpec | null {
  return THEMES[entry.id.replace(/^overture:/, '')] ?? null
}

let releaseCache: { value: string; at: number } | null = null

/** Latest Overture release id, from the STAC root (`latest: true`), falling back to the one in the registry URL. */
export async function overtureRelease(entry?: DatasetEntry): Promise<string> {
  const fromEntry = entry?.access.url.match(/release\/([0-9]{4}-[0-9]{2}-[0-9]{2}\.\d+)/)?.[1]
  if (releaseCache && Date.now() - releaseCache.at < 6 * 3600e3) return releaseCache.value
  try {
    const res = await fetchWithRetry(`${STAC_ROOT}/catalog.json`, undefined, { timeoutMs: 20_000 })
    if (res.ok) {
      const j: any = await res.json()
      const latest = (j.links ?? []).find((l: any) => l.rel === 'child' && l.latest)
      const id = String(latest?.href ?? '').match(/\/([0-9]{4}-[0-9]{2}-[0-9]{2}\.\d+)\//)?.[1]
      if (id) { releaseCache = { value: id, at: Date.now() }; return id }
    }
  } catch { /* fall through to the registry's release */ }
  if (!fromEntry) throw new Error('could not determine the current Overture release')
  return fromEntry
}

async function parquetUrlsFor(release: string, spec: ThemeSpec, bbox: number[]): Promise<string[]> {
  const base = `${STAC_ROOT}/${release}/${spec.theme}/${spec.type}/collection.json`
  const res = await fetchWithRetry(base, undefined, { timeoutMs: 40_000 })
  if (!res.ok) throw new Error(`Overture STAC collection answered HTTP ${res.status}`)
  const col: any = await res.json()
  const items = (col.links ?? []).filter((l: any) => l.rel === 'item')
  const boxes: number[][] = (col.extent?.spatial?.bbox ?? []).slice(1) // [0] is the union
  const hits: string[] = []
  items.forEach((l: any, i: number) => {
    const b = boxes[i]
    if (b && b[0] <= bbox[2] && b[2] >= bbox[0] && b[1] <= bbox[3] && b[3] >= bbox[1]) hits.push(new URL(l.href, base).href)
  })
  const urls: string[] = []
  for (const href of hits.slice(0, 4)) {
    const ir = await fetchWithRetry(href, undefined, { timeoutMs: 30_000 })
    if (!ir.ok) continue
    const item: any = await ir.json()
    const ib: number[] | undefined = item.bbox
    if (ib && !(ib[0] <= bbox[2] && ib[2] >= bbox[0] && ib[1] <= bbox[3] && ib[3] >= bbox[1])) continue
    const a = item.assets ?? {}
    const url = (a.aws ?? Object.values<any>(a)[0])?.href
    if (typeof url === 'string') urls.push(url)
  }
  return urls
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function vertices(g: any): number[][] {
  switch (g?.type) {
    case 'Point': return [g.coordinates]
    case 'LineString': case 'MultiPoint': return g.coordinates
    case 'Polygon': case 'MultiLineString': return g.coordinates.flat()
    case 'MultiPolygon': return g.coordinates.flat(2)
    default: return []
  }
}

/** Does this feature belong to the AOI? Points/polygons by centre of their bbox, lines by any vertex or centre. */
export function featureInAoi(row: { bbox?: any; geometry?: any }, aoi: any): boolean {
  const b = row.bbox
  if (b && Number.isFinite(b.xmin) && pointInAoi((b.xmin + b.xmax) / 2, (b.ymin + b.ymax) / 2, aoi)) return true
  const t = row.geometry?.type
  if (t === 'LineString' || t === 'MultiLineString') return vertices(row.geometry).some((c) => pointInAoi(c[0], c[1], aoi))
  return false
}

function lengthKm(g: any): number {
  const lines: number[][][] = g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : []
  let km = 0
  for (const l of lines) for (let i = 1; i < l.length; i++) km += haversineKm(l[i - 1][1], l[i - 1][0], l[i][1], l[i][0])
  return km
}

const primaryName = (n: any): string | null => (typeof n === 'string' ? n : typeof n?.primary === 'string' ? n.primary : null)

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Row groups decoded at once. */
const GROUP_CONCURRENCY = 6

export interface OvertureRows {
  rows: any[]
  files: number
  rowGroupsScanned: number
  /** Rows whose bbox met the query box, counted before `select`. Equals `rows.length` without a selector. */
  scanned?: number
  /** True when `limit` stopped the read early: the rows are then a prefix, not every match. */
  capped?: boolean
}

export interface OvertureReadOpts {
  /** Stop after this many rows met the query box. */
  limit?: number
  /** Decode only these columns (the `names` struct of a road segment is the heaviest column). */
  columns?: string[]
  /** Reduces each batch of box-matching rows to the ones to keep (or to what they are turned into), so a caller
   *  that tests geometry does not hold every row of a dense city. */
  select?: (rows: any[]) => any[]
}

/** Reads the rows whose bbox meets `bbox`, a FEW ROW GROUPS AT A TIME. Handing hyparquet the whole file
 *  decodes every candidate row group concurrently and holds all of them (geometry as nested JS arrays)
 *  until the last finishes: a 9 km box over Valencia peaked at 1.5 GB of heap for 24 000 matching road
 *  segments. Reading groups in small batches, keeping their matches and letting them go bounds the peak to a batch
 *  (about 60 000 rows) plus what is kept. `limit` stops the read once that many rows are kept; `columns`
 *  narrows the decode (the `names` struct of a road segment is the heaviest column). */
export async function readOvertureRows(urls: string[], spec: ThemeSpec, bbox: number[], opts: OvertureReadOpts = {}): Promise<OvertureRows> {
  const { asyncBufferFromUrl, cachedAsyncBuffer, parquetMetadataAsync, parquetReadObjects } = await import('hyparquet')
  const { compressors } = await import('hyparquet-compressors')
  const limit = opts.limit ?? Infinity
  const filter: any = {
    'bbox.xmin': { $lte: bbox[2] }, 'bbox.xmax': { $gte: bbox[0] },
    'bbox.ymin': { $lte: bbox[3] }, 'bbox.ymax': { $gte: bbox[1] },
  }
  const out: any[] = []
  let capped = false
  let groups = 0
  let scanned = 0
  for (const url of urls) {
    if (capped) break
    const file = cachedAsyncBuffer(await asyncBufferFromUrl({ url, requestInit: { signal: getRequestAbortSignal() } }))
    const metadata = await parquetMetadataAsync(file)
    const ranges: Array<[number, number]> = []
    let rowStart = 0
    for (const rg of metadata.row_groups) {
      ranges.push([rowStart, rowStart + Number(rg.num_rows)])
      rowStart += Number(rg.num_rows)
    }
    // A few groups at a time: the reads are latency-bound (HTTP range requests), the decode is bounded.
    for (let i = 0; i < ranges.length && !capped; i += GROUP_CONCURRENCY) {
      const batch = await Promise.all(ranges.slice(i, i + GROUP_CONCURRENCY).map(([rs, re]) =>
        // hyparquet still prunes the group from the bbox column statistics before decoding anything.
        parquetReadObjects({ file, metadata, compressors, columns: opts.columns ?? spec.columns, filter, rowStart: rs, rowEnd: re })))
      groups += batch.length
      for (const rows of batch) {
        const matched: any[] = []
        for (const row of rows) {
          const b = row.bbox
          if (b && b.xmin <= bbox[2] && b.xmax >= bbox[0] && b.ymin <= bbox[3] && b.ymax >= bbox[1]) {
            if (scanned + matched.length >= limit) { capped = true; break }
            matched.push(row)
          }
        }
        scanned += matched.length
        for (const kept of opts.select ? opts.select(matched) : matched) out.push(kept)
        if (capped) break
      }
    }
  }
  return { rows: out, files: urls.length, rowGroupsScanned: groups, scanned, capped }
}

/** Raw Overture rows of one theme whose bbox meets `bbox` (no AOI filter; optional row `limit`) — for callers
 *  that do their own geometry test, e.g. flood impact. Throws with a user-surfaceable message. */
export async function readOvertureTheme(
  theme: 'buildings' | 'transportation',
  bbox: number[],
  opts: OvertureReadOpts = {},
): Promise<OvertureRows & { release: string }> {
  const spec = THEMES[theme]
  const release = await overtureRelease()
  const urls = await parquetUrlsFor(release, spec, bbox)
  if (urls.length === 0) return { rows: [], files: 0, rowGroupsScanned: 0, release }
  return { ...(await readOvertureRows(urls, spec, bbox, opts)), release }
}

export async function readOverture(entry: DatasetEntry, aoi: ReaderAoi, opts: ReadOpts): Promise<ReadResult> {
  const spec = overtureSpec(entry)
  if (!spec) {
    return honest(entry, 'unavailable', { headline: `No Overture reader for "${entry.title}"`, body: ['Supported Overture themes: buildings, places, transportation, addresses, divisions.'] })
  }
  const geom = toGeometry(aoi.aoi)
  if (!geom) return honest(entry, 'error', { headline: 'The AOI is not a polygon', body: ['An Overture read needs a Polygon or MultiPolygon AOI.'] })
  if (aoi.areaKm2 > spec.maxAreaKm2) {
    return honest(entry, 'unavailable', {
      headline: `AOI too large for an in-app Overture read`,
      body: [`Reading ${spec.label} for ${aoi.areaKm2.toFixed(1)} km² would exceed the in-app limit of ${spec.maxAreaKm2} km² for this theme. Draw a smaller area.`],
      needs: 'smaller-aoi',
    })
  }

  let release: string
  let urls: string[]
  try {
    release = await overtureRelease(entry)
    urls = await parquetUrlsFor(release, spec, aoi.bbox)
  } catch (err: any) {
    return honest(entry, 'error', { headline: `Could not locate Overture ${spec.label} files`, body: [err?.message ?? 'Overture STAC was unreachable'] })
  }
  if (urls.length === 0) {
    return noCoverageResult(entry, aoi, `Overture release ${release} has no ${spec.label} file intersecting this AOI.`)
  }

  let read: OvertureRows
  try {
    read = await readOvertureRows(urls, spec, aoi.bbox)
  } catch (err: any) {
    log.warn({ err: err?.message }, 'overture parquet read failed')
    return honest(entry, 'error', { headline: `Reading Overture ${spec.label} failed`, body: [err?.message ?? 'parquet read error'] })
  }

  const inside = read.rows.filter((row) => featureInAoi(row, geom))
  const total = inside.length
  const kept = inside.slice(0, MAX_FEATURES)
  const capped = total > kept.length

  const features: any[] = []
  const heights: number[] = []
  const areas: number[] = []
  const classCounts = new Map<string, number>()
  let km = 0
  let withHeight = 0
  for (const row of kept) {
    const props: Record<string, any> = { id: row.id }
    if (spec.theme === 'buildings') {
      const h = typeof row.height === 'number' ? row.height : null
      const a = turfArea({ type: 'Feature', properties: {}, geometry: row.geometry } as any)
      props.height = h
      props.num_floors = row.num_floors ?? null
      props.class = row.class ?? null
      props.subtype = row.subtype ?? null
      props.area_m2 = Math.round(a)
      areas.push(a)
      if (h !== null) { heights.push(h); withHeight++ }
      if (row.class) classCounts.set(String(row.class), (classCounts.get(String(row.class)) ?? 0) + 1)
    } else if (spec.theme === 'places') {
      props.name = primaryName(row.names)
      props.category = row.categories?.primary ?? null
      props.confidence = row.confidence ?? null
      classCounts.set(String(props.category ?? 'uncategorised'), (classCounts.get(String(props.category ?? 'uncategorised')) ?? 0) + 1)
    } else if (spec.theme === 'transportation') {
      props.class = row.class ?? null
      props.subtype = row.subtype ?? null
      props.name = primaryName(row.names)
      props.length_km = r(lengthKm(row.geometry), 3)
      km += props.length_km
      classCounts.set(String(row.class ?? 'unknown'), (classCounts.get(String(row.class ?? 'unknown')) ?? 0) + 1)
    } else {
      props.name = primaryName(row.names)
      props.subtype = row.subtype ?? null
      props.class = row.class ?? null
    }
    features.push({ type: 'Feature', properties: props, geometry: row.geometry })
  }

  const classes: ClassRow[] = [...classCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([name, count], i) => ({ value: i, name, count, pct: kept.length ? (count / kept.length) * 100 : 0 }))

  // Style: buildings by height when most of them carry one anywhere near, else by footprint area.
  let vectorStyle: VectorStyle | undefined
  if (spec.theme === 'buildings' && kept.length) {
    vectorStyle = withHeight / kept.length >= 0.1
      ? { property: 'height', kind: 'graduated', method: 'quantile', numClasses: 5, colormap: 'viridis' }
      : { property: 'area_m2', kind: 'graduated', method: 'quantile', numClasses: 5, colormap: 'viridis' }
  } else if (spec.theme === 'places' && kept.length) vectorStyle = { property: 'category', kind: 'categorical' }
  else if (spec.theme === 'transportation' && kept.length) vectorStyle = { property: 'class', kind: 'categorical' }

  const hd = describe(heights)
  const ad = describe(areas)
  const footprintM2 = areas.reduce((s, a) => s + a, 0)
  const stats: ReadStats = {
    kind: 'vector', count: kept.length, total_in_aoi: total, classes,
    ...(hd ? { height_mean_m: r(hd.mean, 2), height_p95_m: r(hd.p95, 2), height_max_m: r(hd.max, 2), with_height: withHeight } : {}),
    ...(ad ? { footprint_area_m2: Math.round(footprintM2), footprint_share_pct: r((footprintM2 / (aoi.areaKm2 * 1e6)) * 100, 2) } : {}),
    ...(km ? { length_km: r(km, 2) } : {}),
  }

  const provenance: Provenance = {
    source: `Overture Maps ${spec.label}, release ${release} (${entry.license})`,
    method: `Overture STAC -> GeoParquet on S3 (HTTP range reads, row groups pruned by bbox statistics) -> rows whose ${spec.theme === 'transportation' ? 'geometry or bbox centre' : 'bbox centre'} falls inside the drawn polygon`,
    clip: 'polygon',
    date: release.slice(0, 10),
    resolution_limit: 'Conflated from OpenStreetMap, Microsoft, Google and others; completeness and attributes (height, class) vary by region.',
  }

  const sd: ReadResult['summary_data'] = { read: 'ok', dataset: entry.id, release, feature_count: kept.length, features_in_aoi: total }
  const lines: string[] = [`**${total.toLocaleString()} ${spec.label}** inside the AOI (${aoi.areaKm2.toFixed(2)} km²), Overture release ${release}.`]
  if (spec.theme === 'buildings') {
    if (ad) {
      sd.footprint_area_m2 = Math.round(footprintM2)
      sd.footprint_share_pct = r((footprintM2 / (aoi.areaKm2 * 1e6)) * 100, 2)
      sd.median_footprint_m2 = Math.round(ad.median)
      lines.push(`- footprints cover **${Math.round(footprintM2).toLocaleString()} m²** (${(sd.footprint_share_pct as number).toFixed(2)}% of the AOI), median building ${Math.round(ad.median)} m²`)
    }
    if (hd) {
      sd.buildings_with_height = withHeight
      sd.height_mean_m = r(hd.mean, 1)
      sd.height_p95_m = r(hd.p95, 1)
      lines.push(`- **${withHeight.toLocaleString()}** of ${kept.length.toLocaleString()} (${((withHeight / kept.length) * 100).toFixed(0)}%) carry a height: mean ${hd.mean.toFixed(1)} m, p95 ${hd.p95.toFixed(1)} m, max ${hd.max.toFixed(1)} m`)
    } else if (kept.length) {
      lines.push('- **No building here carries a height attribute** in Overture, so the layer is coloured by footprint area instead. Height needs lidar (see the 3DEP height-above-ground dataset in the US) or a model.')
    }
  } else if (km) {
    sd.length_km = r(km, 2)
    lines.push(`- total segment length **${km.toFixed(1)} km**`)
  }
  if (classes.length && spec.theme !== 'buildings') lines.push(`- top classes: ${classes.slice(0, 6).map((c) => `${c.name} ${c.count}`).join(', ')}`)
  if (classes.length && spec.theme === 'buildings') lines.push(`- building classes: ${classes.slice(0, 6).map((c) => `${c.name} ${c.count}`).join(', ')}`)
  if (capped) lines.push(`\n_Showing the first ${MAX_FEATURES.toLocaleString()} of ${total.toLocaleString()} features (in-app cap); the counts above cover the shown features only._`)
  if (total === 0) lines.push('\nOvertureMaps contains no features of this type inside the polygon (the files were searched; this is not a read failure).')

  const layer: ResultLayer | undefined = opts.render !== false && kept.length
    ? {
        id: `dataset-${genId()}`, name: `Overture ${spec.label}`.slice(0, 48), type: 'geojson',
        geojson: { type: 'FeatureCollection', features }, bounds: aoi.bbox, provenance, confidence: 'medium',
        ...(vectorStyle ? { vectorStyle } : {}),
      }
    : undefined

  return {
    status: 'ok',
    summary: `${lines.join('\n')}\n\n**Licence:** ${entry.license} · files read: ${read.files} (${urls.map((u) => u.split('/').pop()?.slice(0, 12)).join(', ')})`,
    stats, summary_data: sd, provenance,
    coverage: { verdict: total > 0 ? 'covered' : 'none', declared: declaredExtent(entry), found: `${total} feature(s) in the AOI from ${read.files} file(s)` },
    ...(layer ? { layer } : {}),
  }
}
