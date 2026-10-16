import { describe, it, expect } from 'vitest'
import {
  colormapGradientCss,
  colormapStops,
  formatStretchValue,
  isValidStretch,
  readTileStyle,
  rewriteTileUrl,
  worldMinusAoi,
} from '../raster-style'

const BASE = 'https://titiler.example/stac/tiles/WebMercatorQuad/{z}/{x}/{y}.png'

describe('rewriteTileUrl', () => {
  const url = `${BASE}?url=https%3A%2F%2Fx%2Fitem&assets=nir&expression=b1*0.0001&rescale=0%2C0.5&colormap_name=viridis&return_mask=true`

  it('replaces colormap_name and keeps everything else, including literal {z}/{x}/{y}', () => {
    const out = rewriteTileUrl(url, { colormap: 'magma' })
    expect(out.startsWith(BASE + '?')).toBe(true)
    expect(out).toContain('colormap_name=magma')
    expect(out).not.toContain('viridis')
    expect(out).toContain('assets=nir')
    expect(out).toContain('return_mask=true')
    expect(out).toContain('url=https%3A%2F%2Fx%2Fitem')
  })

  it('replaces rescale with the new min,max', () => {
    const out = rewriteTileUrl(url, { rescale: [[0.1, 0.4]] })
    expect(readTileStyle(out).rescale).toEqual([[0.1, 0.4]])
    expect(out.match(/rescale=/g)).toHaveLength(1)
  })

  it('writes one rescale param per band for RGB', () => {
    const rgb = `${BASE}?url=u&assets=a&assets=b&assets=c&rescale=0,1&rescale=0,1&rescale=0,1&return_mask=true`
    const out = rewriteTileUrl(rgb, { rescale: [[100, 2000], [200, 2500], [300, 3000]] })
    expect(readTileStyle(out).rescale).toEqual([[100, 2000], [200, 2500], [300, 3000]])
    expect(out.match(/assets=/g)).toHaveLength(3)
  })

  it('adds the params when the URL has none and tolerates a URL without a query', () => {
    const out = rewriteTileUrl(BASE, { colormap: 'plasma', rescale: [[-1, 1]] })
    expect(readTileStyle(out)).toEqual({ colormap: 'plasma', rescale: [[-1, 1]] })
    expect(out.startsWith(BASE + '?')).toBe(true)
  })

  it('leaves the URL untouched when asked for nothing', () => {
    expect(readTileStyle(rewriteTileUrl(url, {}))).toEqual({ colormap: 'viridis', rescale: [[0, 0.5]] })
  })
})

describe('colormaps', () => {
  it('gives a gradient for known names and reverses _r', () => {
    expect(colormapGradientCss('viridis')).toMatch(/^linear-gradient\(to right, #440154/)
    expect(colormapStops('blues_r')).toEqual([...colormapStops('blues')!].reverse())
    expect(colormapGradientCss('no-such-map')).toBeNull()
  })
})

describe('stretch helpers', () => {
  it('validates min < max and finiteness', () => {
    expect(isValidStretch(0, 1)).toBe(true)
    expect(isValidStretch(1, 1)).toBe(false)
    expect(isValidStretch(2, 1)).toBe(false)
    expect(isValidStretch(NaN, 1)).toBe(false)
  })
  it('formats by magnitude', () => {
    expect(formatStretchValue(2345.6)).toBe('2346')
    expect(formatStretchValue(0.1234)).toBe('0.123')
    expect(formatStretchValue(0)).toBe('0')
  })
})

describe('worldMinusAoi', () => {
  const square = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] }

  it('cuts the AOI out of a world ring as a hole', () => {
    const g = worldMinusAoi(square)!
    expect(g.type).toBe('Polygon')
    expect(g.coordinates).toHaveLength(2)
    expect(g.coordinates[0][0]).toEqual([-180, -85.06])
    expect(g.coordinates[1]).toHaveLength(5)
  })

  it('winds the hole opposite to the world ring', () => {
    const area = (r: number[][]) => r.slice(0, -1).reduce((a, p, i) => a + p[0] * r[i + 1][1] - r[i + 1][0] * p[1], 0) / 2
    const g = worldMinusAoi(square)!
    expect(area(g.coordinates[0])).toBeGreaterThan(0)
    expect(area(g.coordinates[1])).toBeLessThan(0)
  })

  it('makes one hole per MultiPolygon part and rejects non-areal geometry', () => {
    const multi = { type: 'MultiPolygon', coordinates: [square.coordinates, [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]]] }
    expect(worldMinusAoi(multi)!.coordinates).toHaveLength(3)
    expect(worldMinusAoi({ type: 'Point', coordinates: [0, 0] })).toBeNull()
    expect(worldMinusAoi(null)).toBeNull()
  })
})
