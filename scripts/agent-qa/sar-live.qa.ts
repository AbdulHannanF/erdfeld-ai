/** Sentinel-1 SAR — the value must be calibrated, in dB, and land in the right class.
 *
 *  The defect this pins: VV 0.061 over dense urban Lahore was reported as "very low —
 *  likely open water or flooded areas". The number was an uncalibrated GRD digital
 *  number divided by 5000, compared against thresholds that only mean something in dB.
 *
 *  Run: npx vitest run --config scripts/agent-qa/vitest.qa.config.mts sar-live
 */

import { describe, it, expect } from 'vitest'
import { fetchSar } from '@/app/api/agent/tools/satellite'

interface Site {
  name: string
  lng: number
  lat: number
  half: number
  /** The class this surface must be assigned, and the dB window it must fall in. */
  expectClass: RegExp
  expectDb: [number, number]
}

const SITES: Site[] = [
  // The exact failure case: a city of 13 million previously called open water.
  { name: 'urban Lahore', lng: 74.33, lat: 31.55, half: 0.02, expectClass: /Urban|rough/i, expectDb: [-8, 5] },
  { name: 'Lake Nasser', lng: 32.855, lat: 23.315, half: 0.012, expectClass: /Water|smooth/i, expectDb: [-35, -15] },
  { name: 'Amazon forest', lng: -63.5, lat: -5.5, half: 0.03, expectClass: /Vegetation|mixed/i, expectDb: [-13, -4] },
]

function ctxFor(site: Site) {
  const { lng, lat, half: h } = site
  const ring = [
    [lng - h, lat - h], [lng + h, lat - h], [lng + h, lat + h], [lng - h, lat + h], [lng - h, lat - h],
  ]
  const aoi = { type: 'Polygon', coordinates: [ring] }
  return {
    aoi,
    bbox: [lng - h, lat - h, lng + h, lat + h] as [number, number, number, number],
    areaKm2: 20,
    args: {},
    emit: () => {},
  } as any
}

describe('fetch_sar returns calibrated dB and classifies the surface correctly', () => {
  for (const site of SITES) {
    it(site.name, async () => {
      const res = await fetchSar(ctxFor(site))
      const sd = res.summary_data as any

      if (sd?.vv_gamma0_db == null) {
        // The uncalibrated fallback is allowed, but ONLY if it refuses to name a class.
        console.log(`[fallback] ${site.name}: ${String(res.summary).slice(0, 160)}`)
        expect(res.summary).toMatch(/No surface interpretation is given/)
        expect(sd?.surface_class).toBeUndefined()
        return
      }

      const db = Number(sd.vv_gamma0_db)
      console.log(`${site.name.padEnd(16)} ${db.toFixed(2)} dB — ${sd.surface_class}`)

      expect(db).toBeGreaterThanOrEqual(site.expectDb[0])
      expect(db).toBeLessThanOrEqual(site.expectDb[1])
      expect(String(sd.surface_class)).toMatch(site.expectClass)
      // The unit must be stated, and the provenance must name the catalogue it used.
      expect(res.summary).toContain('dB')
      expect(res.layer?.provenance?.source).toMatch(/Planetary Computer|Earth Search/)
    })
  }
})
