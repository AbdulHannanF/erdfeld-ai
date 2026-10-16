import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The design system's guard (globals.css: type roles in the theme block, controls in section 5b).
 * Components take sizes, weights, radii and colours from the tokens; a one-off value fails here.
 * A deliberate exception carries `design-exception: <why>` on its line.
 */
const SRC = join(__dirname, '../..')
const css = readFileSync(join(SRC, 'app/globals.css'), 'utf8')

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__' && name !== 'node_modules' && name !== 'api') files(p, out)
    } else if (p.endsWith('.tsx')) out.push(p)
  }
  return out
}

/** Every `file:line  text` where `re` matches a line without a design-exception note. */
function offenders(re: RegExp): string[] {
  const found: string[] = []
  for (const f of files(SRC)) {
    // the logotype sets its own letter-spacing: it is a drawing of the name, not interface text
    if (f.endsWith('BrandMark.tsx')) continue
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (re.test(line) && !line.includes('design-exception')) found.push(`${f.slice(SRC.length + 1)}:${i + 1}  ${line.trim().slice(0, 100)}`)
    })
  }
  return found
}

describe('type scale', () => {
  it('every size token is at least 12px and rem-based', () => {
    const sizes = [...css.matchAll(/--text-([a-z-]+):\s*([0-9.]+)(rem|px)/g)]
    expect(sizes.length).toBeGreaterThanOrEqual(8)
    for (const [, name, n, unit] of sizes) {
      expect(unit, name).toBe('rem')
      expect(Number(n) * 16, name).toBeGreaterThanOrEqual(12)
    }
  })
  it('the label eyebrow is 12px or more too', () => {
    const label = css.match(/@utility text-label \{[^}]*font-size:\s*([0-9.]+)rem/)
    expect(label && Number(label[1]) * 16).toBeGreaterThanOrEqual(12)
  })
  it('components use the roles, not Tailwind sizes or arbitrary ones', () => {
    expect(offenders(/(?<![\w-])(?:[a-z0-9\[\]_>&:*.-]+:)*text-(?:xs|sm|base|lg|xl|[2-9]xl)(?![\w-])/)).toEqual([])
    expect(offenders(/text-\[[0-9.]+(?:rem|px|em)\]/)).toEqual([])
  })
  it('weights come from the roles; only inline emphasis uses font-semibold', () => {
    expect(offenders(/(?<![\w-])font-(?:medium|bold|extrabold|black|thin|light)(?![\w-])/)).toEqual([])
  })
  it('tracking is set by a role, not per element', () => {
    expect(offenders(/(?<![\w-])tracking-(?:\[[^\]]+\]|wide|wider|widest|tight|tighter)(?![\w-])/)).toEqual([])
  })
})

describe('colour roles', () => {
  it('no hex, rgb or palette colours in class lists', () => {
    expect(offenders(/(?<![\w-])(?:[a-z0-9\[\]_>&:*.!-]+:)*!?(?:text|bg|border|ring|fill|stroke|from|to|via|shadow|outline|decoration|accent|divide)-\[(?:#|rgb|hsl|oklch)/)).toEqual([])
    expect(offenders(/(?<![\w-])(?:[a-z0-9\[\]_>&:*.!-]+:)*(?:text|bg|border|ring|fill|stroke|divide)-(?:zinc|gray|slate|neutral|stone|red|orange|amber|yellow|lime|green|emerald|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d+)?(?![\w-])/)).toEqual([])
  })
  it('status text uses success / warning / danger, not destructive or the accent scales', () => {
    expect(offenders(/(?<![\w-])text-(?:destructive|amber-ink|aqua-text|leaf-text|brand-[0-9]+|aqua-[0-9]+|leaf-[0-9]+)(?![\w-])/)).toEqual([])
  })
})

describe('shape', () => {
  it('radius is sm 4 / md 6 / lg 10 (or full for dots)', () => {
    expect(offenders(/(?<![\w-])rounded(?:-(?:xs|xl|2xl|3xl|\[(?!inherit)[^\]]+\]))?(?![\w-])(?!-)/)).toEqual([])
  })
})

describe('controls', () => {
  it('buttons come from the .btn system, not hand-built class lists', () => {
    // a raw <button> that builds its own fill and border instead of .btn / .link-btn / .menu-item / .chip / .tab
    expect(offenders(/<button[^>]*className="[^"]*\b(?:bg-primary|bg-secondary|bg-accent|border-input)\b/)).toEqual([])
  })
})
