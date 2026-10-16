/** `fetch_active_fires` without a FIRMS key — the key-free EONET fallback.
 *
 *  Two things must hold, and they pull in opposite directions:
 *   - over a region with active fires it must return real, dated, named incidents;
 *   - over a region with none it must say "none reported", never "no fires", and must
 *     carry the coverage caveat so absence is not read as evidence of absence.
 *
 *  Run: npx vitest run --config scripts/agent-qa/vitest.qa.config.mts fires-live
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { fetchActiveFires } from '@/app/api/agent/tools/satellite'

function ctxFor(minLng: number, minLat: number, maxLng: number, maxLat: number) {
  const ring = [
    [minLng, minLat], [maxLng, minLat], [maxLng, maxLat], [minLng, maxLat], [minLng, minLat],
  ]
  return {
    aoi: { type: 'Polygon', coordinates: [ring] },
    bbox: [minLng, minLat, maxLng, maxLat] as [number, number, number, number],
    areaKm2: 5000,
    emit: () => {},
  } as any
}

describe('fetch_active_fires falls back to EONET when no FIRMS key is set', () => {
  beforeAll(() => {
    // The fallback is what is under test; a key on the dev box would bypass it.
    delete process.env.FIRMS_MAP_KEY
  })

  it('returns real incidents over the western United States', async () => {
    // Broad box over CA/NV/OR — EONET's densest coverage (US IRWIN feed).
    const res = await fetchActiveFires(ctxFor(-125, 32, -114, 45), { days: 30 })
    const sd = res.summary_data as any
    console.log(
      `western US: ${sd?.events_in_aoi} in AOI / ${sd?.events_in_bbox} in bbox, ` +
        `${sd?.total_acres ?? '—'} acres`,
    )

    expect(sd?.source).toMatch(/EONET/)
    // The caveat is mandatory whichever way the count goes.
    expect(res.summary).toMatch(/curated fire \*incidents\*/)

    if ((sd?.events_in_aoi ?? 0) > 0) {
      // Every drawn point must be a real dated incident, not a placeholder.
      const feats = (res.layer as any)?.geojson?.features ?? []
      expect(feats.length).toBe(sd.events_in_aoi)
      for (const f of feats) {
        expect(f.geometry.type).toBe('Point')
        expect(String(f.properties.date)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(String(f.properties.title).length).toBeGreaterThan(3)
      }
      expect((res.layer as any).provenance.source).toMatch(/EONET/)
      // It must never claim to be a per-pixel hotspot product.
      expect((res.layer as any).provenance.method).toMatch(/NOT per-pixel/)
    }
  })

  it('says "none reported" — not "no fires" — over open ocean', async () => {
    const res = await fetchActiveFires(ctxFor(-30, -20, -25, -15), { days: 30 })
    const sd = res.summary_data as any
    console.log(`mid-Atlantic: ${sd?.events_in_aoi} in AOI`)

    expect(sd?.events_in_aoi).toBe(0)
    expect(res.summary).toMatch(/No wildfire incidents reported/)
    expect(res.summary).toMatch(/means "none were reported", not "nothing is burning"/)
    // No layer is attached when there is nothing real to draw.
    expect(res.layer).toBeUndefined()
  })
})
