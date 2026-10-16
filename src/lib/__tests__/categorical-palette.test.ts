import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLASS_COLORS } from '@/app/api/agent/lib/fields/phenology'
import { AOI_COLOR, CATEGORICAL_CORE, CATEGORICAL_PALETTE } from '../categorical-palette'
import { deltaE, minPairwise, simulateHex, type Cvd } from '../color-vision'
import { CATEGORICAL_PALETTE as VECTOR_PALETTE } from '../vector-style'

const CVD: Cvd[] = ['protanopia', 'deuteranopia']
// brand teal (3 steps), leaf, aqua, and the neutral no-data grey
const RESERVED = ['#2E8C78', '#5CBFA6', '#25705F', '#7BB166', '#7AC5C0', '#71717a']

describe('colour-difference implementation', () => {
  it('reproduces the Sharma et al. CIEDE2000 reference pairs', () => {
    // pairs 1 and 17 of the published test data (dE00 2.0425 and 2.3669)
    const de = (a: [number, number, number], b: [number, number, number]) => {
      return import('../color-vision').then((m) => m.deltaE2000(a, b))
    }
    return Promise.all([
      de([50, 2.6772, -79.7751], [50, 0, -82.7485]).then((v) => expect(v).toBeCloseTo(2.0425, 3)),
      de([50, 2.5, 0], [73, 25, -18]).then((v) => expect(v).toBeCloseTo(27.1492, 3)),
      de([60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387]).then((v) => expect(v).toBeCloseTo(1.2644, 3)),
    ])
  })
  it('leaves normal vision unchanged and collapses red-green under deuteranopia', () => {
    expect(simulateHex('#D55E00', 'normal')).toBe('#d55e00')
    expect(deltaE('#ff0000', '#00aa00', 'deuteranopia')).toBeLessThan(deltaE('#ff0000', '#00aa00', 'normal') / 2)
  })
})

describe('categorical palette (BR-06)', () => {
  const core = CATEGORICAL_PALETTE.slice(0, CATEGORICAL_CORE)

  it('is the palette vector styles and charts use', () => {
    expect([...VECTOR_PALETTE]).toEqual([...CATEGORICAL_PALETTE])
  })
  it('has the 12 entries MAX_CATEGORIES needs, all distinct', () => {
    expect(new Set(CATEGORICAL_PALETTE).size).toBe(12)
  })
  it('core 1-8: min CIEDE2000 >= 15 (normal), >= 12 (protanopia, deuteranopia)', () => {
    expect(minPairwise([...core], 'normal').de).toBeGreaterThanOrEqual(15)
    for (const m of CVD) expect(minPairwise([...core], m).de).toBeGreaterThanOrEqual(12)
  })
  it('all 12: min CIEDE2000 >= 12 (normal), >= 7.5 (protanopia, deuteranopia)', () => {
    expect(minPairwise([...CATEGORICAL_PALETTE], 'normal').de).toBeGreaterThanOrEqual(12)
    for (const m of CVD) expect(minPairwise([...CATEGORICAL_PALETTE], m).de).toBeGreaterThanOrEqual(7.5)
  })
  it('never comes within 8 of brand teal, leaf, aqua or the no-data grey, in any vision mode', () => {
    for (const c of CATEGORICAL_PALETTE)
      for (const r of RESERVED)
        for (const m of ['normal', ...CVD] as Cvd[]) expect(deltaE(c, r, m), `${c} vs ${r} (${m})`).toBeGreaterThanOrEqual(8)
  })
  it('the reserved AOI colour is brand teal and not a data colour', () => {
    expect(AOI_COLOR).toBe('#5CBFA6')
    expect(CATEGORICAL_PALETTE).not.toContain(AOI_COLOR)
  })
  it('delineate_fields phenology classes are colour-blind safe (min >= 10)', () => {
    const colors = Object.values(CLASS_COLORS)
    for (const m of CVD) expect(minPairwise(colors, m).de).toBeGreaterThanOrEqual(10)
    expect(minPairwise(colors, 'normal').de).toBeGreaterThanOrEqual(15)
    for (const c of colors) for (const r of RESERVED.slice(0, 5)) expect(deltaE(c, r)).toBeGreaterThan(15)
  })
  it('the Tailwind text-cat-N tokens in globals.css match the palette', () => {
    const css = readFileSync(join(__dirname, '../../app/globals.css'), 'utf8')
    CATEGORICAL_PALETTE.forEach((c, i) => expect(css).toContain(`--color-cat-${i + 1}: ${c};`))
  })
})
