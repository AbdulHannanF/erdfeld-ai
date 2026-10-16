/**
 * A client-side check of a band-math expression before it is sent to `render_raster`, so a typo is
 * caught at the keyboard with the valid names listed instead of after a queue round trip. The
 * server stays the authority: it checks again and refuses unknown bands (`checkRasterBands`).
 * Nothing here evaluates the expression.
 */

export type Sensor = 'sentinel-2-l2a' | 'landsat-c2-l2'

export const SENSOR_BANDS: Record<Sensor, string[]> = {
  'sentinel-2-l2a': ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B8A', 'B09', 'B11', 'B12', 'blue', 'green', 'red', 'nir', 'swir16', 'swir22'],
  'landsat-c2-l2': ['coastal', 'blue', 'green', 'red', 'nir08', 'swir16', 'swir22'],
}

export const COLORMAPS = ['viridis', 'magma', 'inferno', 'plasma', 'cividis', 'greys', 'rdylgn', 'rdbu', 'spectral', 'terrain', 'blues', 'ylgn']

export interface BandCheck {
  ok: boolean
  /** Band names the expression uses, in order of first appearance. */
  bands: string[]
  error?: string
}

/** Numbers, band names, + - * / and brackets, with brackets balanced and every name a real band. */
export function checkBandExpression(sensor: Sensor, expression: string): BandCheck {
  const expr = expression.trim()
  if (!expr) return { ok: false, bands: [], error: 'Type an expression, for example (B08-B04)/(B08+B04)' }
  const bad = /[^A-Za-z0-9_+\-*/().\s]/.exec(expr)
  if (bad) return { ok: false, bands: [], error: `"${bad[0]}" is not allowed. Use band names, numbers, + - * / and brackets.` }
  let depth = 0
  for (const ch of expr) {
    if (ch === '(') depth++
    if (ch === ')' && --depth < 0) return { ok: false, bands: [], error: 'A closing bracket has no opening bracket.' }
  }
  if (depth !== 0) return { ok: false, bands: [], error: 'A bracket is not closed.' }
  const valid = SENSOR_BANDS[sensor]
  const names = [...new Set(expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])]
  const unknown = names.filter((n) => !valid.some((v) => v.toLowerCase() === n.toLowerCase()))
  if (unknown.length) return { ok: false, bands: names, error: `Unknown band ${unknown.map((u) => `"${u}"`).join(', ')}. ${sensor === 'sentinel-2-l2a' ? 'Sentinel-2' : 'Landsat'} bands: ${valid.join(', ')}.` }
  if (names.length === 0) return { ok: false, bands: [], error: 'The expression uses no band.' }
  if (/[+\-*/]\s*[+*/]|[+\-*/]\s*$|^\s*[*/]/.test(expr)) return { ok: false, bands: names, error: 'An operator is missing a value next to it.' }
  return { ok: true, bands: names }
}
