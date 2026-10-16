/** Pure math for `analyze_raster` — Phase 2.5 (spec §3.6 B).
 *
 *  ONE substrate, MANY operations. Every function here takes an `AnalysisGrid`
 *  (a polygon-clipped, already cloud-masked pixel grid) and returns a result, so
 *  a new analysis is a parameter rather than a new tool.
 *
 *  Nothing in this file touches the network, and nothing invents a value:
 *  when there is not enough valid data to answer, the function returns `null`
 *  and the caller must say so. That is the same rule the rest of the codebase
 *  runs on — a fallback that always produces a number is indistinguishable from
 *  one that works (see ISS-107).
 *
 *  Coordinate conventions, matching `lib/variogram.ts`:
 *    - row 0 is the NORTH edge of the grid;
 *    - sample `x` grows east, `y` grows north, both in metres;
 *    - `directionDeg` is an azimuth: 0 = north, 90 = east, clockwise, and a
 *      direction is an AXIS — 45° and 225° select the same pairs.
 */

/** One spatial sample in metric coordinates: `x` east, `y` north, `v` the value. */
export interface VariogramSample {
  x: number
  y: number
  v: number
}

const METERS_PER_DEG_LAT = 110_540
const METERS_PER_DEG_LON_EQ = 111_320

// ---------------------------------------------------------------------------
// The substrate
// ---------------------------------------------------------------------------

/** A polygon-clipped grid whose `valid` flags already encode BOTH "inside the
 *  drawn polygon" and "clear of cloud" — the two masks are combined upstream so
 *  every operation here is automatically cloud-masked. */
export interface AnalysisGrid {
  values: Float64Array
  /** 1 = usable pixel (in polygon AND clear). */
  valid: Uint8Array
  width: number
  height: number
  /** Ground size of one pixel, metres. */
  cellXm: number
  cellYm: number
  /** [minLng, minLat, maxLng, maxLat] of the grid's extent. */
  bbox: [number, number, number, number]
  /** Optional label carried through to the report (e.g. "NDWI"). */
  label?: string
}

/** Build an `AnalysisGrid`, deriving the metric cell size from the bbox. */
export function makeGrid(
  values: Float64Array,
  valid: Uint8Array,
  width: number,
  height: number,
  bbox: [number, number, number, number],
  label?: string,
): AnalysisGrid {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const centerLat = (minLat + maxLat) / 2
  const cellXm = ((maxLng - minLng) / width) * METERS_PER_DEG_LON_EQ * Math.cos((centerLat * Math.PI) / 180)
  const cellYm = ((maxLat - minLat) / height) * METERS_PER_DEG_LAT
  return { values, valid, width, height, cellXm, cellYm, bbox, label }
}

/** True when the pixel is inside the polygon, clear, and finite. */
function usable(g: AnalysisGrid, i: number): boolean {
  return g.valid[i] !== 0 && Number.isFinite(g.values[i])
}

function sameShape(a: AnalysisGrid, b: AnalysisGrid): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `grid shape mismatch (${a.width}×${a.height} vs ${b.width}×${b.height}) — ` +
        'the two reads must use the same polygon and max_size so pixels align',
    )
  }
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

export interface StatsResult {
  mean: number
  median: number
  std: number
  min: number
  max: number
  count: number
  /** Pixels inside the polygon before the clear-sky filter. */
  insidePolygon: number
  p05: number
  p25: number
  p75: number
  p95: number
}

/** Linear-interpolated percentile of an ascending array. */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0]
  const pos = q * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

function statsOf(kept: number[], insidePolygon: number): StatsResult | null {
  if (kept.length === 0) return null
  const sorted = kept.slice().sort((a, b) => a - b)
  const count = sorted.length
  const mean = sorted.reduce((a, b) => a + b, 0) / count
  const variance = sorted.reduce((a, v) => a + (v - mean) * (v - mean), 0) / count
  return {
    mean,
    median: percentile(sorted, 0.5),
    std: Math.sqrt(variance),
    min: sorted[0],
    max: sorted[count - 1],
    count,
    insidePolygon,
    p05: percentile(sorted, 0.05),
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
    p95: percentile(sorted, 0.95),
  }
}

/** Moments and percentiles over usable pixels. Null when none qualify. */
export function computeStats(g: AnalysisGrid): StatsResult | null {
  const kept: number[] = []
  let inside = 0
  const px = g.width * g.height
  for (let i = 0; i < px; i++) {
    if (g.valid[i] === 0) continue
    inside++
    if (Number.isFinite(g.values[i])) kept.push(g.values[i])
  }
  return statsOf(kept, inside)
}

// ---------------------------------------------------------------------------
// histogram
// ---------------------------------------------------------------------------

export interface HistogramResult {
  /** Bin centre label → pixel count, chart-ready. */
  bins: Array<{ label: string; value: number }>
  edges: number[]
  count: number
  min: number
  max: number
}

export function computeHistogram(
  g: AnalysisGrid,
  opts: { bins?: number; range?: [number, number] } = {},
): HistogramResult | null {
  const nBins = Math.max(2, Math.min(60, Math.round(opts.bins ?? 20)))
  const vals: number[] = []
  const px = g.width * g.height
  for (let i = 0; i < px; i++) if (usable(g, i)) vals.push(g.values[i])
  if (vals.length === 0) return null

  let lo: number, hi: number
  if (opts.range) {
    ;[lo, hi] = opts.range
  } else {
    lo = Math.min(...vals)
    hi = Math.max(...vals)
  }
  if (!(hi > lo)) {
    // A constant field is a real answer, not a failure — one bin holds everything.
    hi = lo + 1
  }
  const width = (hi - lo) / nBins
  const counts = new Uint32Array(nBins)
  for (const v of vals) {
    if (v < lo || v > hi) continue
    const b = Math.min(nBins - 1, Math.floor((v - lo) / width))
    counts[b]++
  }
  const edges = Array.from({ length: nBins + 1 }, (_, i) => lo + i * width)
  return {
    bins: Array.from(counts, (c, i) => ({
      label: (lo + (i + 0.5) * width).toFixed(3),
      value: c,
    })),
    edges,
    count: vals.length,
    min: Math.min(...vals),
    max: Math.max(...vals),
  }
}

// ---------------------------------------------------------------------------
// samples (shared by variogram)
// ---------------------------------------------------------------------------

/** Convert a grid to metric-coordinate samples, deterministically thinned to
 *  `maxSamples` (stride-based — reproducible, no RNG). */
export function gridSamples(
  g: AnalysisGrid,
  maxSamples = 1400,
): { samples: VariogramSample[]; validCount: number } {
  const valid: VariogramSample[] = []
  for (let r = 0; r < g.height; r++) {
    for (let c = 0; c < g.width; c++) {
      const i = r * g.width + c
      if (!usable(g, i)) continue
      valid.push({ x: c * g.cellXm, y: (g.height - 1 - r) * g.cellYm, v: g.values[i] })
    }
  }
  const validCount = valid.length
  if (validCount <= maxSamples) return { samples: valid, validCount }
  const stride = validCount / maxSamples
  const samples: VariogramSample[] = []
  for (let k = 0; k < maxSamples; k++) samples.push(valid[Math.floor(k * stride)])
  return { samples, validCount }
}

// ---------------------------------------------------------------------------
// variogram — directional
// ---------------------------------------------------------------------------

export interface VariogramBin {
  /** Bin-centre lag distance, metres. */
  lag_m: number
  semivariance: number
  pairs: number
}

export interface VariogramOptions {
  /** Lag bin WIDTH in metres. The user-facing knob: "40 m lags". */
  lagM?: number
  /** Largest lag considered, metres. Defaults to half the sample envelope. */
  maxLagM?: number
  /** Azimuth in degrees (0 = N, 90 = E). `null`/undefined = omnidirectional. */
  directionDeg?: number | null
  /** Half-angle admitted around the azimuth. */
  toleranceDeg?: number
  /** Minimum pairs for a bin to be reported. */
  minPairs?: number
}

export interface VariogramResult {
  bins: VariogramBin[]
  totalPairs: number
  lagWidthM: number
  maxLagM: number
  directionDeg: number | null
  toleranceDeg: number
  sampleCount: number
  /** True when the field held too few usable pixels to bin at all. */
  tooFewSamples: boolean
}

/** Minimum samples for a variogram to mean anything. Below this the bins are
 *  noise and we say so rather than plotting them. */
export const MIN_VARIOGRAM_SAMPLES = 30

/** Experimental semivariogram γ(h) = ½·mean[(z(s) − z(s+h))²], optionally
 *  restricted to pairs whose separation vector lies within `toleranceDeg` of
 *  `directionDeg` — that restriction is what makes anisotropy visible. */
export function computeVariogram(
  samples: VariogramSample[],
  opts: VariogramOptions = {},
): VariogramResult {
  const n = samples.length
  const toleranceDeg = opts.toleranceDeg ?? 22.5
  const directionDeg = opts.directionDeg == null ? null : ((opts.directionDeg % 180) + 180) % 180
  const minPairs = opts.minPairs ?? 10

  const empty = (lagWidthM: number, maxLagM: number, tooFew: boolean): VariogramResult => ({
    bins: [], totalPairs: 0, lagWidthM, maxLagM, directionDeg, toleranceDeg,
    sampleCount: n, tooFewSamples: tooFew,
  })

  if (n < MIN_VARIOGRAM_SAMPLES) return empty(opts.lagM ?? 0, opts.maxLagM ?? 0, true)

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const s of samples) {
    if (s.x < minX) minX = s.x
    if (s.x > maxX) maxX = s.x
    if (s.y < minY) minY = s.y
    if (s.y > maxY) maxY = s.y
  }
  const envelope = Math.hypot(maxX - minX, maxY - minY)
  const maxLag = opts.maxLagM && opts.maxLagM > 0 ? opts.maxLagM : envelope * 0.5
  if (!(maxLag > 0)) return empty(opts.lagM ?? 0, 0, false)

  // Default to 12 bins across the range when no explicit lag width is asked for.
  const lagWidth = opts.lagM && opts.lagM > 0 ? opts.lagM : maxLag / 12
  const nBins = Math.max(1, Math.min(200, Math.ceil(maxLag / lagWidth)))

  const cosTol = Math.cos((toleranceDeg * Math.PI) / 180)
  // Unit vector of the requested azimuth in (x = east, y = north) space.
  const ux = directionDeg == null ? 0 : Math.sin((directionDeg * Math.PI) / 180)
  const uy = directionDeg == null ? 0 : Math.cos((directionDeg * Math.PI) / 180)

  const sums = new Float64Array(nBins)
  const counts = new Uint32Array(nBins)
  for (let i = 0; i < n; i++) {
    const si = samples[i]
    for (let j = i + 1; j < n; j++) {
      const sj = samples[j]
      const dx = sj.x - si.x
      const dy = sj.y - si.y
      const h = Math.hypot(dx, dy)
      if (h === 0 || h >= maxLag) continue
      if (directionDeg != null) {
        // |cos θ| — a lag is an axis, so the reciprocal direction counts too.
        if (Math.abs((dx * ux + dy * uy) / h) < cosTol) continue
      }
      const b = Math.floor(h / lagWidth)
      if (b >= nBins) continue
      const d = si.v - sj.v
      sums[b] += 0.5 * d * d
      counts[b]++
    }
  }

  const bins: VariogramBin[] = []
  let totalPairs = 0
  for (let b = 0; b < nBins; b++) {
    if (counts[b] < minPairs) continue
    totalPairs += counts[b]
    bins.push({
      lag_m: Math.round((b + 0.5) * lagWidth),
      semivariance: sums[b] / counts[b],
      pairs: counts[b],
    })
  }

  return {
    bins, totalPairs, lagWidthM: lagWidth, maxLagM: maxLag,
    directionDeg, toleranceDeg, sampleCount: n, tooFewSamples: false,
  }
}

// ---------------------------------------------------------------------------
// variogram model fitting
// ---------------------------------------------------------------------------

export type VariogramModel = 'spherical' | 'exponential' | 'gaussian'

export interface VariogramFit {
  model: VariogramModel
  nugget: number
  /** Total sill (nugget + partial sill) — the γ plateau. */
  sill: number
  /** For exponential/gaussian this is the PRACTICAL range (95 % of the sill). */
  range_m: number
  rmse: number
  /** True when the least-squares optimum sits at the search ceiling (the
   *  largest sampled lag) rather than strictly inside it — the semivariance
   *  was still rising at the edge of the sampled window, so `range_m` is a
   *  LOWER BOUND on the true decorrelation length, not a resolved point
   *  estimate. See the comment on the search domain in `fitOne` below. */
  rangeAtWindowLimit: boolean
}

/** Normalised structure functions, each rising 0 → 1. */
const SHAPES: Record<VariogramModel, (h: number, a: number) => number> = {
  spherical: (h, a) => (h >= a ? 1 : 1.5 * (h / a) - 0.5 * (h / a) ** 3),
  exponential: (h, a) => 1 - Math.exp((-3 * h) / a),
  gaussian: (h, a) => 1 - Math.exp((-3 * h * h) / (a * a)),
}

function fitOne(bins: VariogramBin[], model: VariogramModel): VariogramFit | null {
  if (bins.length < 4) return null
  const shape = SHAPES[model]
  const maxLag = bins[bins.length - 1].lag_m
  const minLag = bins[0].lag_m

  let best: VariogramFit | null = null
  let bestStep = 0
  const steps = 120
  for (let k = 1; k <= steps; k++) {
    // The range parameter `a` is searched only up to `maxLag` — the largest
    // lag the caller actually binned pairs for.
    //
    // This used to search up to `maxLag * 1.5`, on the theory that a model
    // could extrapolate a bit past the sampled window. In practice that let
    // `analyze_raster({operation:"variogram", max_lag_m:2000})` report a
    // fitted range of 2301 m: a "measured" correlation length 15% BEYOND the
    // 2000 m window it was fitted over, which is not something the data can
    // support — no pixel pair more than 2000 m apart was ever compared. A
    // range is not identifiable past the largest separation you sampled, so
    // the search domain is bounded there. When the semivariance is still
    // rising at `maxLag` (no plateau observed), the RMSE-optimal `a` lands
    // exactly on this ceiling — see `rangeAtWindowLimit` below, which flags
    // that case so `range_m` reads as a lower bound, not a confident point
    // estimate of the true range.
    const a = minLag + ((maxLag - minLag) * k) / steps
    // Pair-count-weighted OLS for γ = c0 + c·f(h).
    let sw = 0, swf = 0, swff = 0, swg = 0, swfg = 0
    for (const b of bins) {
      const f = shape(b.lag_m, a)
      const w = b.pairs
      sw += w; swf += w * f; swff += w * f * f
      swg += w * b.semivariance; swfg += w * f * b.semivariance
    }
    const det = sw * swff - swf * swf
    if (Math.abs(det) < 1e-12) continue
    let c0 = (swg * swff - swf * swfg) / det
    let c = (sw * swfg - swf * swg) / det
    // Clamp to physically meaningful values, re-solving the remaining 1-D problem.
    if (c < 0) { c = 0; c0 = swg / sw }
    if (c0 < 0) { c0 = 0; c = swff > 0 ? swfg / swff : 0 }

    let sse = 0
    for (const b of bins) {
      const e = b.semivariance - (c0 + c * shape(b.lag_m, a))
      sse += e * e
    }
    const rmse = Math.sqrt(sse / bins.length)
    if (!best || rmse < best.rmse) {
      best = { model, nugget: c0, sill: c0 + c, range_m: Math.round(a), rmse, rangeAtWindowLimit: false }
      bestStep = k
    }
  }
  if (best) best.rangeAtWindowLimit = bestStep >= steps
  return best
}

/** Fit one model, or `'auto'` to try all three and keep the lowest RMSE. */
export function fitVariogramModel(
  bins: VariogramBin[],
  model: VariogramModel | 'auto' = 'auto',
): VariogramFit | null {
  if (model !== 'auto') return fitOne(bins, model)
  const candidates = (['spherical', 'exponential', 'gaussian'] as const)
    .map((m) => fitOne(bins, m))
    .filter((f): f is VariogramFit => f !== null)
  if (candidates.length === 0) return null
  return candidates.reduce((a, b) => (b.rmse < a.rmse ? b : a))
}

// ---------------------------------------------------------------------------
// transect
// ---------------------------------------------------------------------------

export interface TransectPoint {
  distance_m: number
  lon: number
  lat: number
  value: number
}

export interface TransectResult {
  points: TransectPoint[]
  /** Total length of the requested line, metres. */
  length_m: number
  /** Samples requested. */
  requested: number
  /** Samples that landed on a pixel that was outside the polygon or clouded. */
  skipped: number
}

/** Metres between two lon/lat points, using the same planar approximation as the
 *  grid's own cell size — consistent by construction with `cellXm`/`cellYm`. */
function metersBetween(a: [number, number], b: [number, number]): number {
  const midLat = (a[1] + b[1]) / 2
  const dx = (b[0] - a[0]) * METERS_PER_DEG_LON_EQ * Math.cos((midLat * Math.PI) / 180)
  const dy = (b[1] - a[1]) * METERS_PER_DEG_LAT
  return Math.hypot(dx, dy)
}

/** Sample the grid at even intervals along a lon/lat polyline. Samples falling
 *  outside the polygon or on a clouded pixel are omitted and counted, never
 *  interpolated across — a gap in a profile is real information. */
export function computeTransect(
  g: AnalysisGrid,
  line: Array<[number, number]>,
  samples = 100,
): TransectResult {
  const n = Math.max(2, Math.min(500, Math.round(samples)))
  if (!Array.isArray(line) || line.length < 2) {
    throw new Error('transect needs a line with at least two [lon, lat] positions')
  }

  const segLens = line.slice(1).map((p, i) => metersBetween(line[i], p))
  const total = segLens.reduce((a, b) => a + b, 0)
  if (!(total > 0)) throw new Error('transect line has zero length')

  const [minLng, minLat, maxLng, maxLat] = g.bbox
  const out: TransectPoint[] = []
  let skipped = 0

  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1)
    // Walk the segments to find the position at `target` metres along the line.
    let acc = 0
    let si = 0
    while (si < segLens.length - 1 && acc + segLens[si] < target) {
      acc += segLens[si]
      si++
    }
    const t = segLens[si] > 0 ? Math.min(1, (target - acc) / segLens[si]) : 0
    const lon = line[si][0] + (line[si + 1][0] - line[si][0]) * t
    const lat = line[si][1] + (line[si + 1][1] - line[si][1]) * t

    // Half-open bins: a coordinate exactly on the north/east edge indexes one
    // past the last pixel, so fold it back rather than dropping a real sample.
    let col = Math.floor(((lon - minLng) / (maxLng - minLng)) * g.width)
    let row = Math.floor(((maxLat - lat) / (maxLat - minLat)) * g.height)
    if (col === g.width) col = g.width - 1
    if (row === g.height) row = g.height - 1
    if (col < 0 || row < 0 || col >= g.width || row >= g.height) {
      skipped++
      continue
    }
    const i = row * g.width + col
    if (!usable(g, i)) {
      skipped++
      continue
    }
    out.push({ distance_m: Math.round(target), lon, lat, value: g.values[i] })
  }

  return { points: out, length_m: total, requested: n, skipped }
}

// ---------------------------------------------------------------------------
// correlate
// ---------------------------------------------------------------------------

export interface CorrelationResult {
  pearson: number
  spearman: number
  /** Pixels usable in BOTH grids. */
  n: number
  slope: number
  intercept: number
  /** A thinned scatter for plotting — never the full pixel array. */
  scatter: Array<{ x: number; y: number }>
}

/** Ranks with ties averaged (needed for Spearman on quantised rasters). */
function ranks(v: number[]): number[] {
  const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0])
  const r = new Array<number>(v.length)
  let i = 0
  while (i < idx.length) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++
    const avg = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg
    i = j + 1
  }
  return r
}

function pearsonOf(xs: number[], ys: number[]): number {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy
  }
  if (sxx === 0 || syy === 0) return 0
  return sxy / Math.sqrt(sxx * syy)
}

/** Relationship between two co-registered grids over pixels usable in both.
 *  Throws on a shape mismatch rather than comparing unaligned pixels. */
export function computeCorrelation(a: AnalysisGrid, b: AnalysisGrid): CorrelationResult | null {
  sameShape(a, b)
  const xs: number[] = []
  const ys: number[] = []
  const px = a.width * a.height
  for (let i = 0; i < px; i++) {
    if (!usable(a, i) || !usable(b, i)) continue
    xs.push(a.values[i]); ys.push(b.values[i])
  }
  const n = xs.length
  if (n < 3) return null

  const pearson = pearsonOf(xs, ys)
  const spearman = pearsonOf(ranks(xs), ranks(ys))

  const mx = xs.reduce((s, v) => s + v, 0) / n
  const my = ys.reduce((s, v) => s + v, 0) / n
  let sxy = 0, sxx = 0
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2 }
  const slope = sxx === 0 ? 0 : sxy / sxx
  const intercept = my - slope * mx

  const maxScatter = 400
  const stride = Math.max(1, Math.floor(n / maxScatter))
  const scatter: Array<{ x: number; y: number }> = []
  for (let i = 0; i < n; i += stride) scatter.push({ x: xs[i], y: ys[i] })

  return { pearson, spearman, n, slope, intercept, scatter }
}

// ---------------------------------------------------------------------------
// texture
// ---------------------------------------------------------------------------

export type TextureMetric = 'stddev' | 'range' | 'mad'

export interface TextureResult {
  /** Per-pixel texture as a grid, reusable by any other operation. */
  grid: AnalysisGrid
  stats: StatsResult
  window: number
  metric: TextureMetric
  /** Window side length on the ground, metres. */
  windowM: number
}

/** Minimum valid neighbours in a window before a texture value is computed.
 *  Two pixels give a degenerate spread; three is the floor for a real one. */
const MIN_WINDOW_PIXELS = 3

/** Moving-window heterogeneity. Windows with too few valid neighbours produce
 *  no value at all rather than a value derived from one or two pixels. */
export function computeTexture(
  g: AnalysisGrid,
  opts: { window?: number; metric?: TextureMetric } = {},
): TextureResult | null {
  const window = Math.round(opts.window ?? 3)
  const metric = opts.metric ?? 'stddev'
  if (window < 3 || window % 2 === 0) {
    throw new Error(`texture window must be an odd number ≥ 3 (got ${window})`)
  }
  const half = (window - 1) / 2

  const out = new Float64Array(g.width * g.height)
  const valid = new Uint8Array(g.width * g.height)
  const buf: number[] = []

  for (let r = 0; r < g.height; r++) {
    for (let c = 0; c < g.width; c++) {
      const i = r * g.width + c
      if (!usable(g, i)) continue
      buf.length = 0
      for (let dr = -half; dr <= half; dr++) {
        const rr = r + dr
        if (rr < 0 || rr >= g.height) continue
        for (let dc = -half; dc <= half; dc++) {
          const cc = c + dc
          if (cc < 0 || cc >= g.width) continue
          const k = rr * g.width + cc
          if (usable(g, k)) buf.push(g.values[k])
        }
      }
      if (buf.length < MIN_WINDOW_PIXELS) continue
      let v: number
      if (metric === 'range') {
        v = Math.max(...buf) - Math.min(...buf)
      } else {
        const m = buf.reduce((a, b) => a + b, 0) / buf.length
        v = metric === 'mad'
          ? buf.reduce((a, b) => a + Math.abs(b - m), 0) / buf.length
          : Math.sqrt(buf.reduce((a, b) => a + (b - m) * (b - m), 0) / buf.length)
      }
      out[i] = v
      valid[i] = 1
    }
  }

  const grid = makeGrid(out, valid, g.width, g.height, g.bbox, `${g.label ?? 'value'} ${metric}`)
  const stats = computeStats(grid)
  if (!stats) return null
  return {
    grid,
    stats,
    window,
    metric,
    windowM: Math.round(window * ((g.cellXm + g.cellYm) / 2)),
  }
}

// ---------------------------------------------------------------------------
// cluster
// ---------------------------------------------------------------------------

export interface ClusterResult {
  /** Cluster index per pixel; −1 where the pixel was not usable in every band. */
  assignments: Int32Array
  centroids: number[][]
  sizes: number[]
  iterations: number
  /** Within-cluster sum of squares. */
  inertia: number
  /** Pixels assigned. */
  count: number
  bands: string[]
}

/**
 * Deterministic k-means over one or more co-registered bands.
 *
 * Initialisation is quantile-based on the summed band value rather than random,
 * so the same AOI always yields the same zonation — a map that reshuffles
 * between identical requests is not an analysis. Empty clusters are dropped and
 * the real count reported; a returned cluster always has members.
 */
export function computeClusters(
  grids: AnalysisGrid[],
  k: number,
  opts: { maxIter?: number } = {},
): ClusterResult | null {
  if (grids.length === 0) return null
  for (let i = 1; i < grids.length; i++) sameShape(grids[0], grids[i])
  const kk = Math.max(2, Math.min(12, Math.round(k)))
  const maxIter = opts.maxIter ?? 60
  const dims = grids.length
  const px = grids[0].width * grids[0].height

  const idxs: number[] = []
  for (let i = 0; i < px; i++) {
    if (grids.every((g) => usable(g, i))) idxs.push(i)
  }
  if (idxs.length < kk) return null

  const pts = idxs.map((i) => grids.map((g) => g.values[i]))

  // Quantile init on the summed value — deterministic and spread across the range.
  const order = pts.map((p, i) => [p.reduce((a, b) => a + b, 0), i] as const)
    .sort((a, b) => a[0] - b[0])
  let centroids: number[][] = []
  for (let c = 0; c < kk; c++) {
    const pos = Math.min(order.length - 1, Math.floor(((c + 0.5) / kk) * order.length))
    centroids.push(pts[order[pos][1]].slice())
  }

  const assign = new Int32Array(pts.length).fill(-1)
  let iterations = 0
  for (; iterations < maxIter; iterations++) {
    let moved = false
    for (let p = 0; p < pts.length; p++) {
      let bestC = 0
      let bestD = Infinity
      for (let c = 0; c < centroids.length; c++) {
        let d = 0
        for (let dm = 0; dm < dims; dm++) {
          const diff = pts[p][dm] - centroids[c][dm]
          d += diff * diff
        }
        if (d < bestD) { bestD = d; bestC = c }
      }
      if (assign[p] !== bestC) { assign[p] = bestC; moved = true }
    }
    const sums = centroids.map(() => new Array(dims).fill(0))
    const counts = new Array(centroids.length).fill(0)
    for (let p = 0; p < pts.length; p++) {
      const c = assign[p]
      counts[c]++
      for (let dm = 0; dm < dims; dm++) sums[c][dm] += pts[p][dm]
    }
    for (let c = 0; c < centroids.length; c++) {
      if (counts[c] === 0) continue
      for (let dm = 0; dm < dims; dm++) centroids[c][dm] = sums[c][dm] / counts[c]
    }
    if (!moved) break
  }

  // Drop empty clusters and renumber — an empty cluster is not a zone.
  const used = new Map<number, number>()
  for (let p = 0; p < pts.length; p++) {
    if (!used.has(assign[p])) used.set(assign[p], used.size)
  }
  const finalCentroids: number[][] = []
  const sizes = new Array(used.size).fill(0)
  for (const [oldC, newC] of used) finalCentroids[newC] = centroids[oldC]

  const assignments = new Int32Array(px).fill(-1)
  let inertia = 0
  for (let p = 0; p < pts.length; p++) {
    const c = used.get(assign[p])!
    assignments[idxs[p]] = c
    sizes[c]++
    for (let dm = 0; dm < dims; dm++) inertia += (pts[p][dm] - finalCentroids[c][dm]) ** 2
  }

  return {
    assignments,
    centroids: finalCentroids,
    sizes,
    iterations,
    inertia,
    count: pts.length,
    bands: grids.map((g, i) => g.label ?? `band${i + 1}`),
  }
}

// ---------------------------------------------------------------------------
// change
// ---------------------------------------------------------------------------

export interface ChangeResult {
  /** Per-pixel `after − before`, valid only where BOTH dates were clear. */
  grid: AnalysisGrid
  stats: StatsResult
  increasedPct: number
  decreasedPct: number
  unchangedPct: number
  threshold: number
  /** Pixels clear on both dates, before any baseline restriction. */
  clearBoth: number
  /** The restriction applied (pixels whose BEFORE value was at least this), when one was. */
  baselineMin?: number
}

/** Fewest pixels a baseline-restricted change may rest on. Below about 30 observations a mean is
 *  dominated by one or two parcels, so no figure is reported rather than a fragile one. */
export const MIN_BASELINE_PIXELS = 30

/** Per-pixel difference between two co-registered dates, restricted to pixels
 *  clear in BOTH — the rule ISS-103 established for `detect_change`. */
export function computeChange(
  before: AnalysisGrid,
  after: AnalysisGrid,
  opts: { threshold?: number; baselineMin?: number } = {},
): ChangeResult | null {
  sameShape(before, after)
  const threshold = opts.threshold ?? 0
  const baselineMin = opts.baselineMin
  const px = before.width * before.height
  const values = new Float64Array(px)
  const valid = new Uint8Array(px)
  let up = 0, down = 0, same = 0, clearBoth = 0

  for (let i = 0; i < px; i++) {
    if (!usable(before, i) || !usable(after, i)) continue
    clearBoth++
    // Optional restriction to ground that had the property before the event (for example the
    // burnable, vegetated pixels): change on a surface that could not have changed that way is
    // not evidence, and averaging it in only dilutes the signal.
    if (baselineMin !== undefined && before.values[i] < baselineMin) continue
    const d = after.values[i] - before.values[i]
    values[i] = d
    valid[i] = 1
    if (d > threshold) up++
    else if (d < -threshold) down++
    else same++
  }

  const grid = makeGrid(values, valid, before.width, before.height, before.bbox,
    `Δ${after.label ?? 'value'}`)
  const stats = computeStats(grid)
  if (!stats) {
    if (baselineMin !== undefined && clearBoth > 0) {
      throw new Error(`none of the ${clearBoth} pixels clear on both dates had a ${before.label ?? 'value'} of at least ${baselineMin} on the before date, so there is no such ground to measure change on.`)
    }
    return null
  }
  const n = stats.count
  if (baselineMin !== undefined && n < MIN_BASELINE_PIXELS) {
    throw new Error(`only ${n} of ${clearBoth} pixels clear on both dates had a ${before.label ?? 'value'} of at least ${baselineMin} on the before date; fewer than ${MIN_BASELINE_PIXELS} is too few for a stable mean.`)
  }
  return {
    grid,
    stats,
    increasedPct: (up / n) * 100,
    decreasedPct: (down / n) * 100,
    unchangedPct: (same / n) * 100,
    threshold,
    clearBoth,
    baselineMin,
  }
}
