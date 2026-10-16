/** Lidar: derived rasters (readable) and point clouds (metadata only).
 *
 *  (a) USGS 3DEP via Planetary Computer: DSM / DTM / height-above-ground / intensity /
 *      classification COGs go through the STAC reader with a lidar profile.
 *  (b) Point clouds (3DEP COPC, USGS EPT, OpenTopography surveys): there is no browser
 *      point-cloud renderer yet, so the answer is real metadata: how many point-cloud tiles
 *      cover the AOI, point density, acquisition years, project, links, and which derived
 *      raster to read instead.
 *  (c) Outside the US: OpenTopography's catalog (key-free) tells the user whether lidar exists.
 */

import { fetchWithRetry } from '../../cache'
import type { ClassDef } from '../../discovery/use-dataset'
import { getLogger } from '../../logger'
import type { DatasetEntry } from '../types'
import sharp from 'sharp'
import { colormapStops } from '@/lib/raster-style'
import { genId } from '../../geometry'
import { toGeometry } from '../../pixels'
import { authToken, datasetInfo, declaredExtent, describe, fmtDate, noCoverageResult, r } from './common'
import { readItems, readStac, searchItems, type StacProfile } from './stac'
import type { ReadOpts, ReaderAoi, ReadResult } from './types'

const log = getLogger('registry/readers/lidar')

/** ASPRS LAS point classes: the standard the 3DEP classification rasters are documented to use. */
export const ASPRS_CLASSES: ClassDef[] = [
  { value: 1, name: 'Unclassified' }, { value: 2, name: 'Ground' }, { value: 3, name: 'Low vegetation' },
  { value: 4, name: 'Medium vegetation' }, { value: 5, name: 'High vegetation' }, { value: 6, name: 'Building' },
  { value: 7, name: 'Low point (noise)' }, { value: 9, name: 'Water' }, { value: 10, name: 'Rail' },
  { value: 11, name: 'Road surface' }, { value: 13, name: 'Wire guard' }, { value: 14, name: 'Wire conductor' },
  { value: 15, name: 'Transmission tower' }, { value: 17, name: 'Bridge deck' }, { value: 18, name: 'High noise' },
]

export function lidarProfile(entry: DatasetEntry): StacProfile {
  const kind = entry.id.replace(/^planetary-computer:3dep-lidar-/, '')
  switch (kind) {
    case 'hag':
      return { assets: ['data'], aliases: /height|canopy|building|chm|ndsm|hag|vegetation/i, label: 'Height above ground (canopy / building height)', unit: 'm', height: true, colormap: 'viridis' }
    case 'dsm':
      return { assets: ['data'], aliases: /elevation|surface|dsm|height/i, label: 'Lidar surface elevation (DSM)', unit: 'm', colormap: 'terrain' }
    case 'dtm': case 'dtm-native':
      return { assets: ['data'], aliases: /elevation|terrain|ground|dtm|height/i, label: 'Lidar bare-earth elevation (DTM)', unit: 'm', colormap: 'terrain' }
    case 'intensity':
      return { assets: ['data'], aliases: /intensity|data/i, label: 'Lidar return intensity', colormap: 'greys' }
    case 'classification':
      return { assets: ['data'], aliases: /class|data/i, label: 'Lidar point classification', classes: ASPRS_CLASSES }
    default:
      return { assets: ['data'], aliases: /data/i, label: entry.title }
  }
}

export async function readLidarDerived(entry: DatasetEntry, aoi: ReaderAoi, opts: ReadOpts): Promise<ReadResult> {
  const res = await readStac(entry, aoi, opts, lidarProfile(entry))
  if (res.status === 'no_coverage') {
    // 3DEP has gaps even inside the US: say where else to look.
    const ot = await otCatalog(aoi.bbox, 'PointCloud')
    return { ...res, summary: `${res.summary}\n\n${otParagraph(ot)}` }
  }
  if (res.status === 'ok' && entry.id.endsWith('3dep-lidar-hag') && res.stats?.kind === 'continuous') {
    return crossCheckHag(entry, aoi, opts, res)
  }
  return res
}

// ---------------------------------------------------------------------------
// HAG sanity check against DSM - DTM
//
// Measured 2026-10-11 over downtown Denver (-104.995..-104.975, 39.735..39.75): the 3DEP
// height-above-ground COG of the 2013 South Platte project reads mean 89 m and p98 553 m,
// while that project's own DSM minus DTM gives a mean of 7 m. Cell by cell the HAG values
// are 20-180 m where DSM-DTM is 1-9 m. Publishing "building height 89 m" because the raster
// said so would be a confident wrong answer, so the HAG read is always compared with the
// surface-minus-terrain height of the same project and the disagreement is stated.
// ---------------------------------------------------------------------------

export function hagLooksWrong(hag: { mean: number; p95: number }, ndsm: { mean: number; p95: number }): boolean {
  return hag.mean > 3 * ndsm.mean + 10 || hag.p95 > 2 * ndsm.p95 + 30
}

async function projectItems(collection: string, bbox: number[], project: string): Promise<any[]> {
  const found = await searchItems('https://planetarycomputer.microsoft.com/api/stac/v1', collection, bbox, {})
  return found.items.filter((i) => String(i?.properties?.['3dep:usgs_id'] ?? '') === project)
}

/** DSM minus DTM over the polygon for one 3DEP project; null when either surface is unavailable. */
export async function ndsmForProject(aoi: ReaderAoi, project: string): Promise<{ values: Float64Array; width: number; height: number; stats: NonNullable<ReturnType<typeof describe>> } | null> {
  const geom = toGeometry(aoi.aoi)
  if (!geom || !project) return null
  const [dsmItems, dtmItems] = await Promise.all([projectItems('3dep-lidar-dsm', aoi.bbox, project), projectItems('3dep-lidar-dtm', aoi.bbox, project)])
  if (!dsmItems.length || !dtmItems.length) return null
  const [dsm, dtm] = await Promise.all([readItems(dsmItems.slice(0, 6), 'data', geom), readItems(dtmItems.slice(0, 6), 'data', geom)])
  if ('error' in dsm || 'error' in dtm || dsm.width !== dtm.width || dsm.height !== dtm.height) return null
  const out = new Float64Array(dsm.values.length).fill(NaN)
  const vals: number[] = []
  for (let i = 0; i < out.length; i++) {
    const h = dsm.values[i] - dtm.values[i]
    if (Number.isFinite(h)) { out[i] = Math.max(0, h); vals.push(out[i]) }
  }
  const stats = describe(vals)
  return stats ? { values: out, width: dsm.width, height: dsm.height, stats } : null
}

/** RGBA PNG (base64) of a value grid through a colormap; NaN is transparent. */
export async function gridToPng(values: Float64Array, width: number, height: number, lo: number, hi: number, colormap: string): Promise<string> {
  const stops = (colormapStops(colormap) ?? ['#440154', '#21918c', '#fde725']).map((c) => {
    const n = parseInt(c.replace('#', ''), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  })
  const buf = Buffer.alloc(width * height * 4)
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo || 1))) * (stops.length - 1)
    const a = Math.floor(t)
    const b = Math.min(stops.length - 1, a + 1)
    const f = t - a
    for (let c = 0; c < 3; c++) buf[i * 4 + c] = Math.round(stops[a][c] + (stops[b][c] - stops[a][c]) * f)
    buf[i * 4 + 3] = 255
  }
  const png = await sharp(buf, { raw: { width, height, channels: 4 } }).png().toBuffer()
  return png.toString('base64')
}

async function crossCheckHag(entry: DatasetEntry, aoi: ReaderAoi, opts: ReadOpts, res: ReadResult): Promise<ReadResult> {
  const st = res.stats!
  const project = String(res.summary.match(/Lidar project `([^`]+)`/)?.[1] ?? '')
  let nd: Awaited<ReturnType<typeof ndsmForProject>> = null
  try { nd = await ndsmForProject(aoi, project) } catch (err: any) { log.warn({ err: err?.message }, 'nDSM cross-check failed') }
  if (!nd) {
    return { ...res, summary: `${res.summary}\n- Not cross-checked: no matching DSM/DTM pair for this project was available to validate the HAG raster.` }
  }
  const hag = { mean: Number(st.mean), p95: Number(st.p95 ?? st.p98) }
  const nd95 = nd.stats.p95
  if (!hagLooksWrong(hag, { mean: nd.stats.mean, p95: nd95 })) {
    return {
      ...res,
      summary: `${res.summary}\n- Cross-check: DSM minus DTM of the same project gives mean ${nd.stats.mean.toFixed(1)} m, p95 ${nd95.toFixed(1)} m, consistent with the HAG raster.`,
      summary_data: { ...res.summary_data, ndsm_mean_m: r(nd.stats.mean, 2), ndsm_p95_m: r(nd95, 2), hag_cross_check: 'consistent' },
    }
  }

  const d = nd.stats
  const png = opts.render === false ? undefined : await gridToPng(nd.values, nd.width, nd.height, 0, Math.max(d.p98, 1), 'viridis')
  const provenance = { ...(res.provenance as NonNullable<ReadResult['provenance']>), method: `3DEP DSM minus DTM of project ${project}, both read through titiler /cog/feature.npy with the drawn polygon as a cutline; negative differences set to 0`, resolution_limit: '2 m lidar-derived surfaces; the difference includes vegetation, buildings, bridges and any residual noise.' }
  const summary =
    `**${entry.title}: the HAG raster looks wrong here, so height comes from DSM minus DTM.**\n\n` +
    `**Canopy / building height over the AOI (${aoi.areaKm2.toFixed(2)} km², ${d.count.toLocaleString()} valid px), DSM − DTM:**\n\n` +
    `- mean **${d.mean.toFixed(1)} m** · median ${d.median.toFixed(1)} m · σ ${d.std.toFixed(1)}\n` +
    `- p5 ${d.p5.toFixed(1)} · p95 ${d.p95.toFixed(1)} · max ${d.max.toFixed(1)} m (the maximum can include noise; p95 is robust)\n\n` +
    `**Why not the HAG raster:** it reads mean ${hag.mean.toFixed(1)} m and p95 ${hag.p95.toFixed(1)} m for the same polygon, ` +
    `which the same project's surface and terrain models contradict (cell-by-cell it is tens of metres where DSM − DTM is a few). ` +
    `The \`3dep-lidar-hag\` derivative of project \`${project}\` is not reliable over this area; its raw numbers are kept in the data fields as \`hag_raster_*\`, not as heights.\n\n` +
    `**Project:** \`${project}\` · **Licence:** ${entry.license}`
  const layer = png
    ? {
        id: `dataset-${genId()}`, name: 'Canopy / building height (DSM − DTM)', type: 'raster' as const, imageBase64: png, bounds: aoi.bbox, aoiMask: true,
        provenance, confidence: 'medium' as const,
        palette: { kind: 'gradient' as const, min: 0, max: r(Math.max(d.p98, 1), 1), unit: 'm', label: 'Height above ground', stops: (colormapStops('viridis') ?? []).map((color, i, a) => ({ value: r((Math.max(d.p98, 1) * i) / Math.max(1, a.length - 1), 1), color })) },
      }
    : undefined
  return {
    status: 'ok', summary,
    stats: { kind: 'continuous', variable: 'Canopy / building height (DSM - DTM)', unit: 'm', ...d },
    summary_data: {
      read: 'ok', dataset: entry.id, height_source: 'dsm_minus_dtm', pixel_count: d.count,
      mean: r(d.mean, 2), median: r(d.median, 2), min: r(d.min, 2), max: r(d.max, 2), std: r(d.std, 2), p95: r(d.p95, 2), unit: 'm',
      mean_height_m: r(d.mean, 2), p95_height_m: r(d.p95, 2),
      hag_raster_mean_m: r(hag.mean, 2), hag_raster_p95_m: r(hag.p95, 2), hag_cross_check: 'inconsistent',
      ...(res.summary_data.date ? { date: res.summary_data.date } : {}),
    },
    provenance,
    coverage: res.coverage,
    ...(layer ? { layer } : {}),
  }
}

// ---------------------------------------------------------------------------
// OpenTopography catalog (key-free)
// ---------------------------------------------------------------------------

export interface OtDataset { name: string; id: string; idType: string; format: string; temporal: string; created: string; url: string }

export async function otCatalog(
  bbox: number[], productFormat: 'PointCloud' | 'Raster',
): Promise<{ ok: true; datasets: OtDataset[] } | { ok: false; error: string }> {
  const [minx, miny, maxx, maxy] = bbox
  const url = `https://portal.opentopography.org/API/otCatalog?productFormat=${productFormat}&minx=${minx}&miny=${miny}&maxx=${maxx}&maxy=${maxy}&detail=false&outputFormat=json&include_federated=true`
  try {
    const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } }, { timeoutMs: 40_000 })
    if (!res.ok) return { ok: false, error: `OpenTopography catalog answered HTTP ${res.status}` }
    const json: any = JSON.parse(await res.text())
    const datasets: OtDataset[] = (json?.Datasets ?? []).map((d: any) => {
      const x = d?.Dataset ?? d
      const id = String(x?.identifier?.value ?? '')
      const idType = String(x?.identifier?.propertyID ?? '')
      const format = String(x?.fileFormat ?? productFormat)
      return {
        name: String(x?.name ?? 'unnamed'), id, idType, format,
        temporal: String(x?.temporalCoverage ?? '').replace(/\s*\/\s*/, ' to ') || 'not stated',
        created: String(x?.dateCreated ?? ''),
        url: x?.url ? String(x.url) : idType === 'opentopoID'
          ? `https://portal.opentopography.org/${/point/i.test(format) ? 'lidarDataset' : 'rasterDataset'}?opentopoID=${encodeURIComponent(id)}`
          : idType === 'USGS_3DEP_ID' ? `https://usgs-lidar-public.s3.amazonaws.com/${encodeURIComponent(id)}/ept.json` : 'https://portal.opentopography.org/dataCatalog',
      }
    })
    return { ok: true, datasets }
  } catch (err: any) {
    log.warn({ err: err?.message }, 'OpenTopography catalog lookup failed')
    return { ok: false, error: `OpenTopography catalog lookup failed: ${err?.message ?? 'network error'}` }
  }
}

export function otParagraph(ot: Awaited<ReturnType<typeof otCatalog>>): string {
  if (!ot.ok) return `**Other lidar sources:** ${ot.error}. This is a lookup failure, not evidence that no lidar exists.`
  if (ot.datasets.length === 0) {
    return '**Other lidar sources:** the OpenTopography catalog (including federated USGS 3DEP and international collections) lists **no lidar point-cloud survey** intersecting this AOI.'
  }
  const rows = ot.datasets.slice(0, 8).map((d) => `- ${d.name} (${d.temporal}) — ${d.url}`)
  return `**Other lidar sources:** the OpenTopography catalog lists **${ot.datasets.length} point-cloud survey(s)** intersecting this AOI:\n${rows.join('\n')}${ot.datasets.length > 8 ? `\n- ... and ${ot.datasets.length - 8} more` : ''}`
}

/** A lidar entry whose coverage pre-check failed (US-only dataset, AOI elsewhere): refuse, then look elsewhere. */
export async function lidarOutsideCoverage(entry: DatasetEntry, aoi: ReaderAoi, reason: string): Promise<ReadResult> {
  const ot = await otCatalog(aoi.bbox, 'PointCloud')
  const res = noCoverageResult(entry, aoi, reason, otParagraph(ot))
  res.summary_data = { ...res.summary_data, opentopography_surveys: ot.ok ? ot.datasets.length : -1 }
  return res
}

// ---------------------------------------------------------------------------
// Point-cloud metadata
// ---------------------------------------------------------------------------

const EPT_BASE = 'https://usgs-lidar-public.s3.amazonaws.com'

/** Points per m² of a COPC tile from `pc:count` and its projected (metre) bbox. */
export function copcDensity(item: any): number | null {
  const count = Number(item?.properties?.['pc:count'])
  const b: number[] | undefined = item?.properties?.['proj:bbox']
  if (!Number.isFinite(count) || !Array.isArray(b)) return null
  const [x0, y0, x1, y1] = b.length >= 6 ? [b[0], b[1], b[3], b[4]] : b
  const area = (x1 - x0) * (y1 - y0)
  return area > 0 ? count / area : null
}

async function searchCopc(aoi: ReaderAoi): Promise<{ items: any[]; error?: string }> {
  try {
    const res = await fetchWithRetry('https://planetarycomputer.microsoft.com/api/stac/v1/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collections: ['3dep-lidar-copc'], bbox: aoi.bbox, limit: 100 }),
    }, { timeoutMs: 45_000 })
    if (!res.ok) return { items: [], error: `Planetary Computer answered HTTP ${res.status}` }
    return { items: ((await res.json()) as any).features ?? [] }
  } catch (err: any) {
    return { items: [], error: `Planetary Computer was unreachable: ${err?.message ?? 'network error'}` }
  }
}

async function eptSummary(project: string): Promise<{ points: number; url: string } | null> {
  const url = `${EPT_BASE}/${encodeURIComponent(project)}/ept.json`
  try {
    const res = await fetchWithRetry(url, undefined, { timeoutMs: 20_000, retryOn429: false })
    if (!res.ok) return null
    const j: any = await res.json()
    return typeof j?.points === 'number' ? { points: j.points, url } : null
  } catch {
    return null
  }
}

const DERIVED_HINT =
  'Derived rasters you can read now with `use_dataset`: `planetary-computer:3dep-lidar-hag` (canopy/building height), ' +
  '`planetary-computer:3dep-lidar-dsm` (surface), `planetary-computer:3dep-lidar-dtm` (bare earth), `...-intensity`, `...-classification`.'

export async function readPointCloud(entry: DatasetEntry, aoi: ReaderAoi, _opts: ReadOpts): Promise<ReadResult> {
  const isUsgs = entry.id === 'planetary-computer:3dep-lidar-copc' || entry.access.kind === 'ept'
  const body: string[] = []
  const sd: ReadResult['summary_data'] = { read: 'metadata', dataset: entry.id }
  let items: any[] = []

  if (isUsgs) {
    const s = await searchCopc(aoi)
    items = s.items
    if (s.error) body.push(`Coverage search failed: ${s.error}.`)
  }
  const ot = await otCatalog(aoi.bbox, 'PointCloud')

  const projects = new Map<string, any[]>()
  for (const it of items) {
    const id = String(it?.properties?.['3dep:usgs_id'] ?? it?.id)
    projects.set(id, [...(projects.get(id) ?? []), it])
  }
  const dens = items.map(copcDensity).filter((d): d is number => d !== null && d > 0)
  const ends = items.map((i) => fmtDate(i?.properties?.end_datetime)).filter(Boolean).sort()

  const covered = items.length > 0 || (ot.ok && ot.datasets.length > 0) || entry.source === 'opentopography'
  if (isUsgs && items.length > 0) {
    const d = describe(dens)
    sd.copc_tiles = items.length
    sd.projects = projects.size
    if (d) { sd.point_density_median_pts_m2 = r(d.median, 1); sd.point_density_min_pts_m2 = r(d.min, 1); sd.point_density_max_pts_m2 = r(d.max, 1) }
    if (ends.length) { sd.acquired_first = ends[0]; sd.acquired_last = ends[ends.length - 1] }
    body.push(
      `**3DEP point-cloud coverage:** ${items.length}${items.length >= 100 ? '+' : ''} COPC tile(s) from ${projects.size} project(s) intersect the AOI.` +
      `${d ? ` Point density **${d.median.toFixed(1)} pts/m²** (median; range ${d.min.toFixed(1)} to ${d.max.toFixed(1)}).` : ''}` +
      `${ends.length ? ` Acquired ${ends[0].slice(0, 7)}${ends[ends.length - 1] !== ends[0] ? ` to ${ends[ends.length - 1].slice(0, 7)}` : ''}.` : ''}`,
    )
    const rows: string[] = []
    for (const [id, its] of [...projects.entries()].slice(0, 5)) {
      const ept = await eptSummary(id)
      const yr = fmtDate(its[0]?.properties?.end_datetime).slice(0, 4)
      rows.push(`- \`${id}\`${yr ? ` (${yr})` : ''}: ${its.length} tile(s) in the AOI${ept ? `; ${ept.points.toLocaleString()} points project-wide; EPT ${ept.url}` : ''}`)
    }
    body.push(`Projects:\n${rows.join('\n')}`)
    const first = items[0]?.assets?.data?.href
    if (first) body.push(`Example tile (needs SAS signing via the Planetary Computer): ${String(first).split('?')[0]}`)
  } else if (isUsgs && !items.length) {
    body.push('No 3DEP point-cloud tile intersects this AOI in the Planetary Computer COPC collection.')
  }

  if (entry.source === 'opentopography') {
    sd.survey_start = entry.temporal.start ?? ''
    body.push(
      `**Survey:** ${entry.title}. Declared footprint ${declaredExtent(entry)}. ` +
      `Download needs ${authToken('opentopography').have ? 'the configured OPENTOPO_API_KEY (no in-app point-cloud reader yet)' : 'an OpenTopography API key (OPENTOPO_API_KEY, not set here)'}.`,
    )
  }
  body.push(otParagraph(ot))
  if (ot.ok) sd.opentopography_surveys = ot.datasets.length
  body.push(DERIVED_HINT)
  body.push('**Not done in-app:** point clouds are not streamed or rendered here (no browser point-cloud viewer or PDAL service yet). Only the metadata above is real; no point statistics are reported.')

  if (!covered) {
    return {
      ...noCoverageResult(entry, aoi, 'No lidar point-cloud survey was found intersecting this AOI.', body.join('\n\n')),
      summary_data: { ...sd, read: 'no_coverage' },
    }
  }
  const coverage = { verdict: 'covered' as const, declared: declaredExtent(entry), found: items.length ? `${items.length} COPC tile(s), ${projects.size} project(s)` : `${ot.ok ? ot.datasets.length : 0} survey(s) in the OpenTopography catalog`, items_matched: items.length }
  return {
    status: 'ok',
    summary: `**${entry.title}: point-cloud metadata for this AOI** (not point statistics).\n\n${body.join('\n\n')}\n\n${datasetInfo(entry)}`,
    stats: { kind: 'metadata', count: items.length, ...(dens.length ? { density_pts_m2: r(describe(dens)!.median, 1) } : {}), ...(ends.length ? { first_acquired: ends[0] } : {}) },
    summary_data: sd,
    provenance: {
      source: isUsgs ? 'USGS 3DEP lidar via Microsoft Planetary Computer (COPC) and OpenTopography catalog' : 'OpenTopography catalog',
      method: 'STAC search of the COPC collection over the AOI bbox; point density = pc:count / tile area; OpenTopography otCatalog bbox query',
      clip: 'bbox', ...(ends.length ? { date: ends[ends.length - 1] } : {}),
      resolution_limit: 'Metadata only: tile footprints are bounding boxes, density is a tile average.',
    },
    coverage,
  }
}
