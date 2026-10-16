/** Phase 3 — dataset discovery (v2 spec §3.7).
 *
 *  > **Discovery tools.** `search_web` for context, and `find_dataset` federating
 *  > **STAC Index's 118 public catalogs** (verified live, no key) plus Planetary
 *  > Computer, Element84, and LandsatLook, so the agent can locate data it was
 *  > not pre-wired for.
 *
 *  Verified live 2026-08-10: STAC Index serves 118 catalogs (96 public, 58 of
 *  them APIs) with no key; Planetary Computer alone exposes 135 collections, of
 *  which **72 cover Lahore and have no dedicated GeoAgent tool**. Discovery is
 *  therefore not a nicety — most of the available Earth observation data is
 *  outside the 35 wired tools.
 *
 *  Ranking is deliberately strict. A search that always returns *something* is
 *  the ISS-107 pattern in a new place: it looks like it works because it never
 *  says no. So an unrelated collection scores zero and is dropped, and a
 *  collection whose spatial extent misses the AOI is dropped no matter how well
 *  its name matches.
 *
 *  Pure module: scoring and filtering only. Network lives in `catalogs.ts`.
 */

/** A STAC catalog we can query. */
export interface CatalogRef {
  id: string
  name: string
  /** Root URL of the STAC API (no trailing slash). */
  url: string
}

/** The parts of a STAC collection this module reads. */
export interface StacCollection {
  id: string
  title?: string
  description?: string
  keywords?: string[]
  license?: string
  extent?: {
    spatial?: { bbox?: number[][] }
    temporal?: { interval?: (string | null)[][] }
  }
  [k: string]: unknown
}

export interface CollectionCandidate {
  catalog: CatalogRef
  collection: StacCollection
}

export interface RankedCollection extends CollectionCandidate {
  score: number
  /** True when GeoAgent already has a dedicated tool for this data. */
  alreadyWired: boolean
}

/**
 * Collections GeoAgent already has a first-class tool for.
 *
 * Not a blocklist — these still surface, flagged — because "we already have a
 * better path for this" is useful information, and hiding them would make the
 * discovery result look thinner than reality.
 */
const WIRED_PATTERNS: RegExp[] = [
  /^sentinel-2/i,
  /^sentinel-1/i,
  /^landsat-c2/i,
  /esa-worldcover/i,
  /^jrc-gsw$/i,
]

export function isWiredAlready(collectionId: string): boolean {
  return WIRED_PATTERNS.some((re) => re.test(collectionId))
}

/** Does the collection's spatial extent contain any part of the AOI bbox? */
export function collectionCoversBbox(
  collection: StacCollection,
  bbox: [number, number, number, number],
): boolean {
  const boxes = collection.extent?.spatial?.bbox
  // A missing extent is unknown coverage, not global coverage. Assuming global
  // would let every malformed collection match every AOI.
  if (!Array.isArray(boxes) || boxes.length === 0) return false

  const [minLon, minLat, maxLon, maxLat] = bbox
  for (const b of boxes) {
    if (!Array.isArray(b) || b.length < 4) continue
    // STAC allows 6-element bboxes (with elevation); lon/lat are 0,1,-2,-1.
    const cMinLon = Number(b[0])
    const cMinLat = Number(b[1])
    const cMaxLon = Number(b[b.length - 2])
    const cMaxLat = Number(b[b.length - 1])
    if (![cMinLon, cMinLat, cMaxLon, cMaxLat].every(Number.isFinite)) continue
    const overlaps =
      cMinLon <= maxLon && cMaxLon >= minLon && cMinLat <= maxLat && cMaxLat >= minLat
    if (overlaps) return true
  }
  return false
}

/** Split a query into meaningful lower-case terms. */
function terms(query: string): string[] {
  return String(query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'in', 'on', 'at', 'to', 'and', 'or', 'with',
  'data', 'dataset', 'datasets', 'map', 'maps', 'show', 'me', 'find', 'get',
])

/** Whole-word (or hyphen-segment) presence, so "dem" never matches "demand". */
function hasTerm(haystack: string, term: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRe(term)}([^a-z0-9]|$)`, 'i').test(haystack)
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Relevance of a collection to a query. Zero means "not a match" — the caller
 * drops it rather than showing it as a weak result.
 *
 * Fields are weighted by how deliberate they are: an id or title match is a much
 * stronger signal than a word appearing somewhere in a long description.
 *
 * DEFECT 3 (2026-08-17): "unicorn population density" returned ten real
 * population-density STAC collections with nothing marking them as wrong.
 * The old `matched === 0 → 0` gate only caught a query with NO real term in
 * it at all (e.g. "quokka census", already covered by the tests below); it
 * did nothing for a query that mixes a real subject with a nonsense one —
 * "population" and "density" both hit a WorldPop-style collection at full
 * strength, "unicorn" matched nowhere, and the partial-coverage factor
 * (`matched / q.length` = 2/3) still left the score comfortably positive. A
 * collection that answers only PART of what was typed does not answer the
 * question, so every non-stopword term in the query must now be found
 * SOMEWHERE in the collection's metadata or the whole match is zero — see
 * the gate below. "land surface temperature" against a real LST collection
 * still matches all three terms and is unaffected (tested in find-dataset.test.ts).
 */
export function scoreCollection(collection: StacCollection, query: string): number {
  const q = terms(query)
  if (q.length === 0) return 0

  const id = String(collection.id ?? '')
  const title = String(collection.title ?? '')
  const desc = String(collection.description ?? '')
  const keywords = (collection.keywords ?? []).join(' ')

  let score = 0
  let matched = 0
  for (const t of q) {
    let best = 0
    if (hasTerm(id, t)) best = Math.max(best, 5)
    if (hasTerm(title, t)) best = Math.max(best, 4)
    if (hasTerm(keywords, t)) best = Math.max(best, 3)
    if (hasTerm(desc, t)) best = Math.max(best, 1)
    if (best > 0) matched++
    score += best
  }
  // Every meaningful query word must appear somewhere in the collection's
  // metadata. Partial coverage used to still score above zero (weighted by
  // `matched / q.length`), which is precisely what let a nonsense term ride
  // along with a real one and come back looking like a confident match.
  if (matched < q.length) return 0
  return score
}

/**
 * Rank candidates for a query over an AOI.
 *
 * Coverage is a hard filter, not a penalty: a US-only DEM is not a worse answer
 * for a Lahore AOI, it is not an answer at all.
 */
export function rankCollections(
  candidates: CollectionCandidate[],
  query: string,
  bbox: [number, number, number, number],
  limit = 12,
): RankedCollection[] {
  const out: RankedCollection[] = []
  for (const c of candidates) {
    if (!collectionCoversBbox(c.collection, bbox)) continue
    const score = scoreCollection(c.collection, query)
    if (score <= 0) continue
    out.push({ ...c, score, alreadyWired: isWiredAlready(c.collection.id) })
  }
  out.sort((a, b) => b.score - a.score || a.collection.id.localeCompare(b.collection.id))
  return out.slice(0, limit)
}

/** Human-readable spatial + temporal extent, for the report. */
export function summariseExtent(collection: StacCollection): string {
  const boxes = collection.extent?.spatial?.bbox
  let spatial = 'coverage not stated'
  if (Array.isArray(boxes) && boxes.length && Array.isArray(boxes[0])) {
    const b = boxes[0]
    const minLon = Number(b[0])
    const minLat = Number(b[1])
    const maxLon = Number(b[b.length - 2])
    const maxLat = Number(b[b.length - 1])
    spatial =
      minLon <= -179 && maxLon >= 179 && minLat <= -59 && maxLat >= 59
        ? 'global'
        : `${minLat.toFixed(1)}–${maxLat.toFixed(1)}°N, ${minLon.toFixed(1)}–${maxLon.toFixed(1)}°E`
  }

  const interval = collection.extent?.temporal?.interval?.[0]
  let temporal = ''
  if (Array.isArray(interval)) {
    const from = interval[0] ? String(interval[0]).slice(0, 10) : null
    const to = interval[1] ? String(interval[1]).slice(0, 10) : null
    if (from && to) temporal = `, ${from} to ${to}`
    else if (from) temporal = `, ${from} onwards`
    else if (to) temporal = `, up to ${to}`
  }
  return `${spatial}${temporal}`
}
