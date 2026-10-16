/** Digitizing tools: raster → vector polygons from real Sentinel-2 pixels.
 *
 *  vectorize_raster  — threshold any spectral index / band expression and trace the
 *                      result as polygons (water bodies, burn scars, dense vegetation…).
 *  delineate_fields  — every agricultural field in the AOI, from a season of NDVI:
 *                      multi-temporal watershed segmentation + phenology labels.
 *
 *  Both read cloud-masked, polygon-clipped pixels at ~10 m (lib/digitize/scene-grid.ts)
 *  and vectorize in-process (lib/vectorize). Neither names a crop and neither claims
 *  to resolve anything finer than the 10 m pixel.
 */

import { compileBandExpression, toPositionalExpression } from '../lib/analysis/band-expression'
import { dateWindow } from '../lib/analysis/grid-source'
import { examinedScenes, noClearSceneMessage, pickClearestScene, rejectedScenesNote } from '../lib/cloud'
import { chooseMaxSize, readMaskedGrid, resolveExpression, searchSentinel2, S2_GSD_M } from '../lib/digitize/scene-grid'
import { delineateFromStack } from '../lib/fields/delineate'
import { loadNdviStack, selectSeasonScenes } from '../lib/fields/ndvi-stack'
import { CLASS_COLORS, CLASS_ORDER, classLabels, type PhenClass } from '../lib/fields/phenology'
import { validateVegaLite } from '../lib/chart-data'
import { genId } from '../lib/geometry'
import { getLogger } from '../lib/logger'
import { toGeometry } from '../lib/pixels'
import { SPECTRAL_INDEX_TILE_CONFIG } from '../lib/titiler'
import { vectorizeMask } from '../lib/vectorize'
import type { ChartItem } from '@/lib/chart-spec'
import type { VectorStyle } from '@/lib/vector-style'
import type { Confidence, Provenance, SummaryDatum, ToolCtx, ToolOutput } from '../lib/types'

const log = getLogger('agent/digitize')

const SOURCE = 'Sentinel-2 L2A (AWS Earth Search) via titiler /stac/feature.npy'
/** Beyond this many polygons the largest are kept and the cut is reported. */
const MAX_POLYGONS = 5000

function unavailable(message: string): ToolOutput {
  return { summary: `Real data unavailable: ${message}` }
}

/** The upstream could not be reached or read: a fetch failure, not an absence of data. */
function unreachable(message: string): ToolOutput {
  return { ...unavailable(message), failed: true }
}

const fmt = (v: number, d = 1) => v.toLocaleString('en-US', { maximumFractionDigits: d })

// ---------------------------------------------------------------------------
// vectorize_raster
// ---------------------------------------------------------------------------

type Op = '>' | '<' | 'between'

/** Sensible starting thresholds, used (and said so) when the caller names only an index. */
const DEFAULT_RULE: Record<string, { op: Op; t: number }> = {
  NDWI: { op: '>', t: 0.2 },
  NBR: { op: '<', t: -0.1 },
  NDVI: { op: '>', t: 0.6 },
  NDBI: { op: '>', t: 0.1 },
  EVI: { op: '>', t: 0.4 },
  SAVI: { op: '>', t: 0.4 },
}

const INDEX_COLOR: Record<string, string> = {
  NDWI: '#2563eb', NBR: '#dc2626', NDVI: '#16a34a', NDBI: '#a1a1aa', EVI: '#15803d', SAVI: '#65a30d',
}

/** Graduated ramp for the mean-value property (dry→wet / bare→green / low→high). */
const INDEX_COLORMAP: Record<string, string> = {
  NDWI: 'blues', NDVI: 'rdylgn', EVI: 'rdylgn', SAVI: 'rdylgn', NBR: 'rdylgn', NDBI: 'ylorrd',
}

function normalizeOp(raw: unknown): Op | null {
  const s = String(raw ?? '').trim().toLowerCase()
  if (s === '>' || s === '>=' || s === 'gt' || s === 'above') return '>'
  if (s === '<' || s === '<=' || s === 'lt' || s === 'below') return '<'
  if (s === 'between' || s === 'range') return 'between'
  return null
}

export async function vectorizeRaster(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const geom = toGeometry(ctx.aoi)
  if (!geom) return unavailable('vectorize_raster needs a polygon AOI (draw a polygon, rectangle, or circle).')

  // ---- what to threshold ---------------------------------------------------
  const indexKey = args.index ? String(args.index).toUpperCase().trim() : ''
  let bandKeys: string[][]
  let evaluate: (b: ArrayLike<number>) => number
  let label: string
  let bounds: [number, number] | undefined
  if (args.expression) {
    try {
      const r = resolveExpression(String(args.expression))
      bandKeys = r.bandKeys
      evaluate = r.evaluate
      label = r.display
      bounds = [-1e4, 1e4]
    } catch (err: any) {
      return unavailable(`could not use the expression "${args.expression}": ${err?.message}.`)
    }
  } else if (indexKey) {
    const cfg = SPECTRAL_INDEX_TILE_CONFIG[indexKey]
    bandKeys = cfg.bandKeys
    evaluate = compileBandExpression(toPositionalExpression(cfg.exprTemplate))
    label = indexKey
  } else {
    return unavailable('vectorize_raster needs an `index` or an `expression`.')
  }

  // ---- the rule -------------------------------------------------------------
  const dflt = DEFAULT_RULE[indexKey]
  const op: Op | null = args.op ? normalizeOp(args.op) : dflt?.op ?? null
  if (!op) return unavailable('`op` must be ">", "<" or "between" (and a `threshold`).')
  let lo = Number(args.threshold)
  let hi = Number(args.threshold_upper)
  let usedDefault = false
  if (!Number.isFinite(lo)) {
    if (dflt && dflt.op === op && op !== 'between') { lo = dflt.t; usedDefault = true }
    else return unavailable(`${op === 'between' ? 'a `threshold` (lower) and `threshold_upper`' : 'a `threshold`'} is required for this rule.`)
  }
  if (op === 'between') {
    if (!Number.isFinite(hi)) return unavailable('`between` needs both `threshold` (lower) and `threshold_upper`.')
    if (hi < lo) [lo, hi] = [hi, lo]
  }
  const rule = op === 'between' ? `${lo} ≤ ${label} ≤ ${hi}` : `${label} ${op} ${lo}`

  const minAreaM2 = Number.isFinite(Number(args.min_area_m2)) && Number(args.min_area_m2) >= 0 ? Number(args.min_area_m2) : 500

  // ---- scene ----------------------------------------------------------------
  const sizing = chooseMaxSize(geom, S2_GSD_M, 1000)
  if (!sizing) return unavailable('the AOI polygon has no usable extent.')
  const dateArg = typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : undefined
  const window = dateWindow(dateArg)
  ctx.emit?.('token', { type: 'token', content: `Digitizing where ${rule} on Sentinel-2 (${window.label})...\n` })

  const found = await searchSentinel2(sizing.bbox, window.datetime, 12)
  if (!found.ok) return unreachable(found.message)
  if (found.items.length === 0) return unavailable(`no Sentinel-2 L2A scene covers this AOI in the ${window.label}.`)
  const choice = await pickClearestScene(found.items, geom, { maxCandidates: 6 })
  if (!choice) return { summary: noClearSceneMessage(await examinedScenes(found.items, geom), window.label) }

  const read = await readMaskedGrid({
    item: choice.item, geom, bandKeys, evaluate, label: indexKey || 'EXPR', maxSize: sizing.maxSize, bounds,
    cacheTag: `vecr-${indexKey || 'expr'}-${sizing.maxSize}`,
  })
  if (!read.ok) {
    return unreachable(`${read.message} The public titiler.xyz instance is rate-limited — retry, or self-host (TITILER_ENDPOINT).`)
  }
  const g = read.grid

  // ---- threshold + vectorize ----------------------------------------------
  const px = g.width * g.height
  const mask = new Uint8Array(px)
  let hits = 0
  for (let i = 0; i < px; i++) {
    const v = g.values[i]
    if (v !== v) continue
    if (op === '>' ? v > lo : op === '<' ? v < lo : v >= lo && v <= hi) { mask[i] = 1; hits++ }
  }
  const vec = vectorizeMask(mask, g.width, g.height, { bbox: g.bbox, minAreaM2 })

  const gsd = (g.cellXm + g.cellYm) / 2
  const pixelAreaM2 = g.cellXm * g.cellYm
  const observedKm2 = (g.insidePx * pixelAreaM2) / 1e6
  const clearNote = `${g.clearPct.toFixed(0)}% of the observed AOI was clear (${g.clearPx.toLocaleString()} of ${g.insidePx.toLocaleString()} pixels)`

  const resolutionLimit =
    `Sentinel-2 L2A at ${S2_GSD_M} m native; read at ${gsd.toFixed(1)} m/px here. Features narrower than ~20 m ` +
    `(two pixels) are not resolved, edges are accurate to about one pixel, and small gaps may be closed. ` +
    `Pixels hidden by cloud or shadow are unknown, so areas are a lower bound where the scene is not fully clear.`
  const provenance: Provenance = {
    source: SOURCE,
    date: g.date,
    method:
      `per-pixel ${label} (${g.reflectanceNote}) on a ${g.width}×${g.height} polygon-clipped grid; SCL cloud/shadow/cirrus masked; ` +
      `threshold ${rule}; 4-connected components traced to polygons (Douglas–Peucker 0.7 px), components under ${fmt(minAreaM2, 0)} m² dropped` +
      (rejectedScenesNote(choice) ? `; ${rejectedScenesNote(choice)}` : ''),
    clip: 'polygon',
    resolution_limit: resolutionLimit,
  }

  if (vec.polygons.length === 0) {
    return {
      summary:
        `**No polygons where ${rule}** in the ${g.date} scene (${clearNote}). ` +
        (hits > 0
          ? `${hits.toLocaleString()} pixel(s) met the rule but every connected group was under ${fmt(minAreaM2, 0)} m², so none was kept.`
          : 'No clear pixel met the rule — this is a measured absence, not a fetch failure.') +
        `\n\n${resolutionLimit}`,
      summary_data: { polygon_count: 0, total_area_m2: 0, scene_date: g.date, rule, valid_pixel_pct: Math.round(g.clearPct) },
      sources: [SOURCE],
      provenance_items: [String(choice.item?.id)],
    }
  }

  // Per-polygon mean of the underlying values, from the component grid.
  const sum = new Float64Array(vec.polygons.reduce((m, p) => Math.max(m, p.id), 0) + 1)
  const cnt = new Int32Array(sum.length)
  for (let i = 0; i < px; i++) {
    const id = vec.labels[i]
    if (id) { sum[id] += g.values[i]; cnt[id]++ }
  }
  const sorted = [...vec.polygons].sort((a, b) => b.areaM2 - a.areaM2)
  const kept = sorted.slice(0, MAX_POLYGONS)
  const color = INDEX_COLOR[indexKey] ?? '#f59e0b'
  const features = kept.map((p, i) => ({
    type: 'Feature' as const,
    properties: {
      name: `${label} ${op === 'between' ? `${lo}…${hi}` : `${op} ${lo}`}`,
      id: i + 1,
      area_m2: Math.round(p.areaM2),
      area_ha: Number((p.areaM2 / 10_000).toFixed(3)),
      pixels: p.areaPx,
      mean_value: Number((sum[p.id] / cnt[p.id]).toFixed(3)),
      color,
    },
    geometry: { type: 'Polygon' as const, coordinates: p.coordinates },
  }))

  const totalM2 = vec.polygons.reduce((s, p) => s + p.areaM2, 0)
  const pctObserved = (totalM2 / (observedKm2 * 1e6)) * 100
  const truncated = sorted.length > kept.length
  const vectorStyle: VectorStyle = { property: 'mean_value', kind: 'graduated', method: 'quantile', numClasses: 5, colormap: INDEX_COLORMAP[indexKey] ?? 'viridis' }
  const confidence: Confidence = g.clearPct >= 80 ? 'medium' : 'low'

  const summary_data: Record<string, SummaryDatum> = {
    polygon_count: vec.polygons.length,
    total_area_m2: Math.round(totalM2),
    total_area_ha: Number((totalM2 / 10_000).toFixed(2)),
    pct_of_observed_aoi: Number(pctObserved.toFixed(1)),
    largest_area_m2: Math.round(sorted[0].areaM2),
    min_area_m2: minAreaM2,
    dropped_small: vec.droppedSmall,
    scene_date: g.date,
    grid_gsd_m: Number(gsd.toFixed(1)),
    valid_pixel_pct: Math.round(g.clearPct),
    rule,
  }

  return {
    summary:
      `**Digitized ${vec.polygons.length} polygon${vec.polygons.length === 1 ? '' : 's'} where ${rule}** — ` +
      `${fmt(totalM2)} m² (${fmt(totalM2 / 10_000, 2)} ha, ${pctObserved.toFixed(1)}% of the observed AOI) from the ${g.date} Sentinel-2 scene.\n\n` +
      `- Largest: ${fmt(sorted[0].areaM2)} m²; ${vec.droppedSmall} smaller group(s) under ${fmt(minAreaM2, 0)} m² dropped.\n` +
      (usedDefault ? `- No threshold was given, so the default for ${indexKey} (${rule}) was used — adjust it if the polygons look too generous or too tight.\n` : '') +
      (truncated ? `- Showing the ${MAX_POLYGONS.toLocaleString()} largest of ${vec.polygons.length.toLocaleString()} polygons.\n` : '') +
      `- ${clearNote}.\n\n**Resolution:** ${resolutionLimit}`,
    summary_data,
    layer: {
      id: `vectorize-${genId()}`,
      name: `${label}: ${rule} (${vec.polygons.length})`,
      type: 'geojson',
      geojson: { type: 'FeatureCollection', features },
      bounds: g.bbox,
      provenance,
      confidence,
      vectorStyle,
    },
    provenance_items: [String(choice.item?.id)],
  }
}

// ---------------------------------------------------------------------------
// delineate_fields
// ---------------------------------------------------------------------------

const ISO = /^\d{4}-\d{2}-\d{2}$/
const isoDay = (d: Date) => d.toISOString().slice(0, 10)

const SCHEMA = 'https://vega.github.io/schema/vega-lite/v5.json'
/** The season-profile chart draws at most this many fields (largest first). */
const MAX_PROFILE_FIELDS = 150

/** Server-built charts from the delineation's own results (rows inlined here, never typed by the model).
 *  `_fid` is the feature's index in the layer, which links chart clicks and map highlighting. */
function buildFieldCharts(
  features: any[],
  present: PhenClass[],
  labels: Record<PhenClass, string>,
  layerId: string,
): ChartItem[] {
  const fields = features
    .map((f, fid) => ({ p: f.properties, fid }))
    .filter((x) => x.p.is_field)
    .sort((a, b) => b.p.area_ha - a.p.area_ha)
  const shown = fields.slice(0, MAX_PROFILE_FIELDS)
  const rows: Record<string, any>[] = []
  for (const { p, fid } of shown) {
    ;(p.profile_dates as string[]).forEach((date, k) => {
      const ndvi = p.profile_values[k]
      if (typeof ndvi === 'number') rows.push({ _fid: fid, field: `Field ${p.field_id}`, date, ndvi, class: labels[p.class as PhenClass] })
    })
  }
  const used = present.filter((c) => fields.some((x) => x.p.class === c))
  const domain = used.map((c) => labels[c])
  const range = used.map((c) => CLASS_COLORS[c])
  const capped = fields.length > shown.length
  const charts: ChartItem[] = []
  if (rows.length) {
    charts.push({
      id: `chart-${genId()}`,
      title: `NDVI season profile per field${capped ? ` (${shown.length} largest of ${fields.length})` : ` (${shown.length})`}`,
      layerId,
      spec: {
        $schema: SCHEMA,
        data: { values: rows },
        params: [{ name: 'pick', select: { type: 'point', fields: ['_fid'] } }],
        mark: { type: 'line', point: { size: 20 }, strokeWidth: 1.5 },
        encoding: {
          x: { field: 'date', type: 'temporal', axis: { title: null, format: '%b %d' } },
          y: { field: 'ndvi', type: 'quantitative', scale: { zero: false }, axis: { title: 'NDVI' } },
          detail: { field: '_fid', type: 'nominal' },
          color: { field: 'class', type: 'nominal', scale: { domain, range }, legend: { title: 'Phenology class' } },
          tooltip: [
            { field: 'field', title: 'Field' }, { field: 'class', title: 'Class' },
            { field: 'date', type: 'temporal', title: 'Date' }, { field: 'ndvi', type: 'quantitative', title: 'NDVI', format: '.2f' },
          ],
        },
      },
    })
  }
  const areaRows = used.map((c) => ({ label: labels[c], class: labels[c], ha: Number(fields.filter((x) => x.p.class === c).reduce((s, x) => s + x.p.area_ha, 0).toFixed(2)) }))
  if (areaRows.length) {
    charts.push({
      id: `chart-${genId()}`,
      title: 'Field area by phenology class (ha)',
      spec: {
        $schema: SCHEMA,
        data: { values: areaRows },
        mark: { type: 'bar', cornerRadiusEnd: 2 },
        encoding: {
          x: { field: 'label', type: 'nominal', sort: '-y', axis: { title: null, labelAngle: -30 } },
          y: { field: 'ha', type: 'quantitative', axis: { title: 'Area (ha)' } },
          color: { field: 'class', type: 'nominal', scale: { domain, range }, legend: null },
          tooltip: [{ field: 'label', title: 'Class' }, { field: 'ha', type: 'quantitative', title: 'Area (ha)' }],
        },
      },
    })
  }
  return charts
}

export async function delineateFields(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const geom = toGeometry(ctx.aoi)
  if (!geom) return unavailable('delineate_fields needs a polygon AOI (draw a polygon, rectangle, or circle).')

  const endDate = typeof args.end === 'string' && ISO.test(args.end) ? args.end : isoDay(new Date())
  const startDate = typeof args.start === 'string' && ISO.test(args.start)
    ? args.start
    : isoDay(new Date(Date.parse(`${endDate}T00:00:00Z`) - 365 * 86_400_000))
  const spanDays = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000
  if (!(spanDays >= 90)) {
    return unavailable(`a field's phenology needs a season of imagery; ${startDate} → ${endDate} spans only ${Math.max(0, Math.round(spanDays))} days (use at least 90, ideally 12 months).`)
  }
  const minFieldAreaM2 = Number.isFinite(Number(args.min_field_area_m2)) && Number(args.min_field_area_m2) > 0
    ? Number(args.min_field_area_m2) : 2000
  const maxScenes = Math.max(3, Math.min(8, Math.round(Number(args.max_scenes) || 6)))

  const sizing = chooseMaxSize(geom, S2_GSD_M, 800)
  if (!sizing) return unavailable('the AOI polygon has no usable extent.')
  if (sizing.gsdM > 20) {
    return unavailable(
      `this AOI is ~${fmt(Math.max(...sizing.extentM) / 1000)} km across; at the 800-pixel read cap that is ${sizing.gsdM.toFixed(0)} m pixels, ` +
      `too coarse to separate fields. Draw an AOI under ~12 km across (≤8 km for full 10 m detail).`,
    )
  }

  ctx.emit?.('token', { type: 'token', content: `Delineating fields: searching Sentinel-2 ${startDate} → ${endDate}, up to ${maxScenes} clear scenes across the season...\n` })

  const found = await searchSentinel2(sizing.bbox, `${startDate}/${endDate}`, 200)
  if (!found.ok) return unreachable(found.message)
  if (found.items.length === 0) return unavailable(`no Sentinel-2 L2A scene covers this AOI between ${startDate} and ${endDate}.`)

  const selection = await selectSeasonScenes(found.items, geom, startDate, endDate, maxScenes)
  if (selection.scenes.length < 3) {
    return {
      summary:
        `**Not enough clear scenes to delineate fields.** Phenology needs at least 3 usable dates across the season; ` +
        `only ${selection.scenes.length} of ${maxScenes} windows had a scene that was ≥50% clear over the polygon and covered it.\n\n` +
        selection.skipped.map((s) => `- ${s}`).join('\n') +
        `\n\nWiden the date range, or use \`fetch_sar\` (radar sees through cloud). No polygons are drawn from too few observations.`,
    }
  }

  ctx.emit?.('token', { type: 'token', content: `Reading NDVI for ${selection.scenes.length} dates at ~${sizing.gsdM.toFixed(0)} m and segmenting...\n` })
  const loaded = await loadNdviStack(selection.scenes, geom, sizing.maxSize)
  const stack = loaded.stack
  if (!stack || stack.dates.length < 3) {
    return unreachable(
      `only ${stack?.dates.length ?? 0} of ${selection.scenes.length} NDVI reads succeeded (need 3). ` +
      loaded.failures.slice(0, 3).join(' ') +
      ' The public titiler.xyz instance is rate-limited — retry, or self-host (TITILER_ENDPOINT).',
    )
  }

  const t0 = Date.now()
  const result = delineateFromStack(stack, { minFieldAreaM2, lat: ctx.centroid.lat })
  log.info({ ms: Date.now() - t0, fields: result.fieldCount, regions: result.segment.initialRegions }, 'delineate_fields segmented')

  if (result.features.length === 0) {
    return {
      summary:
        `**No field polygons of at least ${fmt(minFieldAreaM2, 0)} m² were found** in ${stack.dates.length} usable dates. ` +
        `This is a measured result, not a fetch failure: the AOI's NDVI shows no region that large and coherent. Try a smaller \`min_field_area_m2\`.`,
      sources: [SOURCE],
      provenance_items: selection.scenes.map((sc) => String(sc.item?.id)),
    }
  }

  const gsd = (stack.cellXm + stack.cellYm) / 2
  const labels = classLabels(ctx.centroid.lat)
  const present = CLASS_ORDER.filter((c) => result.byClass[c].count > 0)
  const total = result.features.length
  const features = result.features.slice(0, MAX_POLYGONS)
  const medianConf = result.medianConfidence
  const layerId = `fields-${genId()}`
  const confidence: Confidence = medianConf !== null && medianConf >= 0.6 ? 'medium' : 'low'

  const resolutionLimit =
    `Sentinel-2 at ${S2_GSD_M} m native (read at ${gsd.toFixed(1)} m/px). Adjacent fields with the same crop and no visible boundary merge into one polygon; ` +
    `fields narrower than ~30 m are lost; the reliable minimum field size is about 0.5–1 ha. Boundaries are accurate to roughly one pixel.`
  const provenance: Provenance = {
    source: `${SOURCE} — ${stack.dates.length}-date NDVI season stack`,
    date: stack.dates[stack.dates.length - 1],
    method:
      `NDVI on ${stack.dates.join(', ')}, SCL cloud/shadow/cirrus/snow masked per pixel (gaps, not zeros); ` +
      `boundary strength = mean Sobel gradient + temporal-profile dissimilarity; marker-controlled watershed from low-gradient cores; ` +
      `regions merged when mean profiles differ < 0.05 NDVI or area < ${fmt(minFieldAreaM2, 0)} m²; ` +
      `labels from NDVI peak timing/count/amplitude (phenology only — not crop identity); built-up/bare/water regions flagged from median NDBI (B11 vs B08) > 0 with flat low NDVI, or NDVI < 0; traced to polygons with Douglas–Peucker 0.7 px. ${stack.reflectanceNote}`,
    clip: 'polygon',
    resolution_limit: resolutionLimit,
  }
  const vectorStyle: VectorStyle = {
    property: 'class',
    kind: 'categorical',
    classes: present.map((c) => ({ value: c, label: labels[c], color: CLASS_COLORS[c] })),
  }
  const validCharts = buildFieldCharts(features, present, labels, layerId).filter((c) => {
    const v = validateVegaLite(c.spec)
    if (!v.ok) log.warn({ chart: c.id, error: v.error }, 'delineate_fields chart rejected')
    return v.ok
  })

  const rowsMd = present
    .map((c) => `| ${labels[c]} | ${result.byClass[c].count} | ${fmt(result.byClass[c].areaHa, 1)} |`)
    .join('\n')

  const summary_data: Record<string, SummaryDatum> = {
    field_count: result.fieldCount,
    non_field_regions: result.nonFieldCount,
    total_field_area_ha: Number(result.totalFieldAreaHa.toFixed(1)),
    // no fields, no mean and no median: a recorded 0 would read as a measurement
    ...(result.fieldCount ? { mean_field_area_ha: Number((result.totalFieldAreaHa / result.fieldCount).toFixed(2)) } : {}),
    ...(medianConf === null ? {} : { median_confidence: Number(medianConf.toFixed(2)) }),
    scenes_used: stack.dates.length,
    grid_gsd_m: Number(gsd.toFixed(1)),
    dropped_below_min: result.droppedSmall,
    min_field_area_m2: minFieldAreaM2,
    area_ha_by_class: present.map((c) => ({ label: labels[c], value: Number(result.byClass[c].areaHa.toFixed(1)) })),
  }
  for (const c of present) {
    summary_data[`${c}_count`] = result.byClass[c].count
    summary_data[`${c}_area_ha`] = Number(result.byClass[c].areaHa.toFixed(1))
  }

  return {
    summary:
      `**Delineated ${result.fieldCount} field${result.fieldCount === 1 ? '' : 's'} (${fmt(result.totalFieldAreaHa, 1)} ha)** ` +
      `plus ${result.nonFieldCount} non-field region${result.nonFieldCount === 1 ? '' : 's'}, from a Sentinel-2 NDVI season ` +
      `(${stack.dates.length} dates: ${stack.dates.join(', ')}).\n\n` +
      `| Phenology class | Polygons | Area (ha) |\n|---|---|---|\n${rowsMd}\n\n` +
      `**What the labels mean:** they describe WHEN the vegetation grows (peak timing, number of seasons, amplitude) — ` +
      `not which crop it is. Naming wheat, rice or maize needs ground truth (field surveys or a labelled crop map); none is used here, so none is claimed.\n\n` +
      `**Confidence:** per-polygon 0–1 score = boundary contrast against neighbours vs interior uniformity (median ${medianConf === null ? 'n/a' : medianConf.toFixed(2)}); ` +
      `it measures how clean the outline is, not whether the phenology label is the true land use.\n\n` +
      `**Resolution:** ${resolutionLimit}\n` +
      (result.droppedSmall > 0 ? `\n${result.droppedSmall} region(s) under ${fmt(minFieldAreaM2, 0)} m² (${fmt(result.droppedAreaHa, 1)} ha) could not be merged and were dropped.` : '') +
      (total > features.length ? `\nShowing the ${MAX_POLYGONS.toLocaleString()} largest of ${total.toLocaleString()} polygons.` : '') +
      (selection.skipped.length ? `\n\nSeason windows without a usable scene: ${selection.skipped.join('; ')}.` : '') +
      (loaded.failures.length ? `\n\nDates that failed to read: ${loaded.failures.join('; ')}.` : '') +
      (stack.resampled ? `\n\n${stack.resampled} date(s) came back on a slightly different grid and were nearest-neighbour aligned.` : ''),
    summary_data,
    layer: {
      id: layerId,
      name: `Fields (${result.fieldCount}) — phenology classes`,
      type: 'geojson',
      geojson: { type: 'FeatureCollection', features },
      bounds: stack.bbox,
      provenance,
      confidence,
      vectorStyle,
    },
    ...(validCharts.length ? { charts: validCharts } : {}),
    provenance_items: selection.scenes.map((sc) => String(sc.item?.id)),
  }
}

// ---------------------------------------------------------------------------
// digitize_features — CV-FIRST (v2 spec §3.7)
// ---------------------------------------------------------------------------
//
// > Digitization inverts. `digitize_features` becomes CV-first; OSM is demoted from default
// > answer to cross-check and enrichment.
//
// The pre-v2 cascade asked OSM first and only fell through to imagery when OSM was empty, which
// meant "find every X" answered from a volunteer map rather than from the pixels — and silently
// reported OSM's completeness as the ground truth. Now the imagery answers, and OSM is used to say
// how that answer compares with what is already mapped.

const FLOOD_RE = /\b(flood(?:s|ed|ing|water|waters|plains?)?|inundat\w*|under\s?water|submerged)\b/i
const WATER_RE = /\b(lake|pond|water|reservoir|lagoon|bay|wetland|marsh|swamp)/i
const FIELD_RE = /\b(fields?|farms?|farmlands?|farmland|parcels?|plots?|crop\s?lands?|crop\s?fields?|paddy|paddies|agricultur\w*)\b/i

/** Where `digitize_features` sends a feature. Flood = water that is new since a dry reference, a
 *  radar question (Sentinel-1 sees through monsoon cloud), not an NDWI one, so it is tested first.
 *  Fields are regions that behave alike through a season, not objects a detector finds. Water is a
 *  spectral question: NDWI measures it directly and beats any detector. */
function digitizeRoute(feature: string): 'flood' | 'fields' | 'water' | 'object' {
  if (FLOOD_RE.test(feature)) return 'flood'
  const isWater = WATER_RE.test(feature)
  if (!isWater && FIELD_RE.test(feature)) return 'fields'
  return isWater ? 'water' : 'object'
}

/** True when the feature is a physical object, which only the (parked) CV pipeline can answer. */
export const isObjectTarget = (feature: string): boolean => digitizeRoute(feature) === 'object'

export async function digitizeFeatures(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const { emit } = ctx
  const feature = String(args.feature).trim()
  const route = digitizeRoute(feature)

  if (route === 'flood') {
    emit?.('token', { type: 'token', content: `Digitizing "${feature}" as flood extent from Sentinel-1 radar (new water since a dry reference scene)...\n` })
    return ctx.runTool('map_flood', {})
  }

  if (route === 'fields') {
    emit?.('token', { type: 'token', content: `Digitizing "${feature}" as agricultural fields from a season of Sentinel-2 NDVI...\n` })
    return ctx.runTool('delineate_fields', {})
  }

  if (route === 'water') {
    emit?.('token', { type: 'token', content: `Digitizing "${feature}" as polygons from Sentinel-2 NDWI (water is measured spectrally, not detected)...\n` })
    const water = await ctx.runTool('vectorize_raster', { index: 'NDWI', op: '>', threshold: 0.2 })
    const osmWater = await ctx.runTool('query_osm', { query: feature })
    return {
      ...water,
      summary:
        `${water.summary}\n\n---\n\n**OpenStreetMap cross-check:** ` +
        (osmWater.layer ? osmWater.summary : 'OSM has no mapped water here, so there is nothing to compare against.'),
      layers: [...(water.layers ?? []), ...(osmWater.layer ? [osmWater.layer] : [])],
      sources: [...(water.sources ?? []), ...(osmWater.sources ?? [])],
      provenance_items: [...(water.provenance_items ?? []), ...(osmWater.provenance_items ?? [])],
    }
  }

  // An object: the imagery answers (the operation's static check has already refused this when
  // the CV pipeline is off).
  emit?.('token', { type: 'token', content: `Digitizing "${feature}" — imagery first, OSM as cross-check...\n` })
  const cv = await ctx.runTool('detect_objects', {
    target: feature,
    ...(args.footprint_m ? { footprint_m: args.footprint_m } : {}),
  })

  // OSM as cross-check/enrichment: it answers "how does this compare with what is already
  // mapped?", which is a genuinely different question from "what is here?" — and is informative
  // whether or not CV found anything.
  const osm = await ctx.runTool('query_osm', { query: feature })
  const cvCount = Number(cv.summary_data?.detection_count ?? 0)
  const osmCount = Number(osm.summary_data?.feature_count ?? osm.summary_data?.count ?? 0)

  let crossCheck: string
  if (!osm.layer) {
    crossCheck = `OpenStreetMap has no "${feature}" mapped in this AOI, so the imagery result stands uncorroborated.`
  } else if (cvCount > 0 && osmCount > 0) {
    crossCheck =
      `OpenStreetMap has ${osmCount} mapped "${feature}" here against ${cvCount} detected from imagery. ` +
      `The two count different things — OSM records what a mapper has drawn, imagery records what was ` +
      `visible on the acquisition date — so a gap in either direction is information, not an error.`
  } else if (cvCount === 0 && osmCount > 0) {
    crossCheck =
      `OpenStreetMap has ${osmCount} mapped "${feature}" here that imagery analysis did not return. ` +
      `Read the ladder above before concluding they are gone: an unresolvable target and an absent one ` +
      `produce the same empty list.`
  } else {
    crossCheck = osm.summary
  }

  return {
    summary: `${cv.summary}\n\n---\n\n**OpenStreetMap cross-check:** ${crossCheck}`,
    summary_data: { ...cv.summary_data, osm_mapped_count: osmCount },
    layer: cv.layer ?? osm.layer,
    layers: cv.layer && osm.layer ? [osm.layer] : undefined,
    sources: [...(cv.sources ?? []), ...(osm.sources ?? [])],
    provenance_items: [...(cv.provenance_items ?? []), ...(osm.provenance_items ?? [])],
  }
}
