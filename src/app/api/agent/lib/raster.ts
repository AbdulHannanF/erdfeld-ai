/** Server-side raster generation: color ramps, interpolation, PNG output. */

import sharp from 'sharp'
import { pointInAoi } from './geometry'

/** NDVI → RGB using standard 7-class palette. Input range: -1 to 1. */
export function ndviToRgb(v: number): [number, number, number] {
  if (v < 0)    return [0,   0,   255]  // water/blue
  if (v < 0.1)  return [139, 69,  19]   // bare soil/brown
  if (v < 0.2)  return [244, 164, 96]   // sparse/tan
  if (v < 0.35) return [255, 255, 0]    // low vegetation/yellow
  if (v < 0.5)  return [154, 205, 50]   // moderate/yellow-green
  if (v < 0.7)  return [34,  139, 34]   // healthy/forest green
  return               [0,   100, 0]    // dense/dark green
}

/** Normalized elevation (0..1) → RGB terrain color ramp. */
export function elevToRgb(t: number): [number, number, number] {
  const stops: Array<{ t: number; r: number; g: number; b: number }> = [
    { t: 0,    r: 49,  g: 54,  b: 149 },
    { t: 0.25, r: 116, g: 173, b: 209 },
    { t: 0.5,  r: 254, g: 224, b: 144 },
    { t: 0.75, r: 244, g: 109, b: 67  },
    { t: 1,    r: 165, g: 0,   b: 38  },
  ]
  const n = Math.max(0, Math.min(1, t))
  let lo = stops[0], hi = stops[stops.length - 1]
  for (let i = 0; i < stops.length - 1; i++) {
    if (n >= stops[i].t && n <= stops[i + 1].t) { lo = stops[i]; hi = stops[i + 1]; break }
  }
  const f = hi.t === lo.t ? 0 : (n - lo.t) / (hi.t - lo.t)
  return [
    Math.round(lo.r + f * (hi.r - lo.r)),
    Math.round(lo.g + f * (hi.g - lo.g)),
    Math.round(lo.b + f * (hi.b - lo.b)),
  ]
}

/** Normalized slope% (0..1, 0=flat, 1=steepest) → yellow→orange→red RGB. */
export function slopeToRgb(t: number): [number, number, number] {
  const n = Math.max(0, Math.min(1, t))
  if (n < 0.05)  return [255, 255, 200]
  if (n < 0.20)  return [255, 240,  80]
  if (n < 0.40)  return [255, 170,  30]
  if (n < 0.60)  return [230,  90,  15]
  if (n < 0.80)  return [190,  30,  10]
  return               [110,   0,   0]
}

/** Normalized aspect (0..1 = 0°..360°, 0=N, 0.25=E, 0.5=S, 0.75=W) → 8-class wind-rose RGB. */
export function aspectToRgb(t: number): [number, number, number] {
  const n = Math.max(0, Math.min(1, t))
  // 22.5° = 1/16 of the circle
  if (n < 1/16 || n >= 15/16) return [ 65, 105, 225]  // N  — royal blue
  if (n < 3/16)               return [  0, 190, 150]  // NE — teal
  if (n < 5/16)               return [ 50, 200,  50]  // E  — lime green
  if (n < 7/16)               return [180, 215,  45]  // SE — yellow-green
  if (n < 9/16)               return [255, 215,   0]  // S  — yellow
  if (n < 11/16)              return [255, 130,   0]  // SW — orange
  if (n < 13/16)              return [210,  45,  45]  // W  — red
  return                             [170,  70, 210]  // NW — purple
}

/** SAR VV backscatter → grayscale false-color RGB. Dark = water/flood; bright = urban/double-bounce. */
export function sarToRgb(v: number): [number, number, number] {
  if (v < 0.05) return [10, 10, 50]
  if (v < 0.12) return [40, 55, 90]
  if (v < 0.22) return [65, 75, 80]
  if (v < 0.38) return [95, 105, 95]
  if (v < 0.55) return [140, 140, 130]
  if (v < 0.72) return [185, 180, 165]
  return [225, 220, 205]
}

/** Bilinear interpolation over a rows×cols grid to a W×H output image. */
export function bilinearInterp(grid: number[][], gridRows: number, gridCols: number, imgH: number, imgW: number): number[][] {
  const out: number[][] = []
  for (let imgR = 0; imgR < imgH; imgR++) {
    out.push([])
    for (let imgC = 0; imgC < imgW; imgC++) {
      const gr = (1 - imgR / (imgH - 1)) * (gridRows - 1)
      const gc = imgC / (imgW - 1) * (gridCols - 1)
      const r0 = Math.floor(gr), r1 = Math.min(r0 + 1, gridRows - 1)
      const c0 = Math.floor(gc), c1 = Math.min(c0 + 1, gridCols - 1)
      const tr = gr - r0, tc = gc - c0
      out[imgR].push(
        grid[r0][c0] * (1 - tr) * (1 - tc) +
        grid[r0][c1] * (1 - tr) * tc +
        grid[r1][c0] * tr * (1 - tc) +
        grid[r1][c1] * tr * tc,
      )
    }
  }
  return out
}

/** Deterministic pseudo-random noise seeded by a number. */
export function seededNoise(seed: number, count: number): number[] {
  let s = Math.abs(Math.round(seed * 1e6)) | 1
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out.push(s / 0x7fffffff)
  }
  return out
}

/** Optional AOI mask: pixels outside `polygon` (a GeoJSON Polygon/MultiPolygon
 *  in `bounds` lon/lat space) are emitted as transparent in the PNG alpha channel. */
export interface RasterClipMask {
  polygon: any
  bounds: [number, number, number, number]
}

/** Generate a base64 PNG from a 2D value grid using a color mapping function.
 *  When `clip` is provided, pixels outside the AOI polygon are made transparent
 *  (alpha=0) so the rendered raster matches the drawn shape, not its bbox. */
export async function generateRasterPng(
  valueGrid: number[][],
  colorFn: (v: number) => [number, number, number],
  width = 200,
  height = 200,
  clip?: RasterClipMask,
): Promise<string> {
  const gridRows = valueGrid.length
  const gridCols = valueGrid[0]?.length ?? 0
  const interpolated = bilinearInterp(valueGrid, gridRows, gridCols, height, width)

  const channels = clip ? 4 : 3
  const pixels = new Uint8Array(width * height * channels)
  const [west, south, east, north] = clip?.bounds ?? [0, 0, 0, 0]
  const lonSpan = east - west
  const latSpan = north - south

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const [rv, gv, bv] = colorFn(interpolated[r][c])
      const idx = (r * width + c) * channels
      pixels[idx] = rv
      pixels[idx + 1] = gv
      pixels[idx + 2] = bv
      if (clip) {
        // Map pixel (c, r) → lon/lat over [west,east]×[south,north]. Image origin
        // is top-left, so row 0 corresponds to the northern edge.
        const lng = west + (c / (width - 1)) * lonSpan
        const lat = north - (r / (height - 1)) * latSpan
        pixels[idx + 3] = pointInAoi(lng, lat, clip.polygon) ? 255 : 0
      }
    }
  }
  const buf = await sharp(Buffer.from(pixels), { raw: { width, height, channels: channels as 3 | 4 } }).png().toBuffer()
  return buf.toString('base64')
}
