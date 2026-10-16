/** Two-phase validation (ADR-0001 §3, Q-43). Nothing that fails is rendered as fine.
 *
 *  STATIC checks run before the operation, are pure and take milliseconds: the arguments
 *  against the zod schema, the AOI against the operation's limits, the dates, the bands against
 *  the sensor, the data resolution against the target. Any `fail` refuses the run.
 *
 *  DYNAMIC checks run on the finished output: physical plausibility, finite numbers, valid-pixel
 *  and cloud fractions, and the rule that any figure or layer must name the data it came from.
 *  Any `fail` flags the result (the layers are still returned, marked, never shown as fine).
 *
 *  Every check returns a `ValidationCheck`; passes are recorded too, so the result states what
 *  was checked and not only what went wrong.
 */

import type { z } from 'zod'

import type { ValidationCheck } from '@/lib/geo-result'
import { EXCESSIVE_AOI_KM2 } from '@/lib/aoi-guard'

import { MIN_USABLE_CLEAR_PCT } from '../lib/cloud'
import { assessResolution } from '../lib/inference/registry'
import { parseRasterSpec } from '../lib/raster-render'
import type { ToolOutput } from '../lib/types'
import { DATE_KEYS, type AnyOperation, type StaticCtx } from './operation'

export const fail = (phase: ValidationCheck['phase'], id: string, message: string): ValidationCheck => ({ id, phase, status: 'fail', message })
export const warn = (phase: ValidationCheck['phase'], id: string, message: string): ValidationCheck => ({ id, phase, status: 'warn', message })
export const pass = (phase: ValidationCheck['phase'], id: string, message: string): ValidationCheck => ({ id, phase, status: 'pass', message })

export const hasFailure = (checks: ValidationCheck[]): boolean => checks.some((c) => c.status === 'fail')

// ---------------------------------------------------------------------------
// Static: arguments
// ---------------------------------------------------------------------------

/** Drop `null` values (models send them for "unset") then validate against the op's schema. */
export function validateParams(
  op: AnyOperation,
  raw: Record<string, unknown>,
): { ok: true; args: Record<string, any> } | { ok: false; check: ValidationCheck } {
  const cleaned = Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v !== null && v !== undefined))
  const parsed = op.params.safeParse(cleaned)
  if (parsed.success) return { ok: true, args: parsed.data }
  return { ok: false, check: fail('static', 'params', `Invalid arguments for ${op.name}: ${formatIssues(parsed.error)}`) }
}

function formatIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ')
}

// ---------------------------------------------------------------------------
// Static: AOI, dates, bands, resolution
// ---------------------------------------------------------------------------

export function checkAoiArea(op: AnyOperation, ctx: StaticCtx): ValidationCheck {
  const max = op.limits?.maxAreaKm2 ?? EXCESSIVE_AOI_KM2
  const min = op.limits?.minAreaKm2
  const a = ctx.areaKm2
  if (!Number.isFinite(a) || a <= 0) return fail('static', 'aoi_area', 'The AOI has no measurable area.')
  if (a > max) {
    return fail('static', 'aoi_area', `The AOI is ${fmt(a)} km², above the ${fmt(max)} km² ${op.name} is built for. Draw a smaller area.`)
  }
  if (min != null && a < min) {
    return fail('static', 'aoi_area', `The AOI is ${fmt(a)} km², below the ${fmt(min)} km² ${op.name} needs for a meaningful answer. Draw a larger area.`)
  }
  return pass('static', 'aoi_area', `AOI ${fmt(a)} km² is within ${op.name}'s limits (${min != null ? `${fmt(min)}–` : 'up to '}${fmt(max)} km²).`)
}

const fmt = (n: number) => (n >= 100 ? Math.round(n) : Math.round(n * 100) / 100).toLocaleString('en-US')

/** `YYYY-MM-DD`, or `YYYY` for the dataset-search arguments that take a bare year. */
function parseDay(v: string): number | null {
  if (/^\d{4}$/.test(v)) return Date.parse(`${v}-01-01T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  const t = Date.parse(`${v}T00:00:00Z`)
  // Date.parse rolls 2026-02-31 over to March; reject it instead.
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v ? null : t
}

/** Pairs that must be in order; `strict` when the same day on both sides is meaningless (a flood
 *  needs a dry reference EARLIER than the event, a change needs two different dates). */
const ORDERED_PAIRS: Array<[string, string, boolean]> = [['start', 'end', false], ['date', 'date2', true], ['before', 'after', true]]

export function checkDates(op: AnyOperation, args: Record<string, any>, now = Date.now()): ValidationCheck[] {
  const present = DATE_KEYS.filter((k) => typeof args[k] === 'string' && args[k] !== '')
  if (present.length === 0) return []
  const checks: ValidationCheck[] = []
  const times: Record<string, number> = {}
  for (const k of present) {
    const t = parseDay(args[k])
    if (t == null) checks.push(fail('static', 'dates_valid', `\`${k}\` must be a real YYYY-MM-DD date, got "${args[k]}".`))
    else times[k] = t
  }
  if (checks.length) return checks

  const today = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z')
  for (const [k, t] of Object.entries(times)) {
    if (t > today) {
      checks.push(fail('static', 'dates_not_future', `\`${k}\` (${args[k]}) is in the future (today is ${new Date(today).toISOString().slice(0, 10)}); no scene exists yet.`))
    }
  }
  const earliest = op.limits?.earliest
  if (earliest) {
    const e = Date.parse(`${earliest}T00:00:00Z`)
    for (const [k, t] of Object.entries(times)) {
      if (t < e) checks.push(fail('static', 'dates_after_earliest', `\`${k}\` (${args[k]}) is before ${op.name}'s data begins (${earliest}).`))
    }
  }
  for (const [a, b, strict] of ORDERED_PAIRS) {
    if (a in times && b in times && (strict ? times[a] >= times[b] : times[a] > times[b])) {
      checks.push(fail('static', 'dates_ordered', `\`${a}\` (${args[a]}) must be ${strict ? 'earlier than' : 'on or before'} \`${b}\` (${args[b]}).`))
    }
  }
  return checks.length ? checks : [pass('static', 'dates', `Dates ${present.map((k) => args[k]).join(', ')} are valid, not in the future${earliest ? `, and not before ${earliest}` : ''}.`)]
}

/** Bands the sensor does not have, for `render_raster`-style `bands` / `expression` arguments. */
export function checkRasterBands(sensor: 'sentinel-2-l2a' | 'landsat-c2-l2', args: { bands?: unknown; expression?: unknown }): ValidationCheck {
  const spec = parseRasterSpec(sensor, { bands: args.bands, expression: args.expression })
  return spec.ok
    ? pass('static', 'bands_exist', `Bands ${spec.bands.join(', ')} exist for ${sensor}.`)
    : fail('static', 'bands_exist', spec.error)
}

export function checkResolution(op: AnyOperation, args: Record<string, any>): ValidationCheck | null {
  const intent = op.target?.(args)
  if (!intent || op.resolution_m == null) return null
  const a = assessResolution(intent, op.resolution_m)
  return a.canAnswer
    ? pass('static', 'resolution_vs_target', a.honestNote)
    : fail('static', 'resolution_vs_target', `${op.name} reads ${op.resolution_m} m data. ${a.honestNote}`)
}

export function runStaticChecks(op: AnyOperation, ctx: StaticCtx, args: Record<string, any>, now = Date.now()): ValidationCheck[] {
  return [
    checkAoiArea(op, ctx),
    ...checkDates(op, args, now),
    ...[checkResolution(op, args)].filter((c): c is ValidationCheck => c != null),
    ...(op.staticChecks?.(ctx, args) ?? []),
  ]
}

// ---------------------------------------------------------------------------
// Dynamic
// ---------------------------------------------------------------------------

/** Normalised-difference indices are bounded by construction; SAVI by its (1+L) factor. EVI has no
 *  hard bound (its denominator can approach zero), so it is deliberately not range-checked. */
const INDEX_BOUNDS: Record<string, [number, number]> = {
  NDVI: [-1, 1], NDWI: [-1, 1], NDBI: [-1, 1], NBR: [-1, 1], SAVI: [-1.5, 1.5],
}
/** Statistics keys that hold values of the layer's own variable. */
const VALUE_KEYS = ['mean', 'index_mean', 'median', 'min', 'max', 'p2', 'p98']

/** Reflectance cannot be negative. The processing offsets (Sentinel-2 -0.1, Landsat -0.2) let dark
 *  surfaces dip slightly below zero, so only a value below the offset itself is impossible. */
const REFLECTANCE_FLOOR = -0.2

/** Share of the AOI's pixels that are clear, below which the figures describe mostly cloud. */
const VALID_PIXEL_WARN_PCT = 70
/** Scene-wide cloud cover above which the scene is flagged as cloudy (the AOI share is judged apart). */
const CLOUD_WARN_PCT = 60

const isNum = (v: unknown): v is number => typeof v === 'number'

export function genericDynamicChecks(output: ToolOutput, layers: NonNullable<ToolOutput['layers']>, sources: string[]): ValidationCheck[] {
  const checks: ValidationCheck[] = []
  const stats = output.summary_data ?? {}

  // Raster descriptors and palettes must be finite and ordered, or the legend and stretch are junk.
  const badRaster: string[] = []
  for (const l of layers) {
    for (const [lo, hi] of l.raster?.rescale ?? []) {
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) badRaster.push(`${l.name}: stretch ${lo}..${hi}`)
    }
    if (l.palette?.kind === 'gradient' && (!Number.isFinite(l.palette.min) || !Number.isFinite(l.palette.max))) {
      badRaster.push(`${l.name}: palette ${l.palette.min}..${l.palette.max}`)
    }
  }
  if (layers.some((l) => l.raster || l.palette?.kind === 'gradient')) {
    checks.push(badRaster.length
      ? fail('dynamic', 'raster_finite', `Raster min/max is not a finite, increasing range (${badRaster.join('; ')}).`)
      : pass('dynamic', 'raster_finite', 'Raster stretch and palette ranges are finite.'))
  }

  // Every number in the stats is finite (NaN and Infinity serialise to null and vanish).
  const nonFinite: string[] = []
  for (const [k, v] of Object.entries(stats)) {
    if (isNum(v) && !Number.isFinite(v)) nonFinite.push(k)
    if (Array.isArray(v) && v.some((p) => !Number.isFinite(p.value))) nonFinite.push(k)
  }
  if (Object.keys(stats).length) {
    checks.push(nonFinite.length
      ? fail('dynamic', 'stats_finite', `Statistics are not finite numbers: ${nonFinite.join(', ')}.`)
      : pass('dynamic', 'stats_finite', 'All statistics are finite numbers.'))
  }

  // Index-like layers stay inside their physical range; reflectance is not negative.
  for (const l of layers) {
    const index = l.raster?.index?.toUpperCase()
    const bounds = index ? INDEX_BOUNDS[index] : undefined
    if (index && bounds) {
      const out = VALUE_KEYS.filter((k) => isNum(stats[k]) && Number.isFinite(stats[k] as number) && ((stats[k] as number) < bounds[0] || (stats[k] as number) > bounds[1]))
      checks.push(out.length
        ? fail('dynamic', 'index_range', `${index} must lie within [${bounds[0]}, ${bounds[1]}] but ${out.map((k) => `${k}=${stats[k]}`).join(', ')}: the computation or the scene is wrong.`)
        : pass('dynamic', 'index_range', `${index} statistics lie within [${bounds[0]}, ${bounds[1]}].`))
    }
    if (l.raster?.units === 'reflectance') {
      const lows = VALUE_KEYS.filter((k) => isNum(stats[k]) && Number.isFinite(stats[k] as number) && (stats[k] as number) < 0)
      const impossible = lows.filter((k) => (stats[k] as number) < REFLECTANCE_FLOOR)
      checks.push(impossible.length
        ? fail('dynamic', 'reflectance_range', `Surface reflectance cannot be below ${REFLECTANCE_FLOOR} but ${impossible.map((k) => `${k}=${stats[k]}`).join(', ')}.`)
        : lows.length
          ? warn('dynamic', 'reflectance_range', `Reflectance is slightly negative (${lows.map((k) => `${k}=${stats[k]}`).join(', ')}); the sensor's processing offset allows this over very dark surfaces.`)
          : pass('dynamic', 'reflectance_range', 'Reflectance is not negative.'))
    }
  }

  // Valid-pixel and cloud fractions, when the tool measured them.
  const valid = stats.valid_pixel_pct
  if (isNum(valid)) {
    checks.push(valid < MIN_USABLE_CLEAR_PCT
      ? fail('dynamic', 'valid_pixels', `Only ${valid}% of the AOI's pixels are clear (floor ${MIN_USABLE_CLEAR_PCT}%): the figures describe mostly cloud or masked ground.`)
      : valid < VALID_PIXEL_WARN_PCT
        ? warn('dynamic', 'valid_pixels', `${valid}% of the AOI's pixels are clear; the rest are masked.`)
        : pass('dynamic', 'valid_pixels', `${valid}% of the AOI's pixels are clear.`))
  }
  const cloud = stats.cloud_pct
  if (isNum(cloud)) {
    checks.push(cloud > CLOUD_WARN_PCT
      ? warn('dynamic', 'cloud_cover', `The scene is ${cloud}% cloud-covered scene-wide.`)
      : pass('dynamic', 'cloud_cover', `Scene-wide cloud cover is ${cloud}%.`))
  }

  // A measured figure or layer must name the data it came from. This is what makes a result with
  // no data behind it impossible to present as a measurement.
  if ((layers.length > 0 || Object.keys(stats).length > 0) && !output.failed) {
    checks.push(sources.length === 0
      ? fail('dynamic', 'provenance_sources', 'The result has layers or figures but names no data source, so it cannot be treated as a measurement.')
      : pass('dynamic', 'provenance_sources', `Data sources: ${sources.join('; ')}.`))
  }
  return checks
}
