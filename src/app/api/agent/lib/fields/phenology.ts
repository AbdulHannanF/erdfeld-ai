/** Phenology classification of a regional NDVI time series.
 *
 *  This labels the SHAPE of the season (when it peaks, how many times, how much it
 *  swings). It does not and cannot name a crop: wheat and mustard share a winter
 *  profile, rice and maize a summer one. Naming crops needs ground truth.
 */

export type PhenClass =
  | 'winter_crop'
  | 'summer_crop'
  | 'double_crop'
  | 'seasonal_other'
  | 'perennial'
  | 'fallow_sparse'
  | 'non_field'
  | 'unknown'

export interface Phenology {
  cls: PhenClass
  label: string
  /** Scene dates (ISO) at which a qualifying seasonal peak was observed. */
  peakDates: string[]
  peaks: number
  maxNdvi: number | null
  minNdvi: number | null
  meanNdvi: number | null
  amplitude: number | null
  /** Median regional NDBI across clear dates; null when no NDBI was supplied. */
  medianNdbi: number | null
}

export const NON_FIELD_MAX_NDVI = 0.3
/** Built-up test. NDBI = (SWIR1 − NIR)/(SWIR1 + NIR) is positive over impervious surfaces
 *  and negative over vegetation (Zha et al. 2003), so the standard cut is NDBI > 0. Bare
 *  soil can also sit near zero, which is why the cut is applied to the MEDIAN across clear
 *  dates AND requires no seasonal vegetation swing: built surfaces keep a flat, low NDVI
 *  year-round (amplitude < 0.2), whereas fallow fields green up after rain or irrigation
 *  and a crop's bare-soil dates do not move its median above 0. */
export const BUILT_MIN_MEDIAN_NDBI = 0
export const BUILT_MAX_NDVI_AMPLITUDE = 0.2
/** Open water absorbs NIR: NDVI < 0 on essentially every clear date (McFeeters 1996). */
export const WATER_MAX_MEDIAN_NDVI = 0
const MIN_PEAK_NDVI = 0.4
const MIN_PROMINENCE = 0.15

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Class-level labels. Winter/summer are the LOCAL cool/warm-season crops, so the month
 *  windows flip in the southern hemisphere; "rabi/kharif" are monsoon-Asia terms and are
 *  only used north of the equator. */
export function classLabels(lat: number): Record<PhenClass, string> {
  const north = lat >= 0
  return {
    winter_crop: north ? 'winter (rabi) crop — peak Jan–Apr' : 'winter crop — peak Jul–Oct',
    summer_crop: north ? 'summer (kharif) crop — peak Jul–Oct' : 'summer crop — peak Jan–Apr',
    double_crop: 'double-cropped',
    seasonal_other: north ? 'seasonal crop — peak May–Jun / Nov–Dec' : 'seasonal crop — peak Nov–Dec / May–Jun',
    perennial: 'perennial / orchard / trees',
    fallow_sparse: 'fallow / sparse',
    non_field: 'non-field (bare/built/water)',
    unknown: 'unclassified (too few clear observations)',
  }
}

export const CLASS_COLORS: Record<PhenClass, string> = {
  // categorical palette (src/lib/categorical-palette.ts): colour-blind safe, no brand teal
  winter_crop: '#0072B2',
  summer_crop: '#D55E00',
  double_crop: '#CC79A7',
  seasonal_other: '#F0E442',
  perennial: '#8B3343',
  fallow_sparse: '#56B4E9',
  non_field: '#6b7280',
  unknown: '#e5e7eb',
}

export const CLASS_ORDER: PhenClass[] = [
  'winter_crop', 'summer_crop', 'double_crop', 'seasonal_other', 'perennial', 'fallow_sparse', 'non_field', 'unknown',
]

/** Linear interpolation across NaN gaps in time; edge gaps take the nearest value. */
function fillGaps(t: number[], y: number[]): number[] | null {
  const idx = y.map((v, i) => (Number.isFinite(v) ? i : -1)).filter((i) => i >= 0)
  if (idx.length < 3) return null
  return y.map((v, i) => {
    if (Number.isFinite(v)) return v
    let lo = -1, hi = -1
    for (const k of idx) { if (k < i) lo = k; else if (k > i) { hi = k; break } }
    if (lo < 0) return y[hi]
    if (hi < 0) return y[lo]
    const f = (t[i] - t[lo]) / (t[hi] - t[lo])
    return y[lo] + f * (y[hi] - y[lo])
  })
}

/** Indices of qualifying peaks: high enough, and prominent against both neighbouring
 *  troughs (an edge peak is judged against the one side it has). */
export function findPeaks(y: number[]): number[] {
  const out: number[] = []
  const n = y.length
  for (let i = 0; i < n; i++) {
    if (y[i] < MIN_PEAK_NDVI) continue
    if (i > 0 && !(y[i] > y[i - 1])) continue // first sample of a plateau only
    if (i < n - 1 && !(y[i] >= y[i + 1])) continue
    let left = Infinity
    for (let j = i - 1; j >= 0 && y[j] <= y[i]; j--) left = Math.min(left, y[j])
    let right = Infinity
    for (let j = i + 1; j < n && y[j] <= y[i]; j++) right = Math.min(right, y[j])
    const base = left === Infinity ? right : right === Infinity ? left : Math.max(left, right)
    if (base === Infinity) continue
    if (y[i] - base >= MIN_PROMINENCE) out.push(i)
  }
  return out
}

const median = (v: number[]): number | null => {
  const a = v.filter((x) => Number.isFinite(x)).sort((p, q) => p - q)
  return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null
}

export function classifyProfile(dates: string[], values: number[], lat: number, ndbi?: number[]): Phenology {
  const labels = classLabels(lat)
  const t = dates.map((d) => Date.parse(`${d}T00:00:00Z`) / 86_400_000)
  const y = fillGaps(t, values)
  if (!y) {
    return { cls: 'unknown', label: labels.unknown, peakDates: [], peaks: 0, maxNdvi: null, minNdvi: null, meanNdvi: null, amplitude: null, medianNdbi: null }
  }
  const max = Math.max(...y), min = Math.min(...y)
  const mean = y.reduce((a, b) => a + b, 0) / y.length
  const amplitude = max - min
  const medianNdbi = ndbi ? median(ndbi) : null
  const stats = { maxNdvi: max, minNdvi: min, meanNdvi: mean, amplitude, medianNdbi }

  const medianNdvi = median(values)
  const built = medianNdbi !== null && medianNdbi > BUILT_MIN_MEDIAN_NDBI && amplitude < BUILT_MAX_NDVI_AMPLITUDE
  if (max < NON_FIELD_MAX_NDVI || built || (medianNdvi !== null && medianNdvi < WATER_MAX_MEDIAN_NDVI)) {
    return { cls: 'non_field', label: labels.non_field, peakDates: [], peaks: 0, ...stats }
  }
  if (min >= 0.4 && mean >= 0.5 && amplitude < 0.25) {
    return { cls: 'perennial', label: labels.perennial, peakDates: [], peaks: 0, ...stats }
  }

  const peakIdx = findPeaks(y)
  const peakDates = peakIdx.map((i) => dates[i])
  if (peakIdx.length >= 2) {
    const where = peakDates.map((d) => MONTHS[Number(d.slice(5, 7)) - 1]).join(', ')
    return { cls: 'double_crop', label: `${labels.double_crop} (peaks ≈ ${where})`, peakDates, peaks: peakIdx.length, ...stats }
  }
  if (peakIdx.length === 1) {
    const month = Number(peakDates[0].slice(5, 7)) // 1..12 (real calendar month)
    const local = lat >= 0 ? month : ((month + 5) % 12) + 1 // season-shifted so "winter" is the local cool season
    const cls: PhenClass = local <= 4 ? 'winter_crop' : local >= 7 && local <= 10 ? 'summer_crop' : 'seasonal_other'
    return { cls, label: labels[cls], peakDates, peaks: 1, ...stats }
  }
  return { cls: 'fallow_sparse', label: labels.fallow_sparse, peakDates: [], peaks: 0, ...stats }
}

/** 0–1 confidence: how clearly the region stands apart from its neighbours relative to how
 *  uniform its own interior is, discounted for gaps in its time series. */
export function regionConfidence(contrast: number | null, sd: number, validDateFrac: number): number {
  let c: number
  if (contrast === null) {
    c = Math.max(0, 1 - sd / 0.1) * 0.8
  } else {
    const ratio = contrast / (sd + 1e-3)
    c = 1 - Math.exp(-ratio / 3)
  }
  return Math.max(0, Math.min(1, c * (0.6 + 0.4 * validDateFrac)))
}
