/**
 * Unit tests for C2 — honest data tiers.
 */

import { describe, it, expect } from 'vitest'
import { classifyDataTier, commercialImageryConfigured } from '../data-tiers'

describe('classifyDataTier (free Tier 0)', () => {
  it('classifies Sentinel-2 as free 10 m', () => {
    const t = classifyDataTier('Sentinel-2 L2A (AWS Element84)')
    expect(t.tier).toBe('free-10m')
    expect(t.resolutionM).toBe(10)
    expect(t.free).toBe(true)
  })
  it('classifies ESA WorldCover as free 10 m', () => {
    expect(classifyDataTier('ESA WorldCover 2021 (Planetary Computer)').resolutionM).toBe(10)
  })
  it('classifies Landsat as free 30 m', () => {
    expect(classifyDataTier('Landsat C2 L2 thermal').resolutionM).toBe(30)
  })
  it('classifies JRC GSW as free 30 m', () => {
    expect(classifyDataTier('JRC Global Surface Water v1.4').resolutionM).toBe(30)
  })
  it('classifies SRTM as free 90 m', () => {
    expect(classifyDataTier('SRTM 90m via opentopodata').resolutionM).toBe(90)
  })
  it('classifies WorldPop as free 100 m', () => {
    expect(classifyDataTier('WorldPop GHS-POP 2020').resolutionM).toBe(100)
  })
  it('classifies SoilGrids as free 250 m', () => {
    expect(classifyDataTier('ISRIC SoilGrids 2.0').resolutionM).toBe(250)
  })
  it('classifies OSM as free vector (resolution N/A)', () => {
    const t = classifyDataTier('OpenStreetMap via Overpass')
    expect(t.tier).toBe('free-10m')
    expect(t.resolutionM).toBeNull()
    expect(t.label).toContain('vector')
  })
})

describe('classifyDataTier (commercial Tier 1)', () => {
  it('flags Maxar as commercial, not free', () => {
    const t = classifyDataTier('Maxar Vivid sub-meter imagery')
    expect(t.tier).toBe('commercial-submeter')
    expect(t.free).toBe(false)
    expect(t.label.toLowerCase()).toContain('maxar')
  })
  it('flags Planet Labs as commercial', () => {
    expect(classifyDataTier('Planet Labs PlanetScope').tier).toBe('commercial-submeter')
  })
  it('flags Mapbox Satellite as commercial', () => {
    expect(classifyDataTier('Mapbox Satellite basemap').tier).toBe('commercial-submeter')
  })
})

describe('classifyDataTier (Tier 2 user upload)', () => {
  it('classifies a user upload + carries the supplied resolution', () => {
    const t = classifyDataTier('User upload: drone orthomosaic', 0.05)
    expect(t.tier).toBe('user-upload')
    expect(t.resolutionM).toBe(0.05)
    expect(t.free).toBe(true)
  })
  it('user upload with no supplied resolution → null (never assumes)', () => {
    expect(classifyDataTier('uploaded GeoTIFF').resolutionM).toBeNull()
  })
})

describe('classifyDataTier (unknown / honest default)', () => {
  it('labels an unrecognized source as unknown (never assumes high-res)', () => {
    const t = classifyDataTier('Some Mystery Source 9000')
    expect(t.tier).toBe('unknown')
    expect(t.resolutionM).toBeNull()
  })
  it('handles null/empty source', () => {
    expect(classifyDataTier(null).tier).toBe('unknown')
    expect(classifyDataTier(undefined).tier).toBe('unknown')
    expect(classifyDataTier('').tier).toBe('unknown')
  })
  it('user-upload + commercial take precedence over a free substring', () => {
    // a source mentioning both "user upload" and "sentinel-2" → user-upload wins
    expect(classifyDataTier('User upload derived from Sentinel-2 mosaic').tier).toBe('user-upload')
  })
})

describe('commercialImageryConfigured', () => {
  it('disabled when no keys set', () => {
    expect(commercialImageryConfigured({} as NodeJS.ProcessEnv).enabled).toBe(false)
  })
  it('enabled with MAPBOX_TOKEN', () => {
    const r = commercialImageryConfigured({ MAPBOX_TOKEN: 'pk.test' } as any)
    expect(r.enabled).toBe(true)
    expect(r.provider).toContain('Mapbox')
  })
  it('enabled with MAXAR_API_KEY', () => {
    expect(commercialImageryConfigured({ MAXAR_API_KEY: 'k' } as any).provider).toBe('Maxar')
  })
})
