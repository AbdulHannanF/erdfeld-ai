/** Grounding the written analysis in what the tools returned.
 *
 *  Two parts, both deterministic:
 *   - `groundingFacts`: a compact, structured line per result (scenes, dates, coverage, method,
 *     caveats, validation) that goes into the synthesis turn, so statements about data conditions
 *     have a source to be copied from instead of being filled in from plausibility;
 *   - `checkAnswerGrounding`: after the answer is written, every sentence with a number is checked
 *     for a `[[result_id#key]]` citation that exists and whose value matches the number. Sentences
 *     that fail are shown to the user as unverified; none are removed.
 */

import { failingChecks, type GeoResult } from '@/lib/geo-result'
import { parseCitations } from '@/lib/citations'

import type { ResultStore } from './types'

/** Stat keys that describe the data's condition rather than the finding. */
const CONDITION_KEY = /date|scene|clear|valid|cloud|coverage|count|resolution|n_obs|observations/i
const MAX_FACT_KEYS = 8

/** One line of facts for a result, copied from its envelope (never inferred). */
export function groundingFacts(result: GeoResult): string {
  const parts: string[] = [`status=${result.status}`]
  if (result.provenance.items.length) parts.push(`scenes/items=${result.provenance.items.slice(0, 6).join(', ')}${result.provenance.items.length > 6 ? ` (+${result.provenance.items.length - 6} more)` : ''}`)
  if (result.provenance.date) parts.push(`date=${result.provenance.date}`)
  parts.push(`method=${result.provenance.method.slice(0, 200)}`)
  const conditions = Object.entries(result.stats ?? {}).filter(([k, v]) => CONDITION_KEY.test(k) && !Array.isArray(v)).slice(0, MAX_FACT_KEYS)
  if (conditions.length) parts.push(conditions.map(([k, v]) => `${k}=${v}`).join(', '))
  const notes = result.uncertainty?.notes ?? []
  if (notes.length) parts.push(`caveats=${notes.slice(0, 3).map((n) => n.slice(0, 160)).join(' | ')}`)
  const flags = failingChecks(result.validation)
  parts.push(flags.length ? `validation=${flags.map((c) => c.message).join(' | ')}` : 'validation=passed')
  return `[facts: ${parts.join(' · ')}]`
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The check.
//
// A figure in the answer is UNVERIFIED only when all of these hold:
//   1. it is not cited, or its citation does not match;
//   2. it appears (within rounding) in none of the run's evidence: every tool result's structured
//      figures, its summary text, provenance, arguments and facts line, the user's question and the
//      plan's arguments; and it is not simple arithmetic on figures the sentence itself uses;
//   3. it is not a label rather than a claim: an ordinal or percentile name, a coordinate, a date, a
//      year, a duration or window, a band or sensor specification, a list marker.
// Clause 3 is about what the number IS, so it is matched by shape, not by a growing list of phrases.
// ---------------------------------------------------------------------------

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?'
const DAY = '\\d{1,2}(?:st|nd|rd|th)?(?!\\d)'

/** Text removed before numbers are read: what remains are the figures the sentence actually claims. */
const LABELS: RegExp[] = [
  /\[\[[^\]]*\]\]/g, // citations
  /`[^`]*`/g, // code spans (tool names, scene ids)
  /\b\d+(?:\.\d+){2,}\b/g, // version strings
  /\b(?:CC-BY(?:-SA)?|CC0|ODbL|MIT|Apache)-?\d*(?:\.\d+)?\b/g, // licence identifiers: "CC-BY-4.0"
  // class and threshold definitions rather than measurements: "NDWI ≤ 0", ">60% slope", "(<5%)", "(15-30% slope)", "the lower 25%"
  /[<>≤≥]=?\s*-?\d+(?:\.\d+)?%?/g,
  /\(\s*\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?\s*%?\s*(?:slope|gradient)?\s*\)/gi,
  /\b(?:lower|upper|bottom|top|first|last)\s+\d+%/gi,
  // dates: ISO, "13 September (2023)", "September 13, 2023", "August 1-31", "March 2031", times of day
  /\b\d{4}-\d{2}(?:-\d{2})?(?:[T ]\d{2}:\d{2}(?::\d{2})?Z?)?\b/g,
  new RegExp(`\\b${DAY}\\s+(?:of\\s+)?${MONTH}(?:\\s+\\d{4})?`, 'gi'),
  new RegExp(`\\b${MONTH}\\s+${DAY}(?:\\s*[-–]\\s*${DAY})?(?:,?\\s+\\d{4})?`, 'gi'),
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  // ordinals and percentile names: "2nd", "98th percentile", "p95", "p2-p98"
  /\b\d+(?:st|nd|rd|th)\b/gi,
  /\bp\d{1,2}\b/gi,
  // durations and windows: "6-day", "±30 days", "~45-day windows", "1-10 day look-back", "3- to 4-week"
  /[±~≈]?\s?\b\d+(?:\.\d+)?(?:\s*(?:-\s*to|-|–|to)\s*\d+(?:\.\d+)?)?[\s-]*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\b/gi,
  // coordinates: "13.5100°N", "-112.07°E", "lat 33.45", "lon: -112.07"
  /-?\d+(?:\.\d+)?\s?°\s?[NSEW]?/g,
  /\b(?:lat(?:itude)?|lon(?:gitude)?|lng)\b\s*[:=]?\s*-?\d+(?:\.\d+)?/gi,
  // band and sensor specifications: "B03", "Band 12", "red edge 2", "SWIR-2", wavelengths, "9-class", "3x3", "3D"
  /\b(?:B\d{1,2}A?|S\d[A-Z]?|L\d[A-Z]?|Sentinel-\d[A-Z]?|Landsat[- ]\d|EPSG:\d+|SWIR-?\d?|NIR-?\d?)\b/g,
  /\b(?:red\s+edge|swir|nir|bands?|steps?|rules?)\s*\d+(?:\s*(?:,|and|&|\/|-|–|to)\s*\d+)*\b/gi,
  /\b\d+(?:\.\d+)?\s?(?:nm|µm|μm|um|GHz|MHz)\b/gi,
  /\b\d+-class(?:es)?\b|\b\d+\s?[x×]\s?\d+\b|\b\d-?D\b/gi,
  // resolution stated next to its noun: "10 m resolution", "25 km grid cell", "sub-meter (<1 m) imagery"
  /[<≤~≈]?\s?\b\d+(?:\.\d+)?\s?-?\s?(?:m|km|meters?|metres?)\s+(?:resolution|pixels?|GSD|grid|cell|spatial|imagery|ground)/gi,
  /\b(?:resolution|pixel size|GSD)\s+(?:of\s+|about\s+|roughly\s+|approximately\s+)?[<≤~≈]?\s?\d+(?:\.\d+)?\s?(?:m|km|meters?|metres?)\b/gi,
  /\bsub-?met(?:er|re)s?\s*\(\s*[<≤]?\s?\d+(?:\.\d+)?\s?m\s*\)/gi,
  /(?<![\w.])\d+-m\b/gi,
]
/** Standard pixel sizes: exempt when the sentence is plainly about resolution. */
const STANDARD_GSD_M = new Set([0.3, 0.5, 1, 2, 3, 5, 10, 12.5, 15, 20, 25, 30, 60, 90, 250, 375, 500, 1000])
const RESOLUTION_CONTEXT = /\b(?:resolution|resolv\w*|pixels?|GSD|sensor|imagery|Sentinel|Landsat|MODIS|VIIRS|ERA5|DEM|raster|grid|scale)\b/i
const GSD_NUMBER = /[<≤~≈]?\s?(\d+(?:\.\d+)?)\s?-?\s?(?:m|km|meters?|metres?)\b(?!\s?[²2]|\s+(?:above|elevation|a\.s\.l))/gi
const NUMBER = /(?<![\w.])-?\d[\d,]*(?:\.\d+)?/g

export interface UnverifiedSentence {
  sentence: string
  reason: string
}

/** Result keys that hold a share of the area, whose complement is also a fact about it. */
const SHARE_KEY = /pct|percent|share|fraction|cover|clear|valid/i

const decimalsOf = (written: string) => Math.min(6, (written.split('.')[1] ?? '').length)

/** The figures in the evidence, so "is this number one of them, to the precision it was written?" is a scan.
 *  A figure is also kept as a percentage of a fraction, a fraction of a percentage, and (for a share between
 *  0 and 100) its complement; a numeric series also contributes its total. */
class FigurePool {
  private readonly values: number[] = []
  add(v: unknown, key = ''): void {
    if (typeof v === 'number') this.addNumber(v, SHARE_KEY.test(key))
    else if (typeof v === 'string') this.addText(v)
    else if (Array.isArray(v)) {
      v.forEach((x) => this.add(x, key))
      const series = v.map((x) => (typeof x === 'number' ? x : typeof x?.value === 'number' ? x.value : NaN))
      if (series.length > 1 && series.every(Number.isFinite)) this.addNumber(series.reduce((s, x) => s + x, 0))
    } else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => this.add(x, k))
  }
  addText(text: string): void {
    for (const m of text.matchAll(NUMBER)) {
      const n = Number(m[0].replace(/,/g, ''))
      if (Number.isFinite(n)) this.addNumber(n)
    }
  }
  addNumber(v: number, share = false): void {
    if (!Number.isFinite(v)) return
    const a = Math.abs(v) // unsigned: a date's "-07" is 7, and the sentence's own wording carries the sign
    this.values.push(a, a * 100, a / 100)
    if (share && a <= 100) this.values.push(100 - a) // what is left of a share: 94.62% clear leaves 5.38% unobserved
  }
  /** Written to its own number of decimals, either rounded (0.9125 -> 0.913) or truncated (0.9125 -> 0.912). */
  has(written: string, n: number): boolean {
    const unit = 10 ** -decimalsOf(written)
    const target = Math.abs(n)
    const eps = unit * 1e-6
    return this.values.some((x) => x - target >= -unit / 2 - eps && x - target < unit + eps)
  }
}

interface Claim { written: string; n: number }

/** The numbers in a sentence that carry a claim. */
function claimedNumbers(sentence: string): Claim[] {
  let text = sentence
    .replace(/^[\s*_#>-]*\d+[.)]/, ' ') // an ordered-list number, also one left alone by the sentence split ("**2.")
    .replace(/^\s*[-*]\s+/, '')
  const about = RESOLUTION_CONTEXT.test(sentence) || /\bB\d{1,2}A?\b/.test(sentence) // a band table lists its pixel sizes
  for (const re of LABELS) text = text.replace(re, ' ')
  if (about) {
    text = text.replace(GSD_NUMBER, (whole, num) => (STANDARD_GSD_M.has(Number(num)) ? ' ' : whole))
  }
  const out: Claim[] = []
  for (const m of text.matchAll(NUMBER)) {
    const written = m[0].replace(/,/g, '')
    const n = Number(written)
    if (!Number.isFinite(n) || n === 0) continue
    if (Number.isInteger(n) && n >= 1900 && n <= 2100) continue // a year
    out.push({ written, n })
  }
  return out
}

/** Does the cited `value` account for the figure as written? Allows rounding and a fraction shown as a percentage. */
function citedAccounts(value: unknown, key: string, c: Claim): boolean {
  const pool = new FigurePool()
  pool.add(value, key)
  // A cited series (monthly values) also stands behind the total of any run of consecutive entries: a season.
  if (Array.isArray(value)) {
    const series = value.map((x) => (typeof x === 'number' ? x : typeof x?.value === 'number' ? x.value : NaN))
    if (series.every(Number.isFinite)) {
      for (let i = 0; i < series.length; i++) {
        let sum = 0
        for (let j = i; j < series.length; j++) { sum += series[j]; pool.addNumber(sum) }
      }
    }
  }
  return pool.has(c.written, c.n)
}

/** Is the figure plain arithmetic on figures the sentence itself uses (a sum of cited months, a density
 *  from a count and an area, 100 minus a share)? Operands are the sentence's own, never the whole run's:
 *  across the whole pool nearly any small number would be "derived". */
function derived(c: Claim, operands: number[], cited: number[]): boolean {
  const pool = new FigurePool()
  const ops = [...new Set(operands.filter((x) => Number.isFinite(x)))]
  for (let i = 0; i < ops.length; i++) {
    const a = ops[i]
    for (let j = i + 1; j < ops.length; j++) {
      const b = ops[j]
      pool.addNumber(a + b); pool.addNumber(Math.abs(a - b)); pool.addNumber(a * b)
      if (b !== 0) pool.addNumber(a / b)
      if (a !== 0) pool.addNumber(b / a)
    }
  }
  for (const a of cited) if (a >= 0 && a <= 100) pool.addNumber(100 - a) // what is left of a cited share
  if (ops.length > 2) pool.addNumber(ops.reduce((s, x) => s + x, 0))
  return pool.has(c.written, c.n)
}

/** "N per km²": a count from the run divided by the area the run states. Only for a sentence that says "per". */
function perArea(c: Claim, sentence: string, counts: number[], areas: number[]): boolean {
  if (!/\bper\s+(?:km|square|hectare|ha)|\/\s?km|density/i.test(sentence)) return false
  const pool = new FigurePool()
  for (const a of areas) for (const n of counts) if (a > 0) pool.addNumber(n / a)
  return pool.has(c.written, c.n)
}

const numericOf = (v: unknown): number[] => {
  const p: number[] = []
  const walk = (x: unknown) => {
    if (typeof x === 'number') p.push(x)
    else if (Array.isArray(x)) x.forEach(walk)
    else if (x && typeof x === 'object') Object.values(x).forEach(walk)
  }
  walk(v)
  return p
}

/** Sentences with a figure that nothing in the run accounts for. Questions (follow-up suggestions) and
 *  sentences without figures are not checked. `known` are figures the run states as context (the drawn
 *  area's size); `texts` is the run's free text: tool summaries, provenance, arguments, facts lines, the
 *  user's question. */
export function checkAnswerGrounding(answer: string, store: ResultStore, known: number[] = [], texts: string[] = []): UnverifiedSentence[] {
  const evidence = new FigurePool()
  for (const r of store.values()) evidence.add(r.summary_data)
  for (const k of known) evidence.addNumber(k)
  for (const t of texts) evidence.addText(t)

  const runNumbers = [...store.values()].flatMap((r) => numericOf(r.summary_data))
  const areas = [...known, ...[...store.values()].flatMap((r) => numericOf(r.summary_data?.area_km2))]
  const flagged: UnverifiedSentence[] = []
  const sentences = answer.replace(/\n+/g, '\n').split(/(?<=[.!;])\s+(?=[A-Z*_[(\d])|\n/).map((s) => s.trim()).filter(Boolean)
  for (const sentence of sentences) {
    if (sentence.endsWith('?')) continue
    const claims = claimedNumbers(sentence)
    if (claims.length === 0) continue
    const cited = parseCitations(sentence)
    const values = cited.map((c) => store.get(c.resultId)?.summary_data?.[c.key])
    const unresolved = cited.filter((_, i) => values[i] === undefined)
    if (unresolved.length) {
      flagged.push({ sentence, reason: `cites ${unresolved.map((c) => c.raw).join(', ')}, which no tool result contains` })
      continue
    }
    const operands = [...values.flatMap(numericOf), ...claims.map((c) => c.n), ...known]
    const unmatched = claims.filter((c) =>
      !values.some((v, i) => citedAccounts(v, cited[i].key, c)) && !evidence.has(c.written, c.n) && !derived(c, operands.filter((x) => x !== c.n), values.flatMap(numericOf))
      && !perArea(c, sentence, runNumbers, areas))
    if (unmatched.length) {
      const list = unmatched.map((c) => c.written).join(', ')
      flagged.push({
        sentence,
        reason: cited.length === 0
          ? `${list} has no citation and appears in no tool result`
          : `${list} does not match the cited value${cited.length > 1 ? 's' : ''} and appears in no tool result`,
      })
    }
  }
  return flagged
}

/** The note appended to an answer that has unverified sentences. */
export function unverifiedNote(flagged: UnverifiedSentence[]): string {
  const lines = flagged.slice(0, 8).map((f) => `- ${f.sentence.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').slice(0, 240)} _(${f.reason})_`)
  const more = flagged.length > 8 ? `\n- …and ${flagged.length - 8} more.` : ''
  return `\n\n**Unverified statements.** These sentences contain figures that are not backed by a matching tool result, so treat them as unconfirmed:\n${lines.join('\n')}${more}`
}
