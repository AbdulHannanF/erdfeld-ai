/** NDVI stack → labelled field polygons (segmentation + phenology + vectorization).
 *  Pure computation: no network, so the whole chain is testable on synthetic stacks. */

import { vectorizeLabels, type BBox } from '../vectorize'
import { CLASS_COLORS, classLabels, classifyProfile, regionConfidence, type PhenClass } from './phenology'
import { segmentFields, type SegmentResult, type StackInput } from './segment'

export interface DelineateStack extends StackInput {
  bbox: BBox
  dates: string[]
  cellXm: number
  cellYm: number
}

export interface DelineateOptions {
  minFieldAreaM2: number
  /** Latitude, for hemisphere-aware season labels. */
  lat: number
  simplifyTolerancePx?: number
  mergeDistance?: number
}

export interface ClassTotals { count: number; areaHa: number }

export interface DelineateResult {
  features: any[]
  byClass: Record<PhenClass, ClassTotals>
  fieldCount: number
  nonFieldCount: number
  totalFieldAreaHa: number
  droppedSmall: number
  droppedAreaHa: number
  medianConfidence: number | null
  segment: SegmentResult
}

const round = (v: number, d: number) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null)

export function delineateFromStack(stack: DelineateStack, opts: DelineateOptions): DelineateResult {
  const pixelAreaM2 = stack.cellXm * stack.cellYm
  const minAreaPx = Math.max(1, Math.ceil(opts.minFieldAreaM2 / pixelAreaM2))
  const segment = segmentFields(stack, { minAreaPx, mergeDistance: opts.mergeDistance })

  const vec = vectorizeLabels(segment.labels, stack.width, stack.height, {
    bbox: stack.bbox,
    minAreaM2: opts.minFieldAreaM2,
    simplifyTolerancePx: opts.simplifyTolerancePx ?? 0.7,
  })

  const labels = classLabels(opts.lat)
  const byClass = Object.fromEntries(
    (Object.keys(labels) as PhenClass[]).map((c) => [c, { count: 0, areaHa: 0 }]),
  ) as Record<PhenClass, ClassTotals>

  const rows = vec.polygons
    .map((p) => {
      const region = segment.regions[p.value - 1]
      const ph = classifyProfile(stack.dates, region.profile, opts.lat, region.ndbiProfile)
      return { p, region, ph, confidence: regionConfidence(region.contrast, region.sd, region.validDateFrac) }
    })
    .sort((a, b) => b.p.areaM2 - a.p.areaM2)

  const confidences: number[] = []
  let fieldCount = 0
  let nonFieldCount = 0
  let totalFieldAreaHa = 0
  const features = rows.map(({ p, region, ph, confidence }, i) => {
    const areaHa = p.areaM2 / 10_000
    const isField = ph.cls !== 'non_field' && ph.cls !== 'unknown'
    byClass[ph.cls].count++
    byClass[ph.cls].areaHa += areaHa
    if (isField) {
      fieldCount++
      totalFieldAreaHa += areaHa
      confidences.push(confidence)
    } else nonFieldCount++
    const profileValues = region.profile.map((v) => round(v, 2))
    return {
      type: 'Feature' as const,
      properties: {
        name: ph.label,
        field_id: i + 1,
        class: ph.cls,
        phenology: ph.label,
        is_field: isField,
        area_ha: round(areaHa, 2),
        area_m2: Math.round(p.areaM2),
        ndvi_max: round(ph.maxNdvi ?? NaN, 2),
        ndvi_min: round(ph.minNdvi ?? NaN, 2),
        ndvi_amplitude: round(ph.amplitude ?? NaN, 2),
        ndbi_median: round(ph.medianNdbi ?? NaN, 2),
        growing_seasons: ph.peaks,
        peak_dates: ph.peakDates.join(', ') || null,
        ndvi_profile: stack.dates
          .map((d, k) => `${d.slice(5)}: ${profileValues[k] === null ? '–' : profileValues[k]!.toFixed(2)}`)
          .join(' · '),
        profile_dates: stack.dates,
        profile_values: profileValues,
        confidence: round(confidence, 2),
        color: CLASS_COLORS[ph.cls],
      },
      geometry: { type: 'Polygon' as const, coordinates: p.coordinates },
    }
  })

  confidences.sort((a, b) => a - b)
  const medianConfidence = confidences.length ? confidences[Math.floor(confidences.length / 2)] : null
  return {
    features,
    byClass,
    fieldCount,
    nonFieldCount,
    totalFieldAreaHa,
    droppedSmall: vec.droppedSmall,
    droppedAreaHa: vec.droppedAreaM2 / 10_000,
    medianConfidence,
    segment,
  }
}
