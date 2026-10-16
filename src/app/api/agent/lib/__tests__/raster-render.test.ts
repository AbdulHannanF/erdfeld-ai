import { describe, it, expect } from 'vitest'
import {
  assetKeyForBand,
  buildIndexRasterLayer,
  buildRasterTileUrl,
  normalizeColormap,
  parseRasterSpec,
  parseRescale,
  percentile,
  scaleExpression,
  stretchFromSummary,
  summarizeValues,
  validBandNames,
} from '../raster-render'
import { readTileStyle } from '@/lib/raster-style'

const S2 = 'sentinel-2-l2a' as const
const LS = 'landsat-c2-l2' as const

const s2Item = {
  id: 'S2A_TEST',
  properties: { datetime: '2026-08-15T10:00:00Z' },
  links: [{ rel: 'self', href: 'https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/S2A_TEST' }],
  assets: Object.fromEntries(
    ['coastal', 'blue', 'green', 'red', 'rededge1', 'nir', 'nir08', 'swir16', 'swir22', 'scl'].map((k) => [k, { href: `https://cogs/${k}.tif` }]),
  ),
}

describe('band -> asset mapping', () => {
  it('maps Sentinel-2 band names to Earth Search asset keys', () => {
    expect(assetKeyForBand(S2, 'B08', s2Item)).toBe('nir')
    expect(assetKeyForBand(S2, 'B04', s2Item)).toBe('red')
    expect(assetKeyForBand(S2, 'B8A', s2Item)).toBe('nir08')
    expect(assetKeyForBand(S2, 'B11', s2Item)).toBe('swir16')
    expect(assetKeyForBand(S2, 'B12', s2Item)).toBe('swir22')
  })
  it('falls back to PC-style B-keys when the item uses them', () => {
    const pcItem = { assets: { B08: { href: 'h' } } }
    expect(assetKeyForBand(S2, 'b8', pcItem)).toBe('B08')
  })
  it('returns null when the item lacks the asset (no substitution)', () => {
    expect(assetKeyForBand(S2, 'B09', s2Item)).toBeNull()
  })
  it('maps Landsat common names and OLI band numbers', () => {
    const item = { assets: { nir08: { href: 'h' }, red: { href: 'h' } } }
    expect(assetKeyForBand(LS, 'nir', item)).toBe('nir08')
    expect(assetKeyForBand(LS, 'B5', item)).toBe('nir08')
    expect(assetKeyForBand(LS, 'B4', item)).toBe('red')
  })
  it('lists the valid bands per sensor', () => {
    expect(validBandNames(S2)).toEqual(expect.arrayContaining(['B02', 'B08', 'B8A', 'B12']))
    expect(validBandNames(LS)).toEqual(['coastal', 'blue', 'green', 'red', 'nir08', 'swir16', 'swir22'])
  })
})

describe('parseRasterSpec', () => {
  it('1 band = single, 3 bands = rgb in the given order', () => {
    expect(parseRasterSpec(S2, { bands: ['b08'] })).toMatchObject({ ok: true, mode: 'single', bands: ['B08'], positional: 'b1' })
    expect(parseRasterSpec(S2, { bands: ['B08', 'B04', 'B03'] })).toMatchObject({ ok: true, mode: 'rgb', bands: ['B08', 'B04', 'B03'] })
  })
  it('rejects 2 or 4 bands, naming the rule', () => {
    const r = parseRasterSpec(S2, { bands: ['B08', 'B04'] })
    expect(r.ok).toBe(false)
    expect((r as any).error).toMatch(/1 band .* or 3 bands/)
  })
  it('names the valid bands for an unknown band and never substitutes', () => {
    const r = parseRasterSpec(S2, { bands: ['B13'] }) as any
    expect(r.ok).toBe(false)
    expect(r.error).toContain('"B13"')
    expect(r.error).toContain('B08 (NIR, 10 m)')
    const l = parseRasterSpec(LS, { bands: ['B08'] }) as any
    expect(l.error).toContain('Landsat')
    expect(l.error).toContain('nir08')
  })
  it('parses an expression into positional form with distinct bands in order of appearance', () => {
    const r = parseRasterSpec(S2, { expression: '(B11-B08)/(B11+B08)' })
    expect(r).toMatchObject({ ok: true, mode: 'expression', bands: ['B11', 'B08'], positional: '(b1-b2)/(b1+b2)' })
  })
  it('accepts aliases and canonicalises the shown expression', () => {
    const r = parseRasterSpec(S2, { expression: '(nir - red)/(nir + red)' }) as any
    expect(r.ok).toBe(true)
    expect(r.bands).toEqual(['B08', 'B04'])
    expect(r.expression).toBe('(B08 - B04)/(B08 + B04)')
  })
  it('rejects unknown identifiers, bad syntax, unsupported operators, and both/neither inputs', () => {
    expect((parseRasterSpec(S2, { expression: '(B11-FOO)/B08' }) as any).error).toContain('"FOO"')
    expect((parseRasterSpec(S2, { expression: '(B11-B08' }) as any).error).toMatch(/Cannot evaluate/)
    expect((parseRasterSpec(S2, { expression: 'B11 ** 2' }) as any).ok).toBe(false)
    expect((parseRasterSpec(S2, { expression: '2*3' }) as any).error).toMatch(/no bands/)
    expect(parseRasterSpec(S2, { bands: ['B08'], expression: 'B08' }).ok).toBe(false)
    expect(parseRasterSpec(S2, {}).ok).toBe(false)
  })
})

describe('colormap + rescale validation', () => {
  it('accepts known names (and reversed), rejects unknown', () => {
    expect(normalizeColormap('Viridis')).toBe('viridis')
    expect(normalizeColormap('rdylgn_r')).toBe('rdylgn_r')
    expect(normalizeColormap('notamap')).toBeNull()
  })
  it('parses a single pair, replicates it per band, and validates', () => {
    expect(parseRescale([0, 1], 1)).toEqual({ ok: true, rescale: [[0, 1]] })
    expect(parseRescale([0, 1], 3)).toEqual({ ok: true, rescale: [[0, 1], [0, 1], [0, 1]] })
    expect(parseRescale([[0, 1], [0, 2], [0, 3]], 3)).toEqual({ ok: true, rescale: [[0, 1], [0, 2], [0, 3]] })
    expect(parseRescale(undefined, 1)).toEqual({ ok: true, rescale: null })
    expect(parseRescale([1, 0], 1).ok).toBe(false)
    expect(parseRescale([[0, 1], [0, 2]], 3).ok).toBe(false)
  })
})

describe('buildRasterTileUrl', () => {
  const target = { kind: 'stac' as const, base: 'https://titiler.example', itemHref: 'https://es/items/X' }

  it('single band: expression on one asset, rescale and colormap, literal tile placeholders', () => {
    const url = buildRasterTileUrl({ target, assets: ['nir'], expression: 'b1*0.0001', rescale: [[0.05, 0.45]], colormap: 'magma' })
    expect(url.startsWith('https://titiler.example/stac/tiles/WebMercatorQuad/{z}/{x}/{y}.png?')).toBe(true)
    const q = new URL(url.replace(/\{z\}|\{x\}|\{y\}/g, '0')).searchParams
    expect(q.get('url')).toBe('https://es/items/X')
    expect(q.getAll('assets')).toEqual(['nir'])
    expect(q.get('expression')).toBe('b1*0.0001')
    expect(q.getAll('rescale')).toEqual(['0.05,0.45'])
    expect(q.get('colormap_name')).toBe('magma')
    expect(q.get('return_mask')).toBe('true')
  })

  it('RGB: three assets, one rescale per band, no colormap or expression', () => {
    const url = buildRasterTileUrl({ target, assets: ['nir', 'red', 'green'], rescale: [[100, 4000], [200, 3000], [300, 2500]] })
    const q = new URL(url.replace(/\{z\}|\{x\}|\{y\}/g, '0')).searchParams
    expect(q.getAll('assets')).toEqual(['nir', 'red', 'green'])
    expect(q.getAll('rescale')).toEqual(['100,4000', '200,3000', '300,2500'])
    expect(q.has('colormap_name')).toBe(false)
    expect(q.has('expression')).toBe(false)
    expect(readTileStyle(url).rescale).toHaveLength(3)
  })

  it('Planetary Computer target uses /item/tiles with collection + item', () => {
    const url = buildRasterTileUrl({
      target: { kind: 'pc', base: 'https://pc/api/data/v1', collection: 'landsat-c2-l2', itemId: 'LC09_X' },
      assets: ['red'], expression: 'b1', rescale: [[0, 1]], colormap: 'greys',
    })
    expect(url.startsWith('https://pc/api/data/v1/item/tiles/WebMercatorQuad/{z}/{x}/{y}.png?')).toBe(true)
    const q = new URL(url.replace(/\{z\}|\{x\}|\{y\}/g, '0')).searchParams
    expect(q.get('collection')).toBe('landsat-c2-l2')
    expect(q.get('item')).toBe('LC09_X')
  })

  it('encodes expression operators so they survive the query string', () => {
    const url = buildRasterTileUrl({ target, assets: ['a', 'b'], expression: '(b1-b2)/(b1+b2)', rescale: [[-1, 1]], colormap: 'rdylgn' })
    expect(url).toContain('expression=%28b1-b2%29%2F%28b1%2Bb2%29')
    expect(new URL(url.replace(/\{z\}|\{x\}|\{y\}/g, '0')).searchParams.get('expression')).toBe('(b1-b2)/(b1+b2)')
  })
})

describe('scaleExpression', () => {
  const t = (scale: number, offset = 0) => ({ scale, offset, source: 'sensor-default' as const, note: '', nodata: null })

  it('wraps each band reference in its own DN->reflectance transform', () => {
    expect(scaleExpression('b1', [t(0.0001)])).toBe('(b1*0.0001)')
    expect(scaleExpression('(b1-b2)/(b1+b2)', [t(0.0001), t(0.0001)])).toBe('((b1*0.0001)-(b2*0.0001))/((b1*0.0001)+(b2*0.0001))')
  })
  it('includes the additive offset (Landsat) and never emits exponent notation', () => {
    const out = scaleExpression('b1', [t(0.0000275, -0.2)])
    expect(out).toBe('(b1*0.0000275+(-0.2))')
    expect(out).not.toMatch(/e-/)
  })
  it('does not cascade on multi-digit band numbers', () => {
    const ts = Array.from({ length: 11 }, () => t(0.5))
    expect(scaleExpression('b10+b1', ts)).toBe('(b10*0.5)+(b1*0.5)')
  })
})

describe('percentile stretch', () => {
  const ramp = Float64Array.from({ length: 101 }, (_, i) => i) // 0..100

  it('interpolates percentiles of a sorted array', () => {
    expect(percentile(ramp, 2)).toBeCloseTo(2, 10)
    expect(percentile(ramp, 98)).toBeCloseTo(98, 10)
    expect(percentile(Float64Array.from([0, 10]), 50)).toBe(5)
    expect(percentile([], 50)).toBeNaN()
  })

  it('summarises only finite values and the p2-p98 stretch clips the tails', () => {
    const vals = [...ramp, NaN, Infinity]
    vals[0] = -1000 // an outlier the stretch must ignore
    const s = summarizeValues(vals)!
    expect(s.n).toBe(101)
    expect(s.min).toBe(-1000)
    expect(s.p2).toBeGreaterThan(0)
    const [lo, hi] = stretchFromSummary(s)
    expect(lo).toBeGreaterThan(0)
    expect(hi).toBeCloseTo(98, 5)
    expect(stretchFromSummary(s, 'minmax')).toEqual([-1000, 100])
  })

  it('returns null for no finite data and widens a flat distribution', () => {
    expect(summarizeValues([NaN])).toBeNull()
    const flat = summarizeValues([0.3, 0.3, 0.3])!
    const [lo, hi] = stretchFromSummary(flat)
    expect(hi).toBeGreaterThan(lo)
    expect(lo).toBeLessThan(0.3)
    expect(hi).toBeGreaterThan(0.3)
  })
})

describe('buildIndexRasterLayer', () => {
  const base = {
    id: 'ndvi-active',
    name: 'NDVI 2026-08-15',
    item: s2Item,
    index: 'NDVI',
    bounds: [0, 0, 1, 1] as [number, number, number, number],
    provenance: { source: 's', method: 'm', clip: 'polygon' as const },
    confidence: 'high' as const,
  }

  it('emits a tile layer with an AOI mask and a data-driven stretch from the stats', () => {
    const layer = buildIndexRasterLayer({ ...base, stats: { min: -0.1, max: 0.9, p2: 0.12, p98: 0.71, mean: 0.4, count: 1000 } })!
    expect(layer.aoiMask).toBe(true)
    expect(layer.imageBase64).toBeUndefined()
    expect(layer.raster).toMatchObject({ kind: 'continuous', sensor: 'sentinel-2-l2a', stretch: 'p2-p98', colormap: 'rdylgn', rescale: [[0.12, 0.71]] })
    expect(layer.raster?.bands).toEqual(['B08', 'B04'])
    expect(layer.raster?.expression).toBe('(B08-B04)/(B08+B04)')
    const style = readTileStyle(layer.tileUrl!)
    expect(style).toEqual({ colormap: 'rdylgn', rescale: [[0.12, 0.71]] })
    expect(layer.tileUrl).not.toContain('rescale=-1')
    // Reflectance-scaled: Earth Search pixels are DN x 0.0001.
    expect(decodeURIComponent(layer.tileUrl!)).toContain('(b1*0.0001)')
  })

  it('falls back to the index bounds and says the stretch is fixed when there are no stats', () => {
    const layer = buildIndexRasterLayer({ ...base, stats: null })!
    expect(layer.raster).toMatchObject({ stretch: 'fixed', rescale: [[-1, 1]] })
  })

  it('returns null when the scene lacks a band the index needs', () => {
    const item = { ...s2Item, assets: { red: s2Item.assets.red } }
    expect(buildIndexRasterLayer({ ...base, item, stats: null })).toBeNull()
  })
})
