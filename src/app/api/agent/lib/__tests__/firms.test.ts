import { describe, it, expect } from 'vitest'
import {
  frpToColor,
  normalizeConfidence,
  parseFirmsCsv,
  mergeAndDedup,
  computeFireStats,
  type FireFeature,
} from '../firms'

// ── frpToColor ─────────────────────────────────────────────────────────────

describe('frpToColor', () => {
  it('returns yellow for FRP ≤ 10 MW (low tier)', () => {
    expect(frpToColor(0)).toBe('#ffd700')
    expect(frpToColor(5)).toBe('#ffd700')
    expect(frpToColor(10)).toBe('#ffd700')
  })

  it('returns orange for FRP > 10 and ≤ 50 MW (moderate tier)', () => {
    expect(frpToColor(10.1)).toBe('#ff8c00')
    expect(frpToColor(30)).toBe('#ff8c00')
    expect(frpToColor(50)).toBe('#ff8c00')
  })

  it('returns red-orange for FRP > 50 and ≤ 200 MW (high tier)', () => {
    expect(frpToColor(50.1)).toBe('#ff4500')
    expect(frpToColor(100)).toBe('#ff4500')
    expect(frpToColor(200)).toBe('#ff4500')
  })

  it('returns dark red for FRP > 200 MW (extreme tier)', () => {
    expect(frpToColor(200.1)).toBe('#8b0000')
    expect(frpToColor(500)).toBe('#8b0000')
  })
})

// ── normalizeConfidence ─────────────────────────────────────────────────────

describe('normalizeConfidence', () => {
  it('maps VIIRS "high" / "h" to high', () => {
    expect(normalizeConfidence('high', true)).toBe('high')
    expect(normalizeConfidence('h', true)).toBe('high')
    expect(normalizeConfidence('HIGH', true)).toBe('high')
  })

  it('maps VIIRS "low" / "l" to low', () => {
    expect(normalizeConfidence('low', true)).toBe('low')
    expect(normalizeConfidence('l', true)).toBe('low')
  })

  it('maps VIIRS "nominal" / "n" / unrecognized to medium', () => {
    expect(normalizeConfidence('nominal', true)).toBe('medium')
    expect(normalizeConfidence('n', true)).toBe('medium')
    expect(normalizeConfidence('', true)).toBe('medium')
  })

  it('maps MODIS ≥ 80 to high', () => {
    expect(normalizeConfidence('80', false)).toBe('high')
    expect(normalizeConfidence('95', false)).toBe('high')
    expect(normalizeConfidence('100', false)).toBe('high')
  })

  it('maps MODIS 50–79 to medium', () => {
    expect(normalizeConfidence('50', false)).toBe('medium')
    expect(normalizeConfidence('70', false)).toBe('medium')
    expect(normalizeConfidence('79', false)).toBe('medium')
  })

  it('maps MODIS < 50 to low', () => {
    expect(normalizeConfidence('49', false)).toBe('low')
    expect(normalizeConfidence('20', false)).toBe('low')
    expect(normalizeConfidence('0', false)).toBe('low')
  })
})

// ── parseFirmsCsv ───────────────────────────────────────────────────────────

const VIIRS_HEADER = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,type,close_date'
const MODIS_HEADER = 'latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight,type,close_date'

describe('parseFirmsCsv', () => {
  it('returns empty array for header-only CSV', () => {
    expect(parseFirmsCsv(VIIRS_HEADER, 'VIIRS_SNPP_NRT')).toHaveLength(0)
  })

  it('returns empty array for empty/whitespace input', () => {
    expect(parseFirmsCsv('', 'VIIRS_SNPP_NRT')).toHaveLength(0)
    expect(parseFirmsCsv('   \n  ', 'VIIRS_SNPP_NRT')).toHaveLength(0)
  })

  it('parses a VIIRS row with correct coordinates and properties', () => {
    const csv = [VIIRS_HEADER, '34.5678,-120.1234,340.2,0.5,0.5,2026-05-28,0930,N,VIIRS,h,2.0NRT,320.1,25.4,D,0,'].join('\n')
    const features = parseFirmsCsv(csv, 'VIIRS_SNPP_NRT')
    expect(features).toHaveLength(1)
    const f = features[0]
    expect(f.geometry.type).toBe('Point')
    expect(f.geometry.coordinates).toEqual([-120.1234, 34.5678])
    expect(f.properties.frp).toBe(25.4)
    expect(f.properties.confidence).toBe('high')
    expect(f.properties.daynight).toBe('D')
    expect(f.properties.acq_date).toBe('2026-05-28')
    expect(f.properties.color).toBe('#ff8c00') // 25.4 MW → moderate
    expect(f.properties.source).toBe('VIIRS_SNPP_NRT')
  })

  it('parses a MODIS row with numeric confidence', () => {
    const csv = [MODIS_HEADER, '34.0,-120.0,325.5,1.0,1.0,2026-05-28,1200,Terra,MODIS,85,6.3,300.1,75.0,D,0,'].join('\n')
    const features = parseFirmsCsv(csv, 'MODIS_NRT')
    expect(features).toHaveLength(1)
    expect(features[0].properties.confidence).toBe('high') // 85 → high
    expect(features[0].properties.frp).toBe(75.0)
    expect(features[0].properties.color).toBe('#ff4500') // 75 MW → high
  })

  it('skips rows with NaN latitude or longitude', () => {
    const csv = [VIIRS_HEADER, 'bad,-120.0,340.2,0.5,0.5,2026-05-28,0930,N,VIIRS,h,2.0NRT,320.1,25.4,D,0,'].join('\n')
    expect(parseFirmsCsv(csv, 'VIIRS_SNPP_NRT')).toHaveLength(0)
  })
})

// ── mergeAndDedup ───────────────────────────────────────────────────────────

function makeFireFeature(lon: number, lat: number, date: string, source: string, frp = 10): FireFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      frp, confidence: 'high', acq_date: date, acq_time: '1200',
      satellite: 'N', daynight: 'D', type: 0, brightness: 300,
      source, color: frpToColor(frp),
    },
  }
}

describe('mergeAndDedup', () => {
  it('returns viirs unchanged when modis is empty', () => {
    const viirs = [makeFireFeature(-120.0, 34.0, '2026-05-28', 'VIIRS_SNPP_NRT')]
    expect(mergeAndDedup(viirs, [])).toEqual(viirs)
  })

  it('drops MODIS point co-located with a same-date VIIRS point (~0.01° grid cell)', () => {
    const viirs = [makeFireFeature(-120.001, 34.001, '2026-05-28', 'VIIRS_SNPP_NRT')]
    const modis = [makeFireFeature(-120.002, 34.002, '2026-05-28', 'MODIS_NRT')]
    // Both round to lon=-12000, lat=3400 → same grid cell → MODIS dropped
    const merged = mergeAndDedup(viirs, modis)
    expect(merged).toHaveLength(1)
    expect(merged[0].properties.source).toBe('VIIRS_SNPP_NRT')
  })

  it('keeps MODIS points outside the 0.01° dedup radius', () => {
    const viirs = [makeFireFeature(-120.0, 34.0, '2026-05-28', 'VIIRS_SNPP_NRT')]
    const modis = [makeFireFeature(-121.5, 35.5, '2026-05-28', 'MODIS_NRT')]
    expect(mergeAndDedup(viirs, modis)).toHaveLength(2)
  })

  it('keeps co-located MODIS points that are on a different date', () => {
    const viirs = [makeFireFeature(-120.001, 34.001, '2026-05-28', 'VIIRS_SNPP_NRT')]
    const modis = [makeFireFeature(-120.001, 34.001, '2026-05-27', 'MODIS_NRT')]
    expect(mergeAndDedup(viirs, modis)).toHaveLength(2)
  })
})

// ── computeFireStats ────────────────────────────────────────────────────────

describe('computeFireStats', () => {
  it('returns zeros for an empty feature array', () => {
    const s = computeFireStats([])
    expect(s.count).toBe(0)
    expect(s.meanFrp).toBe(0)
    expect(s.maxFrp).toBe(0)
    expect(s.dates).toEqual([])
    expect(s.frpTiers).toEqual({ extreme: 0, high: 0, moderate: 0, low: 0 })
  })

  it('computes correct aggregates for mixed fire features', () => {
    const make = (frp: number, conf: 'high'|'medium'|'low', dn: string, date: string): FireFeature => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { frp, confidence: conf, acq_date: date, acq_time: '1200', satellite: 'N', daynight: dn, type: 0, brightness: 300, source: 'VIIRS_SNPP_NRT', color: frpToColor(frp) },
    })

    const features = [
      make(5,   'low',    'D', '2026-05-27'), // low FRP, day
      make(25,  'medium', 'N', '2026-05-28'), // moderate, night
      make(100, 'high',   'D', '2026-05-28'), // high, day
      make(250, 'high',   'N', '2026-05-29'), // extreme, night
    ]

    const s = computeFireStats(features)
    expect(s.count).toBe(4)
    expect(s.meanFrp).toBeCloseTo((5 + 25 + 100 + 250) / 4)
    expect(s.maxFrp).toBe(250)
    expect(s.highConf).toBe(2)
    expect(s.medConf).toBe(1)
    expect(s.lowConf).toBe(1)
    expect(s.dayCount).toBe(2)
    expect(s.nightCount).toBe(2)
    expect(s.frpTiers.extreme).toBe(1)  // 250
    expect(s.frpTiers.high).toBe(1)     // 100
    expect(s.frpTiers.moderate).toBe(1) // 25
    expect(s.frpTiers.low).toBe(1)      // 5
    expect(s.dates).toEqual(['2026-05-27', '2026-05-28', '2026-05-29'])
  })
})
