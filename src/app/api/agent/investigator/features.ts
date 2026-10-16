/**
 * Feature extractors: the measured numbers an evidence item reads out of a `GeoResult`.
 *
 * Pure. Each reads the result's citable `stats` only, names the raw field it came from (so the
 * dossier can cite `[[result_id#field]]`), and says why when it cannot read anything. A result
 * that did not run, or that a validation check flagged, yields no feature at all: it is recorded
 * as "could not measure" and never updates a belief (see `readFeature`).
 */

import { failingChecks, type GeoResult } from '@/lib/geo-result'

export type FeatureOutcome =
  | { ok: true; value: number | string; field: string; derivation: string }
  | { ok: false; reason: string }

type Stats = NonNullable<GeoResult['stats']>
type Extractor = (stats: Stats, result: GeoResult) => FeatureOutcome

const no = (reason: string): FeatureOutcome => ({ ok: false, reason })
const yes = (value: number | string, field: string, derivation: string): FeatureOutcome => ({ ok: true, value, field, derivation })

const num = (stats: Stats, key: string): number | undefined => {
  const v = stats[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

const missing = (key: string, op: string): FeatureOutcome => no(`${op} did not report \`${key}\``)

/** Round to a stable precision so a derived feature is reproducible. */
const r4 = (x: number) => Number(x.toFixed(4))

/** Change analyses report `mean_delta` as after minus before. */
function changeOf(index: string, sign: 1 | -1, derivation: string): Extractor {
  return (stats) => {
    if (stats.operation !== 'change') return no('analyze_raster did not return a change analysis')
    if (String(stats.index).toUpperCase() !== index) return no(`the change analysis was for ${String(stats.index)}, not ${index}`)
    const d = num(stats, 'mean_delta')
    return d === undefined ? missing('mean_delta', 'analyze_raster') : yes(r4(sign * d), 'mean_delta', derivation)
  }
}

/** Features read from a change analysis that was restricted to ground with a baseline property. */
function restricted(name: string, read: Extractor): Extractor {
  return (s, result) => {
    if (typeof s.baseline_min !== 'number') return no(`${name} needs a change analysis restricted with baseline_min; this one covers the whole area`)
    return read(s, result)
  }
}

const DAY_MS = 86_400_000

export const FEATURES: Record<string, Extractor> = {
  newly_flooded_fraction: (s) => {
    const v = num(s, 'flood_pct_of_observed')
    return v === undefined ? missing('flood_pct_of_observed', 'map_flood') : yes(r4(v / 100), 'flood_pct_of_observed', 'flood_pct_of_observed / 100')
  },
  pre_event_water_fraction: (s) => {
    const v = num(s, 'before_water_pct')
    return v === undefined ? missing('before_water_pct', 'map_flood') : yes(r4(v / 100), 'before_water_pct', 'before_water_pct / 100')
  },
  sar_orbit_match: (s) => {
    const v = s.orbit_match
    return typeof v === 'string' ? yes(v, 'orbit_match', 'as reported') : missing('orbit_match', 'map_flood')
  },
  water_occurrence_pct: (s) => {
    const v = num(s, 'occurrence_mean_pct')
    return v === undefined ? missing('occurrence_mean_pct', 'fetch_surface_water') : yes(v, 'occurrence_mean_pct', 'as reported')
  },
  ndwi_rise: changeOf('NDWI', 1, 'mean_delta (after minus before)'),
  ndbi_rise: changeOf('NDBI', 1, 'mean_delta (after minus before)'),
  ndvi_drop: changeOf('NDVI', -1, '-mean_delta (before minus after)'),
  dnbr: changeOf('NBR', -1, '-mean_delta (pre-fire NBR minus post-fire NBR)'),
  nbr_loss_fraction: (s) => {
    if (s.operation !== 'change' || String(s.index).toUpperCase() !== 'NBR') return no('the result is not an NBR change analysis')
    const v = num(s, 'decreased_pct')
    return v === undefined ? missing('decreased_pct', 'analyze_raster') : yes(r4(v / 100), 'decreased_pct', 'decreased_pct / 100 (pixels whose NBR fell by more than the threshold)')
  },
  /** dNBR over the ground that was vegetated before: the setting the USGS severity classes were made for. */
  dnbr_burnable: restricted('dnbr_burnable', changeOf('NBR', -1, '-mean_delta over pixels with NBR >= baseline_min before the event (pre minus post)')),
  nbr_loss_fraction_burnable: restricted('nbr_loss_fraction_burnable', (s) => {
    if (s.operation !== 'change' || String(s.index).toUpperCase() !== 'NBR') return no('the result is not an NBR change analysis')
    const v = num(s, 'decreased_pct')
    return v === undefined ? missing('decreased_pct', 'analyze_raster') : yes(r4(v / 100), 'decreased_pct', 'decreased_pct / 100 over pixels with NBR >= baseline_min before the event')
  }),
  anniversary_gap_days: (s) => {
    const a = typeof s.date_before === 'string' ? Date.parse(s.date_before) : NaN
    const b = typeof s.date_after === 'string' ? Date.parse(s.date_after) : NaN
    if (!Number.isFinite(a) || !Number.isFinite(b)) return missing('date_before / date_after', 'analyze_raster')
    const span = (b - a) / DAY_MS
    if (span < 330) return no(`the two scenes are ${Math.round(span)} days apart, under a year, so there is no anniversary to compare against`)
    const years = Math.round(span / 365.25)
    return yes(Math.round(Math.abs(span - years * 365.25)), 'date_after', 'days between the scenes actually used, from the nearest whole number of years')
  },
  built_up_pct: (s) => {
    const v = num(s, 'built_up_pct')
    return v === undefined ? missing('built_up_pct', 'fetch_built_surface') : yes(v, 'built_up_pct', 'as reported')
  },
  cropland_pct: (s) => {
    const v = num(s, 'cropland_pct')
    return v === undefined ? missing('cropland_pct', 'fetch_built_surface') : yes(v, 'cropland_pct', 'as reported')
  },
  mapped_building_density_per_km2: (s) => {
    const n = num(s, 'feature_count')
    const area = num(s, 'area_km2')
    if (n === undefined || area === undefined || area <= 0) return missing('feature_count / area_km2', 'query_osm')
    return yes(r4(n / area), 'feature_count', 'feature_count / area_km2')
  },
  active_fire_count: (s) => {
    // FIRMS reports `fire_count`; the key-free EONET fallback reports incidents instead.
    const v = num(s, 'fire_count') ?? num(s, 'events_in_aoi')
    return v === undefined ? missing('fire_count', 'fetch_active_fires') : yes(v, num(s, 'fire_count') !== undefined ? 'fire_count' : 'events_in_aoi', 'as reported')
  },
  within_expected_range: (s) => {
    const v = s.verdict
    if (v === 'within_expected' || v === 'below_expected' || v === 'above_expected') return yes(v, 'verdict', 'as reported')
    return no(typeof v === 'string' ? `detect_anomaly answered "${v}"` : 'detect_anomaly did not report a verdict')
  },
}

/** Why a result cannot be measured from, or null when it can be read. */
export function unusableReason(result: GeoResult): string | null {
  if (result.status === 'refused') return `refused before running: ${result.summary.replace(/\*+/g, '').slice(0, 220)}`
  if (result.status === 'failed') return `could not be read: ${result.summary.replace(/\*+/g, '').slice(0, 220)}`
  if (result.status === 'flagged') {
    const why = failingChecks(result.validation).filter((c) => c.status === 'fail').map((c) => c.message).join(' ')
    return `flagged by a validation check, so it does not update the belief: ${why.slice(0, 220)}`
  }
  return null
}

/** The feature `name` read from `result`, or the reason there is none. */
export function readFeature(name: string, result: GeoResult): FeatureOutcome {
  const unusable = unusableReason(result)
  if (unusable) return no(unusable)
  const extract = FEATURES[name]
  if (!extract) return no(`no extractor named ${name}`)
  if (!result.stats) return no(`the result has no figures: ${result.summary.replace(/\*+/g, '').replace(/\s+/g, ' ').slice(0, 200)}`)
  return extract(result.stats, result)
}
