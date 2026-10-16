import { describe, expect, it } from 'vitest'
import {
  buildColorExpression,
  equalBreaks,
  featureProperties,
  legendItems,
  quantileBreaks,
  rampColors,
  resolveVectorStyle,
  sampleColormap,
  validateStyleProperty,
  vectorStylePaint,
} from '../vector-style'

const fc = (rows: Array<Record<string, unknown>>) => ({ features: rows.map((properties) => ({ properties })) })

const FIELDS = fc([
  { crop: 'maize', ndvi: 0.1, ha: 1 },
  { crop: 'maize', ndvi: 0.2, ha: 2 },
  { crop: 'wheat', ndvi: 0.4, ha: 3 },
  { crop: 'wheat', ndvi: 0.6, ha: 4 },
  { crop: 'soy', ndvi: 0.8, ha: 5 },
  { crop: 'soy', ndvi: 1.0, ha: 6 },
])

describe('breaks', () => {
  it('quantile: n-1 interpolated interior breaks', () => {
    const b = quantileBreaks([1, 2, 3, 4, 5], 5)
    expect(b).toHaveLength(4)
    ;[1.8, 2.6, 3.4, 4.2].forEach((x, k) => expect(b[k]).toBeCloseTo(x, 10))
    expect(quantileBreaks([1, 2, 3, 4, 5], 2)).toEqual([3])
  })
  it('quantile collapses ties instead of emitting duplicate breaks', () => {
    expect(quantileBreaks([2, 2, 2, 2, 2, 2], 5)).toEqual([])
    const b = quantileBreaks([1, 1, 1, 1, 9], 5)
    expect(new Set(b).size).toBe(b.length)
    expect(b.every((x, k) => k === 0 || x > b[k - 1])).toBe(true)
  })
  it('equal: evenly spaced between min and max', () => {
    expect(equalBreaks([0, 10, 4], 5)).toEqual([2, 4, 6, 8])
    expect(equalBreaks([3, 3], 5)).toEqual([])
  })
})

describe('featureProperties', () => {
  it('classifies numeric vs text columns and skips mixed / object ones', () => {
    const props = featureProperties(fc([
      { a: 1, b: 'x', c: 1, d: { z: 1 }, flag: true },
      { a: 2.5, b: 'y', c: 'oops', d: { z: 2 }, flag: false },
    ]))
    expect(props).toEqual([
      { name: 'a', type: 'number' },
      { name: 'b', type: 'string' },
      { name: 'flag', type: 'string' },
    ])
  })
  it('ignores nulls and non-finite numbers', () => {
    expect(featureProperties(fc([{ a: null, b: NaN }, { a: 3 }]))).toEqual([{ name: 'a', type: 'number' }])
  })
})

describe('validateStyleProperty', () => {
  it('accepts an existing property and infers the kind', () => {
    expect(validateStyleProperty(FIELDS, 'ndvi')).toEqual({ ok: true, value: { property: 'ndvi', kind: 'graduated' } })
    expect(validateStyleProperty(FIELDS, 'crop')).toEqual({ ok: true, value: { property: 'crop', kind: 'categorical' } })
  })
  it('rejects an unknown property and lists the real ones', () => {
    const r = validateStyleProperty(FIELDS, 'median_ndvi')
    expect(r.ok).toBe(false)
    expect((r as any).error).toContain('"median_ndvi" does not exist')
    expect((r as any).error).toContain('ndvi (number)')
    expect((r as any).error).toContain('crop (string)')
  })
  it('rejects graduating a text property', () => {
    const r = validateStyleProperty(FIELDS, 'crop', 'graduated')
    expect(r.ok).toBe(false)
    expect((r as any).error).toMatch(/categorical/)
  })
})

describe('colormaps', () => {
  it('samples endpoints and honours reversal', () => {
    expect(sampleColormap('viridis', 0)).toBe('#440154')
    expect(sampleColormap('viridis', 1)).toBe('#fde725')
    expect(sampleColormap('viridis_r', 0)).toBe('#fde725')
    expect(sampleColormap('nope', 0.5)).toBeNull()
    expect(rampColors('viridis', 3)).toHaveLength(3)
  })
})

describe('resolveVectorStyle + expressions', () => {
  it('graduated quantile (default 5 classes): step expression with typeof guard', () => {
    const r = resolveVectorStyle({ property: 'ndvi', kind: 'graduated' }, FIELDS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.breaks).toHaveLength(4)
    expect(r.value.colors).toHaveLength(5)
    const expr = buildColorExpression(r.value)
    expect(expr[0]).toBe('case')
    expect(expr[1]).toEqual(['==', ['typeof', ['get', 'ndvi']], 'number'])
    const step = expr[2]
    expect(step.slice(0, 3)).toEqual(['step', ['get', 'ndvi'], r.value.colors[0]])
    expect(step).toHaveLength(3 + 4 * 2)
    expect(step[3]).toBe(r.value.breaks[0])
    expect(expr[3]).toBe('#71717a')
  })
  it('equal method and explicit class count', () => {
    const r = resolveVectorStyle({ property: 'ndvi', kind: 'graduated', method: 'equal', numClasses: 3 }, FIELDS)
    expect(r.ok && r.value.breaks).toEqual([expect.closeTo(0.4, 10), expect.closeTo(0.7, 10)])
  })
  it('explicit breaks win and are sorted / deduped', () => {
    const r = resolveVectorStyle({ property: 'ndvi', kind: 'graduated', breaks: [0.5, 0.25, 0.5] }, FIELDS)
    expect(r.ok && r.value.breaks).toEqual([0.25, 0.5])
    expect(r.ok && r.value.colors).toHaveLength(3)
  })
  it('categorical: match over the stringified value, most frequent first', () => {
    const r = resolveVectorStyle({ property: 'crop', kind: 'categorical' }, FIELDS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const expr = buildColorExpression(r.value)
    expect(expr.slice(0, 2)).toEqual(['match', ['to-string', ['get', 'crop']]])
    expect(expr.filter((x, i) => i >= 2 && i % 2 === 0 && i < expr.length - 1)).toEqual(['maize', 'soy', 'wheat'])
    expect(expr[expr.length - 1]).toBe('#71717a')
  })
  it('categorical with explicit classes uses the given colours and flags uncovered values', () => {
    const r = resolveVectorStyle({ property: 'crop', kind: 'categorical', classes: [{ value: 'maize', label: 'Maize', color: '#ff0' }] }, FIELDS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(buildColorExpression(r.value)).toEqual(['match', ['to-string', ['get', 'crop']], 'maize', '#ff0', '#71717a'])
    expect(legendItems(r.value)).toEqual([{ color: '#ff0', label: 'Maize' }, { color: '#71717a', label: 'Other' }])
  })
  it('legend: graduated ranges span min..max', () => {
    const r = resolveVectorStyle({ property: 'ha', kind: 'graduated', method: 'equal', numClasses: 5 }, FIELDS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const items = legendItems(r.value)
    expect(items).toHaveLength(5)
    expect(items[0].label).toBe('1.00 – 2.00')
    expect(items[4].label).toBe('5.00 – 6.00')
    expect(items[0].color).toBe(r.value.colors[0])
  })
  it('caps categories at 12 and shows Other', () => {
    const many = fc(Array.from({ length: 20 }, (_, i) => ({ k: `v${i}` })))
    const r = resolveVectorStyle({ property: 'k', kind: 'categorical' }, many)
    expect(r.ok && r.value.classes).toHaveLength(12)
    expect(r.ok && legendItems(r.value).at(-1)?.label).toBe('Other')
  })
  it('fails honestly on unknown property / colormap / empty data', () => {
    expect(resolveVectorStyle({ property: 'zzz', kind: 'graduated' }, FIELDS).ok).toBe(false)
    const cm = resolveVectorStyle({ property: 'ndvi', kind: 'graduated', colormap: 'rainbowz' }, FIELDS)
    expect(cm.ok).toBe(false)
    expect((cm as any).error).toContain('Unknown colormap')
    expect(vectorStylePaint({ property: 'ndvi', kind: 'graduated' }, fc([]))).toBeNull()
    expect(vectorStylePaint(undefined, FIELDS)).toBeNull()
  })
})
