/** ISS-131 live verification — the DN→reflectance transform, end to end.
 *
 *  Runs the REAL `maskedIndexStats` against live earth-search + titiler over control
 *  surfaces whose spectral signature is not in doubt, and asserts the values are
 *  *physically possible*. That framing matters: the bug this closes produced numbers
 *  that were finite, modest-looking and impossible (NDVI 1.77 over forest, NDWI 0.037
 *  over open water), so a test that only checks for crashes or NaNs would pass on the
 *  broken code.
 *
 *  Site choice is deliberate. An earlier version of this file used -60.00, -3.00 as
 *  "Amazon rainforest"; that is ~11 km from central Manaus, and the resulting
 *  "implausible" readings were a mislabelled AOI rather than a tool defect — the same
 *  trap the 2026-08-17 sweep fell into with a "farmland" probe that was peri-urban
 *  Faisalabad. The forest sites below are hundreds of km from any city.
 *
 *  Run: npx vitest run --config scripts/agent-qa/vitest.qa.config.mts reflectance-live
 */

import { describe, it, expect } from 'vitest'
import { maskedIndexStats } from '@/app/api/agent/lib/index-stats'
import { pickClearestScene } from '@/app/api/agent/lib/cloud'
import { STAC_SEARCH_URL } from '@/app/api/agent/lib/stac'

interface Site {
  name: string
  lng: number
  lat: number
  halfDeg: number
  /** Index → [min, max] the surface must fall inside for the answer to be believable. */
  expect: Record<string, [number, number]>
}

const SITES: Site[] = [
  {
    // Central Amazonas, ~400 km from Manaus. Continuous closed-canopy forest.
    name: 'Amazon forest (remote)',
    lng: -63.5,
    lat: -5.5,
    halfDeg: 0.03,
    // Closed canopy: NIR ~0.29, red ~0.05 → NDVI ~0.72. Water index strongly
    // negative, built-up index clearly negative (SWIR well below NIR).
    expect: { NDVI: [0.55, 0.95], NDWI: [-0.9, -0.3], NDBI: [-0.8, -0.1] },
  },
  {
    // Eastern Sahara, hyper-arid sand sheet. No vegetation, no water, high SWIR.
    name: 'Sahara desert',
    lng: 25.0,
    lat: 24.0,
    halfDeg: 0.03,
    expect: { NDVI: [-0.15, 0.25], NDWI: [-0.6, 0.05], NDBI: [0.05, 0.6] },
  },
  {
    // Lake Nasser main channel — deep, permanently inundated, far from either shore.
    name: 'Lake Nasser (open water)',
    lng: 32.855,
    lat: 23.315,
    halfDeg: 0.012,
    // Water absorbs NIR almost completely, so NDWI must be clearly positive and
    // NDVI clearly negative. This is the pair that reads ~0.03 when the transform
    // is wrong, which is what ISS-131 originally reported.
    expect: { NDWI: [0.15, 0.95], NDVI: [-0.95, -0.05] },
  },
]

function boxAoi(site: Site) {
  const { lng, lat, halfDeg: h } = site
  const ring = [
    [lng - h, lat - h],
    [lng + h, lat - h],
    [lng + h, lat + h],
    [lng - h, lat + h],
    [lng - h, lat - h],
  ]
  return {
    aoi: { type: 'Polygon', coordinates: [ring] },
    bbox: [lng - h, lat - h, lng + h, lat + h] as [number, number, number, number],
  }
}

async function clearestScene(bbox: [number, number, number, number], geom: any) {
  const res = await fetch(STAC_SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collections: ['sentinel-2-l2a'],
      bbox,
      limit: 12,
      sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`STAC HTTP ${res.status}`)
  const json = await res.json()
  const choice = await pickClearestScene(json.features ?? [], geom, { minClearPct: 40, maxCandidates: 6 })
  return choice?.item ?? null
}

describe('ISS-131 — indices are physically possible on known surfaces', () => {
  for (const site of SITES) {
    it(site.name, async () => {
      const { aoi, bbox } = boxAoi(site)
      const item = await clearestScene(bbox, aoi)
      if (!item) {
        console.log(`[skip] ${site.name}: no sufficiently clear scene right now`)
        return
      }

      let checked = 0
      for (const [index, [lo, hi]] of Object.entries(site.expect)) {
        const out = await maskedIndexStats(item, index, aoi, { maxSize: 64, minClearPct: 40 })
        if (!out.ok) {
          console.log(`[skip] ${site.name} ${index}: ${out.failure.reason}`)
          continue
        }
        const { mean, min, max, reflectanceNote, count } = out.stats
        console.log(
          `${site.name.padEnd(24)} ${index.padEnd(5)} mean ${mean.toFixed(3).padStart(7)} ` +
            `[${min.toFixed(2)}, ${max.toFixed(2)}] ${count} px — ${reflectanceNote}`,
        )

        // The transform must be resolved and stated, not silently skipped.
        expect(reflectanceNote).toMatch(/DN->reflectance/)
        // Every per-pixel value must be inside the index's mathematical range. A
        // normalised difference outside [-1, 1] is arithmetic, not a measurement.
        expect(min).toBeGreaterThanOrEqual(-1.0001)
        expect(max).toBeLessThanOrEqual(1.0001)
        // And the mean must match what this surface actually is.
        expect(mean).toBeGreaterThanOrEqual(lo)
        expect(mean).toBeLessThanOrEqual(hi)
        checked++
      }
      expect(checked).toBeGreaterThan(0)
    })
  }
})
