/** Cross-catalog de-duplication.
 *
 *  The same dataset is often published by several catalogs (Sentinel-2 L2A is on
 *  Planetary Computer, Earth Search, CDSE and Earth Engine). The registry keeps
 *  one entry per dataset and lists the other routes under `alternates`, so a
 *  search shows it once and stage 2 can pick whichever route is readable.
 *
 *  Three identity rules, strictest first. All err on the side of NOT merging: a
 *  missed merge shows a dataset twice; a wrong merge hides a different dataset.
 *   1. `ALIASES` - explicit, human-checked equivalences.
 *   2. Product codes - MODIS/VIIRS short names + collection version.
 *   3. Same normalised collection id on different STAC catalogs with similar titles.
 */

import type { DatasetAlternate, DatasetEntry } from './types'
import { sourcePriority } from './sources'

/** canonical key -> entry ids that are the same dataset. */
export const ALIASES: Record<string, string[]> = {
  's2-l2a': ['planetary-computer:sentinel-2-l2a', 'element84:sentinel-2-l2a', 'cdse:sentinel-2-l2a', 'gee:COPERNICUS/S2_SR_HARMONIZED'],
  's2-l1c': ['element84:sentinel-2-l1c', 'cdse:sentinel-2-l1c', 'gee:COPERNICUS/S2_HARMONIZED'],
  's1-grd': ['planetary-computer:sentinel-1-grd', 'element84:sentinel-1-grd', 'cdse:sentinel-1-grd', 'gee:COPERNICUS/S1_GRD'],
  'nasadem': ['planetary-computer:nasadem', 'gee:NASA/NASADEM_HGT/001'],
  'worldcover-v200': ['planetary-computer:esa-worldcover', 'gee:ESA/WorldCover/v200'],
  'jrc-gsw': ['planetary-computer:jrc-gsw', 'gee:JRC/GSW1_4/GlobalSurfaceWater'],
  'ms-buildings': ['planetary-computer:ms-buildings', 'microsoft-buildings:global-ml-footprints'],
  'hansen-gfc': ['hansen:global-forest-change', 'gee:UMD/hansen/global_forest_change_2025_v1_13'],
  'naip': ['planetary-computer:naip', 'element84:naip', 'gee:USDA/NAIP/DOQQ'],
  'daymet-na': ['planetary-computer:daymet-daily-na', 'gee:NASA/ORNL/DAYMET_V4'],
}

const ALIAS_LOOKUP: Map<string, string> = new Map(
  Object.entries(ALIASES).flatMap(([key, ids]) => ids.map((id) => [id, key] as const)),
)

const MCD_PRODUCTS = new Set(['12', '43', '44', '64'])

/** MODIS/VIIRS product identity: `mod13a1:061`, or null. */
export function productCodeKey(entry: Pick<DatasetEntry, 'id' | 'source'>): string | null {
  const local = entry.id.slice(entry.source.length + 1)
  // CMR / GEE style: MOD13A1_061, MODIS/061/MOD13A1, VNP46A2_2 ...
  const direct = local.match(/(?<![A-Za-z0-9])((?:MOD|MYD|MCD|VNP|VJ1)\d{2}[A-Z]\d[A-Z]?\d?)(?![A-Za-z0-9])/i)
  if (direct) {
    const code = direct[1].toLowerCase()
    const ver = local.match(/(?:_|\/|\.|-)0?(\d{1,3})(?:\.\d+)?(?:_|\/|$|-)/)?.[1]
    const v = (ver ?? '').padStart(3, '0')
    if (/^(mod|myd|mcd)/.test(code) && /^\d{3}$/.test(v)) return `${code}:${v}`
    return null
  }
  // Planetary Computer style: modis-13A1-061
  const pc = local.match(/^modis-(\d{2}[A-Za-z]\d[A-Za-z]?\d?)-(\d{3})$/i)
  if (pc) {
    const prefix = MCD_PRODUCTS.has(pc[1].slice(0, 2)) ? 'mcd' : 'mod'
    return `${prefix}${pc[1].toLowerCase()}:${pc[2]}`
  }
  return null
}

function normaliseLocalId(entry: DatasetEntry): string {
  return entry.id.slice(entry.source.length + 1).toLowerCase().replace(/[^a-z0-9]+/g, '')
}

const STOP = new Set(['the', 'of', 'and', 'for', 'a', 'an', 'data', 'dataset', 'product', 'v1', 'v2'])

function titleTokens(t: string): Set<string> {
  return new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)))
}

export function titleSimilarity(a: string, b: string): number {
  const A = titleTokens(a)
  const B = titleTokens(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

const STAC_LIKE = new Set(['planetary-computer', 'element84', 'landsatlook', 'cdse', 'eodc', 'openeo-cdse'])

/** Identity key for an entry, or null when it should never merge. */
export function identityKey(entry: DatasetEntry): string | null {
  const alias = ALIAS_LOOKUP.get(entry.id)
  if (alias) return `alias:${alias}`
  const code = productCodeKey(entry)
  if (code) return `product:${code}`
  if (STAC_LIKE.has(entry.source)) return `stacid:${normaliseLocalId(entry)}`
  return null
}

function mergeInto(primary: DatasetEntry, other: DatasetEntry): void {
  const alt: DatasetAlternate = { source: other.source, id: other.id, access: other.access }
  primary.alternates = [...(primary.alternates ?? []), alt, ...(other.alternates ?? [])]
  if (primary.resolution_m == null && other.resolution_m != null) primary.resolution_m = other.resolution_m
  if (!primary.variables.length && other.variables.length) primary.variables = other.variables
  for (const t of other.themes) if (primary.themes.length < 6 && !primary.themes.includes(t)) primary.themes.push(t)
  const kw = new Set(primary.keywords.map((k) => k.toLowerCase()))
  for (const k of other.keywords) if (primary.keywords.length < 16 && !kw.has(k.toLowerCase())) primary.keywords.push(k)
  for (const p of other.providers) if (primary.providers.length < 6 && !primary.providers.includes(p)) primary.providers.push(p)
  if (primary.license === 'various' && other.license !== 'various') primary.license = other.license
  if (!primary.temporal.start && other.temporal.start) primary.temporal = { ...other.temporal }
}

export interface DedupeResult {
  entries: DatasetEntry[]
  /** Number of entries folded into another as alternates. */
  merged: number
}

/**
 * Collapse duplicates. Input order is irrelevant; output is sorted by id so the
 * snapshot diff stays small between runs.
 */
export function dedupeEntries(input: DatasetEntry[]): DedupeResult {
  const groups = new Map<string, DatasetEntry[]>()
  const loose: DatasetEntry[] = []
  for (const e of input) {
    const key = identityKey(e)
    if (!key) { loose.push(e); continue }
    const g = groups.get(key)
    if (g) g.push(e)
    else groups.set(key, [e])
  }

  const out: DatasetEntry[] = [...loose]
  let merged = 0
  for (const [key, group] of groups) {
    if (group.length === 1) { out.push(group[0]); continue }
    group.sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source) || a.id.localeCompare(b.id))
    const clusters: DatasetEntry[][] = []
    for (const e of group) {
      // A bare id match is weak evidence; require the same title shape. Aliases
      // and product codes were already asserted by a human or a strict regex.
      const strict = key.startsWith('alias:') || key.startsWith('product:')
      const home = clusters.find((c) =>
        c[0].source !== e.source && c.every((x) => x.source !== e.source) &&
        (strict || titleSimilarity(c[0].title, e.title) >= 0.5))
      if (home) home.push(e)
      else clusters.push([e])
    }
    for (const c of clusters) {
      const [primary, ...rest] = c
      const copy: DatasetEntry = JSON.parse(JSON.stringify(primary))
      for (const r of rest) { mergeInto(copy, r); merged++ }
      out.push(copy)
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return { entries: out, merged }
}
