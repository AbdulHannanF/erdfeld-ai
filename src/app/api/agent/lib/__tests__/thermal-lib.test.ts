import { describe, expect, it } from 'vitest'

import { LST_FALLBACK_RANGE_C, lstDescriptor, lstStretchC } from '../thermal'
import { LST_CELSIUS_EXPRESSION, buildLandsatLstTileUrl, dnToCelsius, landsatLstRenderParams } from '../titiler'
import { readTileStyle } from '@/lib/raster-style'

describe('lstStretchC', () => {
  it('converts the AOI percentiles from DN to degrees C', () => {
    const { rescale, stretch } = lstStretchC({ min: 44000, max: 52000, p2: 45000, p98: 50000, mean: 47000, count: 500 })
    expect(stretch).toBe('p2-p98')
    expect(rescale[0]).toBeCloseTo(dnToCelsius(45000), 1)
    expect(rescale[1]).toBeCloseTo(dnToCelsius(50000), 1)
  })
  it('is a stated fixed range with no pixels, and never narrower than 1 degree for a uniform scene', () => {
    expect(lstStretchC(null)).toEqual({ rescale: LST_FALLBACK_RANGE_C, stretch: 'fixed' })
    const flat = lstStretchC({ min: 48000, max: 48000, p2: 48000, p98: 48000, mean: 48000, count: 10 })
    expect(flat.rescale[1] - flat.rescale[0]).toBeGreaterThanOrEqual(1)
  })
})

describe('Landsat LST render params', () => {
  it('apply the scale and offset by band math, with the stretch in degrees C', () => {
    expect(LST_CELSIUS_EXPRESSION).toBe('b1*0.00341802+149-273.15')
    expect(landsatLstRenderParams(30, 48)).toEqual({ expression: LST_CELSIUS_EXPRESSION, rescale: '30,48', colormap: 'plasma' })
  })
  it('the tile URL and the descriptor describe the same stretch', () => {
    const url = buildLandsatLstTileUrl('https://blob/lst.tif?sig=1', 30, 48)
    expect(readTileStyle(url)).toEqual({ colormap: 'plasma', rescale: [[30, 48]] })
    expect(new URL(url.replace('{z}/{x}/{y}', '0/0/0')).searchParams.get('expression')).toBe(LST_CELSIUS_EXPRESSION)
    expect(lstDescriptor({ rescale: [30, 48], stretch: 'p2-p98' })).toMatchObject({ units: '°C', rescale: [[30, 48]], colormap: 'plasma' })
  })
})
