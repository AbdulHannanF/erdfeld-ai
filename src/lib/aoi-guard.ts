/**
 * AOI size guard — classify an area of interest by area so callers can warn
 * or refuse before running analysis.
 *
 * Pure + framework-free (no React, no Next, no network) so it can be
 * unit-tested in isolation and called from any layer of the app.
 *
 * Background: a map fly-to can silently fail, leaving the map at world zoom.
 * A rectangle drawn at that zoom covers tens of millions of km² (QA saw
 * 23,315,369 km² — roughly the land area of Africa — accepted and analyzed
 * with no warning). Upstream services such as Overpass time out on large
 * areas, and statistics over such areas are meaningless.
 */

/**
 * Up to this area (inclusive) is fine. ~50 km² is the project's own
 * engineering-note threshold: Overpass and other upstreams start to time
 * out above it, so this is where we begin warning.
 */
export const LARGE_AOI_KM2 = 50

/**
 * Above LARGE_AOI_KM2 and up to this area (inclusive) is "large": we warn
 * but still allow the run. 5000 km² is a generous ceiling for a legitimate
 * regional analysis; beyond it the area is almost certainly an accidental
 * world-zoom draw rather than a real AOI.
 */
export const EXCESSIVE_AOI_KM2 = 5000

export type AoiTier = 'ok' | 'large' | 'excessive'

export interface AoiSizeClassification {
  tier: AoiTier
  /** Short human-readable sentence for end users, or null when tier is 'ok'. */
  warning: string | null
  /** True only for 'excessive' — callers should refuse to run. */
  shouldRefuse: boolean
}

/**
 * Classify an AOI by its area in km².
 *
 * Bad input (NaN, Infinity, -Infinity, negative, zero, or non-numbers)
 * never throws. It returns the 'excessive' classification with
 * shouldRefuse = true: a non-finite or non-positive area cannot be a real
 * drawn rectangle, so the safe behavior is to refuse rather than silently
 * proceed with a bogus value.
 */
export function classifyAoiSize(areaKm2: number): AoiSizeClassification {
  if (typeof areaKm2 !== 'number' || !Number.isFinite(areaKm2) || areaKm2 <= 0) {
    return {
      tier: 'excessive',
      warning:
        'The selected area could not be measured. Zoom in on the map and draw the area again.',
      shouldRefuse: true,
    }
  }

  if (areaKm2 <= LARGE_AOI_KM2) {
    return { tier: 'ok', warning: null, shouldRefuse: false }
  }

  if (areaKm2 <= EXCESSIVE_AOI_KM2) {
    return {
      tier: 'large',
      warning:
        'This area is large, so the analysis may take longer to finish and the results will be less detailed. If you meant a smaller area, zoom in and draw it again.',
      shouldRefuse: false,
    }
  }

  return {
    tier: 'excessive',
    warning:
      'This area is far too large to analyze — it is probably a mistake. Zoom in on the map and draw the area again.',
    shouldRefuse: true,
  }
}
