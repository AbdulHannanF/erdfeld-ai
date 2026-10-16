/**
 * LIVE cloud-masked index statistics (opt-in: CLOUD_LIVE=1).
 *
 *   CLOUD_LIVE=1 npx vitest run index-stats-live
 *
 * Pins both halves of the Phase 0 contract:
 *   - a clouded AOI yields an honest refusal, never a number
 *   - a clear AOI yields a physically plausible, polygon-true, per-pixel index
 */

import { describe, it, expect } from 'vitest'
import { searchPlanetaryComputer } from '../stac'
import { pickClearestScene } from '../cloud'
import { maskedIndexStats } from '../index-stats'

const LIVE = !!process.env.CLOUD_LIVE
const suite = LIVE ? describe : describe.skip

/** Lahore in monsoon — the case the pre-v2 stack got wrong (reported NDVI −0.072). */
const CLOUDY_AOI = {
  type: 'Polygon',
  coordinates: [[[74.30, 31.50], [74.34, 31.50], [74.34, 31.54], [74.30, 31.54], [74.30, 31.50]]],
}

/** California Central Valley irrigated cropland — reliably cloud-free in August. */
const CLEAR_AOI = {
  type: 'Polygon',
  coordinates: [[[-120.04, 36.56], [-119.98, 36.56], [-119.98, 36.62], [-120.04, 36.62], [-120.04, 36.56]]],
}

suite('LIVE masked index statistics', () => {
  it('refuses to report a value when the AOI is under cloud', async () => {
    const stac = await searchPlanetaryComputer(
      [74.30, 31.50, 74.34, 31.54], 'sentinel-2-l2a', 0, '2026-07-10', '2026-07-20',
    )
    expect(stac.features.length).toBeGreaterThan(0)

    const out = await maskedIndexStats(stac.features[0], 'NDVI', CLOUDY_AOI)
    if (out.ok) {
      // Acceptable only if this particular scene genuinely was clear over the AOI.
      expect(out.stats.clearPct).toBeGreaterThanOrEqual(40)
      console.log(`clear after all: ${out.stats.clearPct.toFixed(0)}% clear, NDVI ${out.stats.mean.toFixed(3)}`)
      return
    }
    expect(['too_cloudy', 'fetch_failed']).toContain(out.failure.reason)
    console.log(`refused as designed → ${out.failure.reason}: ${out.failure.message.slice(0, 110)}`)
  }, 300_000)

  it('returns a plausible polygon-true NDVI over clear irrigated cropland', async () => {
    const stac = await searchPlanetaryComputer(
      [-120.04, 36.56, -119.98, 36.62], 'sentinel-2-l2a', 40, '2026-06-01', '2026-08-09',
    )
    expect(stac.features.length).toBeGreaterThan(0)

    const choice = await pickClearestScene(stac.features, CLEAR_AOI, { maxCandidates: 3 })
    if (!choice) {
      console.warn('no clear scene in window — upstream conditions, not a code failure')
      return
    }

    const out = await maskedIndexStats(choice.item, 'NDVI', CLEAR_AOI, { clarity: choice.clarity })
    expect(out.ok, out.ok ? '' : `unexpected refusal: ${(out as any).failure?.message}`).toBe(true)
    if (!out.ok) return

    const s = out.stats
    console.log(
      `${s.sceneDate}: NDVI mean ${s.mean.toFixed(3)} (median ${s.median.toFixed(3)}), ` +
      `${s.count}/${s.insidePolygon} clear px, ${s.clearPct.toFixed(0)}% clear, scene cloud ${s.sceneCloudPct}%`,
    )

    // Physical sanity: vegetated land is positive NDVI. The old code returned −0.072
    // over farmland; anything negative here means cloud contamination is back.
    expect(s.mean).toBeGreaterThan(0.05)
    expect(s.mean).toBeLessThanOrEqual(1)
    expect(s.clip).toBe('polygon')
    expect(s.count).toBeGreaterThan(0)
    expect(s.count).toBeLessThanOrEqual(s.insidePolygon)
  }, 300_000)
})
