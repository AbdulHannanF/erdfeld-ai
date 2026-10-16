/** Which reader serves a registry entry. Pure (no I/O) so `find_dataset` can say, per hit,
 *  whether `use_dataset` can read it, needs credentials, or cannot read it in-app yet. */

import type { AuthKind, DatasetEntry } from '../types'

export type ReaderRoute =
  | 'stac'
  | 'lidar-derived' // 3DEP lidar COG derivatives on Planetary Computer (HAG / DSM / DTM / ...)
  | 'lidar-pointcloud' // 3DEP COPC / EPT / OpenTopography surveys: metadata only
  | 'earthengine'
  | 'rest-tool' // routed to an existing dedicated tool
  | 'rest-other'
  | 'geoparquet'
  | 'unavailable'

/** Entry id -> existing tool (and the reason the tool is the right reader). */
export const REST_TOOLS: Record<string, string> = {
  'open-meteo:era5-archive': 'fetch_weather_history',
  'nasa-firms:active-fires': 'fetch_active_fires',
}

const LIDAR_DERIVED = /^planetary-computer:3dep-lidar-(hag|dsm|dtm|dtm-native|intensity|classification|returns|pointsourceid)$/

export function routeFor(entry: DatasetEntry): ReaderRoute {
  const id = entry.id
  if (LIDAR_DERIVED.test(id)) return 'lidar-derived'
  if (id === 'planetary-computer:3dep-lidar-copc' || entry.source === 'opentopography' || entry.access.kind === 'ept') return 'lidar-pointcloud'
  if (REST_TOOLS[id]) return 'rest-tool'
  switch (entry.access.kind) {
    case 'stac-cog': case 'stac-other': return 'stac'
    case 'earthengine': return 'earthengine'
    case 'geoparquet': return 'geoparquet'
    case 'rest': case 'tiles': return 'rest-other'
    default: return 'unavailable' // stac-zarr, zarr, openeo, cog (static file stores)
  }
}

/** Env vars that satisfy each auth kind, first one is the documented name. */
export const AUTH_ENV: Record<AuthKind, string[]> = {
  earthdata: ['EARTHDATA_TOKEN'],
  earthengine: ['GEE_KEY_FILE', 'GEE_SERVICE_ACCOUNT_KEY'],
  copernicus: ['CDSE_TOKEN'],
  opentopography: ['OPENTOPO_API_KEY', 'OPENTOPOGRAPHY_API_KEY'],
  'api-key': ['FIRMS_MAP_KEY', 'GFW_API_KEY', 'OPENAQ_API_KEY'],
}

export interface Readability {
  state: 'readable' | 'auth' | 'info-only' | 'unavailable'
  /** One short phrase for the `find_dataset` hit line. */
  note: string
}

/** What `use_dataset({dataset_id})` will do for this entry (without running anything). */
export function readability(entry: DatasetEntry, haveAuth: (k: AuthKind) => boolean): Readability {
  const route = routeFor(entry)
  const need = entry.access.requires_auth
  switch (route) {
    case 'unavailable':
      return { state: 'unavailable', note: unavailableReason(entry) }
    case 'lidar-pointcloud':
      return { state: 'info-only', note: 'point cloud: returns real metadata and coverage only (no in-app point-cloud renderer); read the derived rasters instead' }
    case 'rest-tool':
      return { state: 'readable', note: 'routed to the dedicated GeoAgent tool' }
    case 'rest-other':
      return need && !haveAuth(need)
        ? { state: 'auth', note: `needs ${need} credentials, and no in-app reader for this REST endpoint exists yet` }
        : { state: 'unavailable', note: 'REST endpoint with no wired in-app reader' }
    case 'earthengine':
      return haveAuth('earthengine')
        ? { state: 'readable', note: 'read via Earth Engine' }
        : { state: 'auth', note: 'needs Earth Engine credentials (GEE_KEY_FILE), not configured here' }
    default:
      return need && !haveAuth(need)
        ? { state: 'auth', note: `needs ${need} credentials for pixels; returns real granule/metadata facts without them` }
        : { state: 'readable', note: 'readable now' }
  }
}

export function unavailableReason(entry: DatasetEntry): string {
  switch (entry.access.kind) {
    case 'stac-zarr': case 'zarr': return 'Zarr store: needs the Python geo service (queue Q-22)'
    case 'openeo': return 'openEO back end: needs an openEO account / the Python geo service'
    case 'cog': return 'static file store with no index: not readable in-app yet'
    default: return 'no in-app reader for this access kind yet'
  }
}
