/**
 * LIVE cloud-screening verification (opt-in: CLOUD_LIVE=1).
 * Hits AWS Earth Search + titiler.xyz — NOT part of the default suite.
 *
 *   CLOUD_LIVE=1 npx vitest run cloud-live
 *
 * Pins the behaviour that Phase 0 exists to guarantee: scene choice is scored on
 * cloud OVER THE POLYGON, and a fully-clouded AOI yields an honest refusal rather
 * than cloud-top reflectance reported as a surface index.
 */

import { describe, it, expect } from 'vitest'
import { searchPlanetaryComputer } from '../stac'
import { pickClearestScene, sceneClarity, MIN_USABLE_CLEAR_PCT } from '../cloud'

const LIVE = !!process.env.CLOUD_LIVE
const suite = LIVE ? describe : describe.skip

// Lahore — monsoon season; reliably cloudy in Jul/Aug, which is exactly the case
// the pre-v2 stack got wrong (reported NDVI −0.072 from a cloud top).
const AOI = {
  type: 'Polygon',
  coordinates: [[[74.30, 31.50], [74.34, 31.50], [74.34, 31.54], [74.30, 31.54], [74.30, 31.50]]],
}

suite('LIVE cloud screening — AOI-local SCL', () => {
  it('scores AOI-local clarity independently of scene-wide cloud cover', async () => {
    const stac = await searchPlanetaryComputer(
      [74.30, 31.50, 74.34, 31.54], 'sentinel-2-l2a', 0, '2026-05-01', '2026-08-09',
    )
    expect(stac.features.length).toBeGreaterThan(0)

    const clarity = await sceneClarity(stac.features[0], AOI)
    if (!clarity) {
      console.warn('SCL unavailable (titiler down?) — degraded, not a failure')
      return
    }

    expect(clarity.totalPx).toBeGreaterThan(0)
    expect(clarity.clearPct).toBeGreaterThanOrEqual(0)
    expect(clarity.clearPct).toBeLessThanOrEqual(100)
    // Percentages describe the polygon, not the 110 km scene.
    expect(clarity.breakdown.reduce((a, b) => a + b.pct, 0)).toBeCloseTo(100, 0)
    console.log(
      `AOI clarity ${clarity.clearPct.toFixed(1)}% clear vs scene-wide cloud ` +
      `${stac.features[0].properties?.['eo:cloud_cover']}%`,
    )
  }, 180_000)

  it('refuses rather than returning a value when every candidate is clouded', async () => {
    const stac = await searchPlanetaryComputer(
      [74.30, 31.50, 74.34, 31.54], 'sentinel-2-l2a', 0, '2026-07-15', '2026-08-09',
    )
    const choice = await pickClearestScene(stac.features, AOI, { maxCandidates: 4 })

    if (choice === null) {
      // The honest path: nothing usable, and we can say what we looked at.
      expect(stac.features.length).toBeGreaterThan(0)
      return
    }
    // If a scene IS usable it must genuinely clear the bar — never a silent pass.
    expect(choice.clarity.clearPct).toBeGreaterThanOrEqual(MIN_USABLE_CLEAR_PCT)
    expect(choice.examined.length).toBeGreaterThan(0)
  }, 300_000)
})
