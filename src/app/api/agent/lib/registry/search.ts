/** BM25 search over the dataset registry, with synonym expansion and hard filters.
 *
 *  Pure module (no I/O): build a `RegistryIndex` from entries once, query it many
 *  times. Index build is O(total tokens); a query touches only the posting lists
 *  of its terms, so a full-snapshot query runs in a few milliseconds.
 *
 *  Ranking = BM25F-style field-weighted term frequency (title > keywords > id >
 *  variables/themes > providers > description), weighted query terms (user words
 *  1.0, synonym expansions 0.45), a coordination factor so documents matching
 *  more of the user's own words win, a small theme-intent boost, and a rank boost
 *  for curated "golden" datasets.
 */

import type { AuthKind, DatasetEntry, Theme } from './types'
import { THEMES } from './types'
import { assignThemes } from './themes'
import { SYNONYM_RULES } from './synonyms'

// ---------------------------------------------------------------------------
// Tokenisation
// ---------------------------------------------------------------------------

const STOP = new Set([
  'the', 'a', 'an', 'of', 'for', 'in', 'on', 'at', 'to', 'and', 'or', 'with', 'by', 'from', 'is', 'are', 'was',
  'be', 'it', 'its', 'as', 'this', 'that', 'these', 'those', 'which', 'what', 'where', 'how', 'can', 'could',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'do', 'does', 'get', 'got', 'find', 'need', 'want', 'show',
  'give', 'look', 'looking', 'using', 'use', 'any', 'some', 'there', 'over', 'around', 'near', 'about',
  'please', 'should', 'would', 'than', 'then', 'into', 'out', 'up', 'has', 'have', 'had', 'will', 'not',
  'best', 'good', 'free', 'available', 'source', 'sources', 'datasets', 'dataset', 'data', 'map', 'maps',
  'layer', 'layers', 'product', 'products', 'info', 'information', 'across', 'per', 'all', 'one', 'based',
  'type', 'types', 'kind', 'like', 'such', 'also', 'more', 'most', 'many', 'much', 'very',
])

/** Plural / light stem so "buildings" matches "building" and "glaciers" "glacier". */
export function stem(w: string): string {
  if (w.length <= 3) return w
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`
  if (w.endsWith('sses')) return w.slice(0, -2)
  if (/(ss|us|is|ics)$/.test(w)) return w
  if (w.endsWith('ses') || w.endsWith('xes') || w.endsWith('zes') || w.endsWith('ches') || w.endsWith('shes')) return w.slice(0, -2)
  if (w.endsWith('s')) return w.slice(0, -1)
  return w
}

/**
 * Split on non-alphanumerics. Emits joined letter+digit pairs ("sentinel-2" ->
 * sentinel2) and digit+unit pairs ("30 m" -> 30m) so the same quantity matches
 * however it was typed. Single letters are dropped.
 */
export function tokenize(text: string, opts: { dropStop?: boolean } = {}): string[] {
  const parts = String(text ?? '')
    .toLowerCase()
    .replace(/(\d)\.(\d)/g, '$1$2') // pm2.5 -> pm25, 12.5km -> 125km
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    const next = parts[i + 1]
    const isDigits = /^\d+$/.test(p)
    if (isDigits && next && (next === 'm' || next === 'km' || next === 'cm')) {
      out.push(p + next)
      i++
      continue
    }
    // Radar band names: "L-band" -> lband (single letters are otherwise dropped).
    if (next === 'band' && /^(l|c|x|p|s|k|ku|ka)$/.test(p)) {
      out.push(`${p}band`)
      i++
      continue
    }
    if (!isDigits && next && /^\d{1,2}[a-z]?$/.test(next) && /^[a-z]+$/.test(p)) out.push(stem(p) + next)
    if (opts.dropStop && STOP.has(p)) continue
    if (p.length < 2) continue
    out.push(isDigits ? p : stem(p))
  }
  return out
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

const FIELD_WEIGHTS = {
  title: 4.0,
  keywords: 3.0,
  id: 2.5,
  variables: 1.6,
  themes: 1.8,
  providers: 1.2,
  description: 1.0,
} as const
type Field = keyof typeof FIELD_WEIGHTS

const K1 = 1.4
const B = 0.55

interface Posting { docs: Int32Array; tfs: Float32Array }

export interface SearchFilters {
  /** [minLon, minLat, maxLon, maxLat] of the area of interest. Global datasets always pass. */
  aoi?: [number, number, number, number]
  /** ISO dates (YYYY or YYYY-MM-DD accepted). A dataset with no stated start always passes. */
  time?: { start?: string; end?: string }
  /** Any-of. */
  themes?: Theme[]
  /** Keep datasets whose best resolution is this fine or finer. Unknown resolution passes unless `excludeUnknownResolution`. */
  maxResolutionM?: number
  excludeUnknownResolution?: boolean
  /** Auth kinds the caller can satisfy. Used to FLAG entries, never to hide them. */
  availableAuth?: AuthKind[]
  /** SPDX-ish ids (case-insensitive), or the pseudo-value 'open' for any open licence. */
  license?: string[]
}

export interface SearchOptions extends SearchFilters {
  limit?: number
}

export type CoverageVerdict = 'global' | 'covers' | 'partial' | 'unknown'

export interface SearchHit {
  entry: DatasetEntry
  score: number
  coverage: CoverageVerdict
  /** null = no auth needed; true/false = needed and (not) available to the caller. */
  authAvailable: boolean | null
  golden: boolean
}

export interface SearchResult {
  hits: SearchHit[]
  /** Candidates that matched the text before filters. */
  matched: number
  /** Passed all filters. */
  afterFilters: number
  /** True when the best hit is strong enough to answer without a live fallback. */
  confident: boolean
  expandedTerms: string[]
  /** Query words that appear nowhere in the registry (typos, invented terms). */
  unknownTerms: string[]
  queryThemes: Theme[]
}

const OPEN_LICENSE = /^(cc0|cc-by(-4\.0|-3\.0|-sa-4\.0)?|odc-by|odbl|pddl|public-domain|mit|apache-2\.0|cdla-permissive|eosdis-open|us-gov|ogl|etalab)/i

export function isOpenLicense(license: string): boolean {
  return OPEN_LICENSE.test(license.trim())
}

/** The registry answers on its own only when the best hit is strong and the question is not built on words it has never seen. */
export const CONFIDENT_SCORE = 12
/** At most this idf-weighted share of the question may be words the registry has never seen. */
export const MAX_UNKNOWN_SHARE = 0.34

export function isConfident(hits: Array<{ score: number }>, unknownShare: number): boolean {
  return hits.length > 0 && hits[0].score >= CONFIDENT_SCORE && unknownShare <= MAX_UNKNOWN_SHARE
}

export class RegistryIndex {
  readonly entries: DatasetEntry[]
  private postings = new Map<string, Posting>()
  private idf = new Map<string, number>()
  private goldenDocs: Uint8Array
  private goldenMask: Uint32Array
  private themeMask: Uint32Array
  private penalty: Float32Array
  // Reused per-query scratch buffers (search is synchronous, so this is safe).
  private scores: Float32Array
  private matchedIdf: Float32Array
  private touched: Int32Array

  constructor(entries: DatasetEntry[], golden: GoldenMap = {}) {
    this.entries = entries
    const N = entries.length
    const fieldLens: Record<Field, number[]> = {
      title: [], keywords: [], id: [], variables: [], themes: [], providers: [], description: [],
    }
    const docTokens: Array<Record<Field, string[]>> = []
    for (const e of entries) {
      const f: Record<Field, string[]> = {
        title: tokenize(e.title),
        keywords: tokenize(e.keywords.join(' ')),
        id: tokenize(e.id.slice(e.source.length + 1)),
        variables: tokenize(e.variables.map((v) => v.name).join(' ')),
        themes: e.themes.flatMap((t) => (t.includes('-') ? [t.replace(/-/g, ''), ...tokenize(t)] : tokenize(t))),
        providers: tokenize(e.providers.join(' ')),
        description: tokenize(e.description),
      }
      docTokens.push(f)
      for (const k of Object.keys(f) as Field[]) fieldLens[k].push(f[k].length)
    }
    const avg: Record<Field, number> = {} as any
    for (const k of Object.keys(fieldLens) as Field[]) {
      avg[k] = Math.max(1, fieldLens[k].reduce((a, b) => a + b, 0) / Math.max(1, N))
    }

    const df = new Map<string, number>()
    const building = new Map<string, number[]>()
    for (let d = 0; d < N; d++) {
      const acc = new Map<string, number>()
      const f = docTokens[d]
      for (const field of Object.keys(f) as Field[]) {
        const toks = f[field]
        if (!toks.length) continue
        const counts = new Map<string, number>()
        for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1)
        const norm = 1 - B + B * (toks.length / avg[field])
        for (const [t, c] of counts) acc.set(t, (acc.get(t) ?? 0) + (FIELD_WEIGHTS[field] * c) / norm)
      }
      for (const [t, tf] of acc) {
        let list = building.get(t)
        if (!list) building.set(t, (list = []))
        list.push(d, tf)
        df.set(t, (df.get(t) ?? 0) + 1)
      }
    }
    // Freeze posting lists into typed arrays: smaller and much faster to scan.
    for (const [t, flat] of building) {
      const n = flat.length / 2
      const docs = new Int32Array(n)
      const tfs = new Float32Array(n)
      for (let i = 0; i < n; i++) { docs[i] = flat[2 * i]; tfs[i] = flat[2 * i + 1] }
      this.postings.set(t, { docs, tfs })
    }
    for (const [t, n] of df) this.idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)))

    this.goldenDocs = new Uint8Array(N)
    this.goldenMask = new Uint32Array(N)
    this.themeMask = new Uint32Array(N)
    this.scores = new Float32Array(N)
    this.matchedIdf = new Float32Array(N)
    this.touched = new Int32Array(N)
    this.penalty = new Float32Array(N).fill(1)
    const idToDoc = new Map<string, number>()
    entries.forEach((e, i) => {
      for (const t of e.themes) this.themeMask[i] |= 1 << THEMES.indexOf(t)
      idToDoc.set(e.id, i)
      for (const a of e.alternates ?? []) idToDoc.set(a.id, i)
      // Per-survey records (OpenTopography) are many and narrow: rank them below
      // general datasets unless the question carries an AOI that selects them.
      if (e.source === 'opentopography') this.penalty[i] = 0.55
    })
    for (const [id, themes] of Object.entries(golden)) {
      const d = idToDoc.get(id)
      if (d === undefined) continue
      this.goldenDocs[d] = 1
      for (const t of themes) this.goldenMask[d] |= 1 << THEMES.indexOf(t)
    }
  }

  /** Golden entry ids that did not resolve (a registry/golden-list drift check). */
  static unresolvedGolden(entries: DatasetEntry[], golden: GoldenMap): string[] {
    const known = new Set<string>()
    for (const e of entries) { known.add(e.id); for (const a of e.alternates ?? []) known.add(a.id) }
    return Object.keys(golden).filter((id) => !known.has(id))
  }

  search(query: string, opts: SearchOptions = {}): SearchResult {
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 100))
    const { primary, expanded, themes } = expandQuery(query)
    const weights = new Map<string, number>()
    for (const t of primary) weights.set(t, 1)
    // Many expansion terms must not drown a specific word the user typed: share a fixed budget.
    // Expansion words that are common across the registry ("data", "land", "cover") add noise, not signal.
    const maxDf = Math.max(25, this.entries.length * 0.04)
    const usable = expanded.filter((t) => (this.postings.get(t)?.docs.length ?? 0) > 0 && (this.postings.get(t)?.docs.length ?? 0) <= maxDf)
    const expW = 0.45 * Math.min(1, Math.sqrt(10 / Math.max(1, usable.length)))
    for (const t of usable) if (!weights.has(t)) weights.set(t, expW)
    const primarySet = new Set(primary)

    const { scores, matchedIdf, touched } = this
    let nTouched = 0
    let idfTotal = 0
    // A word nobody in the registry uses counts as a MISS worth the maximum idf: "unicorn
    // population density" must not look like a complete match for "population density".
    const unknownIdf = Math.log(1 + this.entries.length)
    const unknownTerms: string[] = []
    for (const t of primarySet) {
      if (this.postings.has(t)) idfTotal += this.idf.get(t) ?? 0
      else { idfTotal += unknownIdf; unknownTerms.push(t) }
    }
    const unknownShare = idfTotal > 0 ? (unknownTerms.length * unknownIdf) / idfTotal : 0
    for (const [term, w] of weights) {
      const list = this.postings.get(term)
      if (!list) continue
      const rawIdf = this.idf.get(term) ?? 0
      const idf = rawIdf * w
      const isPrimary = primarySet.has(term)
      const { docs, tfs } = list
      for (let k = 0; k < docs.length; k++) {
        const doc = docs[k]
        const tf = tfs[k]
        if (scores[doc] === 0) touched[nTouched++] = doc
        scores[doc] += idf * ((tf * (K1 + 1)) / (tf + K1))
        if (isPrimary) matchedIdf[doc] += rawIdf
      }
    }

    const queryThemeSet = new Set<Theme>(opts.themes?.length ? [...themes, ...opts.themes] : themes)
    let qMask = 0
    for (const t of queryThemeSet) qMask |= 1 << THEMES.indexOf(t)

    // Top-`limit` by insertion into a short sorted array: O(touched) with a tiny constant.
    const top: Array<{ d: number; score: number; coverage: CoverageVerdict }> = []
    let afterFilters = 0
    for (let n = 0; n < nTouched; n++) {
      const d = touched[n]
      const base = scores[d]
      // idf-weighted coverage of the user's own words: matching the rare word counts more.
      const coord = idfTotal > 0 ? Math.min(1, matchedIdf[d] / idfTotal) : 1
      scores[d] = 0
      matchedIdf[d] = 0

      const e = this.entries[d]
      const coverage = coverageVerdict(e, opts.aoi)
      if (coverage === null || !passesFilters(e, opts)) continue
      afterFilters++

      let score = base * (0.55 + 0.45 * coord)
      if (qMask & this.themeMask[d]) score *= 1.12
      if (this.goldenDocs[d] === 1) {
        score *= 1.3
        if (qMask & this.goldenMask[d]) score *= 1.2
      }
      const pen = this.penalty[d]
      score *= pen === 1 || !opts.aoi ? pen : Math.min(1, pen * 1.6)
      if (!e.access.requires_auth) score *= 1.04

      if (top.length === limit && score <= top[top.length - 1].score) continue
      let pos = top.length
      while (pos > 0 && top[pos - 1].score < score) pos--
      top.splice(pos, 0, { d, score, coverage })
      if (top.length > limit) top.pop()
    }

    const hits: SearchHit[] = top.map((t) => ({
      entry: this.entries[t.d],
      score: t.score,
      coverage: t.coverage,
      authAvailable: authFlag(this.entries[t.d], opts.availableAuth),
      golden: this.goldenDocs[t.d] === 1,
    }))
    return {
      hits,
      matched: nTouched,
      afterFilters,
      confident: isConfident(hits, unknownShare),
      unknownTerms,
      expandedTerms: [...expanded],
      queryThemes: [...queryThemeSet],
    }
  }
}

export type GoldenMap = Record<string, Theme[]>

// ---------------------------------------------------------------------------
// Query expansion
// ---------------------------------------------------------------------------

/** A `when` entry is a phrase, or `a+b` meaning "both words appear anywhere in the query". */
const RULE_CACHE = SYNONYM_RULES.map((r) => ({
  when: r.when.map((p) => p.split('+').map((part) => tokenize(part).join(' ')).filter(Boolean)),
  add: r.add.flatMap((p) => tokenize(p)),
}))

export function expandQuery(query: string): { primary: string[]; expanded: string[]; themes: Theme[] } {
  const all = tokenize(query)
  const primary = tokenize(query, { dropStop: true })
  const joined = ` ${all.join(' ')} `
  const expanded = new Set<string>()
  for (const r of RULE_CACHE) {
    if (r.when.some((parts) => parts.length > 0 && parts.every((p) => joined.includes(` ${p} `)))) for (const t of r.add) expanded.add(t)
  }
  for (const t of primary) expanded.delete(t)
  const themes = assignThemes({ title: query }, 3)
  return { primary, expanded: [...expanded], themes }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** Longitude intervals of a bbox; a box with minLon > maxLon is split at the antimeridian. */
function lonIntervals(minLon: number, maxLon: number): Array<[number, number]> {
  return minLon <= maxLon ? [[minLon, maxLon]] : [[minLon, 180], [-180, maxLon]]
}

/** null = excluded by the AOI filter. */
export function coverageVerdict(e: DatasetEntry, aoi?: [number, number, number, number]): CoverageVerdict | null {
  if (e.spatial.global) return 'global'
  if (!aoi) return 'unknown'
  const [a0, a1, a2, a3] = aoi
  const [b0, b1, b2, b3] = e.spatial.bbox
  if (!(b1 <= a3 && b3 >= a1)) return null
  let intersects = false
  let covers = false
  for (const [lo, hi] of lonIntervals(b0, b2)) {
    if (lo <= a2 && hi >= a0) intersects = true
    if (lo <= a0 && hi >= a2) covers = true
  }
  if (!intersects) return null
  return covers && b1 <= a1 && b3 >= a3 ? 'covers' : 'partial'
}

function toTime(s: string | undefined, end: boolean): number | null {
  if (!s) return null
  const full = /^\d{4}$/.test(s) ? (end ? `${s}-12-31` : `${s}-01-01`) : /^\d{4}-\d{2}$/.test(s) ? (end ? `${s}-28` : `${s}-01`) : s
  const t = Date.parse(full)
  return Number.isFinite(t) ? t : null
}

export function overlapsTime(e: DatasetEntry, time?: { start?: string; end?: string }): boolean {
  if (!time || (!time.start && !time.end)) return true
  const qs = toTime(time.start, false)
  const qe = toTime(time.end, true)
  const ds = toTime(e.temporal.start ?? undefined, false)
  const de = toTime(e.temporal.end ?? undefined, true)
  if (ds !== null && qe !== null && ds > qe) return false
  if (de !== null && qs !== null && de < qs) return false
  return true
}

function passesFilters(e: DatasetEntry, f: SearchFilters): boolean {
  if (f.themes?.length && !e.themes.some((t) => f.themes!.includes(t))) return false
  if (f.maxResolutionM !== undefined) {
    if (e.resolution_m === null) { if (f.excludeUnknownResolution) return false }
    else if (e.resolution_m > f.maxResolutionM) return false
  }
  if (!overlapsTime(e, f.time)) return false
  if (f.license?.length) {
    const want = f.license.map((l) => l.toLowerCase())
    const lic = e.license.toLowerCase()
    const ok = want.some((w) => (w === 'open' ? isOpenLicense(e.license) : lic === w || lic.startsWith(w)))
    if (!ok) return false
  }
  return true
}

function authFlag(e: DatasetEntry, available?: AuthKind[]): boolean | null {
  const need = e.access.requires_auth
  if (!need) return null
  return !!available?.includes(need)
}

export { THEMES }
