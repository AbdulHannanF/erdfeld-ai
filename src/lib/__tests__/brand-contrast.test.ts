import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STATUS, blend, contrast, measure, parseTokens } from '../brand-contrast'

const css = readFileSync(join(__dirname, '../../app/globals.css'), 'utf8')

describe('brand contrast (BR-02)', () => {
  it('matches the documented reference ratios', () => {
    expect(contrast('#25705F', '#FFFFFF')).toBeCloseTo(5.9, 1)
    expect(contrast('#5CBFA6', '#2C3032')).toBeCloseTo(6.0, 1)
  })
  it('every text/background pair in use meets AA', () => {
    const failing = measure(css).filter((r) => !r.pass).map((r) => `${r.theme} ${r.fg} on ${r.bg}: ${r.ratio.toFixed(2)} < ${r.min}`)
    expect(failing).toEqual([])
  })
})

describe('status tokens', () => {
  const tokens = parseTokens(css)
  const results = measure(css)

  it('defines success, warning, danger and info with a foreground in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const k of STATUS) {
        expect(tokens[theme][k], `${theme} ${k}`).toMatch(/^#[0-9a-f]{6}$/i)
        expect(tokens[theme][`${k}-foreground`], `${theme} ${k}-foreground`).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })
  it('checks each status as text, on its own tint and as a solid fill, in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const k of STATUS) {
        const rows = results.filter((r) => r.theme === theme && (r.fg === k || r.bg === k))
        expect(rows.length, `${theme} ${k}`).toBeGreaterThanOrEqual(4)
        expect(rows.some((r) => r.tint)).toBe(true)
        expect(rows.every((r) => r.pass)).toBe(true)
      }
    }
  })
  it('danger is the destructive colour', () => {
    expect(tokens.light.danger).toBe(tokens.light.destructive)
    expect(tokens.dark.danger).toBe(tokens.dark.destructive)
  })
  it('warning is amber, not red: green channel well above danger', () => {
    const green = (hex: string) => parseInt(hex.slice(3, 5), 16)
    for (const theme of ['light', 'dark'] as const) expect(green(tokens[theme].warning)).toBeGreaterThan(green(tokens[theme].danger) + 30)
  })
})

describe('blend', () => {
  it('lays a translucent colour over a base', () => {
    expect(blend('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(blend('#123456', '#ffffff', 1)).toBe('#123456')
  })
})
