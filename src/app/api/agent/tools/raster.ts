/** render_raster — show ANY band, composite or band-math expression of a satellite
 *  scene over the drawn AOI.
 *
 *  Before this tool, only six hard-wired indices could be displayed; a raw band such as
 *  Sentinel-2 B08 (NIR) could not be shown at all, and the agent substituted whatever
 *  product it had. This tool never substitutes: an unknown band is an error that names
 *  the valid ones, and the returned layer is exactly what was asked for.
 *
 *  Output is an XYZ tile layer (titiler) plus a `raster` descriptor. The client masks
 *  pixels outside the polygon (`aoiMask`) and can restyle colormap / stretch without
 *  another agent turn. The default stretch is the p2-p98 of the AOI's own clear pixels.
 */

import { cachedFetchJson } from '../lib/cache'
import {
  PC_DATA,
  PC_STAC,
  SENSORS,
  sensorById,
  type SensorSpec,
} from '../lib/analysis/sensors'
import { compileBandExpression } from '../lib/analysis/band-expression'
import {
  CLEAR_CLASSES,
  MIN_USABLE_CLEAR_PCT,
  clarityNote,
  examinedScenes,
  landsatQaIsClear,
  noClearSceneMessage,
  pickClearestLandsatScene,
  pickClearestScene,
  rejectedScenesNote,
} from '../lib/cloud'
import { getLogger } from '../lib/logger'
import { span } from '../lib/timings'
import { parseNpy } from '../lib/npy'
import { fetchFeatureGrid, toGeometry } from '../lib/pixels'
import {
  COLORMAP_CHOICES,
  assetKeyForBand,
  buildRasterTileUrl,
  normalizeColormap,
  parseRasterSpec,
  parseRescale,
  roundSig,
  scaleExpression,
  stretchFromSummary,
  summarizeValues,
  validBandNames,
  type TileTarget,
  type ValueSummary,
} from '../lib/raster-render'
import { resolveBandSetReflectance, type ReflectanceTransform } from '../lib/reflectance'
import { STAC_SEARCH_URL, getStacItemHref, signPCAsset, toRfc3339Interval } from '../lib/stac'
import { TITILER_BASE } from '../lib/titiler'
import type { Confidence, SummaryDatum, ToolCtx, ToolOutput } from '../lib/types'
import type { RasterDescriptor } from '@/lib/raster-style'

const log = getLogger('tools/raster')

/** Longest-edge pixel budget for the AOI statistics grid. */
const GRID_MAX_SIZE = 256

const SHORT_NAME: Record<string, string> = { 'sentinel-2-l2a': 'Sentinel-2', 'landsat-c2-l2': 'Landsat' }
const PROVIDER: Record<string, string> = {
  'sentinel-2-l2a': 'AWS Element84 Earth Search + titiler.xyz',
  'landsat-c2-l2': 'Microsoft Planetary Computer',
}

// ---------------------------------------------------------------------------
// Time window
// ---------------------------------------------------------------------------

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Search window from `date` (+-3 days) or `start`/`end`; default the last 90 days. */
export function resolveWindow(
  args: Record<string, any>,
  now = Date.now(),
): { ok: true; datetime: string; label: string; explicit: boolean } | { ok: false; error: string } {
  const valid = (v: unknown): v is string => typeof v === 'string' && ISO_DAY.test(v) && !Number.isNaN(Date.parse(v))
  for (const k of ['date', 'start', 'end'] as const) {
    if (args[k] != null && !valid(args[k])) return { ok: false, error: `\`${k}\` must be a YYYY-MM-DD date, got "${String(args[k])}".` }
  }
  if (args.date) {
    const t = Date.parse(args.date)
    return { ok: true, datetime: `${isoDay(t - 3 * DAY_MS)}/${isoDay(t + 3 * DAY_MS)}`, label: `${args.date} (+-3 days)`, explicit: true }
  }
  if (args.start || args.end) {
    const end = args.end ?? isoDay(now)
    const start = args.start ?? isoDay(Date.parse(end) - 90 * DAY_MS)
    if (Date.parse(start) > Date.parse(end)) return { ok: false, error: '`start` is after `end`.' }
    return { ok: true, datetime: `${start}/${end}`, label: `${start} to ${end}`, explicit: true }
  }
  return { ok: true, datetime: `${isoDay(now - 90 * DAY_MS)}/${isoDay(now)}`, label: 'the last 90 days', explicit: false }
}

// ---------------------------------------------------------------------------
// Scene search + pixel reads (throw on fetch failure; empty result means no data)
// ---------------------------------------------------------------------------

async function stacSearch(url: string, body: Record<string, unknown>): Promise<any[]> {
  const data = await cachedFetchJson(`render-raster-search:${url}:${JSON.stringify(body)}`, 10 * 60 * 1000, async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`STAC search HTTP ${res.status}`)
    return res.json()
  })
  return (data?.features as any[]) ?? []
}

function searchScenes(sensor: SensorSpec, bbox: number[], datetime: string, capCloud: boolean): Promise<any[]> {
  const body: Record<string, unknown> = {
    collections: [sensor.collection],
    bbox,
    datetime: toRfc3339Interval(datetime),
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    limit: 12,
    ...(capCloud ? { query: { 'eo:cloud_cover': { lt: 70 } } } : {}),
  }
  return span('stac_search', () => stacSearch(sensor.id === 'sentinel-2-l2a' ? STAC_SEARCH_URL : PC_STAC, body))
}

/** Band-major pixels of one scene over the AOI: the requested bands, an optional
 *  quality band, then the validity mask — all on ONE grid (one request). */
interface SceneGrid {
  raw: ArrayLike<number>
  px: number
  nBands: number
  quality: ArrayLike<number> | null
  mask: ArrayLike<number>
}

async function readSceneGrid(
  sensor: SensorSpec,
  item: any,
  assets: string[],
  geom: any,
  bbox: [number, number, number, number],
): Promise<SceneGrid> {
  const n = assets.length
  if (sensor.id === 'sentinel-2-l2a') {
    const itemHref = getStacItemHref(item)
    if (!itemHref) throw new Error('scene has no canonical STAC item URL')
    const sclKey = item?.assets?.scl?.href ? 'scl' : item?.assets?.SCL?.href ? 'SCL' : null
    const g = await fetchFeatureGrid({
      itemHref,
      assets: sclKey ? [...assets, sclKey] : assets,
      geom,
      maxSize: GRID_MAX_SIZE,
      cacheTag: 'render-raster',
    })
    const px = g.width * g.height
    const hasQ = !!sclKey && g.bands >= n + 2
    if (g.bands < n + 1) throw new Error(`titiler returned ${g.bands} bands for a ${n}-band read`)
    return { raw: g.raw, px, nBands: n, quality: hasQ ? g.raw.subarray(n * px, (n + 1) * px) : null, mask: g.mask }
  }

  // Landsat: Planetary Computer's own titiler, explicit width/height from the AOI aspect.
  const [w0, s0, e0, n0] = bbox
  const lonSpan = Math.max((e0 - w0) * Math.cos(((s0 + n0) / 2) * Math.PI / 180), 1e-9)
  const latSpan = Math.max(n0 - s0, 1e-9)
  const long = Math.max(lonSpan, latSpan)
  const width = Math.max(8, Math.round((GRID_MAX_SIZE * lonSpan) / long))
  const height = Math.max(8, Math.round((GRID_MAX_SIZE * latSpan) / long))
  const qs = new URLSearchParams({
    collection: sensor.collection,
    item: String(item?.id ?? ''),
    width: String(width),
    height: String(height),
  })
  for (const a of assets) qs.append('assets', a)
  qs.append('assets', sensor.qualityAsset)
  const res = await fetch(`${PC_DATA}/item/feature.npy?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'Feature', properties: {}, geometry: geom }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) throw new Error(`Planetary Computer feature.npy HTTP ${res.status}`)
  const { shape, data } = parseNpy(Buffer.from(await res.arrayBuffer()))
  if (shape.length !== 3 || shape[0] < n + 2) throw new Error(`Planetary Computer returned ${shape[0] ?? '?'} bands for a ${n}-band + quality read`)
  const px = shape[1] * shape[2]
  return { raw: data, px, nBands: n, quality: data.subarray(n * px, (n + 1) * px), mask: data.subarray((n + 1) * px, (n + 2) * px) }
}

// ---------------------------------------------------------------------------
// Statistics over the AOI's clear pixels
// ---------------------------------------------------------------------------

interface AoiStats {
  /** Continuous: one summary. RGB: one per band (DN). */
  summaries: ValueSummary[]
  insidePx: number
  clearPx: number
  /** False when no quality band existed or the caller opted out of masking. */
  masked: boolean
}

function computeAoiStats(
  grid: SceneGrid,
  mode: 'single' | 'expression' | 'rgb',
  positional: string | undefined,
  transforms: ReflectanceTransform[],
  useMask: boolean,
  isClear: (q: number) => boolean,
): AoiStats {
  const { px, nBands, raw, mask, quality } = grid
  const masked = useMask && quality != null
  const evaluate = mode === 'rgb' ? null : compileBandExpression(positional!)
  const perBand: number[][] = Array.from({ length: mode === 'rgb' ? nBands : 1 }, () => [])
  const buf = new Float64Array(nBands)
  let insidePx = 0
  let clearPx = 0
  for (let i = 0; i < px; i++) {
    if (!mask[i]) continue
    insidePx++
    if (masked && !isClear(quality![i])) continue
    let skip = false
    for (let b = 0; b < nBands; b++) {
      const dn = raw[b * px + i]
      if (dn === 0 || !Number.isFinite(dn)) { skip = true; break } // DN 0 is nodata for both sensors
      buf[b] = mode === 'rgb' ? dn : dn * transforms[b].scale + transforms[b].offset
    }
    if (skip) continue
    if (evaluate) {
      const v = evaluate(buf)
      if (!Number.isFinite(v)) continue
      perBand[0].push(v)
    } else {
      for (let b = 0; b < nBands; b++) perBand[b].push(buf[b])
    }
    clearPx++
  }
  const summaries = perBand.map((vals) => summarizeValues(vals)).filter((s): s is ValueSummary => s != null)
  return { summaries: summaries.length === perBand.length ? summaries : [], insidePx, clearPx, masked }
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
}

export async function renderRaster(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const { aoi, bbox, areaKm2, emit } = ctx

  const sensor = sensorById(String(args.sensor ?? 'sentinel-2-l2a'))
  if (!sensor) {
    return { summary: `Unknown sensor "${String(args.sensor)}". Supported: ${SENSORS.map((s) => s.id).join(', ')}.` }
  }
  const spec = parseRasterSpec(sensor.id, { bands: args.bands, expression: args.expression })
  if (!spec.ok) return { summary: spec.error }

  let colormap: string | undefined
  if (spec.mode !== 'rgb') {
    colormap = normalizeColormap(args.colormap ?? 'viridis') ?? undefined
    if (!colormap) return { summary: `Unknown colormap "${String(args.colormap)}". Choose one of: ${COLORMAP_CHOICES.join(', ')} (append _r to reverse).` }
  } else if (args.colormap) {
    return { summary: 'A colormap does not apply to a 3-band RGB composite. Omit `colormap`, or pass one band / an expression.' }
  }
  const given = parseRescale(args.rescale, spec.mode === 'rgb' ? 3 : 1)
  if (!given.ok) return { summary: given.error }
  const window = resolveWindow(args)
  if (!window.ok) return { summary: window.error }

  const geom = toGeometry(aoi)
  if (!geom) return { summary: 'A polygon AOI is required (draw a polygon, rectangle, or circle).' }

  // ---- 1. scene ---------------------------------------------------------
  emit?.('token', { type: 'token', content: `Searching ${sensor.label} scenes for ${window.label}...\n` })
  let items: any[]
  try {
    items = await searchScenes(sensor, bbox, window.datetime, !window.explicit)
  } catch (err: any) {
    log.warn({ sensor: sensor.id, err: err?.message }, 'scene search failed')
    return { summary: `**Could not search ${sensor.label} scenes** (${err?.message ?? 'unknown error'}). This is a catalogue/network failure, not an absence of data — retry shortly.`, failed: true }
  }
  if (items.length === 0) {
    return { summary: `No ${sensor.label} scenes cover this AOI for ${window.label}. Nothing was rendered; try a wider \`start\`/\`end\` window.` }
  }

  emit?.('token', { type: 'token', content: `Scoring ${Math.min(items.length, 6)} candidate scene(s) on cloud over your AOI...\n` })
  // The AOI pixel read the stretch needs depends only on the chosen scene, so it starts for each
  // candidate while that candidate's reflectance gate runs (Q-15) instead of after it.
  const gridFor = (it: any): Promise<SceneGrid> => {
    const keys = spec.bands.map((band) => assetKeyForBand(sensor.id, band, it))
    if (keys.some((k) => !k)) return Promise.reject(new Error('scene lacks a requested band'))
    return span('stats', () => readSceneGrid(sensor, it, keys as string[], geom, bbox))
  }
  const choice = await span('scene_scoring', () => sensor.id === 'sentinel-2-l2a'
    ? pickClearestScene(items, geom, { speculate: gridFor })
    : pickClearestLandsatScene(items, geom, signPCAsset))
  const item = choice ? choice.item : items[0]
  const noClearScene = !choice
  const sceneId = String(item?.id ?? 'unknown')
  const sceneDate = String(item?.properties?.datetime ?? '').slice(0, 10)
  const sceneCloud = typeof item?.properties?.['eo:cloud_cover'] === 'number' ? (item.properties['eo:cloud_cover'] as number) : null
  const requestedDay = typeof args.date === 'string' ? args.date : null

  // ---- 2. assets + units ------------------------------------------------
  const assets: string[] = []
  for (const band of spec.bands) {
    const key = assetKeyForBand(sensor.id, band, item)
    if (!key) {
      return { summary: `Scene ${sceneId} (${sceneDate}) does not carry an asset for band ${band}. Bands available for ${sensor.label}: ${validBandNames(sensor.id).join(', ')}. Nothing was substituted.` }
    }
    assets.push(key)
  }
  const reflect = resolveBandSetReflectance(item, assets, {
    isSentinel2: sensor.id === 'sentinel-2-l2a',
    fallback: { scale: sensor.scale, offset: sensor.offset, note: `${sensor.label} sensor default` },
  })

  // ---- 3. AOI statistics for the stretch --------------------------------
  emit?.('token', { type: 'token', content: `Reading ${sceneId} over the AOI to set the display stretch...\n` })
  let stats: AoiStats | null = null
  let readError: string | null = null
  try {
    const grid = await ((choice?.speculative as Promise<SceneGrid> | undefined) ?? span('stats', () => readSceneGrid(sensor, item, assets, geom, bbox)))
    const isClear = sensor.qualityKind === 'scl'
      ? (q: number) => CLEAR_CLASSES.has(Math.round(q))
      : (q: number) => landsatQaIsClear(q)
    stats = computeAoiStats(grid, spec.mode, spec.positional, reflect.transforms, !noClearScene, isClear)
  } catch (err: any) {
    readError = err?.message ?? 'unknown error'
    log.warn({ sensor: sensor.id, scene: sceneId, err: readError }, 'AOI pixel read failed')
  }

  if (stats && stats.summaries.length === 0 && !given.rescale) {
    return {
      summary: `**No usable pixels.** Scene ${sceneId} (${sceneDate}) has ${stats.insidePx} pixels inside your polygon but none are both clear and valid for ${spec.expression ?? spec.bands.join('/')}. Nothing was rendered; try another date window.`,
    }
  }
  if (!stats && !given.rescale) {
    return {
      summary: `**Could not read the pixels** of scene ${sceneId} (${sceneDate}) to set a display stretch (${readError}). This is a fetch failure, not an absence of data. Retry, or pass an explicit \`rescale\` to render without AOI statistics.`,
      failed: true,
    }
  }

  // ---- 4. stretch + tile URL -------------------------------------------
  const nStretch = spec.mode === 'rgb' ? 3 : 1
  const measured = stats && stats.summaries.length === nStretch ? stats.summaries : null
  const rescale: [number, number][] = given.rescale
    ?? measured!.map((s) => stretchFromSummary(s, 'p2-p98'))
  const stretch: RasterDescriptor['stretch'] = given.rescale ? 'fixed' : 'p2-p98'

  const itemHref = getStacItemHref(item)
  const target: TileTarget | null = sensor.id === 'sentinel-2-l2a'
    ? itemHref ? { kind: 'stac', base: TITILER_BASE, itemHref } : null
    : { kind: 'pc', base: PC_DATA, collection: sensor.collection, itemId: sceneId }
  if (!target) return { summary: `Scene ${sceneId} has no canonical STAC item URL, so tiles cannot be requested. Nothing was rendered.` }

  const tileUrl = buildRasterTileUrl({
    target,
    assets,
    expression: spec.mode === 'rgb' ? undefined : scaleExpression(spec.positional!, reflect.transforms),
    rescale,
    colormap,
  })

  // ---- 5. layer ---------------------------------------------------------
  const short = SHORT_NAME[sensor.id]
  const what = spec.mode === 'expression' ? spec.expression! : spec.mode === 'rgb' ? `${spec.bands.join('/')} (RGB)` : spec.bands[0]
  const raster: RasterDescriptor = {
    kind: spec.mode === 'rgb' ? 'rgb' : 'continuous',
    sensor: sensor.id,
    collection: sensor.collection,
    sceneId,
    datetime: sceneDate || undefined,
    bands: spec.bands,
    ...(spec.mode === 'expression' ? { expression: spec.expression } : {}),
    rescale,
    stretch,
    ...(colormap ? { colormap } : {}),
    units: spec.mode === 'rgb' ? 'DN' : spec.mode === 'single' ? 'reflectance' : undefined,
  }

  const clearPct = choice ? choice.clarity.clearPct : null
  const confidence: Confidence = noClearScene ? 'low' : (clearPct ?? 0) >= 80 && (measured || given.rescale) ? 'high' : 'medium'
  const stretchText = given.rescale
    ? 'caller-supplied stretch'
    : `p2-p98 of ${stats!.clearPx} ${stats!.masked ? 'clear ' : ''}AOI pixels`
  const dnNote = spec.mode === 'rgb'
    ? 'raw DN per band'
    : `surface reflectance (${reflect.note})`

  const summary_data: Record<string, SummaryDatum> = {
    scene_date: sceneDate,
    scene_id: sceneId,
    area_km2: Number(areaKm2.toFixed(1)),
  }
  if (sceneCloud != null) summary_data.cloud_pct = Number(sceneCloud.toFixed(1))
  if (clearPct != null) summary_data.valid_pixel_pct = Number(clearPct.toFixed(1))
  if (measured) {
    if (spec.mode === 'rgb') {
      measured.forEach((s, i) => {
        summary_data[`${spec.bands[i]}_p2`] = roundSig(s.p2)
        summary_data[`${spec.bands[i]}_p98`] = roundSig(s.p98)
        summary_data[`${spec.bands[i]}_mean`] = roundSig(s.mean)
      })
    } else {
      const s = measured[0]
      Object.assign(summary_data, { min: roundSig(s.min), max: roundSig(s.max), p2: roundSig(s.p2), p98: roundSig(s.p98), mean: roundSig(s.mean) })
    }
    summary_data.clear_pixels = stats!.clearPx
  }

  const lines: string[] = []
  lines.push(`**${short} ${what}** rendered over ${areaKm2.toFixed(1)} km² (drawn polygon).`)
  lines.push(`**Scene:** ${sceneId} | **Date:** ${sceneDate}${requestedDay && requestedDay !== sceneDate ? ` (requested ${requestedDay}; nearest clear scene within +-3 days)` : ''} | **Scene-wide cloud:** ${sceneCloud != null ? `${sceneCloud.toFixed(1)}%` : 'N/A'}`)
  if (choice) lines.push(`**Scene quality (over your AOI):** ${clarityNote(choice.clarity)}`)
  const skipped = choice ? rejectedScenesNote(choice) : null
  if (skipped) lines.push(`**Caution:** ${skipped}`)
  if (measured && spec.mode !== 'rgb') {
    const s = measured[0]
    lines.push(`**Values over the AOI:** min ${roundSig(s.min)} · p2 ${roundSig(s.p2)} · mean ${roundSig(s.mean)} · p98 ${roundSig(s.p98)} · max ${roundSig(s.max)} (${raster.units ?? 'index value'})`)
  } else if (measured) {
    lines.push(`**Per-band DN over the AOI (p2–p98):** ${measured.map((s, i) => `${spec.bands[i]} ${roundSig(s.p2)}–${roundSig(s.p98)}`).join(' · ')}`)
  }
  lines.push(`**Stretch:** ${stretchText}${colormap ? ` · colormap ${colormap}` : ''}. Values are ${dnNote}.`)
  if (noClearScene) {
    const examined = await examinedScenes(items, geom).catch(() => [])
    lines.push(`**Caution:** no scene in ${window.label} reached ${MIN_USABLE_CLEAR_PCT}% clear sky over your AOI, so the newest scene is shown UNMASKED and includes cloud/shadow.${examined.length ? `\n${noClearSceneMessage(examined, window.label)}` : ''}`)
  }
  if (readError && given.rescale) lines.push(`_AOI statistics were unavailable (${readError}); the layer uses your \`rescale\`._`)
  lines.push('Pixels outside the polygon are hidden on the map; use the layer panel to change the colormap or stretch.')

  return {
    summary: lines.join('\n'),
    summary_data,
    layer: {
      id: `raster-${sensor.id === 'sentinel-2-l2a' ? 's2' : 'ls'}-${slug(what)}`,
      name: `${short} ${what} ${sceneDate}`.trim(),
      type: 'raster',
      tileUrl,
      bounds: bbox,
      aoiMask: true,
      raster,
      provenance: {
        source: `${sensor.label} via ${PROVIDER[sensor.id]} — ${what}`,
        date: sceneDate || undefined,
        method: `titiler XYZ tiles of ${spec.mode === 'rgb' ? 'a 3-band composite' : spec.mode === 'expression' ? `the expression ${spec.expression}` : `band ${spec.bands[0]}`}; ${stretchText}; ${dnNote}; clearest-scene pick by ${sensor.qualityKind === 'scl' ? 'SCL' : 'QA_PIXEL'} over the AOI${noClearScene ? ' (none reached the clear-sky floor — unmasked newest scene)' : ''}${skipped ? `; ${skipped}` : ''}`,
        clip: 'polygon (display mask)',
      },
      confidence,
    },
  }
}
