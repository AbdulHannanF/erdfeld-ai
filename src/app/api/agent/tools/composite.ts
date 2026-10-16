/** composite — cloud-masked MEDIAN composite over a date window, computed by the Python geo
 *  service (services/geo, Q-22) instead of picking one scene (Q-18).
 *
 *  Per pixel: the median of every clear observation (SCL-masked) in the window, then the band
 *  or index maths on that median. It is not an acquisition: the result says how many scenes and
 *  how many clear observations per pixel stand behind it. Tiles are served through our own
 *  proxy (`/api/geo/tiles/...`), because the service is server-side only.
 *
 *  Honesty: a failed upstream read is `failed`, never "no data"; "no scenes in the window" and
 *  "every pixel masked" are explicit, distinct answers; nothing is drawn without a composite.
 */

import { composite, GeoServiceError, type CompositeRequest, type CompositeResponse } from '../lib/geo-service'
import { getLogger } from '../lib/logger'
import { toGeometry } from '../lib/pixels'
import { normalizeColormap, roundSig } from '../lib/raster-render'
import type { Confidence, SummaryDatum, ToolCtx, ToolOutput } from '../lib/types'
import type { RasterDescriptor } from '@/lib/raster-style'

const log = getLogger('tools/composite')

export const COMPOSITE_INDICES = ['NDVI', 'NDWI', 'NDBI', 'EVI', 'NBR', 'SAVI'] as const
/** Longest window the operation accepts (a year: the service holds every clear day in RAM). */
export const MAX_SPAN_DAYS = 366
export const DEFAULT_SPAN_DAYS = 30
/** A median of fewer clear days than this is barely a median. */
export const THIN_OBS = 3
const SOURCE = 'Sentinel-2 L2A (AWS Element84 Earth Search), cloud-masked median composite via the geo service'

export interface CompositeArgs {
  bands?: string[]
  expression?: string
  start?: string
  end?: string
  colormap?: string
  rescale?: number[]
  resolution?: number
  max_cloud?: number
}

export const DAY_MS = 86_400_000
export const spanDays = (start: string, end: string): number => Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1

/** The window the service is asked for: the given dates, else the last 30 days. */
export function resolveCompositeWindow(args: Pick<CompositeArgs, 'start' | 'end'>, now = Date.now()): { start: string; end: string } {
  const end = args.end ?? new Date(now).toISOString().slice(0, 10)
  const start = args.start ?? new Date(Date.parse(`${end}T00:00:00Z`) - (DEFAULT_SPAN_DAYS - 1) * DAY_MS).toISOString().slice(0, 10)
  return { start, end }
}

const namedIndex = (expression?: string): string | undefined =>
  expression && (COMPOSITE_INDICES as readonly string[]).includes(expression.trim().toUpperCase()) ? expression.trim().toUpperCase() : undefined

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
const upstream = (e: unknown) => (e instanceof GeoServiceError ? e : null)

/** The proxy URL for a composite's tiles; `{z}/{x}/{y}` stay literal for MapLibre. */
export function compositeTileUrl(id: string, style: { rescale: [number, number][]; colormap?: string }): string {
  const q = new URLSearchParams()
  if (style.colormap) q.set('colormap_name', style.colormap)
  q.set('rescale', style.rescale[0].join(','))
  return `/api/geo/tiles/${id}/{z}/{x}/{y}?${q.toString().replace(/%2C/g, ',')}`
}

export async function runComposite(ctx: ToolCtx, args: CompositeArgs): Promise<ToolOutput> {
  const geometry = toGeometry(ctx.aoi)
  if (!geometry) return { summary: 'A polygon AOI is required (draw a polygon, rectangle, or circle).' }
  const { start, end } = resolveCompositeWindow(args)
  const resolution = args.resolution ?? 10
  const what = args.expression ?? (args.bands ?? []).join('/')
  const index = namedIndex(args.expression)
  const rgb = !args.expression && args.bands?.length === 3

  const colormap = rgb ? undefined : (normalizeColormap(args.colormap ?? (index ? 'rdylgn' : 'viridis')) ?? undefined)
  if (!rgb && !colormap) return { summary: `Unknown colormap "${String(args.colormap)}".` }

  const req: CompositeRequest = {
    geometry, start, end, resolution,
    ...(args.max_cloud != null ? { max_cloud: args.max_cloud } : {}),
    ...(args.expression ? { expression: args.expression } : { bands: args.bands! }),
  }
  ctx.emit?.('token', { type: 'token', content: `Building a cloud-masked median composite of Sentinel-2 ${what} for ${start} to ${end}...\n` })

  let res: CompositeResponse
  try {
    res = await composite(req)
  } catch (e) {
    const err = upstream(e)
    log.warn({ err: err ? `${err.kind}: ${err.detail}` : String(e) }, 'composite failed')
    if (err && !err.isUpstreamFailure) {
      // Our request was refused (bad expression, AOI/stack over the service's memory cap): not a fetch failure.
      return { summary: `**Composite not computed:** the geo service refused the request (${err.kind}: ${err.detail}). Try a smaller area, a coarser \`resolution\` or a shorter window.` }
    }
    const why = err ? `${err.kind}: ${err.detail}` : e instanceof Error ? e.message : String(e)
    return { summary: `**Could not build the composite for ${start} to ${end}** (${why}). This is a fetch failure of the imagery source or the geo service, not an absence of data — retry shortly.`, failed: true }
  }

  const sources = [SOURCE]
  if (res.item_count === 0) {
    return {
      summary: `**No Sentinel-2 scenes** intersect this AOI between ${start} and ${end}${args.max_cloud != null ? ` with scene cloud cover under ${args.max_cloud}%` : ''}. No composite was made; this is an absence of scenes, not a failed fetch. Try a wider window${args.max_cloud != null ? ' or drop `max_cloud`' : ''}.`,
      summary_data: { item_count: 0 },
      sources,
    }
  }
  if (!res.id) {
    return {
      summary: `**Every pixel was masked.** ${res.item_count} Sentinel-2 scene(s) cover this AOI between ${start} and ${end}, but cloud, shadow or no-data masked every pixel in all of them, so no composite exists. Nothing is drawn; try a longer window.`,
      summary_data: { item_count: res.item_count, valid_pixel_pct: 0 },
      sources,
      provenance_items: res.items,
    }
  }

  const names = res.bands ?? []
  const stats = names.map((n) => res.stats?.[n])
  if (!res.tile_url_template || stats.length === 0 || stats.some((s) => !s)) {
    return { summary: `**Could not use the geo service's answer** for composite ${res.id}: it returned no tile template or band statistics. Nothing is drawn.`, failed: true }
  }

  // Legend and tiles use the same stretch: p2-p98 of the composite itself (a flat field falls back to min-max).
  const range = (s: NonNullable<(typeof stats)[number]>): [number, number] => {
    const [lo, hi] = [s.p2, s.p98]
    if (lo != null && hi != null && hi > lo) return [roundSig(lo, 4), roundSig(hi, 4)]
    return [roundSig(s.min ?? NaN, 4), roundSig(s.max ?? NaN, 4)]
  }
  const given = args.rescale as [number, number] | undefined
  const rescale: [number, number][] = rgb ? [[0, 0.3], [0, 0.3], [0, 0.3]] : [given ?? range(stats[0]!)]
  const tileUrl = compositeTileUrl(res.id, { rescale, colormap })

  const meanObs = res.valid_obs_per_pixel?.mean
  const minObs = res.valid_obs_per_pixel?.min
  const valid = res.valid_pixel_pct ?? 0
  const confidence: Confidence = valid >= 90 && (minObs ?? 0) >= THIN_OBS ? 'high' : valid >= 60 && (meanObs ?? 0) >= THIN_OBS ? 'medium' : 'low'

  const raster: RasterDescriptor = {
    kind: rgb ? 'rgb' : 'continuous',
    sensor: 'sentinel-2-l2a',
    collection: 'sentinel-2-l2a',
    datetime: `${start}/${end}`,
    bands: rgb ? names : undefined,
    ...(args.expression ? { expression: args.expression } : {}),
    ...(index ? { index } : {}),
    rescale,
    stretch: given ? 'fixed' : rgb ? 'fixed' : 'p2-p98',
    ...(colormap ? { colormap } : {}),
    ...(rgb || (!args.expression && args.bands?.length === 1) ? { units: 'reflectance' } : {}),
  }

  const summary_data: Record<string, SummaryDatum> = {
    composite_id: res.id,
    window_start: start,
    window_end: end,
    item_count: res.item_count,
    valid_pixel_pct: res.valid_pixel_pct ?? 0,
    area_km2: Number(ctx.areaKm2.toFixed(1)),
  }
  if (res.scene_days != null) summary_data.scene_days = res.scene_days
  if (meanObs != null) summary_data.obs_per_pixel_mean = meanObs
  if (minObs != null) summary_data.obs_per_pixel_min = minObs
  names.forEach((n, i) => {
    const s = stats[i]!
    const key = names.length === 1 ? '' : `${n}_`
    for (const k of ['min', 'max', 'mean', 'p2', 'p98'] as const) if (s[k] != null) summary_data[`${key}${k}`] = roundSig(s[k]!)
  })

  const lines = [`**Sentinel-2 ${what} — cloud-masked median composite, ${start} to ${end}**, over ${ctx.areaKm2.toFixed(1)} km² (drawn polygon, ${resolution} m).`]
  lines.push(`**Built from:** ${res.item_count} scene(s) on ${res.scene_days ?? '?'} acquisition day(s); the value of each pixel is the median of its clear observations${meanObs != null ? ` (${meanObs} per pixel on average, minimum ${minObs})` : ''}. This is not a single acquisition date.`)
  lines.push(`**Valid pixels:** ${valid}% of the AOI has at least one clear observation${res.cached ? ' (composite reused from the service cache)' : ''}.`)
  if (!rgb && stats[0]) {
    const s = stats[0]
    lines.push(`**Values over the AOI:** p2 ${roundSig(s.p2 ?? NaN)} · mean ${roundSig(s.mean ?? NaN)} · p98 ${roundSig(s.p98 ?? NaN)} (min ${roundSig(s.min ?? NaN)}, max ${roundSig(s.max ?? NaN)}); display stretch ${given ? 'caller-supplied' : 'p2–p98 of the composite'}${colormap ? `, colormap ${colormap}` : ''}.`)
  }
  if (valid < 100) lines.push(`${(100 - valid).toFixed(1)}% of the AOI had no clear observation in the window and is left empty, not filled.`)
  if ((meanObs ?? Infinity) < THIN_OBS) lines.push(`**Caution:** only ${meanObs} clear observation(s) per pixel on average; a median of so few is close to a single-date value and cloud residue is not averaged out. Try a longer window.`)
  if (res.message) lines.push(res.message)

  const notes = [
    `Median of ${res.item_count} scene(s) on ${res.scene_days ?? '?'} day(s) between ${start} and ${end}, not a single acquisition date; changes inside the window (harvest, flood, burn) are blended.`,
    'Cloud, shadow and cirrus are masked per pixel with the SCL layer; "dark area" pixels are also dropped, so some very dark surfaces can be under-represented.',
  ]
  if (meanObs != null) notes.push(`Clear observations per pixel: mean ${meanObs}, min ${minObs}, max ${res.valid_obs_per_pixel?.max}.`)

  return {
    summary: lines.join('\n'),
    summary_data,
    provenance_items: res.items,
    uncertainty: { notes },
    layer: {
      id: `composite-${slug(what)}-${res.id.slice(0, 8)}`,
      name: `Median ${what} ${start}/${end}`,
      type: 'raster',
      tileUrl,
      bounds: res.bounds ?? ctx.bbox,
      aoiMask: true,
      raster,
      provenance: {
        source: SOURCE,
        method: `per-pixel median of SCL-clear observations over ${start}..${end} (${res.item_count} scenes, ${res.scene_days ?? '?'} days), then ${args.expression ? `the expression ${args.expression}` : `bands ${names.join('/')}`}; ${resolution} m UTM grid; composite ${res.id}`,
        clip: 'polygon (display mask)',
      },
      confidence,
    },
  }
}
