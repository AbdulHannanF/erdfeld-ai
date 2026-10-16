/** Tests for the band-expression evaluator.
 *
 *  The point of this evaluator is that `SPECTRAL_INDEX_TILE_CONFIG` stays the
 *  single definition of every index, so the load-bearing tests are the ones
 *  that run the REAL templates and compare against the formula written out by
 *  hand. If those two ever disagree, the in-process index and titiler's tiles
 *  would disagree — the ISS-120 failure shape.
 */

import { describe, it, expect } from 'vitest'
import { compileBandExpression, toPositionalExpression } from '../band-expression'
import { SPECTRAL_INDEX_TILE_CONFIG } from '../../titiler'

describe('compileBandExpression', () => {
  it('evaluates arithmetic with correct precedence', () => {
    expect(compileBandExpression('1+2*3')([])).toBe(7)
    expect(compileBandExpression('(1+2)*3')([])).toBe(9)
    expect(compileBandExpression('8/2/2')([])).toBe(2)
    expect(compileBandExpression('8-2-3')([])).toBe(3)
  })

  it('resolves b1-based band references', () => {
    const f = compileBandExpression('(b1-b2)/(b1+b2)')
    expect(f([3, 1])).toBeCloseTo(0.5, 12)
    expect(f([1, 3])).toBeCloseTo(-0.5, 12)
  })

  it('handles unary minus and decimals', () => {
    expect(compileBandExpression('-0.5')([])).toBe(-0.5)
    expect(compileBandExpression('1-(-2)')([])).toBe(3)
    expect(compileBandExpression('2.5*b1')([4])).toBe(10)
  })

  it('yields NaN for a missing band rather than a silent zero', () => {
    expect(Number.isNaN(compileBandExpression('b1+b3')([1, 2]))).toBe(true)
  })

  it('rejects an unparseable expression by name instead of approximating', () => {
    expect(() => compileBandExpression('sqrt(b1)')).toThrow(/unsupported character/)
    expect(() => compileBandExpression('(b1+b2')).toThrow(/parenthes/)
    expect(() => compileBandExpression('b1+')).toThrow(/malformed/)
    expect(() => compileBandExpression('')).toThrow()
  })
})

describe('the real index templates', () => {
  it('converts BAND0-style templates to titiler positional form', () => {
    expect(toPositionalExpression('(BAND0-BAND1)/(BAND0+BAND1)')).toBe('(b1-b2)/(b1+b2)')
  })

  it('reproduces every shipped index formula exactly', () => {
    const nir = 3000, red = 1200, green = 900, swir16 = 2200, swir22 = 1800
    // EVI's constants (6, 7.5, +1) are in reflectance units, so its inputs are reflectance.
    const rNir = 0.3, rRed = 0.12, rBlue = 0.05

    // Band order per SPECTRAL_INDEX_TILE_CONFIG.bandKeys.
    const cases: Array<[string, number[], number]> = [
      ['NDVI', [nir, red], (nir - red) / (nir + red)],
      ['NDWI', [green, nir], (green - nir) / (green + nir)],
      ['NDBI', [swir16, nir], (swir16 - nir) / (swir16 + nir)],
      ['EVI', [rNir, rRed, rBlue], (2.5 * (rNir - rRed)) / (rNir + 6 * rRed - 7.5 * rBlue + 1)],
      ['NBR', [nir, swir22], (nir - swir22) / (nir + swir22)],
      ['SAVI', [nir, red], (1.5 * (nir - red)) / (nir + red + 0.5)],
    ]

    for (const [index, bands, expected] of cases) {
      const cfg = SPECTRAL_INDEX_TILE_CONFIG[index]
      expect(cfg, `${index} must exist in the config`).toBeDefined()
      const f = compileBandExpression(toPositionalExpression(cfg.exprTemplate))
      expect(f(bands), `${index}`).toBeCloseTo(expected, 12)
    }
  })

  it('EVI is the canonical 2.5*(NIR-RED)/(NIR+6*RED-7.5*BLUE+1) with blue as its third band', () => {
    const cfg = SPECTRAL_INDEX_TILE_CONFIG.EVI
    expect(cfg.bandKeys.map((k) => k[0])).toEqual(['nir', 'red', 'blue'])
    expect(cfg.bandKeys[2]).toEqual(['blue', 'B02'])
    expect(toPositionalExpression(cfg.exprTemplate)).toBe('2.5*(b1-b2)/(b1+6*b2-7.5*b3+1)')
    expect(cfg.reflectance).toBe(true)
  })

  it('every configured index compiles — a new index cannot ship unevaluable', () => {
    for (const [name, cfg] of Object.entries(SPECTRAL_INDEX_TILE_CONFIG)) {
      expect(() => compileBandExpression(toPositionalExpression(cfg.exprTemplate)), name).not.toThrow()
    }
  })
})
