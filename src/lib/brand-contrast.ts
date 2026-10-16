/** WCAG 2.x contrast for the brand tokens in globals.css (BR-02).
 *
 *  `PAIRS` lists every text/background (and UI-component) pair the interface uses, by token
 *  name. `resolve` reads the token values from globals.css, so the table in
 *  docs/brand/BRAND.md and the unit test cannot drift from the real tokens. Run
 *  `npx tsx docs/brand/tools/contrast.ts` to print the markdown table. */

export type Theme = 'light' | 'dark'
export interface Pair {
  theme: Theme
  fg: string
  bg: string
  /** 4.5 for body text, 3 for large text and non-text UI. */
  min: 4.5 | 3
  use: string
  /** Optional tint laid over `bg` (a status fill such as `bg-success/10`), blended before measuring. */
  tint?: { token: string; alpha: number }
}

/** Fixed colours used by pairs: white text and the brand-700 fill that carries it in both themes. */
export const FIXED_COLOURS = { white: '#ffffff', 'brand-700': '#25705f' }

const lightText = (fg: string, bg: string, use: string): Pair => ({ theme: 'light', fg, bg, min: 4.5, use })
const darkText = (fg: string, bg: string, use: string): Pair => ({ theme: 'dark', fg, bg, min: 4.5, use })

/** Semantic status tokens: success, warning (caveat), danger, info. */
export const STATUS = ['success', 'warning', 'danger', 'info'] as const

export const PAIRS: Pair[] = [
  lightText('foreground', 'background', 'body text'),
  lightText('card-foreground', 'card', 'text on cards'),
  lightText('popover-foreground', 'popover', 'text in menus and popovers'),
  lightText('muted-foreground', 'background', 'secondary text'),
  lightText('muted-foreground', 'muted', 'secondary text on muted fills'),
  lightText('secondary-foreground', 'secondary', 'secondary buttons'),
  lightText('accent-foreground', 'accent', 'hover and selected rows'),
  lightText('primary-foreground', 'primary', 'primary buttons'),
  lightText('brand-text', 'background', 'links, active tab, accent text'),
  lightText('brand-text', 'card', 'accent text on cards'),
  lightText('aqua-text', 'background', 'info accent text'),
  lightText('aqua-text', 'card', 'info accent text on cards'),
  lightText('leaf-text', 'background', 'success accent text'),
  lightText('destructive', 'background', 'error text'),
  lightText('destructive', 'card', 'error text on cards'),
  ...STATUS.flatMap((k) => [
    lightText(k, 'background', `${k} text`),
    lightText(k, 'card', `${k} text on cards`),
    { ...lightText(k, 'card', `${k} text on its 10% tint`), tint: { token: k, alpha: 0.1 } },
    lightText(`${k}-foreground`, k, `label on a solid ${k} fill`),
  ]),
  lightText('destructive-foreground', 'destructive', 'label on a destructive button'),
  { theme: 'light', fg: 'ring', bg: 'background', min: 3, use: 'focus ring' },
  { theme: 'light', fg: 'ring', bg: 'card', min: 3, use: 'focus ring on cards' },
  // solid brand fills with white text (buttons, badges, skip link); same in both themes
  lightText('white', 'brand-700', 'solid brand button / badge, white text'),
  darkText('white', 'brand-700', 'solid brand button / badge, white text'),
  darkText('foreground', 'background', 'body text'),
  darkText('card-foreground', 'card', 'text on cards'),
  darkText('popover-foreground', 'popover', 'text in menus and popovers'),
  darkText('muted-foreground', 'background', 'secondary text'),
  darkText('muted-foreground', 'muted', 'secondary text on muted fills'),
  darkText('muted-foreground', 'card', 'secondary text on cards'),
  darkText('secondary-foreground', 'secondary', 'secondary buttons'),
  darkText('accent-foreground', 'accent', 'hover and selected rows'),
  darkText('primary-foreground', 'primary', 'primary buttons'),
  darkText('brand-text', 'background', 'links, active tab, accent text'),
  darkText('brand-text', 'card', 'accent text on cards'),
  darkText('aqua-text', 'background', 'info accent text'),
  darkText('leaf-text', 'background', 'success accent text'),
  darkText('destructive', 'background', 'error text'),
  darkText('destructive', 'card', 'error text on cards'),
  ...STATUS.flatMap((k) => [
    darkText(k, 'background', `${k} text`),
    darkText(k, 'card', `${k} text on cards`),
    { ...darkText(k, 'card', `${k} text on its 10% tint`), tint: { token: k, alpha: 0.1 } },
    darkText(`${k}-foreground`, k, `label on a solid ${k} fill`),
  ]),
  darkText('destructive-foreground', 'destructive', 'label on a destructive button'),
  { theme: 'dark', fg: 'ring', bg: 'background', min: 3, use: 'focus ring' },
  { theme: 'dark', fg: 'ring', bg: 'card', min: 3, use: 'focus ring on cards' },
]

export function parseTokens(source: string): Record<Theme, Record<string, string>> {
  const css = source.split(String.fromCharCode(13)).join('') // CRLF checkouts (Windows)
  const block = (re: RegExp) => {
    const m = css.match(re)
    const out: Record<string, string> = {}
    for (const t of (m?.[0] ?? '').matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[t[1]] = t[2]
    return out
  }
  const light = block(/\n:root \{\n[\s\S]*?\n\}/)
  const dark = block(/\n\.dark \{[\s\S]*?\n\}/)
  return { light, dark: { ...light, ...dark } }
}

function lin(c: number) {
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
/** `alpha` of `top` over `bottom`, both #rrggbb. */
export function blend(top: string, bottom: string, alpha: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
  const mixed = [0, 1, 2].map((i) => Math.round(ch(top, i) * alpha + ch(bottom, i) * (1 - alpha)))
  return '#' + mixed.map((v) => v.toString(16).padStart(2, '0')).join('')
}
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => lin(v / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

export interface Measured extends Pair { fgHex: string; bgHex: string; ratio: number; pass: boolean }

export function measure(css: string): Measured[] {
  const tokens = parseTokens(css)
  return PAIRS.map((p) => {
    const t = tokens[p.theme]
    const fixed = FIXED_COLOURS as Record<string, string>
    const fgHex = t[p.fg] ?? fixed[p.fg]
    let bgHex = t[p.bg] ?? fixed[p.bg]
    if (!fgHex || !bgHex) throw new Error(`unresolved token in pair ${p.fg} / ${p.bg} (${p.theme})`)
    if (p.tint) {
      const tintHex = t[p.tint.token]
      if (!tintHex) throw new Error(`unresolved tint token ${p.tint.token} (${p.theme})`)
      bgHex = blend(tintHex, bgHex, p.tint.alpha)
    }
    const ratio = contrast(fgHex, bgHex)
    return { ...p, fgHex, bgHex, ratio, pass: ratio >= p.min }
  })
}
