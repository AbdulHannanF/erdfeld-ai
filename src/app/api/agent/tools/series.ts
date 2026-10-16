/** scene_series: one cloud-masked index value per acquisition over the whole archive, not just the
 *  last year (`fetch_temporal_stack` stops at 12 months).
 *
 *  The scenes come from the same catalogue the timeline browses (`lib/scenes.ts`), one per day. Each
 *  value is the polygon-clipped, cloud-masked MEAN of the index in that scene (`maskedIndexStats` for
 *  Sentinel-2, the SCL mask; `readSensorIndexGrid` for Landsat, the QA mask), so a clouded day is a GAP,
 *  never a value and never interpolated. The chart rows carry the scene id and date so the timeline can
 *  jump to the scene a point is.
 */

import { validateVegaLite } from '../lib/chart-data'
import { SPECTRAL_INDEX_TILE_CONFIG } from '../lib/titiler'
import { sensorById } from '../lib/analysis/sensors'
import { readSensorIndexGrid } from '../lib/analysis/sensors'
import { genId } from '../lib/geometry'
import { maskedIndexStats } from '../lib/index-stats'
import { getLogger } from '../lib/logger'
import { toGeometry } from '../lib/pixels'
import { SCENE_SENSOR_INFO, searchSceneCatalogue, type SceneRecord, type SceneSensor } from '../lib/scenes'
import type { ChartItem } from '@/lib/chart-spec'
import type { SummaryDatum, ToolCtx, ToolOutput } from '../lib/types'

const log = getLogger('tools/series')

export const SERIES_MAX_SCENES = 150
/** A scene whose footprint box covers less of the area than this would give a mean of part of it. */
const MIN_COVERAGE_PCT = 90
/** Fewer clear pixels than this share of the area is a gap, not a value. */
const MIN_CLEAR_PCT = 40
const GRID = 96

export interface SeriesPoint {
  date: string
  value: number
  clearPct: number
  sceneId: string
  cloudScenePct: number | null
}

/** Even thinning to at most `max` scenes, always keeping the oldest and the newest. */
export function thin<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(items[Math.round((i * (items.length - 1)) / (max - 1))])
  return out
}

function chart(index: string, label: string, points: SeriesPoint[]): ChartItem | null {
  if (points.length < 2) return null
  const rows = points.map((p) => ({ date: p.date, value: p.value, clear_pct: p.clearPct, scene_id: p.sceneId, sensor: label }))
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    data: { values: rows },
    layer: [
      { mark: { type: 'line', color: '#2e7d32', strokeWidth: 1.5, opacity: 0.7 } },
      { mark: { type: 'point', filled: true, color: '#2e7d32', size: 36, opacity: 1 } },
    ],
    encoding: {
      x: { field: 'date', type: 'temporal', axis: { title: null, format: '%Y' } },
      y: { field: 'value', type: 'quantitative', axis: { title: `Mean ${index} (cloud-masked, drawn polygon)` }, scale: { zero: false } },
      tooltip: [
        { field: 'date', type: 'temporal', title: 'Acquisition' },
        { field: 'value', type: 'quantitative', title: `Mean ${index}`, format: '.3f' },
        { field: 'clear_pct', type: 'quantitative', title: 'Area clear (%)' },
        { field: 'scene_id', type: 'nominal', title: 'Scene' },
      ],
    },
  }
  const ok = validateVegaLite(spec)
  if (!ok.ok) {
    log.warn({ error: ok.error }, 'scene series chart rejected')
    return null
  }
  return { id: `chart-${genId()}`, title: `${index} per ${label} acquisition`, spec }
}

export async function sceneSeries(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const { aoi, bbox, emit } = ctx
  const sensor = (args.sensor ?? 'sentinel-2') as SceneSensor
  const info = SCENE_SENSOR_INFO[sensor]
  if (!info || !info.opSensor) return { summary: `\`sensor\` must be sentinel-2 or landsat; radar has no index to chart (got "${String(args.sensor)}").` }
  const index = String(args.index ?? 'NDVI').toUpperCase()
  if (!SPECTRAL_INDEX_TILE_CONFIG[index]) return { summary: `Unknown index "${index}". Supported: ${Object.keys(SPECTRAL_INDEX_TILE_CONFIG).join(', ')}.` }
  const geom = toGeometry(aoi)
  if (!geom) return { summary: 'A polygon AOI is required (draw a polygon, rectangle or circle).' }
  const maxCloud = typeof args.max_cloud === 'number' ? args.max_cloud : 60
  const maxScenes = Math.min(Math.max(2, Math.round(args.max_scenes ?? 60)), SERIES_MAX_SCENES)

  emit?.('token', { type: 'token', content: `Listing ${info.label} scenes over the area...\n` })
  const found = await searchSceneCatalogue({ sensor, bbox, from: args.start, to: args.end, maxCloud, order: 'asc', group: 'day', render: 'ndvi' })
  if (!found.ok) return { summary: found.message, failed: true }

  let candidates: SceneRecord[] = found.scenes
  if (Array.isArray(args.scene_ids) && args.scene_ids.length) {
    const want = new Set(args.scene_ids.map(String))
    candidates = candidates.filter((s) => want.has(s.id) || s.itemIds.some((i) => want.has(i)))
    if (candidates.length === 0) return { summary: `None of the ${want.size} scene ids is a scene of ${info.label} over this area in the window. Nothing was substituted.` }
  }
  if (candidates.length === 0) {
    return { summary: `The ${info.label} catalogue holds no scene over this area with scene-wide cloud at most ${maxCloud}% between ${found.window.from} and ${found.window.to}. Raise \`max_cloud\` or widen the dates.` }
  }
  const partial = candidates.filter((s) => s.coveragePct < MIN_COVERAGE_PCT)
  const whole = candidates.filter((s) => s.coveragePct >= MIN_COVERAGE_PCT)
  const usable = thin(whole, maxScenes)
  const thinned = whole.length > usable.length

  emit?.('token', { type: 'token', content: `Reading ${usable.length} scene${usable.length === 1 ? '' : 's'} over your polygon (cloud-masked)...\n` })
  const points: SeriesPoint[] = []
  const gaps: { date: string; reason: string }[] = []
  const lspec = sensorById('landsat-c2-l2')!
  const [w0, s0, e0, n0] = bbox
  const lonSpan = Math.max((e0 - w0) * Math.cos(((s0 + n0) / 2) * Math.PI / 180), 1e-9)
  const latSpan = Math.max(n0 - s0, 1e-9)
  const long = Math.max(lonSpan, latSpan)
  const width = Math.max(8, Math.round((GRID * lonSpan) / long))
  const height = Math.max(8, Math.round((GRID * latSpan) / long))

  const results: ({ point: SeriesPoint } | { gap: { date: string; reason: string } })[] = new Array(usable.length)
  let next = 0
  const read = async (i: number) => {
    const sc = usable[i]
    const item = found.itemsById.get(sc.id)
    if (!item) return { gap: { date: sc.date, reason: 'scene record missing' } }
    try {
      if (sensor === 'sentinel-2') {
        const out = await maskedIndexStats(item, index, aoi, { maxSize: GRID, minClearPct: MIN_CLEAR_PCT })
        if (!out.ok) return { gap: { date: sc.date, reason: out.failure.message } }
        return { point: { date: sc.date, value: Number(out.stats.mean.toFixed(4)), clearPct: Number(out.stats.clearPct.toFixed(0)), sceneId: sc.id, cloudScenePct: sc.cloudPct } }
      }
      const out = await readSensorIndexGrid({ sensor: lspec, item, index, aoi, width, height })
      if (!out.ok) return { gap: { date: sc.date, reason: out.message } }
      const g = out.grid
      const clearPct = (g.clearPixels / Math.max(1, g.insidePolygon)) * 100
      if (clearPct < MIN_CLEAR_PCT) return { gap: { date: sc.date, reason: `only ${clearPct.toFixed(0)}% of the area is clear` } }
      let sum = 0
      let n = 0
      for (let k = 0; k < g.values.length; k++) if (g.valid[k]) { sum += g.values[k]; n++ }
      if (n === 0) return { gap: { date: sc.date, reason: 'no valid pixels' } }
      return { point: { date: sc.date, value: Number((sum / n).toFixed(4)), clearPct: Number(clearPct.toFixed(0)), sceneId: sc.id, cloudScenePct: sc.cloudPct } }
    } catch (err: any) {
      return { gap: { date: sc.date, reason: `read failed (${err?.message ?? 'unknown'})` } }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, usable.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= usable.length) return
      results[i] = await read(i)
    }
  }))
  for (const r of results) {
    if ('point' in r) points.push(r.point)
    else gaps.push(r.gap)
  }
  points.sort((a, b) => a.date.localeCompare(b.date))

  if (points.length === 0) {
    return { summary: `No scene of ${usable.length} gave a usable ${index} value over the polygon (${gaps.slice(0, 3).map((g) => `${g.date}: ${g.reason}`).join('; ')}). Nothing is charted.`, ...(gaps.every((g) => /failed|fetch/i.test(g.reason)) ? { failed: true } : {}) }
  }

  const first = points[0]
  const last = points[points.length - 1]
  const lines: string[] = []
  lines.push(`**${index} per ${info.label} acquisition, ${first.date} to ${last.date}:** ${points.length} cloud-masked values from ${usable.length} scenes over ${found.scenes.length} in the catalogue window (oldest to newest).`)
  if (points.length >= 2) {
    const delta = last.value - first.value
    lines.push(`First **${first.value.toFixed(3)}** (${first.date}), last **${last.value.toFixed(3)}** (${last.date}), change ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}. Each value is the mean of the clear pixels inside the drawn polygon, one scene each.`)
  }
  if (thinned) lines.push(`_${whole.length} scenes qualified; every ${(whole.length / usable.length).toFixed(1)}th was read to stay within ${maxScenes} (the first and last are always kept). Raise \`max_scenes\` (up to ${SERIES_MAX_SCENES}) or narrow the dates for more._`)
  if (partial.length) lines.push(`_${partial.length} scene${partial.length === 1 ? '' : 's'} covered under ${MIN_COVERAGE_PCT}% of the area and ${partial.length === 1 ? 'was' : 'were'} left out rather than averaged over part of it._`)
  if (gaps.length) lines.push(`_${gaps.length} scene${gaps.length === 1 ? '' : 's'} gave no value (under ${MIN_CLEAR_PCT}% of the area clear, or the read failed) and ${gaps.length === 1 ? 'is a gap' : 'are gaps'} in the series, not interpolated._`)
  if (found.truncated) lines.push('_The catalogue search hit its size limit for at least one year, so some scenes of that year may be missing._')
  lines.push(`${sensor === 'sentinel-2' ? 'Sentinel-2' : 'Landsat'} values are not comparable with the other sensor's: the two disagree by 0.02 to 0.11 NDVI on the same ground.`)

  const sd: Record<string, SummaryDatum> = {
    scene_count: points.length,
    scenes_in_window: found.scenes.length,
    gaps: gaps.length,
    first_date: first.date,
    last_date: last.date,
    [`${index.toLowerCase()}_first`]: first.value,
    [`${index.toLowerCase()}_last`]: last.value,
    [`${index.toLowerCase()}_by_date`]: points.map((p) => ({ label: p.date, value: p.value })),
  }
  const c = chart(index, info.short, points)
  return {
    summary: lines.join('\n'),
    summary_data: sd,
    ...(c ? { charts: [c] } : {}),
  }
}
