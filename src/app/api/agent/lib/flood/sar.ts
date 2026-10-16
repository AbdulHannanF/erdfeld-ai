/** SAR water detection primitives (pure, no I/O).
 *
 *  Open water is a specular reflector: it throws the radar pulse away from the sensor,
 *  so it is dark in VV (typically below about -18 dB gamma-nought) while land, even wet
 *  bare soil, scatters back far more. Flood mapping is therefore a threshold on dB,
 *  applied the same way to a "before" and an "after" scene.
 *
 *  Pipeline per scene: linear power -> dB (`linearToDb`) -> 3x3 median speckle filter
 *  (`medianFilter3`) -> one threshold for the whole analysis (`chooseWaterThreshold`,
 *  Otsu on the pooled AOI histogram, clamped to a physical range, with a stated
 *  fallback) -> water mask -> 1 px open then close (`cleanMask`).
 *  A single threshold is shared by both dates of a comparison: two thresholds would
 *  manufacture "change" out of a threshold difference.
 */

import type { PixelGrid } from '../pixels'

/** Plausible range for a VV open-water threshold (dB). Otsu results outside it are clamped. */
export const WATER_DB_MIN = -23
export const WATER_DB_MAX = -15
/** Used when the AOI histogram is not bimodal enough for Otsu to be trusted. */
export const FALLBACK_THRESHOLD_DB = -18

export const HIST_MIN_DB = -35
export const HIST_MAX_DB = 5
export const HIST_BIN_DB = 0.25
const NBINS = Math.round((HIST_MAX_DB - HIST_MIN_DB) / HIST_BIN_DB)

/** Otsu's separability (between-class / total variance) below this is "weak bimodality". */
export const MIN_SEPARABILITY = 0.5
/** A dark class smaller than this share of pixels is not evidence of a water mode. */
export const MIN_DARK_SHARE = 0.005

/** Class labels of `classifyChange`. */
export const CHANGE = { NONE: 0, FLOOD: 1, PERMANENT: 2, RECEDED: 3 } as const

/**
 * Linear gamma-nought power -> dB. NaN where the pixel is outside the polygon, nodata
 * (validity mask 0, or a non-positive / non-finite value) — never a fabricated number.
 */
export function linearToDb(grid: Pick<PixelGrid, 'values' | 'mask' | 'width' | 'height'>): Float32Array {
  const n = grid.width * grid.height
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = grid.values[i]
    out[i] = grid.mask[i] > 0 && Number.isFinite(v) && v > 0 ? 10 * Math.log10(v) : NaN
  }
  return out
}

/** 3x3 median speckle filter. NaN pixels stay NaN and are ignored by their neighbours. */
export function medianFilter3(src: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(src.length)
  const win = new Float32Array(9)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (src[i] !== src[i]) { out[i] = NaN; continue }
      let n = 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= width) continue
          const v = src[yy * width + xx]
          if (v === v) win[n++] = v
        }
      }
      // insertion sort of <= 9 values
      for (let a = 1; a < n; a++) {
        const v = win[a]
        let b = a - 1
        while (b >= 0 && win[b] > v) { win[b + 1] = win[b]; b-- }
        win[b + 1] = v
      }
      out[i] = n % 2 === 1 ? win[(n - 1) / 2] : (win[n / 2 - 1] + win[n / 2]) / 2
    }
  }
  return out
}

/** Nearest-neighbour resample onto another grid size (used when two scenes differ in shape). */
export function resampleNearest(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  if (sw === dw && sh === dh) return src
  const out = new Float32Array(dw * dh)
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh))
    for (let x = 0; x < dw; x++) out[y * dw + x] = src[sy * sw + Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw))]
  }
  return out
}

// ---------------------------------------------------------------------------
// Threshold
// ---------------------------------------------------------------------------

/** Histogram of finite dB values over [HIST_MIN_DB, HIST_MAX_DB]; outliers go in the end bins. */
export function dbHistogram(grids: Float32Array[]): { counts: Float64Array; total: number } {
  const counts = new Float64Array(NBINS)
  let total = 0
  for (const g of grids) {
    for (let i = 0; i < g.length; i++) {
      const v = g[i]
      if (v !== v) continue
      let b = Math.floor((v - HIST_MIN_DB) / HIST_BIN_DB)
      if (b < 0) b = 0
      else if (b >= NBINS) b = NBINS - 1
      counts[b]++
      total++
    }
  }
  return { counts, total }
}

export interface OtsuResult {
  /** dB value at the split (upper edge of the last dark bin). */
  threshold: number
  /** Between-class variance / total variance, 0..1 (about 0.8+ for a clearly bimodal histogram). */
  separability: number
  /** Share of pixels in the dark class. */
  darkShare: number
}

/** Otsu's method on a dB histogram. Returns null for an empty or single-valued histogram. */
export function otsu(counts: Float64Array): OtsuResult | null {
  let total = 0
  let sumAll = 0
  for (let b = 0; b < counts.length; b++) {
    total += counts[b]
    sumAll += counts[b] * (HIST_MIN_DB + (b + 0.5) * HIST_BIN_DB)
  }
  if (total === 0) return null
  const mean = sumAll / total
  let varT = 0
  for (let b = 0; b < counts.length; b++) {
    const d = HIST_MIN_DB + (b + 0.5) * HIST_BIN_DB - mean
    varT += counts[b] * d * d
  }
  varT /= total
  if (varT < 1e-9) return null

  let w0 = 0
  let sum0 = 0
  const varBs = new Float64Array(counts.length)
  let best = -1
  for (let b = 0; b < counts.length - 1; b++) {
    w0 += counts[b]
    sum0 += counts[b] * (HIST_MIN_DB + (b + 0.5) * HIST_BIN_DB)
    const w1 = total - w0
    if (w0 === 0 || w1 === 0) continue
    const m0 = sum0 / w0
    const m1 = (sumAll - sum0) / w1
    varBs[b] = (w0 / total) * (w1 / total) * (m0 - m1) * (m0 - m1)
    if (varBs[b] > best) best = varBs[b]
  }
  if (best <= 0) return null
  // When the two populations are separated by an empty gap every split inside it scores the
  // same; take the middle of that plateau rather than hugging the dark mode.
  let first = -1
  let last = -1
  for (let b = 0; b < counts.length - 1; b++) {
    if (varBs[b] >= best * (1 - 1e-9)) { if (first < 0) first = b; last = b }
  }
  const bestBin = Math.floor((first + last) / 2)
  const bestVarB = varBs[bestBin]
  let dark = 0
  for (let b = 0; b <= bestBin; b++) dark += counts[b]
  return {
    threshold: HIST_MIN_DB + (bestBin + 1) * HIST_BIN_DB,
    separability: bestVarB / varT,
    darkShare: dark / total,
  }
}

export interface ThresholdChoice {
  thresholdDb: number
  /** 'otsu': used as found. 'otsu-clamped': Otsu fell outside the plausible range. 'fallback': histogram not bimodal. */
  method: 'otsu' | 'otsu-clamped' | 'fallback'
  /** The unclamped Otsu split, when one could be computed. */
  otsuDb: number | null
  separability: number | null
  darkSharePct: number | null
  pixels: number
  /** One honest sentence for the summary. */
  note: string
}

/**
 * Pick the water threshold from the pooled AOI histogram of `grids`.
 * Otsu, clamped to [`WATER_DB_MIN`, `WATER_DB_MAX`]; when separability is weak or the dark
 * class is negligible the histogram does not show two populations, so the fixed
 * `FALLBACK_THRESHOLD_DB` is used and the note says so.
 */
export function chooseWaterThreshold(
  grids: Float32Array[],
  range: [number, number] = [WATER_DB_MIN, WATER_DB_MAX],
  minSeparability = MIN_SEPARABILITY,
): ThresholdChoice {
  const { counts, total } = dbHistogram(grids)
  const o = total > 0 ? otsu(counts) : null
  const f1 = (v: number) => v.toFixed(1)
  if (!o) {
    return {
      thresholdDb: FALLBACK_THRESHOLD_DB, method: 'fallback', otsuDb: null, separability: null, darkSharePct: null, pixels: total,
      note: `No usable backscatter histogram (${total} pixels), so the fixed ${FALLBACK_THRESHOLD_DB} dB threshold was used.`,
    }
  }
  const stats = { otsuDb: o.threshold, separability: o.separability, darkSharePct: o.darkShare * 100, pixels: total }
  if (o.separability < minSeparability || o.darkShare < MIN_DARK_SHARE) {
    return {
      thresholdDb: FALLBACK_THRESHOLD_DB, method: 'fallback', ...stats,
      note:
        `The AOI backscatter histogram is only weakly bimodal (Otsu separability ${o.separability.toFixed(2)} < ${minSeparability}, ` +
        `dark class ${(o.darkShare * 100).toFixed(1)}% of pixels), so Otsu was not trusted and the fixed ${FALLBACK_THRESHOLD_DB} dB threshold was used.`,
    }
  }
  const clamped = Math.min(range[1], Math.max(range[0], o.threshold))
  if (clamped !== o.threshold) {
    // The split that explains the histogram is not a water split (e.g. two land populations). Clamping is
    // only meaningful if a dark population actually exists below the clamped level.
    let below = 0
    for (let b = 0; b < counts.length; b++) if (HIST_MIN_DB + (b + 1) * HIST_BIN_DB <= clamped + 1e-9) below += counts[b]
    if (below / total < MIN_DARK_SHARE) {
      return {
        thresholdDb: FALLBACK_THRESHOLD_DB, method: 'fallback', ...stats,
        note:
          `Otsu split the AOI histogram at ${f1(o.threshold)} dB, outside the plausible water range ${range[0]} to ${range[1]} dB, and fewer than ${MIN_DARK_SHARE * 100}% of pixels ` +
          `are darker than ${f1(clamped)} dB: the histogram is not bimodal (no water mode), so the fixed ${FALLBACK_THRESHOLD_DB} dB threshold was used.`,
      }
    }
    return {
      thresholdDb: clamped, method: 'otsu-clamped', ...stats,
      note: `Otsu split the AOI histogram at ${f1(o.threshold)} dB (separability ${o.separability.toFixed(2)}), outside the plausible water range ${range[0]} to ${range[1]} dB, so it was clamped to ${f1(clamped)} dB.`,
    }
  }
  return {
    thresholdDb: o.threshold, method: 'otsu', ...stats,
    note: `Otsu threshold ${f1(o.threshold)} dB on the pooled AOI histogram (separability ${o.separability.toFixed(2)}, dark class ${(o.darkShare * 100).toFixed(1)}% of pixels).`,
  }
}

// ---------------------------------------------------------------------------
// Masks
// ---------------------------------------------------------------------------

/** 1 where dB is finite and below the threshold (water), else 0. */
export function waterMask(db: Float32Array, thresholdDb: number): Uint8Array {
  const out = new Uint8Array(db.length)
  for (let i = 0; i < db.length; i++) out[i] = db[i] < thresholdDb ? 1 : 0
  return out
}

/** Binary erosion with a 3x3 square (radius 1); neighbours outside the grid are ignored, so edges are not eaten. */
export function erode(m: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(m.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue
      let keep = 1
      for (let dy = -1; dy <= 1 && keep; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx >= 0 && xx < w && !m[yy * w + xx]) { keep = 0; break }
        }
      }
      out[y * w + x] = keep
    }
  }
  return out
}

/** Binary dilation with a 3x3 square. */
export function dilate(m: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(m.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx >= 0 && xx < w) out[yy * w + xx] = 1
        }
      }
    }
  }
  return out
}

export const openMask = (m: Uint8Array, w: number, h: number) => dilate(erode(m, w, h), w, h)
export const closeMask = (m: Uint8Array, w: number, h: number) => erode(dilate(m, w, h), w, h)

/** 1 px closing (fills 1 px speckle pinholes inside water) then 1 px opening (drops isolated pixels and 1 px spurs).
 *  Closing first matters: opening a block that has a pinhole would nibble its corners. */
export function cleanMask(m: Uint8Array, w: number, h: number): Uint8Array {
  return openMask(closeMask(m, w, h), w, h)
}

/**
 * Per-pixel change classes from two water masks. Pixels not observed in BOTH scenes
 * (`valid` = 0) are NONE — a gap in either scene cannot be called flooded or receded.
 *   FLOOD     = water(after) AND NOT water(before)
 *   PERMANENT = water in both
 *   RECEDED   = water(before) only
 */
export function classifyChange(before: Uint8Array, after: Uint8Array, valid: Uint8Array): Uint8Array {
  const out = new Uint8Array(before.length)
  for (let i = 0; i < out.length; i++) {
    if (!valid[i]) continue
    out[i] = after[i] ? (before[i] ? CHANGE.PERMANENT : CHANGE.FLOOD) : before[i] ? CHANGE.RECEDED : CHANGE.NONE
  }
  return out
}

/** Extract one class of a label grid as a 0/1 mask. */
export function classMask(labels: Uint8Array, cls: number): Uint8Array {
  const out = new Uint8Array(labels.length)
  for (let i = 0; i < labels.length; i++) out[i] = labels[i] === cls ? 1 : 0
  return out
}

/** Water share (0..1) of observed pixels, or null when nothing was observed. */
export function waterFraction(water: Uint8Array, db: Float32Array): number | null {
  let valid = 0
  let wet = 0
  for (let i = 0; i < db.length; i++) {
    if (db[i] !== db[i]) continue
    valid++
    wet += water[i]
  }
  return valid > 0 ? wet / valid : null
}
