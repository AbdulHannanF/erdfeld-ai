/** Native-resolution PNG rendering for `analyze_raster` result grids.
 *
 *  Deliberately NOT `lib/raster.ts#generateRasterPng`: that helper bilinearly
 *  interpolates the grid up to a fixed size, which would smear values across
 *  masked-out pixels and is meaningless for a cluster map (class 1 and class 3
 *  do not average to class 2). Here one grid cell is one image pixel and an
 *  invalid cell is fully transparent, so the picture shows exactly the pixels
 *  the statistics used — including the holes where cloud was masked out.
 */

import sharp from 'sharp'
import type { AnalysisGrid } from './operations'

export type Rgb = [number, number, number]

/** Categorical palette for cluster maps — distinguishable in both themes. */
export const CLUSTER_COLORS: string[] = [
  '#10b981', '#60a5fa', '#f59e0b', '#f87171', '#a78bfa', '#34d399',
  '#fbbf24', '#38bdf8', '#fb7185', '#c084fc', '#4ade80', '#facc15',
]

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Blue → white → red, centred on 0 and saturating at ±`scale`. */
export function divergingRamp(scale: number): (v: number) => Rgb {
  const s = scale > 0 ? scale : 1
  return (v: number) => {
    const t = Math.max(-1, Math.min(1, v / s))
    if (t >= 0) return [255, Math.round(255 * (1 - t)), Math.round(255 * (1 - t))]
    return [Math.round(255 * (1 + t)), Math.round(255 * (1 + t)), 255]
  }
}

/** Dark-to-bright sequential ramp for magnitudes (texture, spread). */
export function sequentialRamp(min: number, max: number): (v: number) => Rgb {
  const span = max > min ? max - min : 1
  return (v: number) => {
    const t = Math.max(0, Math.min(1, (v - min) / span))
    // deep indigo → teal → amber
    if (t < 0.5) {
      const u = t / 0.5
      return [Math.round(30 + 6 * u), Math.round(27 + 160 * u), Math.round(75 + 62 * u)]
    }
    const u = (t - 0.5) / 0.5
    return [Math.round(36 + 215 * u), Math.round(187 - 26 * u), Math.round(137 - 126 * u)]
  }
}

/** Palette lookup by integer class index (cluster maps). */
export function classRamp(): (v: number) => Rgb {
  const rgb = CLUSTER_COLORS.map(hexToRgb)
  return (v: number) => rgb[Math.max(0, Math.round(v)) % rgb.length]
}

/**
 * Render a grid at its native size: one cell → one pixel, invalid cells fully
 * transparent. Returns base64 PNG, or null when nothing is valid.
 */
export async function renderGridPng(
  grid: AnalysisGrid,
  colorFn: (v: number) => Rgb,
): Promise<string | null> {
  const { width, height } = grid
  const px = width * height
  let any = false
  const pixels = new Uint8Array(px * 4)
  for (let i = 0; i < px; i++) {
    if (grid.valid[i] === 0 || !Number.isFinite(grid.values[i])) continue
    const [r, g, b] = colorFn(grid.values[i])
    const o = i * 4
    pixels[o] = r; pixels[o + 1] = g; pixels[o + 2] = b; pixels[o + 3] = 255
    any = true
  }
  if (!any) return null
  const buf = await sharp(Buffer.from(pixels), { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer()
  return buf.toString('base64')
}
