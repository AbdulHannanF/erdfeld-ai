/** ISS-131 — DN→reflectance resolution and the guards around it.
 *
 *  The live counterpart is `scripts/agent-qa/reflectance-live.qa.ts`. These cases pin
 *  the decision rules; that one proves the numbers come out physically possible.
 */

import { describe, it, expect } from 'vitest'
import {
  buildIndexValues,
  detectProducer,
  indexBounds,
  isPlausibleIndexValue,
  looksOverCorrected,
  parseProcessingBaseline,
  resolveBandSetReflectance,
  resolveReflectance,
  toReflectance,
} from '../reflectance'

/** An earth-search item: declares an offset it does not actually serve. */
function earthSearchItem(baseline = '05.12') {
  return {
    id: 'S2B_20MMU_20260815_0_L2A',
    properties: { 's2:processing_baseline': baseline },
    links: [{ rel: 'self', href: 'https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/x' }],
    assets: {
      red: {
        href: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/x/B04.tif',
        'raster:bands': [{ nodata: 0, scale: 0.0001, offset: -0.1 }],
      },
      nir: {
        href: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/x/B08.tif',
        'raster:bands': [{ nodata: 0, scale: 0.0001, offset: -0.1 }],
      },
    },
  }
}

/** A Planetary Computer item: serves an offset it declares nowhere. */
function pcItem(baseline = '05.12') {
  return {
    id: 'S2B_MSIL2A_20260815T143739_R096_T20MMV_20260815T181707',
    properties: { 's2:processing_baseline': baseline },
    links: [{ rel: 'self', href: 'https://planetarycomputer.microsoft.com/api/stac/v1/collections/sentinel-2-l2a/items/x' }],
    assets: {
      B04: { href: 'https://sentinel2l2a01.blob.core.windows.net/x/B04.tif' },
      B08: { href: 'https://sentinel2l2a01.blob.core.windows.net/x/B08.tif' },
    },
  }
}

describe('detectProducer', () => {
  it('recognises earth-search from its links and asset hrefs', () => {
    expect(detectProducer(earthSearchItem())).toBe('earth-search')
  })

  it('recognises Planetary Computer from its blob storage hosts', () => {
    expect(detectProducer(pcItem())).toBe('planetary-computer')
  })

  it('returns unknown rather than guessing', () => {
    expect(detectProducer({ assets: { red: { href: 'https://example.com/a.tif' } } })).toBe('unknown')
    expect(detectProducer(null)).toBe('unknown')
  })
})

describe('parseProcessingBaseline', () => {
  it('parses the string form Sentinel-2 actually uses', () => {
    expect(parseProcessingBaseline({ properties: { 's2:processing_baseline': '05.12' } })).toBeCloseTo(5.12)
    expect(parseProcessingBaseline({ properties: { 's2:processing_baseline': '02.12' } })).toBeCloseTo(2.12)
  })

  it('returns null when absent, so callers fall back explicitly', () => {
    expect(parseProcessingBaseline({ properties: {} })).toBeNull()
    expect(parseProcessingBaseline(null)).toBeNull()
  })
})

describe('resolveReflectance', () => {
  it('does NOT apply the offset earth-search declares, because the pixels lack it', () => {
    const t = resolveReflectance(earthSearchItem(), 'red', { isSentinel2: true })
    expect(t.scale).toBeCloseTo(0.0001)
    expect(t.offset).toBe(0)
    expect(t.source).toBe('producer-earth-search')
  })

  it('applies the offset for a modern Planetary Computer scene, which declares none', () => {
    const t = resolveReflectance(pcItem('05.12'), 'B04', { isSentinel2: true })
    expect(t.scale).toBeCloseTo(0.0001)
    expect(t.offset).toBeCloseTo(-0.1)
    expect(t.source).toBe('producer-planetary-computer')
  })

  it('does not apply the offset to a pre-baseline-04.00 Planetary Computer scene', () => {
    // This is the case that made a 2019-vs-2026 comparison read a processing
    // change as a -0.26 NDVI change when both were treated identically.
    const t = resolveReflectance(pcItem('02.12'), 'B04', { isSentinel2: true })
    expect(t.offset).toBe(0)
  })

  it('assumes the offset is present when PC declares no baseline at all', () => {
    const item = pcItem()
    delete (item.properties as any)['s2:processing_baseline']
    expect(resolveReflectance(item, 'B04', { isSentinel2: true }).offset).toBeCloseTo(-0.1)
  })

  it('falls back to the sensor default for a non-Sentinel-2 sensor', () => {
    const landsat = {
      links: [{ rel: 'self', href: 'https://planetarycomputer.microsoft.com/api/stac/v1/x' }],
      assets: { red: { href: 'https://landsateuwest.blob.core.windows.net/x/red.tif' } },
    }
    const t = resolveReflectance(landsat, 'red', {
      fallback: { scale: 0.0000275, offset: -0.2, note: 'Landsat C2 L2' },
    })
    expect(t.scale).toBeCloseTo(0.0000275)
    expect(t.offset).toBeCloseTo(-0.2)
    expect(t.source).toBe('sensor-default')
  })

  it('uses a declared transform for an unknown producer that describes itself', () => {
    const item = {
      assets: { red: { href: 'https://example.org/red.tif', 'raster:bands': [{ scale: 0.5, offset: 3 }] } },
    }
    const t = resolveReflectance(item, 'red')
    expect(t.source).toBe('stac-declared')
    expect(toReflectance(4, t)).toBeCloseTo(5)
  })

  it('never returns null — an unresolvable asset yields a self-describing identity', () => {
    const t = resolveReflectance({ assets: {} }, 'red')
    expect(t.scale).toBe(1)
    expect(t.offset).toBe(0)
    expect(t.note).toMatch(/unconverted/)
  })
})

describe('resolveBandSetReflectance', () => {
  it('reports a uniform transform once', () => {
    const r = resolveBandSetReflectance(earthSearchItem(), ['nir', 'red'], { isSentinel2: true })
    expect(r.uniform).toBe(true)
    expect(r.note).toMatch(/DN->reflectance x0\.0001/)
  })

  it('flags bands that disagree instead of silently picking one', () => {
    const item = {
      assets: {
        a: { href: 'https://example.org/a.tif', 'raster:bands': [{ scale: 1, offset: 0 }] },
        b: { href: 'https://example.org/b.tif', 'raster:bands': [{ scale: 0.5, offset: -1 }] },
      },
    }
    const r = resolveBandSetReflectance(item, ['a', 'b'])
    expect(r.uniform).toBe(false)
    expect(r.note).toMatch(/differing/)
  })
})

describe('index bounds', () => {
  it('bounds a normalised difference to [-1, 1]', () => {
    expect(indexBounds('NDVI')).toEqual([-1, 1])
    // 1.77 is finite and modest-looking, and impossible. This is the check that
    // catches an offset applied where it does not belong.
    expect(isPlausibleIndexValue(1.77, 'NDVI')).toBe(false)
    expect(isPlausibleIndexValue(0.72, 'NDVI')).toBe(true)
  })

  it('allows EVI its gain factor', () => {
    expect(isPlausibleIndexValue(1.8, 'EVI')).toBe(true)
    expect(isPlausibleIndexValue(1.8, 'NDVI')).toBe(false)
  })

  it('rejects the degenerate blow-up that reverted the first attempt', () => {
    expect(isPlausibleIndexValue(-1.09e11, 'NDVI')).toBe(false)
    expect(isPlausibleIndexValue(Infinity, 'NDVI')).toBe(false)
    expect(isPlausibleIndexValue(NaN, 'NDVI')).toBe(false)
  })
})

describe('buildIndexValues', () => {
  const ndvi = (b: Float64Array) => (b[0] - b[1]) / (b[0] + b[1])

  /** Two bands, four pixels: nir then red, band-major. */
  function grid(nir: number[], red: number[]) {
    return Float64Array.from([...nir, ...red])
  }

  it('applies the transform and computes the index per pixel', () => {
    const t = { scale: 0.0001, offset: 0, source: 'producer-earth-search' as const, note: 'n', nodata: 0 }
    const out = buildIndexValues({
      raw: grid([2900, 2900], [500, 500]),
      px: 2,
      nBands: 2,
      transforms: [t, t],
      index: 'NDVI',
      evaluate: ndvi,
      include: () => true,
      baseNote: 'base',
    })
    expect(out.validCount).toBe(2)
    expect(out.values[0]).toBeCloseTo((0.29 - 0.05) / (0.29 + 0.05), 4)
    expect(out.retriedWithoutOffset).toBe(false)
  })

  it('skips nodata pixels rather than converting them into a reflectance', () => {
    const t = { scale: 0.0001, offset: 0, source: 'producer-earth-search' as const, note: 'n', nodata: 0 }
    const out = buildIndexValues({
      raw: grid([2900, 0], [500, 500]),
      px: 2,
      nBands: 2,
      transforms: [t, t],
      index: 'NDVI',
      evaluate: ndvi,
      include: () => true,
      baseNote: 'base',
    })
    expect(out.validCount).toBe(1)
    expect(Number.isNaN(out.values[1])).toBe(true)
  })

  it('honours the include filter, so cloudy pixels never reach the formula', () => {
    const t = { scale: 0.0001, offset: 0, source: 'producer-earth-search' as const, note: 'n', nodata: 0 }
    const out = buildIndexValues({
      raw: grid([2900, 2900], [500, 500]),
      px: 2,
      nBands: 2,
      transforms: [t, t],
      index: 'NDVI',
      evaluate: ndvi,
      include: (i) => i === 0,
      baseNote: 'base',
    })
    expect(out.validCount).toBe(1)
    expect(Number.isNaN(out.values[1])).toBe(true)
  })

  it('withdraws an offset that drives the scene to negative reflectance', () => {
    // Earth-search DN with the declared -0.1 offset wrongly applied: every band
    // goes negative. The builder must notice and recompute without it.
    const t = { scale: 0.0001, offset: -0.1, source: 'stac-declared' as const, note: 'n', nodata: 0 }
    const out = buildIndexValues({
      raw: grid([600, 620, 610, 605], [480, 470, 475, 465]),
      px: 4,
      nBands: 2,
      transforms: [t, t],
      index: 'NDVI',
      evaluate: ndvi,
      include: () => true,
      baseNote: 'base',
    })
    expect(out.retriedWithoutOffset).toBe(true)
    expect(out.note).toMatch(/OFFSET WITHDRAWN/)
    expect(out.validCount).toBe(4)
    // Recomputed without the offset, these are ordinary positive NDVI values.
    expect(out.values[0]).toBeCloseTo((0.06 - 0.048) / (0.06 + 0.048), 4)
  })

  it('leaves a correct offset alone', () => {
    // Planetary Computer DN: the offset IS present, so removing it yields ordinary
    // positive reflectance and no retry should happen.
    const t = { scale: 0.0001, offset: -0.1, source: 'producer-planetary-computer' as const, note: 'n', nodata: 0 }
    const out = buildIndexValues({
      raw: grid([3900, 3850], [1500, 1520]),
      px: 2,
      nBands: 2,
      transforms: [t, t],
      index: 'NDVI',
      evaluate: ndvi,
      include: () => true,
      baseNote: 'base',
    })
    expect(out.retriedWithoutOffset).toBe(false)
    expect(out.values[0]).toBeCloseTo((0.29 - 0.05) / (0.29 + 0.05), 4)
  })

  it('drops values outside the index range instead of averaging them in', () => {
    // A denominator near zero produces an enormous finite value.
    const t = { scale: 0.0001, offset: -0.1, source: 'stac-declared' as const, note: 'n', nodata: 0 }
    const out = buildIndexValues({
      raw: grid([1000.00001, 3900], [999.99999, 1500]),
      px: 2,
      nBands: 2,
      transforms: [t, t],
      index: 'NDVI',
      evaluate: ndvi,
      include: () => true,
      baseNote: 'base',
    })
    expect(Number.isNaN(out.values[0])).toBe(true)
    expect(out.validCount).toBe(1)
  })
})

describe('looksOverCorrected', () => {
  it('tolerates the genuine over-correction atmospheric models produce', () => {
    expect(looksOverCorrected(0.05)).toBe(false)
    expect(looksOverCorrected(0.2)).toBe(false)
  })

  it('fires when a whole missing offset is the likelier explanation', () => {
    expect(looksOverCorrected(0.9)).toBe(true)
  })
})
