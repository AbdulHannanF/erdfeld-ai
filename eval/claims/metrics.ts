/** Evaluation metrics for a claim recipe. Pure. A row is one plot: its Hansen label and the
 *  verdict (with confidence) the recipe gave. "Answered" means Supported or Contradicted;
 *  Cannot determine is an abstention, never counted right or wrong. */

export interface Row {
  id: string
  biome: string
  label: 'loss' | 'stable'
  split: string
  verdict: string
  confidence: number | null
  kind?: string
}

/** What the claim "not cleared since 2020-07-31" should be given each label. */
export const expectedVerdict = (label: Row['label']) => (label === 'loss' ? 'contradicted' : 'supported')

export interface Summary {
  n: number
  answered: number
  correct: number
  abstained: number
  errors: number
  /** answered / n */
  coverage: number
  /** abstained / n */
  abstention_rate: number
  /** correct / answered, null when nothing was answered. */
  accuracy: number | null
  accuracy_ci95: [number, number] | null
  /** Of loss plots answered, the share called Contradicted; of stable plots answered, Supported. */
  loss_recall: number | null
  stable_recall: number | null
  ece: number | null
}

/** Wilson score interval, 95%. */
export function wilson(k: number, n: number): [number, number] | null {
  if (n === 0) return null
  const z = 1.96
  const p = k / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)]
}

/** Expected calibration error over answered rows: equal-width confidence bins, the weighted mean
 *  of |accuracy - mean confidence|. */
export function ece(rows: Array<{ confidence: number; correct: boolean }>, bins = 5): number | null {
  if (!rows.length) return null
  let total = 0
  for (let b = 0; b < bins; b++) {
    const lo = b / bins
    const hi = (b + 1) / bins
    const inBin = rows.filter((r) => r.confidence >= lo && (b === bins - 1 ? r.confidence <= hi : r.confidence < hi))
    if (!inBin.length) continue
    const acc = inBin.filter((r) => r.correct).length / inBin.length
    const conf = inBin.reduce((s, r) => s + r.confidence, 0) / inBin.length
    total += (inBin.length / rows.length) * Math.abs(acc - conf)
  }
  return total
}

export function summarize(rows: Row[]): Summary {
  const errors = rows.filter((r) => r.verdict === 'error').length
  const scored = rows.filter((r) => r.verdict !== 'error')
  const answered = scored.filter((r) => r.verdict === 'supported' || r.verdict === 'contradicted')
  const isRight = (r: Row) => r.verdict === expectedVerdict(r.label)
  const correct = answered.filter(isRight).length
  const calib = answered.filter((r) => r.confidence != null).map((r) => ({ confidence: r.confidence!, correct: isRight(r) }))
  const recall = (label: Row['label']) => {
    const a = answered.filter((r) => r.label === label)
    return a.length ? a.filter(isRight).length / a.length : null
  }
  return {
    n: rows.length, answered: answered.length, correct, abstained: scored.length - answered.length, errors,
    coverage: scored.length ? answered.length / rows.length : 0,
    abstention_rate: rows.length ? (scored.length - answered.length) / rows.length : 0,
    accuracy: answered.length ? correct / answered.length : null,
    accuracy_ci95: wilson(correct, answered.length),
    loss_recall: recall('loss'), stable_recall: recall('stable'), ece: ece(calib),
  }
}

export function byBiome(rows: Row[]): Record<string, Summary> {
  return Object.fromEntries([...new Set(rows.map((r) => r.biome))].sort().map((b) => [b, summarize(rows.filter((r) => r.biome === b))]))
}
