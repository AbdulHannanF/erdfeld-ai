import { describe, expect, it } from 'vitest'
import { checkBandExpression } from '../band-math'

describe('band-math check', () => {
  it('accepts an index over known bands', () => {
    expect(checkBandExpression('sentinel-2-l2a', '(B08-B04)/(B08+B04)')).toEqual({ ok: true, bands: ['B08', 'B04'] })
    expect(checkBandExpression('landsat-c2-l2', '(nir08 - red) / (nir08 + red)').ok).toBe(true)
  })
  it('names the valid bands when one is unknown, per sensor', () => {
    const r = checkBandExpression('landsat-c2-l2', '(B08-B04)/(B08+B04)')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Unknown band "B08", "B04"/)
    expect(r.error).toMatch(/Landsat bands: coastal/)
  })
  it('refuses characters that are not arithmetic', () => {
    expect(checkBandExpression('sentinel-2-l2a', 'B08; drop').error).toMatch(/not allowed/)
    expect(checkBandExpression('sentinel-2-l2a', 'B08 ** 2').error).toMatch(/operator/)
  })
  it('catches brackets, an empty expression and a missing value', () => {
    expect(checkBandExpression('sentinel-2-l2a', '(B08-B04').error).toMatch(/not closed/)
    expect(checkBandExpression('sentinel-2-l2a', 'B08-B04)').error).toMatch(/no opening/)
    expect(checkBandExpression('sentinel-2-l2a', '').error).toMatch(/Type an expression/)
    expect(checkBandExpression('sentinel-2-l2a', 'B08 -').error).toMatch(/operator/)
    expect(checkBandExpression('sentinel-2-l2a', '2 * 3').error).toMatch(/no band/)
  })
})
