/** STAC catalog access — AWS Element84 Earth Search v1 (stable, no auth). */

import { cachedFetchJson, fetchWithRetry } from './cache'

/** STAC endpoint — AWS Element84 Earth Search v1 (stable, no auth required). */
export const STAC_SEARCH_URL = 'https://earth-search.aws.element84.com/v1/search'

/**
 * Element84 Earth Search now strictly validates the STAC `datetime` interval as
 * RFC3339: a bare `YYYY-MM-DD` is rejected with HTTP 400 ("datetime value is
 * invalid, does not match RFC3339 format"). Normalize a `start/end` interval (or a
 * single instant) so each present side carries a time component. Sides that already
 * bear a time, an empty side, or the open-ended `..` sentinel are left untouched.
 * Start → `T00:00:00Z`, end → `T23:59:59Z` (preserves the inclusive day range).
 */
export function toRfc3339Interval(datetime: string): string {
  const pad = (side: string, endOfDay: boolean): string => {
    const s = side.trim()
    if (s === '' || s === '..') return s
    if (s.includes('T')) return s
    return `${s}${endOfDay ? 'T23:59:59Z' : 'T00:00:00Z'}`
  }
  const slash = datetime.indexOf('/')
  if (slash === -1) return pad(datetime, false)
  return `${pad(datetime.slice(0, slash), false)}/${pad(datetime.slice(slash + 1), true)}`
}

/** Sentinel-2 / Landsat asset key resolver. Element84 uses lowercase keys (red, nir,
 *  swir16, lwir11) while some catalogs/aliases use B-band-number keys. Try both. */
export function pickAsset(item: any, keys: string[]): string | null {
  for (const k of keys) {
    const href = item?.assets?.[k]?.href
    if (typeof href === 'string' && href.length > 0) return href
  }
  return null
}

/** Returns the first key that exists as an asset on the STAC item (not the href, the key name).
 *  Used to build expressions for the titiler /stac/tiles/ endpoint where variable names
 *  must match the actual asset key names in the item (e.g. "nir", not "B08"). */
export function pickAssetKey(item: any, keys: string[]): string | null {
  for (const k of keys) {
    if (item?.assets?.[k]?.href) return k
  }
  return null
}

/** Canonical URL for a STAC item — required by the titiler /stac/tiles/ endpoint.
 *  Tries the item's self link first; falls back to constructing from collection + id. */
export function getStacItemHref(item: any): string | null {
  const self = (item?.links as any[] | undefined)?.find((l: any) => l.rel === 'self')
  if (typeof self?.href === 'string') return self.href
  const col = item?.collection as string | undefined
  const id = item?.id as string | undefined
  if (col && id) return `https://earth-search.aws.element84.com/v1/collections/${col}/items/${id}`
  return null
}

export const S2_ASSET_KEYS: Record<string, string[]> = {
  B02: ['B02', 'blue'],
  B03: ['B03', 'green'],
  B04: ['B04', 'red'],
  B08: ['B08', 'nir'],
  B8A: ['B8A', 'nir08'],
  B11: ['B11', 'swir16'],
  B12: ['B12', 'swir22'],
}

export const LANDSAT_THERMAL_KEYS = ['ST_B10', 'lwir11', 'lwir', 'thermal']

/** Query Microsoft Planetary Computer STAC (free, no auth — separate from Element84).
 *  Use for PC-hosted datasets: JRC GSW, NOAA, USGS, etc. Cached 60 min. */
export async function searchPCStac(
  bbox: number[],
  collection: string,
  limit = 1,
  query?: Record<string, any>,
  /** STAC datetime interval (`start/end`, RFC 3339 or bare days); absent = no date filter. */
  datetime?: string,
): Promise<{ features: any[] }> {
  const body: any = { collections: [collection], bbox, limit }
  if (datetime) body.datetime = toRfc3339Interval(datetime)
  if (query || datetime) {
    if (query) body.query = query
    // When filtering (e.g. by cloud cover), return newest first so limit=1 is the best recent scene.
    body.sortby = [{ field: 'properties.datetime', direction: 'desc' }]
  }
  // `limit` participates in the key: without it, a caller asking for 5 candidates
  // could be served a cached 1-item response from an earlier call.
  const cacheKey = `pc-stac:${collection}:${JSON.stringify(bbox)}:${limit}:${query ? JSON.stringify(query) : ''}${datetime ? `:${datetime}` : ''}`
  return cachedFetchJson(cacheKey, { source: 'pc-stac' }, async () => {
    const res = await fetchWithRetry('https://planetarycomputer.microsoft.com/api/stac/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`PC STAC HTTP ${res.status}`)
    return res.json()
  }) as Promise<{ features: any[] }>
}

/** Sign a Planetary Computer asset URL via the public SAS signing endpoint.
 *  The returned signed URL is valid for ~1 hour. Cached for 45 min per base URL. */
export async function signPCAsset(unsignedHref: string): Promise<string> {
  const base = unsignedHref.split('?')[0]
  const cacheKey = `pc-sign:${base}`
  const result = await cachedFetchJson(cacheKey, { source: 'pc-sign', persist: true }, async () => {
    const url = `https://planetarycomputer.microsoft.com/api/sas/v1/sign?href=${encodeURIComponent(unsignedHref)}`
    const res = await fetchWithRetry(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`PC signing HTTP ${res.status}`)
    return res.json()
  })
  return (result as any).href as string
}

/** Search STAC catalog (AWS Element84 Earth Search) for items in a collection.
 *  Cached for 10 minutes (read-only, idempotent). */
export async function searchPlanetaryComputer(
  bbox: number[],
  collection: string,
  maxCloudCover: number = 30,
  dateStart?: string,
  dateEnd?: string,
): Promise<{ features: any[] }> {
  const end = dateEnd ?? new Date().toISOString().split('T')[0]
  const start = dateStart ?? new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]
  const body: any = {
    collections: [collection],
    bbox,
    datetime: toRfc3339Interval(`${start}/${end}`),
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    limit: 3,
  }
  if (maxCloudCover > 0) body.query = { 'eo:cloud_cover': { lt: maxCloudCover } }

  const cacheKey = `stac:${collection}:${JSON.stringify(body)}`
  return cachedFetchJson(cacheKey, { source: 'stac' }, async () => {
    const res = await fetchWithRetry(STAC_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`STAC search failed: HTTP ${res.status}`)
    return res.json()
  }) as Promise<{ features: any[] }>
}
