/** Synthetic multi-date NDVI stacks with known ground truth, for the field tests. */

import { makeGeoref, type BBox } from '../../vectorize'
import type { DelineateStack } from '../delineate'

/** Deterministic PRNG (mulberry32) + Box–Muller normal. */
export function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const normal = () => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next())
  return { next, normal }
}

export const DATES = [
  '2025-01-10', '2025-02-24', '2025-04-10', '2025-05-25',
  '2025-07-09', '2025-08-23', '2025-10-07', '2025-11-21',
]

const doy = (d: string) => (Date.parse(`${d}T00:00:00Z`) - Date.parse('2025-01-01T00:00:00Z')) / 86_400_000
const bump = (t: number, peak: number, width: number) => Math.exp(-(((t - peak) / width) ** 2))

export type Truth = 'winter_crop' | 'summer_crop' | 'double_crop' | 'perennial' | 'seasonal_other' | 'fallow_sparse' | 'non_field' | 'built_up'

const PROFILE: Record<Truth, (t: number) => number> = {
  winter_crop: (t) => 0.2 + 0.6 * bump(t, 50, 40),
  summer_crop: (t) => 0.2 + 0.55 * bump(t, 230, 40),
  double_crop: (t) => 0.2 + 0.5 * bump(t, 45, 30) + 0.5 * bump(t, 225, 30),
  perennial: (t) => 0.7 + 0.05 * Math.sin(t / 58),
  seasonal_other: (t) => 0.2 + 0.5 * bump(t, 135, 30),
  fallow_sparse: () => 0.35,
  non_field: () => 0.1,
  // Built-up: low, nearly flat NDVI that still crosses the 0.3 "bare" cut on some dates.
  built_up: (t) => 0.3 + 0.06 * Math.sin(t / 40),
}

/** NDBI truth: positive over impervious surface, negative over vegetation and fallow soil. */
const NDBI: Record<Truth, (t: number) => number> = {
  winter_crop: (t) => -0.45 * PROFILE.winter_crop(t),
  summer_crop: (t) => -0.45 * PROFILE.summer_crop(t),
  double_crop: (t) => -0.45 * PROFILE.double_crop(t),
  perennial: () => -0.3,
  seasonal_other: (t) => -0.45 * PROFILE.seasonal_other(t),
  fallow_sparse: () => -0.08,
  non_field: () => 0.12,
  built_up: () => 0.14,
}

export interface TruthRect { cls: Truth; x0: number; x1: number; y0: number; y1: number }

/** 120×120 at ~10 m: six touching fields (distinct phenologies) over a bare strip. */
export const RECTS: TruthRect[] = [
  { cls: 'winter_crop', x0: 0, x1: 40, y0: 0, y1: 60 },
  { cls: 'summer_crop', x0: 40, x1: 80, y0: 0, y1: 60 },
  { cls: 'double_crop', x0: 80, x1: 120, y0: 0, y1: 60 },
  { cls: 'perennial', x0: 0, x1: 50, y0: 60, y1: 100 },
  { cls: 'seasonal_other', x0: 50, x1: 90, y0: 60, y1: 100 },
  { cls: 'fallow_sparse', x0: 90, x1: 120, y0: 60, y1: 100 },
  { cls: 'non_field', x0: 0, x1: 120, y0: 100, y1: 120 },
]

export function makeStack(opts: {
  size?: number
  noise?: number
  gapRate?: number
  cloudBlobs?: boolean
  dates?: string[]
  seed?: number
  rects?: TruthRect[]
} = {}): DelineateStack {
  const size = opts.size ?? 120
  const scale = size / 120
  const dates = opts.dates ?? DATES
  const r = rng(opts.seed ?? 7)
  const noise = opts.noise ?? 0.03
  const gap = opts.gapRate ?? 0.08
  const rects = (opts.rects ?? RECTS).map((q) => ({
    ...q, x0: Math.round(q.x0 * scale), x1: Math.round(q.x1 * scale), y0: Math.round(q.y0 * scale), y1: Math.round(q.y1 * scale),
  }))
  const n = size * size
  const layers = dates.map(() => new Float32Array(n))
  const ndbi = dates.map(() => new Float32Array(n))
  for (const q of rects) {
    for (let y = q.y0; y < q.y1; y++) {
      for (let x = q.x0; x < q.x1; x++) {
        dates.forEach((d, k) => {
          layers[k][y * size + x] = PROFILE[q.cls](doy(d)) + noise * r.normal()
          ndbi[k][y * size + x] = NDBI[q.cls](doy(d)) + noise * r.normal()
        })
      }
    }
  }
  // Scattered clear-sky gaps, plus a large cloud on one date over a field boundary.
  for (let k = 0; k < dates.length; k++) {
    for (let i = 0; i < n; i++) if (r.next() < gap) layers[k][i] = ndbi[k][i] = NaN
  }
  if (opts.cloudBlobs !== false) {
    const k = 2, cx = Math.round(40 * scale), cy = Math.round(30 * scale), rad = Math.round(22 * scale)
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 < rad * rad) layers[k][y * size + x] = ndbi[k][y * size + x] = NaN
    }
  }
  // ~10 m cells at 25°N.
  const bbox: BBox = [78, 25, 78 + (size * 10) / (111_320 * Math.cos((25.0054 * Math.PI) / 180)), 25 + (size * 10) / 110_540]
  const geo = makeGeoref(bbox, size, size)
  return {
    width: size, height: size, layers, ndbi, inside: new Uint8Array(n).fill(1),
    bbox, dates, cellXm: geo.cellXm, cellYm: geo.cellYm,
  }
}

export function rectCentre(q: TruthRect, size: number) {
  const s = size / 120
  return { x: ((q.x0 + q.x1) / 2) * s, y: ((q.y0 + q.y1) / 2) * s }
}

export function truthArea(q: TruthRect, size: number) {
  const s = size / 120
  return Math.round((q.x1 - q.x0) * s) * Math.round((q.y1 - q.y0) * s)
}

/** Ray-cast point-in-polygon on a GeoJSON Polygon feature. */
export function pip(feature: any, lon: number, lat: number): boolean {
  let inside = false
  for (const ring of feature.geometry.coordinates as number[][][]) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j]
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}
