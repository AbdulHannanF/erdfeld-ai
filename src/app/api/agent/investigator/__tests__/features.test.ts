import { describe, expect, it } from 'vitest'

import { readFeature, unusableReason } from '../features'
import { failedGeo, flaggedGeo, geo, refusedGeo } from './fixtures'

describe('feature extraction', () => {
  it('reads the new-flood fraction from map_flood', () => {
    const f = readFeature('newly_flooded_fraction', geo('map_flood', { flood_pct_of_observed: 12.34 }))
    expect(f).toMatchObject({ ok: true, value: 0.1234, field: 'flood_pct_of_observed' })
  })

  it('reads dNBR as pre minus post (a fall in NBR is positive burn severity)', () => {
    const f = readFeature('dnbr', geo('analyze_raster', { operation: 'change', index: 'NBR', mean_delta: -0.31 }))
    expect(f).toMatchObject({ ok: true, value: 0.31, field: 'mean_delta' })
  })

  it('reads burn change on vegetated ground only from a restricted analysis, and refuses a whole-area one', () => {
    const restricted = { operation: 'change', index: 'NBR', mean_delta: -0.25, decreased_pct: 76.3, baseline_min: 0.15 }
    expect(readFeature('dnbr_burnable', geo('analyze_raster', restricted))).toMatchObject({ ok: true, value: 0.25 })
    expect(readFeature('nbr_loss_fraction_burnable', geo('analyze_raster', restricted))).toMatchObject({ ok: true, value: 0.763 })
    const whole = readFeature('dnbr_burnable', geo('analyze_raster', { operation: 'change', index: 'NBR', mean_delta: -0.25, decreased_pct: 50 }))
    expect(whole).toMatchObject({ ok: false })
  })

  it('reads the NDVI drop and refuses a change analysis of another index', () => {
    expect(readFeature('ndvi_drop', geo('analyze_raster', { operation: 'change', index: 'NDVI', mean_delta: -0.2 }))).toMatchObject({ ok: true, value: 0.2 })
    const wrong = readFeature('ndvi_drop', geo('analyze_raster', { operation: 'change', index: 'NBR', mean_delta: -0.2 }))
    expect(wrong.ok).toBe(false)
  })

  it('measures the anniversary gap only for a window of about a year or more', () => {
    const aligned = readFeature('anniversary_gap_days', geo('analyze_raster', { date_before: '2023-06-10', date_after: '2025-06-20' }))
    expect(aligned).toMatchObject({ ok: true })
    expect((aligned as any).value).toBeLessThan(30)
    const off = readFeature('anniversary_gap_days', geo('analyze_raster', { date_before: '2023-01-10', date_after: '2025-06-20' }))
    expect((off as any).value).toBeGreaterThan(60)
    const short = readFeature('anniversary_gap_days', geo('analyze_raster', { date_before: '2025-01-10', date_after: '2025-03-20' }))
    expect(short.ok).toBe(false)
  })

  it('reads a measured zero fire count, from FIRMS or the EONET fallback', () => {
    expect(readFeature('active_fire_count', geo('fetch_active_fires', { fire_count: 0 }))).toMatchObject({ ok: true, value: 0 })
    expect(readFeature('active_fire_count', geo('fetch_active_fires', { events_in_aoi: 3 }))).toMatchObject({ ok: true, value: 3, field: 'events_in_aoi' })
  })

  it('turns an OSM count into a density', () => {
    expect(readFeature('mapped_building_density_per_km2', geo('query_osm', { feature_count: 50, area_km2: 10 }))).toMatchObject({ ok: true, value: 5 })
  })

  it('reads only a real anomaly verdict', () => {
    expect(readFeature('within_expected_range', geo('detect_anomaly', { verdict: 'below_expected' }))).toMatchObject({ ok: true, value: 'below_expected' })
    expect(readFeature('within_expected_range', geo('detect_anomaly', { verdict: 'cannot_determine' })).ok).toBe(false)
  })

  describe('results that cannot be measured from', () => {
    it('does not read a failed result, and says it could not be read', () => {
      const f = readFeature('newly_flooded_fraction', failedGeo('map_flood'))
      expect(f.ok).toBe(false)
      expect((f as any).reason).toMatch(/could not be read/)
    })
    it('does not read a refused result', () => {
      const f = readFeature('newly_flooded_fraction', refusedGeo('map_flood'))
      expect((f as any).reason).toMatch(/refused before running/)
    })
    it('does not read a flagged result, even though it carries figures', () => {
      const r = flaggedGeo('analyze_raster', { operation: 'change', index: 'NDVI', mean_delta: -0.4 })
      const f = readFeature('ndvi_drop', r)
      expect(f.ok).toBe(false)
      expect((f as any).reason).toMatch(/flagged by a validation check/)
      expect(unusableReason(r)).toMatch(/Only 10% of pixels are clear/)
    })
    it('says so when an ok result has no figures, rather than reading a zero', () => {
      const f = readFeature('ndvi_drop', geo('analyze_raster', undefined, { summary: 'Real data unavailable: no clear scene' }))
      expect(f.ok).toBe(false)
      expect((f as any).reason).toMatch(/no figures/)
    })
  })
})
