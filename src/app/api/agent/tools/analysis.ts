/** `analyze_raster` — Phase 2.5's one parameterised analysis capability (spec §3.6 B).
 *
 *  ONE tool, ONE substrate, MANY operations. The user can ask for a *specific*
 *  variogram ("directional NDWI at 40 m lags") or for an analysis nobody
 *  pre-wired, and it is a parameter change rather than a new tool. This replaces
 *  the standalone `compute_variogram`, which could only ever produce the one
 *  omnidirectional NDVI-family variogram its author anticipated.
 *
 *  Every operation runs on `lib/analysis/grid-source.ts`'s polygon-clipped,
 *  SCL-masked grid, so cloud masking is structural: a clouded pixel is not
 *  `valid` and no operation can accidentally include it.
 */

import {
  computeChange,
  computeClusters,
  computeCorrelation,
  computeHistogram,
  computeStats,
  computeTexture,
  computeTransect,
  computeVariogram,
  fitVariogramModel,
  gridSamples,
  type AnalysisGrid,
  type TextureMetric,
  type VariogramModel,
} from '../lib/analysis/operations'
import {
  DEFAULT_ANALYSIS_MAX_SIZE,
  gridMethodNote,
  loadIndexGrid,
  pickSceneForAoi,
  SUPPORTED_INDICES,
  type LoadedGrid,
} from '../lib/analysis/grid-source'
import { loadSensorGridNear, pickSensorForPair } from '../lib/analysis/sensors'
import { makeGrid } from '../lib/analysis/operations'
import {
  classRamp,
  divergingRamp,
  renderGridPng,
  sequentialRamp,
  CLUSTER_COLORS,
} from '../lib/analysis/render'
import { genId } from '../lib/geometry'
import { getLogger } from '../lib/logger'
import type { LayerPalette, SummaryDatum, ToolCtx, ToolOutput } from '../lib/types'

const log = getLogger('agent/analyze-raster')

export const ANALYZE_OPERATIONS = [
  'stats', 'histogram', 'variogram', 'transect', 'correlate', 'texture', 'cluster', 'change',
] as const
export type AnalyzeOperation = (typeof ANALYZE_OPERATIONS)[number]

const ANALYSIS_SOURCE = 'Sentinel-2 L2A (AWS Earth Search) via titiler /stac/feature.npy'

/** Honest refusal, in the phrasing the rest of the codebase uses. */
function unavailable(message: string): ToolOutput {
  return { summary: `Real data unavailable: ${message}` }
}

function n(v: number, digits = 4): number {
  return Number(v.toFixed(digits))
}

/** Scene + masking caveat, appended to every answer. Spec §3.6: finding, then
 *  the number, then the caveat — never a wall of statistics. */
function caveat(loaded: LoadedGrid): string {
  const g = loaded.grid
  return (
    `Scene ${loaded.scene.date} (${loaded.scene.id}) covering ${loaded.coveragePct.toFixed(0)}% of the polygon, ` +
    `${loaded.scene.clearPct.toFixed(0)}% of that clear; ` +
    `${loaded.clearPixels.toLocaleString()} of ${loaded.insidePolygon.toLocaleString()} observed pixels used ` +
    `at ~${Math.round((g.cellXm + g.cellYm) / 2)} m/px. Cloud, shadow and cirrus are excluded per pixel (SCL).`
  )
}

/** What a stats-only result was computed from: the source and the scene it read. */
function evidence(loaded: LoadedGrid): Pick<ToolOutput, 'sources' | 'provenance_items'> {
  return { sources: [ANALYSIS_SOURCE], provenance_items: [loaded.scene.id] }
}

function baseProvenance(loaded: LoadedGrid, method: string) {
  return {
    source: ANALYSIS_SOURCE,
    date: loaded.scene.date,
    method: gridMethodNote(loaded, method),
    clip: 'polygon' as const,
  }
}

/** Parse a line argument: [[lon,lat],…], a GeoJSON LineString, or a Feature. */
function parseLine(arg: any): Array<[number, number]> | null {
  const coords =
    Array.isArray(arg) ? arg
    : arg?.type === 'Feature' ? arg.geometry?.coordinates
    : arg?.type === 'LineString' ? arg.coordinates
    : arg?.coordinates ?? null
  if (!Array.isArray(coords) || coords.length < 2) return null
  const out: Array<[number, number]> = []
  for (const p of coords) {
    if (!Array.isArray(p) || p.length < 2) return null
    const lon = Number(p[0]); const lat = Number(p[1])
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
    out.push([lon, lat])
  }
  return out
}

/** Ground size of one pixel the read will produce, before the read happens.
 *  titiler scales the AOI's longest edge to `maxSize`, and Sentinel-2 cannot go
 *  below 10 m, so the finer of the two is not achievable. */
export function expectedCellSizeM(
  bbox: [number, number, number, number],
  maxSize: number,
): number {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const midLat = (minLat + maxLat) / 2
  const spanX = (maxLng - minLng) * 111_320 * Math.cos((midLat * Math.PI) / 180)
  const spanY = (maxLat - minLat) * 110_540
  const longest = Math.max(spanX, spanY)
  return Math.max(10, longest / Math.max(1, maxSize))
}

/** Argument checks that need no data: the `analyze_raster` operation's static validation (the
 *  executor runs it before the tool, so a bad request is refused without a scene search).
 *  Returns every problem found; empty when the arguments are usable. */
export function analyzeArgErrors(
  args: Record<string, any>,
  bbox: [number, number, number, number],
): string[] {
  const errors: string[] = []
  const operation = args.operation as AnalyzeOperation
  const index = String(args.index || 'NDVI').toUpperCase()

  const named = [args.index, args.index2, ...(args.indices ?? [])].filter((v): v is string => typeof v === 'string')
  const unknown = named.filter((n) => !SUPPORTED_INDICES.includes(n.toUpperCase()))
  if (unknown.length) errors.push(`Unsupported index ${unknown.map((n) => `"${n}"`).join(', ')}. Supported: ${SUPPORTED_INDICES.join(', ')}.`)

  switch (operation) {
    case 'change':
      if (!args.date || !args.date2) {
        errors.push('a change analysis needs two dates — pass `date` (before) and `date2` (after) as YYYY-MM-DD.')
      }
      break
    case 'correlate': {
      const index2 = String(args.index2 || '').toUpperCase()
      if (!index2) {
        errors.push(`a correlation needs a second index — pass \`index2\` (one of ${SUPPORTED_INDICES.join(', ')}).`)
      } else if (index2 === index) {
        errors.push(`correlating ${index} with itself is trivially 1.0 — pass a different \`index2\`.`)
      }
      break
    }
    case 'transect':
      if (!parseLine(args.line)) {
        errors.push('a transect needs a line — pass `line` as [[lon,lat],[lon,lat],…] or a GeoJSON LineString.')
      }
      break
    case 'texture': {
      const window = args.window != null ? Number(args.window) : 3
      if (!Number.isFinite(window) || window < 3 || window % 2 === 0) {
        errors.push(`texture window must be an odd number ≥ 3 (got ${args.window}).`)
      }
      break
    }
    case 'variogram':
      // A lag finer than the pixel the read will produce is unanswerable, and the pixel size is
      // knowable from the AOI and `max_size` before any fetch: titiler scales the longest edge
      // to `max_size`, and Sentinel-2 is 10 m at best.
      if (args.lag_m != null) {
        const maxSize = args.max_size ? Number(args.max_size) : DEFAULT_ANALYSIS_MAX_SIZE
        const expected = expectedCellSizeM(bbox, maxSize)
        if (Number(args.lag_m) < expected) {
          errors.push(
            `a ${Number(args.lag_m)} m lag is finer than the ~${Math.round(expected)} m pixels this AOI resolves to ` +
            `at max_size ${maxSize}. Ask for a lag of at least ${Math.ceil(expected)} m, or raise max_size (≤512). ` +
            `Sentinel-2's own limit is 10 m — no lag below that is measurable from this sensor.`,
          )
        }
      }
      break
  }
  return errors
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export async function analyzeRaster(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const { aoi, bbox, emit } = ctx
  const operation = args.operation as AnalyzeOperation
  const index = String(args.index || 'NDVI').toUpperCase()
  const maxSize = args.max_size ? Number(args.max_size) : DEFAULT_ANALYSIS_MAX_SIZE

  emit?.('token', {
    type: 'token',
    content: `Reading cloud-masked ${index} pixels over the AOI for a ${operation} analysis...\n`,
  })

  // ---- change: two dates, each with its own clearest scene ------------------
  if (operation === 'change') {
    const dateA = args.date ? String(args.date) : undefined
    const dateB = args.date2 ? String(args.date2) : undefined
    if (!dateA || !dateB) {
      return unavailable('a change analysis needs two dates — pass `date` (before) and `date2` (after) as YYYY-MM-DD.')
    }
    // ---- Phase 4: pick ONE sensor that observed BOTH dates ------------------
    //
    // Sentinel-2's archive starts 2015-06-27, so a pair reaching back further
    // has to be answered by Landsat at 30 m — for BOTH endpoints, not just the
    // old one. Reading 2024 at 10 m and 1990 at 30 m would difference two
    // instruments: measured on coincident clear scenes, S2 and Landsat NDVI
    // disagree by 0.02–0.11 over the same polygon, which is larger than most
    // multi-decade signals. See `lib/analysis/sensors.ts`.
    const choice = pickSensorForPair(dateA, dateB, index)
    if (!choice.ok) return unavailable(choice.message)

    let gridA: AnalysisGrid
    let gridB: AnalysisGrid
    let sceneA: string
    let sceneB: string
    let clearA: number
    let clearB: number
    let methodNote: string

    if (choice.sensor.id === 'sentinel-2-l2a') {
      // Both dates are inside Sentinel-2's archive — keep the proven Phase 0/2.5
      // path, which also brings AOI-coverage gating and clarity ranking.
      // `bracket`: the before scene is on or before `date`, the after scene on or after `date2`, so
      // an event inside the interval is between the two scenes and not already in the "before" one.
      const a = await loadIndexGrid({ index, aoi, bbox, date: dateA, maxSize, side: args.bracket ? 'before' : undefined })
      if (!a.ok) return unavailable(`${dateA}: ${a.message}`)
      const b = await loadIndexGrid({ index, aoi, bbox, date: dateB, maxSize, side: args.bracket ? 'after' : undefined })
      if (!b.ok) return unavailable(`${dateB}: ${b.message}`)
      gridA = a.loaded.grid; gridB = b.loaded.grid
      sceneA = a.loaded.scene.date; sceneB = b.loaded.scene.date
      clearA = a.loaded.clearPixels; clearB = b.loaded.clearPixels
      methodNote = gridMethodNote(a.loaded)
    } else {
      // A pre-2015 endpoint. Both dates come from the same deeper archive, read
      // at ONE explicit grid — `max_size` is a cap (ISS-126), so only explicit
      // width/height guarantees two dates are differenced pixel-for-pixel.
      const [ra, rb] = await Promise.all([
        loadSensorGridNear({ sensor: choice.sensor, index, aoi, bbox, date: dateA, width: maxSize, height: maxSize }),
        loadSensorGridNear({ sensor: choice.sensor, index, aoi, bbox, date: dateB, width: maxSize, height: maxSize }),
      ])
      if (!ra.ok) return unavailable(`${dateA}: ${ra.message}`)
      if (!rb.ok) return unavailable(`${dateB}: ${rb.message}`)
      gridA = makeGrid(ra.grid.values, ra.grid.valid, ra.grid.width, ra.grid.height, bbox, index)
      gridB = makeGrid(rb.grid.values, rb.grid.valid, rb.grid.width, rb.grid.height, bbox, index)
      sceneA = ra.grid.sceneDate; sceneB = rb.grid.sceneDate
      clearA = ra.grid.clearPixels; clearB = rb.grid.clearPixels
      methodNote =
        `per-pixel ${index} from ${choice.sensor.label} (${choice.sensor.nativeResM} m native), ` +
        `clipped to the drawn polygon at an explicit ${gridA.width}×${gridA.height} grid so both dates align; ` +
        `surface reflectance scaled (DN × ${choice.sensor.scale} ${choice.sensor.offset < 0 ? '−' : '+'} ` +
        `${Math.abs(choice.sensor.offset)}) and ${choice.sensor.qualityAsset} masked ` +
        `(${clearA} / ${clearB} clear pixels)`
    }

    let change
    try {
      change = computeChange(gridA, gridB, {
        threshold: args.threshold != null ? Number(args.threshold) : 0.05,
        baselineMin: args.baseline_min != null ? Number(args.baseline_min) : undefined,
      })
    } catch (err: any) {
      return unavailable(err?.message ?? 'the two dates could not be aligned.')
    }
    if (!change) {
      return unavailable(
        `no pixel was clear in BOTH scenes (${sceneA} and ${sceneB}), ` +
        `so no per-pixel change can be computed. A difference measured where one date is cloud is not change.`,
      )
    }

    const s = change.stats
    const direction = s.mean > change.threshold ? 'increased' : s.mean < -change.threshold ? 'decreased' : 'barely moved'
    const png = await renderGridPng(change.grid, divergingRamp(Math.max(1e-6, Math.abs(s.p95), Math.abs(s.p05))))

    const summary_data: Record<string, SummaryDatum> = {
      index,
      operation: 'change',
      date_before: sceneA,
      date_after: sceneB,
      sensor: choice.sensor.label,
      sensor_resolution_m: choice.sensor.nativeResM,
      mean_delta: n(s.mean),
      median_delta: n(s.median),
      std_delta: n(s.std),
      increased_pct: n(change.increasedPct, 1),
      decreased_pct: n(change.decreasedPct, 1),
      unchanged_pct: n(change.unchangedPct, 1),
      threshold: n(change.threshold),
      pixels_clear_both: change.clearBoth,
    }
    if (args.bracket) summary_data.scene_search = 'bracket'
    if (change.baselineMin !== undefined) {
      // The statistics above describe only the restricted ground; say which, and how much of the area it is.
      summary_data.baseline_min = n(change.baselineMin)
      summary_data.baseline_pixels = s.count
      summary_data.baseline_pixels_pct = n((s.count / change.clearBoth) * 100, 1)
    }

    const palette: LayerPalette = {
      kind: 'gradient',
      label: `Δ${index}`,
      min: n(-Math.abs(s.p05 || s.min)),
      max: n(Math.abs(s.p95 || s.max)),
      stops: [
        { value: n(-Math.abs(s.p05 || s.min)), color: '#3b82f6', label: 'decrease' },
        { value: 0, color: '#ffffff', label: 'no change' },
        { value: n(Math.abs(s.p95 || s.max)), color: '#ef4444', label: 'increase' },
      ],
    }

    return {
      summary: [
        `**${index} ${direction} between ${sceneA} and ${sceneB}** — mean change ` +
          `${s.mean >= 0 ? '+' : ''}${n(s.mean, 3)} ${index} units.`,
        `${n(change.decreasedPct, 0)}% of clear pixels fell by more than ${n(change.threshold, 2)}, ` +
          `${n(change.increasedPct, 0)}% rose, ${n(change.unchangedPct, 0)}% held steady ` +
          `(σ ${n(s.std, 3)}, range ${n(s.min, 3)} to ${n(s.max, 3)}).`,
        change.baselineMin !== undefined
          ? `Restricted to the ${s.count.toLocaleString()} pixels (${n((s.count / change.clearBoth) * 100, 0)}% of the ${change.clearBoth.toLocaleString()} clear in **both** scenes) ` +
            `whose ${index} on ${sceneA} was at least ${n(change.baselineMin, 2)}; the rest of the area is not counted.`
          : `Computed on the ${s.count.toLocaleString()} pixels that were clear in **both** scenes — ` +
            `a difference measured where one date is cloud is not change.`,
        choice.reason,
      ].join('\n\n'),
      summary_data,
      layer: png ? {
        id: `change-${genId()}`,
        name: `Δ${index} ${sceneA} → ${sceneB}`,
        type: 'raster',
        imageBase64: png,
        bounds: bbox,
        palette,
        confidence: 'high',
        provenance: {
          source: `${choice.sensor.label} ${sceneA} and ${sceneB}`,
          date: sceneB,
          method: `${methodNote}; per-pixel difference vs ${sceneA}, masked on BOTH dates`,
          clip: 'polygon',
        },
      } : undefined,
    }
  }

  // ---- every other operation reads one primary grid --------------------------
  const primary = await loadIndexGrid({
    index, aoi, bbox, date: args.date ? String(args.date) : undefined, maxSize,
  })
  if (!primary.ok) return unavailable(primary.message)
  const loaded = primary.loaded
  const grid = loaded.grid
  const cellM = (grid.cellXm + grid.cellYm) / 2

  switch (operation) {
    // -----------------------------------------------------------------------
    case 'stats': {
      const s = computeStats(grid)
      if (!s) return unavailable(`no clear ${index} pixel remained inside the polygon.`)
      return {
        ...evidence(loaded),
        summary: [
          `**Mean ${index} over the AOI is ${n(s.mean, 3)}** (median ${n(s.median, 3)}, σ ${n(s.std, 3)}).`,
          `The middle 50% of pixels fall between ${n(s.p25, 3)} and ${n(s.p75, 3)}; ` +
            `the full clear-sky range is ${n(s.min, 3)} to ${n(s.max, 3)}.`,
          caveat(loaded),
        ].join('\n\n'),
        summary_data: {
          index, operation: 'stats',
          mean: n(s.mean), median: n(s.median), std: n(s.std),
          min: n(s.min), max: n(s.max),
          p05: n(s.p05), p25: n(s.p25), p75: n(s.p75), p95: n(s.p95),
          clear_pixels: s.count, in_polygon_pixels: s.insidePolygon,
          clear_pct: n(loaded.scene.clearPct, 1),
          aoi_coverage_pct: n(loaded.coveragePct, 1),
          scene_date: loaded.scene.date,
          pixel_size_m: Math.round(cellM),
        },
      }
    }

    // -----------------------------------------------------------------------
    case 'histogram': {
      const range = Array.isArray(args.range) && args.range.length === 2
        ? [Number(args.range[0]), Number(args.range[1])] as [number, number]
        : undefined
      const h = computeHistogram(grid, { bins: args.bins != null ? Number(args.bins) : 20, range })
      if (!h) return unavailable(`no clear ${index} pixel remained inside the polygon.`)
      const peak = h.bins.reduce((a, b) => (b.value > a.value ? b : a))
      return {
        ...evidence(loaded),
        summary: [
          `**The ${index} distribution peaks near ${peak.label}**, holding ${n((peak.value / h.count) * 100, 1)}% ` +
            `of the ${h.count.toLocaleString()} clear pixels.`,
          `Values span ${n(h.min, 3)} to ${n(h.max, 3)} across ${h.bins.length} bins.`,
          caveat(loaded),
        ].join('\n\n'),
        summary_data: {
          index, operation: 'histogram',
          bins: h.bins.length, count: h.count,
          min: n(h.min), max: n(h.max),
          modal_value: Number(peak.label),
          distribution: h.bins,
          scene_date: loaded.scene.date,
        },
      }
    }

    // -----------------------------------------------------------------------
    case 'variogram': {
      const lagM = args.lag_m != null ? Number(args.lag_m) : undefined
      const directionDeg = args.direction_deg != null && args.direction_deg !== ''
        ? Number(args.direction_deg) : null
      const toleranceDeg = args.tolerance_deg != null ? Number(args.tolerance_deg) : 22.5
      const maxLagM = args.max_lag_m != null ? Number(args.max_lag_m) : undefined
      const model = (String(args.model || 'auto') as VariogramModel | 'auto')

      if (lagM != null && lagM < cellM) {
        return unavailable(
          `a ${lagM} m lag is finer than the ${Math.round(cellM)} m pixels this AOI resolves to ` +
          `(${grid.width}×${grid.height} over the polygon). Ask for a lag of at least ${Math.ceil(cellM)} m, ` +
          `or raise max_size (≤512) if the AOI is large enough to support it. ` +
          `Sentinel-2's own limit is 10 m — no lag below that is measurable from this sensor.`,
        )
      }

      const { samples, validCount } = gridSamples(grid, 1600)
      const v = computeVariogram(samples, { lagM, maxLagM, directionDeg, toleranceDeg })
      if (v.tooFewSamples || v.bins.length === 0) {
        return unavailable(
          `only ${validCount} clear ${index} pixels are inside the polygon` +
          (directionDeg != null ? ` along the ${directionDeg}° axis (±${toleranceDeg}°)` : '') +
          ` — too few pairs to bin a variogram. Draw a larger AOI, widen the tolerance, or use a coarser lag.`,
        )
      }
      const fit = fitVariogramModel(v.bins, model)

      const dirLabel = v.directionDeg == null
        ? 'omnidirectional'
        : `along the ${v.directionDeg}° axis (±${v.toleranceDeg}°)`
      const finding = fit
        ? `**${index} decorrelates over about ${fit.range_m} m ${dirLabel}** — beyond that distance, ` +
          `pixels carry no information about each other.`
        : `**${index} semivariance rises from ${n(v.bins[0].semivariance, 4)} at ${v.bins[0].lag_m} m to ` +
          `${n(v.bins[v.bins.length - 1].semivariance, 4)} at ${v.bins[v.bins.length - 1].lag_m} m ${dirLabel}**, ` +
          `but no model fit converged.`

      const summary_data: Record<string, SummaryDatum> = {
        index, operation: 'variogram',
        direction_deg: v.directionDeg == null ? 'omnidirectional' : v.directionDeg,
        tolerance_deg: v.toleranceDeg,
        lag_width_m: Math.round(v.lagWidthM),
        max_lag_m: Math.round(v.maxLagM),
        lag_bins: v.bins.length,
        pairs: v.totalPairs,
        samples: v.sampleCount,
        valid_pixels: validCount,
        pixel_size_m: Math.round(cellM),
        scene_date: loaded.scene.date,
        semivariogram: v.bins.map((b) => ({ label: String(b.lag_m), value: n(b.semivariance, 6) })),
      }
      if (fit) {
        summary_data.model = fit.model
        summary_data.nugget = n(fit.nugget, 5)
        summary_data.sill = n(fit.sill, 5)
        summary_data.range_m = fit.range_m
        summary_data.fit_rmse = n(fit.rmse, 5)
      }

      return {
        ...evidence(loaded),
        summary: [
          finding,
          fit
            ? `${fit.model} fit: nugget ${n(fit.nugget, 4)}, sill ${n(fit.sill, 4)}, range ${fit.range_m} m ` +
              `(RMSE ${n(fit.rmse, 4)}), from ${v.totalPairs.toLocaleString()} pixel pairs in ` +
              `${v.bins.length} bins of ${Math.round(v.lagWidthM)} m.`
            : `${v.bins.length} lag bins of ${Math.round(v.lagWidthM)} m from ` +
              `${v.totalPairs.toLocaleString()} pixel pairs.`,
          `${caveat(loaded)} Lags below ${Math.round(cellM)} m are not measurable at this pixel size.`,
        ].join('\n\n'),
        summary_data,
      }
    }

    // -----------------------------------------------------------------------
    case 'transect': {
      const line = parseLine(args.line)
      if (!line) {
        return unavailable(
          'a transect needs a line — pass `line` as [[lon,lat],[lon,lat],…] or a GeoJSON LineString.',
        )
      }
      let t
      try {
        t = computeTransect(grid, line, args.samples != null ? Number(args.samples) : 100)
      } catch (err: any) {
        return unavailable(err?.message ?? 'the transect line could not be sampled.')
      }
      if (t.points.length < 2) {
        return unavailable(
          `the transect crossed no clear ${index} pixel inside the AOI ` +
          `(${t.skipped} of ${t.requested} samples fell outside the polygon or on cloud). ` +
          `Check the line lies inside the drawn AOI.`,
        )
      }
      const vals = t.points.map((p) => p.value)
      const first = vals[0]
      const last = vals[vals.length - 1]
      const lo = Math.min(...vals)
      const hi = Math.max(...vals)
      const trend = last > first ? 'rises' : last < first ? 'falls' : 'is flat'

      return {
        ...evidence(loaded),
        summary: [
          `**${index} ${trend} from ${n(first, 3)} to ${n(last, 3)} along the ${Math.round(t.length_m)} m transect**, ` +
            `spanning ${n(lo, 3)} to ${n(hi, 3)}.`,
          `${t.points.length} of ${t.requested} sample points returned a value; ` +
            `${t.skipped} fell outside the polygon or on a masked pixel and are left as gaps rather than interpolated.`,
          caveat(loaded),
        ].join('\n\n'),
        summary_data: {
          index, operation: 'transect',
          length_m: Math.round(t.length_m),
          samples: t.points.length,
          skipped: t.skipped,
          start_value: n(first), end_value: n(last),
          min: n(lo), max: n(hi),
          scene_date: loaded.scene.date,
          profile: t.points.map((p) => ({ label: String(p.distance_m), value: n(p.value, 4) })),
        },
      }
    }

    // -----------------------------------------------------------------------
    case 'correlate': {
      const index2 = String(args.index2 || '').toUpperCase()
      if (!index2) {
        return unavailable(`a correlation needs a second index — pass \`index2\` (one of ${SUPPORTED_INDICES.join(', ')}).`)
      }
      if (index2 === index) {
        return unavailable(`correlating ${index} with itself is trivially 1.0 — pass a different \`index2\`.`)
      }
      // Pin both reads to the same scene: correlating two dates would measure
      // time, not the relationship between the bands.
      const scene = await pickSceneForAoi(aoi, bbox, args.date ? String(args.date) : undefined)
      if (!scene.ok) return unavailable(scene.message)
      const a = await loadIndexGrid({ index, aoi, bbox, maxSize, item: scene.item })
      if (!a.ok) return unavailable(a.message)
      const b = await loadIndexGrid({ index: index2, aoi, bbox, maxSize, item: scene.item })
      if (!b.ok) return unavailable(b.message)

      let c
      try {
        c = computeCorrelation(a.loaded.grid, b.loaded.grid)
      } catch (err: any) {
        return unavailable(err?.message ?? 'the two index grids could not be aligned.')
      }
      if (!c) return unavailable(`fewer than three pixels were clear for both ${index} and ${index2}.`)

      const strength = Math.abs(c.pearson) > 0.8 ? 'strongly'
        : Math.abs(c.pearson) > 0.5 ? 'moderately'
        : Math.abs(c.pearson) > 0.2 ? 'weakly' : 'barely'
      const sign = c.pearson >= 0 ? 'positively' : 'negatively'

      return {
        ...evidence(loaded),
        summary: [
          `**${index} and ${index2} are ${strength} ${sign} correlated over this AOI (r = ${n(c.pearson, 3)})**.`,
          `Across ${c.n.toLocaleString()} pixels clear for both, ${index2} ≈ ${n(c.slope, 3)}·${index} ` +
            `${c.intercept >= 0 ? '+' : '−'} ${n(Math.abs(c.intercept), 3)} ` +
            `(Spearman ρ ${n(c.spearman, 3)}, so the relationship is ` +
            `${Math.abs(c.spearman) - Math.abs(c.pearson) > 0.05 ? 'monotone but not linear' : 'close to linear'}).`,
          `Both indices come from the same scene — ${a.loaded.scene.date} — so this measures the relationship ` +
            `between bands, not change over time. ${caveat(a.loaded)}`,
        ].join('\n\n'),
        summary_data: {
          operation: 'correlate',
          index_x: index, index_y: index2,
          pearson_r: n(c.pearson), spearman_rho: n(c.spearman),
          r_squared: n(c.pearson * c.pearson),
          slope: n(c.slope), intercept: n(c.intercept),
          pixels: c.n,
          scene_date: a.loaded.scene.date,
        },
      }
    }

    // -----------------------------------------------------------------------
    case 'texture': {
      const window = args.window != null ? Number(args.window) : 3
      const metric = String(args.metric || 'stddev') as TextureMetric
      if (!['stddev', 'range', 'mad'].includes(metric)) {
        return unavailable(`unknown texture metric "${args.metric}". Supported: stddev, range, mad.`)
      }
      let t
      try {
        t = computeTexture(grid, { window, metric })
      } catch (err: any) {
        return unavailable(err?.message ?? 'the texture window was invalid.')
      }
      if (!t) {
        return unavailable(
          `too few clear neighbours in any ${window}×${window} window to measure ${index} texture — ` +
          `the AOI is mostly masked or too small at this resolution.`,
        )
      }
      const s = t.stats
      const heterogeneity = s.mean > 0.08 ? 'heterogeneous' : s.mean > 0.03 ? 'moderately varied' : 'smooth'
      const png = await renderGridPng(t.grid, sequentialRamp(s.p05, s.p95))

      return {
        summary: [
          `**The AOI is ${heterogeneity} in ${index} at the ${t.windowM} m scale** — mean local ${metric} ` +
            `${n(s.mean, 4)}.`,
          `Local variation runs from ${n(s.p05, 4)} (5th pct) to ${n(s.p95, 4)} (95th pct) across ` +
            `${s.count.toLocaleString()} ${t.window}×${t.window}-pixel windows.`,
          caveat(loaded),
        ].join('\n\n'),
        summary_data: {
          index, operation: 'texture', metric,
          window_px: t.window, window_m: t.windowM,
          mean: n(s.mean), median: n(s.median), std: n(s.std),
          p05: n(s.p05), p95: n(s.p95), max: n(s.max),
          windows: s.count,
          scene_date: loaded.scene.date,
        },
        layer: png ? {
          id: `texture-${genId()}`,
          name: `${index} texture (${metric}, ${t.windowM} m)`,
          type: 'raster',
          imageBase64: png,
          bounds: bbox,
          palette: {
            kind: 'gradient',
            label: `${index} local ${metric}`,
            min: n(s.p05), max: n(s.p95),
            stops: [
              { value: n(s.p05), color: '#1e1b4b', label: 'smooth' },
              { value: n((s.p05 + s.p95) / 2), color: '#24bb89', label: '' },
              { value: n(s.p95), color: '#f7a10b', label: 'rough' },
            ],
          },
          confidence: 'high',
          provenance: baseProvenance(loaded, `${t.window}×${t.window} moving-window ${metric}`),
        } : undefined,
      }
    }

    // -----------------------------------------------------------------------
    case 'cluster': {
      const k = args.k != null ? Number(args.k) : 4
      const requested: string[] = Array.isArray(args.indices) && args.indices.length
        ? args.indices.map((s: any) => String(s).toUpperCase())
        : [index]

      const scene = await pickSceneForAoi(aoi, bbox, args.date ? String(args.date) : undefined)
      if (!scene.ok) return unavailable(scene.message)

      const grids: AnalysisGrid[] = []
      let firstLoaded: LoadedGrid | null = null
      for (const idx of requested) {
        const g = await loadIndexGrid({ index: idx, aoi, bbox, maxSize, item: scene.item })
        if (!g.ok) return unavailable(`${idx}: ${g.message}`)
        grids.push(g.loaded.grid)
        firstLoaded ??= g.loaded
      }

      let out
      try {
        out = computeClusters(grids, k)
      } catch (err: any) {
        return unavailable(err?.message ?? 'the index grids could not be aligned for clustering.')
      }
      if (!out || !firstLoaded) {
        return unavailable(
          `too few pixels are clear across all of ${requested.join(', ')} to form ${k} zones.`,
        )
      }

      const total = out.count
      const ranked = out.sizes
        .map((size, i) => ({ i, size, centroid: out.centroids[i] }))
        .sort((a, b) => b.size - a.size)
      const top = ranked[0]
      const assignValues = new Float64Array(out.assignments.length)
      const assignValid = new Uint8Array(out.assignments.length)
      for (let i = 0; i < out.assignments.length; i++) {
        const c = out.assignments[i]
        if (c < 0) continue
        assignValues[i] = c
        assignValid[i] = 1
      }
      const assignGrid: AnalysisGrid = {
        ...grids[0],
        values: assignValues,
        valid: assignValid,
        label: 'cluster',
      }
      const png = await renderGridPng(assignGrid, classRamp())

      const describe = (c: { i: number; size: number; centroid: number[] }) =>
        `zone ${c.i + 1} (${n((c.size / total) * 100, 1)}%, ` +
        requested.map((idx, d) => `${idx} ${n(c.centroid[d], 3)}`).join(', ') + ')'

      return {
        summary: [
          `**The AOI splits into ${out.centroids.length} spectral zones**, the largest covering ` +
            `${n((top.size / total) * 100, 1)}% of clear pixels at ` +
            requested.map((idx, d) => `${idx} ${n(top.centroid[d], 3)}`).join(', ') + '.',
          `Zones by size: ${ranked.map(describe).join('; ')}. ` +
            `k-means on ${requested.join(' + ')} over ${total.toLocaleString()} pixels, ` +
            `${out.iterations} iterations, deterministic initialisation (the same AOI always gives the same zones).` +
            (out.centroids.length < k
              ? ` Only ${out.centroids.length} of the ${k} requested zones held any pixel — the rest would have been empty.`
              : ''),
          caveat(firstLoaded) + ' Zones are spectral groupings, not land-cover classes — ' +
            'use `classify_land_cover` or `find_dataset` for a labelled vocabulary.',
        ].join('\n\n'),
        summary_data: {
          operation: 'cluster',
          indices: requested.join(','),
          k_requested: k,
          k_returned: out.centroids.length,
          pixels: total,
          iterations: out.iterations,
          scene_date: firstLoaded.scene.date,
          zone_sizes: ranked.map((c) => ({ label: `zone ${c.i + 1}`, value: n((c.size / total) * 100, 1) })),
        },
        layer: png ? {
          id: `cluster-${genId()}`,
          name: `${requested.join('+')} zones (k=${out.centroids.length})`,
          type: 'raster',
          imageBase64: png,
          bounds: bbox,
          palette: {
            kind: 'classes',
            label: 'spectral zone',
            classes: ranked.map((c) => ({
              color: CLUSTER_COLORS[c.i % CLUSTER_COLORS.length],
              label: `zone ${c.i + 1} — ${n((c.size / total) * 100, 1)}%`,
              value: c.i,
            })),
          },
          confidence: 'medium',
          provenance: baseProvenance(firstLoaded, `k-means (k=${out.centroids.length}) on ${requested.join(' + ')}`),
        } : undefined,
      }
    }
  }

  // Unreachable — every operation returns above.
  log.warn({ operation }, 'analyze_raster fell through the dispatcher')
  return unavailable(`operation "${operation}" is not implemented.`)
}
