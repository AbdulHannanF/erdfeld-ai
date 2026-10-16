/** Tier C — indirect evidence (v2 spec §3.4).
 *
 *  > For targets below nadir resolving power: shadow-length geometry (sun
 *  > azimuth/elevation from scene date/time), texture and pattern signatures, or
 *  > street-level detection via Mapillary.
 *
 *  Scope note, deliberate: **Tier C emits no detections.** A 0.3 m pole is ~1 px
 *  at 0.25 m/px; nothing recovers its outline, and a polygon drawn from a shadow
 *  would be a fabricated boundary presented with a real coordinate. What Tier C
 *  does instead is state the physics — how long a shadow the target casts here
 *  and now, whether that shadow is itself resolvable, and which street-level
 *  source would settle it. That is the honest use of indirect evidence, and it
 *  is what turns "we found nothing" into "here is why, and here is what would".
 *
 *  The solar geometry is the NOAA low-precision algorithm: pure, deterministic
 *  and good to ~0.1°, which is far more than enough to decide whether a shadow
 *  is metres or centimetres long.
 */

import type { LadderContext, TierRunner, TierRunResult } from './ladder'

export interface SolarPosition {
  /** Degrees above the horizon; negative when the sun has set. */
  elevationDeg: number
  /** Degrees clockwise from true north. */
  azimuthDeg: number
}

const RAD = Math.PI / 180

/** Sun elevation and azimuth for a moment and place (NOAA low-precision). */
export function solarPosition(when: Date, lat: number, lon: number): SolarPosition {
  // Julian day → Julian century.
  const jd = when.getTime() / 86_400_000 + 2440587.5
  const t = (jd - 2451545) / 36525

  const meanLong = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360
  const meanAnom = 357.52911 + t * (35999.05029 - 0.0001537 * t)
  const eccent = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)

  const sunEqOfCentre =
    Math.sin(meanAnom * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnom * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnom * RAD) * 0.000289

  const trueLong = meanLong + sunEqOfCentre
  const omega = 125.04 - 1934.136 * t
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD)

  const meanObliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
  const obliqCorr = meanObliq + 0.00256 * Math.cos(omega * RAD)

  const declination =
    Math.asin(Math.sin(obliqCorr * RAD) * Math.sin(appLong * RAD)) / RAD

  const varY = Math.tan((obliqCorr / 2) * RAD) ** 2
  const eqOfTime =
    4 *
    (varY * Math.sin(2 * meanLong * RAD) -
      2 * eccent * Math.sin(meanAnom * RAD) +
      4 * eccent * varY * Math.sin(meanAnom * RAD) * Math.cos(2 * meanLong * RAD) -
      0.5 * varY * varY * Math.sin(4 * meanLong * RAD) -
      1.25 * eccent * eccent * Math.sin(2 * meanAnom * RAD)) /
    RAD

  const minutesUtc =
    when.getUTCHours() * 60 + when.getUTCMinutes() + when.getUTCSeconds() / 60
  // True solar time in minutes, referenced to the actual longitude.
  const trueSolarTime = (minutesUtc + eqOfTime + 4 * lon + 1440) % 1440
  const hourAngle = trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180

  const zenith =
    Math.acos(
      Math.sin(lat * RAD) * Math.sin(declination * RAD) +
        Math.cos(lat * RAD) * Math.cos(declination * RAD) * Math.cos(hourAngle * RAD),
    ) / RAD

  const elevationDeg = 90 - zenith

  let azimuthDeg: number
  const denom = Math.cos(lat * RAD) * Math.sin(zenith * RAD)
  if (Math.abs(denom) > 1e-9) {
    let c =
      (Math.sin(lat * RAD) * Math.cos(zenith * RAD) - Math.sin(declination * RAD)) / denom
    c = Math.max(-1, Math.min(1, c))
    azimuthDeg = hourAngle > 0 ? (Math.acos(c) / RAD + 180) % 360 : (540 - Math.acos(c) / RAD) % 360
  } else {
    azimuthDeg = lat > 0 ? 180 : 0
  }

  return { elevationDeg, azimuthDeg }
}

/** Shadow cast on flat ground by a vertical object, or null when the sun is down. */
export function shadowLengthM(heightM: number, sunElevationDeg: number): number | null {
  if (!(sunElevationDeg > 0)) return null
  return heightM / Math.tan(sunElevationDeg * RAD)
}

/**
 * Rough vertical extent for a target, used only for shadow arithmetic.
 *
 * Kept separate from the footprint table because height and footprint are
 * different questions: a utility pole is 0.3 m across and 9 m tall, which is
 * exactly why its shadow is the only thing about it that is visible.
 */
const TYPICAL_HEIGHT_M: Record<string, number> = {
  'utility pole': 9,
  tree: 8,
  building: 10,
  house: 6,
  'wind turbine': 100,
  'storage tank': 12,
  car: 1.5,
  truck: 3.5,
  bus: 3.2,
  aircraft: 8,
  tent: 2,
  'informal structure': 2.5,
}

export interface TierCDeps {
  /** Injected for determinism in tests. */
  now?: Date
  /** Null when Mapillary is usable, else why it is not. */
  mapillaryAvailable?: () => string | null
}

export function makeTierCRunner(deps: TierCDeps = {}): TierRunner {
  return {
    tier: 'C',
    name: 'indirect evidence',

    gate(): string | null {
      return null
    },

    async run(ctx: LadderContext): Promise<TierRunResult> {
      const when = deps.now ?? new Date()
      const lat = (ctx.bbox[1] + ctx.bbox[3]) / 2
      const lon = (ctx.bbox[0] + ctx.bbox[2]) / 2
      const sun = solarPosition(when, lat, lon)

      const height = TYPICAL_HEIGHT_M[ctx.profile.target]
      const mpp = ctx.plan.mpp ?? ctx.plan.ceilingMpp ?? null
      const parts: string[] = []

      if (height != null) {
        const shadow = shadowLengthM(height, sun.elevationDeg)
        if (shadow == null) {
          parts.push(
            `the sun is below the horizon at this location and time ` +
              `(elevation ${sun.elevationDeg.toFixed(1)}°), so no shadow evidence exists in daytime imagery ` +
              `taken now — a scene from local morning or late afternoon would carry the longest shadows.`,
          )
        } else {
          const shadowPx = mpp ? shadow / mpp : null
          parts.push(
            `a typical ${ctx.profile.target} stands about ${height} m, and with the sun at ` +
              `${sun.elevationDeg.toFixed(1)}° elevation / ${sun.azimuthDeg.toFixed(0)}° azimuth it casts a ` +
              `**${shadow.toFixed(1)} m** shadow` +
              (shadowPx != null
                ? ` — about ${shadowPx.toFixed(0)} px at ${mpp!.toFixed(2)} m/px, ` +
                  (shadowPx >= 3
                    ? `which IS resolvable even though the object itself is not. Counting shadows is a ` +
                      `viable manual cross-check on this imagery.`
                    : `which is still too small to measure reliably.`)
                : '.'),
          )
        }
      } else {
        parts.push(
          `no typical height is known for "${ctx.profile.target}", so shadow-length geometry cannot be ` +
            `applied. Sun position here is ${sun.elevationDeg.toFixed(1)}° elevation / ` +
            `${sun.azimuthDeg.toFixed(0)}° azimuth.`,
        )
      }

      const mapillary = deps.mapillaryAvailable?.() ?? 'MAPILLARY_TOKEN is not set'
      parts.push(
        `Street-level imagery is the other indirect route: ${mapillary ? `${mapillary}, so it was not queried` : 'available'}. ` +
          `Mapillary covers many road corridors at centimetre scale and sees objects nadir imagery never will.`,
      )

      return {
        detections: [],
        note:
          `no detections are produced from indirect evidence — a boundary inferred from a shadow would ` +
          `be a fabricated outline on a real coordinate. What the evidence says: ` + parts.join(' '),
      }
    },
  }
}
