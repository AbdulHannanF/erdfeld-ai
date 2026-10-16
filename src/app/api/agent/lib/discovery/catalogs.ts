/** STAC catalog federation (v2 spec §3.7).
 *
 *  Verified live 2026-08-10, all key-free:
 *
 *  | source | result |
 *  |---|---|
 *  | STAC Index `/api/catalogs` | **118** catalogs — 96 public, 58 of them APIs |
 *  | Planetary Computer `/collections` | **135** collections |
 *  | Element84 Earth Search `/collections` | 9 |
 *  | USGS LandsatLook `/collections` | 18 |
 *
 *  Of Planetary Computer's 135, **72 cover the audit AOI and have no dedicated
 *  GeoAgent tool** — which is the whole argument for discovery: most available
 *  Earth observation data sits outside the wired tool list.
 *
 *  The three named catalogs lead because they are verified, fast and stable. The
 *  STAC Index list is breadth: many of its entries are static catalogs or dead
 *  hosts, so it is queried opportunistically and a failure there never fails the
 *  search.
 */

import { getLogger } from '../logger'
import { cachedFetchJson } from '../cache'
import type { CatalogRef, CollectionCandidate, StacCollection } from './find-dataset'

const log = getLogger('agent/discovery')

/** Catalogs verified live and queried first. */
export const KNOWN_CATALOGS: CatalogRef[] = [
  { id: 'planetary-computer', name: 'Microsoft Planetary Computer', url: 'https://planetarycomputer.microsoft.com/api/stac/v1' },
  { id: 'element84', name: 'Element 84 Earth Search', url: 'https://earth-search.aws.element84.com/v1' },
  { id: 'landsatlook', name: 'USGS LandsatLook', url: 'https://landsatlook.usgs.gov/stac-server' },
]

const STAC_INDEX_URL = 'https://stacindex.org/api/catalogs'

export interface StacIndexEntry {
  id: string
  url: string
  slug?: string
  title?: string
  summary?: string
  isPrivate?: boolean
  isApi?: boolean
}

/**
 * The STAC Index registry: every public catalog anyone has published.
 *
 * Only `isApi && !isPrivate` entries are usable here — a static catalog is a
 * tree of JSON files with no `/collections` endpoint to query.
 */
export async function fetchStacIndexCatalogs(): Promise<CatalogRef[]> {
  try {
    const raw = await cachedFetchJson<StacIndexEntry[]>(
      'stac-index:catalogs',
      { source: 'stac-index', ttlMs: 24 * 60 * 60_000, persist: true },
      async () => {
        const res = await fetch(STAC_INDEX_URL, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        })
        if (!res.ok) throw new Error(`STAC Index HTTP ${res.status}`)
        const json = await res.json()
        return Array.isArray(json) ? json : (json?.catalogs ?? [])
      },
    )
    const usable = (raw ?? []).filter((c) => c.isApi && !c.isPrivate && typeof c.url === 'string')
    log.info({ total: raw?.length ?? 0, usable: usable.length }, 'stac index catalogs')
    return usable.map((c) => ({
      id: c.slug || c.id,
      name: c.title || c.slug || c.id,
      url: c.url.replace(/\/+$/, ''),
    }))
  } catch (err: any) {
    log.warn({ err: err?.message }, 'STAC Index unavailable')
    return []
  }
}

/** Collections advertised by one catalog. Never throws. */
export async function fetchCollections(catalog: CatalogRef, timeoutMs = 25_000): Promise<StacCollection[]> {
  try {
    return await cachedFetchJson<StacCollection[]>(
      `stac-collections:${catalog.url}`,
      { source: 'stac-index', ttlMs: 6 * 60 * 60_000, persist: true },
      async () => {
        const res = await fetch(`${catalog.url}/collections`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        const cols = json?.collections ?? json
        return Array.isArray(cols) ? cols : []
      },
    )
  } catch (err: any) {
    log.info({ catalog: catalog.id, err: err?.message }, 'catalog unreachable')
    return []
  }
}

export interface GatherResult {
  candidates: CollectionCandidate[]
  /** Catalogs actually queried. */
  catalogsSearched: number
  /** Catalogs that failed or returned nothing. */
  catalogsUnreachable: number
  collectionsSeen: number
}

/**
 * Collect candidate collections across catalogs.
 *
 * The known-good three are always queried. `breadth` adds STAC Index catalogs,
 * capped and run concurrently — worth it for an unusual request, not worth 118
 * round-trips for "elevation".
 */
export async function gatherCandidates(opts: {
  breadth?: boolean
  maxIndexCatalogs?: number
  catalogs?: CatalogRef[]
} = {}): Promise<GatherResult> {
  const base = opts.catalogs ?? KNOWN_CATALOGS
  let all: CatalogRef[] = [...base]

  if (opts.breadth) {
    const extra = await fetchStacIndexCatalogs()
    const seen = new Set(all.map((c) => c.url))
    for (const c of extra) {
      if (all.length >= (opts.maxIndexCatalogs ?? 24) + base.length) break
      if (!seen.has(c.url)) { all.push(c); seen.add(c.url) }
    }
  }

  const results = await Promise.all(all.map(async (catalog) => ({
    catalog,
    collections: await fetchCollections(catalog),
  })))

  const candidates: CollectionCandidate[] = []
  let unreachable = 0
  for (const { catalog, collections } of results) {
    if (collections.length === 0) { unreachable++; continue }
    for (const collection of collections) {
      if (collection?.id) candidates.push({ catalog, collection })
    }
  }

  return {
    candidates,
    catalogsSearched: all.length,
    catalogsUnreachable: unreachable,
    collectionsSeen: candidates.length,
  }
}
