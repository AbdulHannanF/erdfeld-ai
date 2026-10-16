import { describe, expect, it } from 'vitest'
import { BASEMAP_GROUND, initialWorldZoom, worldFitZoom } from '../basemaps'

describe('world view', () => {
  it('keeps the usual world view (zoom 2) wherever one world already fills the map', () => {
    expect(initialWorldZoom(1280, 600)).toBe(2)
    expect(initialWorldZoom(1920, 900)).toBe(2)
  })

  it('zooms in on a wide screen until one copy of the world fills the map', () => {
    // 512 * 2^z px is the world's width: 2775 px needs z = log2(2775/512)
    expect(worldFitZoom(2775, 1700)).toBeCloseTo(2.44, 2)
    expect(initialWorldZoom(2775, 1700)).toBeCloseTo(2.44, 2)
    // and the world is then not narrower than the map
    expect(512 * 2 ** worldFitZoom(2775, 1700)).toBeGreaterThanOrEqual(2775 - 1e-6)
  })

  it('uses the longer side, so a tall map is covered top to bottom too', () => {
    expect(worldFitZoom(900, 2400)).toBeCloseTo(worldFitZoom(2400, 900), 10)
  })

  it('never goes negative for a tiny or empty box', () => {
    expect(worldFitZoom(0, 0)).toBe(0)
    expect(worldFitZoom(100, 100)).toBe(0)
  })

  it('has a ground colour for every basemap', () => {
    expect(Object.keys(BASEMAP_GROUND).sort()).toEqual(['dark', 'light', 'satellite', 'voyager'])
  })
})
