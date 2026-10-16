/** Catalog metadata shared by the harvester, the deduper and the tool layer. */

import type { AuthKind } from './types'

export interface SourceInfo {
  id: string
  name: string
  /** Root URL (STAC API root, REST base, or static catalog). */
  root: string
  /** True when the root is a STAC API that `use_dataset` can already search. */
  stacApi: boolean
  auth: AuthKind | null
  /** Lower number wins as the primary route when the same dataset is on several catalogs. */
  priority: number
}

export const SOURCES: SourceInfo[] = [
  { id: 'curated', name: 'Curated (hand-written, URL-verified)', root: '', stacApi: false, auth: null, priority: 0 },
  { id: 'planetary-computer', name: 'Microsoft Planetary Computer', root: 'https://planetarycomputer.microsoft.com/api/stac/v1', stacApi: true, auth: null, priority: 1 },
  { id: 'element84', name: 'Element 84 Earth Search (AWS)', root: 'https://earth-search.aws.element84.com/v1', stacApi: true, auth: null, priority: 2 },
  { id: 'landsatlook', name: 'USGS LandsatLook', root: 'https://landsatlook.usgs.gov/stac-server', stacApi: true, auth: null, priority: 3 },
  { id: 'eodc', name: 'EODC STAC (Austria)', root: 'https://stac.eodc.eu/api/v1', stacApi: true, auth: null, priority: 4 },
  { id: 'cdse', name: 'Copernicus Data Space STAC', root: 'https://stac.dataspace.copernicus.eu/v1', stacApi: true, auth: 'copernicus', priority: 5 },
  { id: 'openeo-cdse', name: 'Copernicus Data Space openEO', root: 'https://openeo.dataspace.copernicus.eu/openeo/1.2', stacApi: false, auth: 'copernicus', priority: 6 },
  { id: 'gee', name: 'Google Earth Engine catalog', root: 'https://storage.googleapis.com/earthengine-stac/catalog/catalog.json', stacApi: false, auth: 'earthengine', priority: 7 },
  { id: 'cmr', name: 'NASA CMR-STAC', root: 'https://cmr.earthdata.nasa.gov/stac', stacApi: true, auth: 'earthdata', priority: 8 },
  { id: 'gfw', name: 'Global Forest Watch data API', root: 'https://data-api.globalforestwatch.org', stacApi: false, auth: 'api-key', priority: 9 },
  { id: 'opentopography', name: 'OpenTopography catalog', root: 'https://portal.opentopography.org/API/otCatalog', stacApi: false, auth: 'opentopography', priority: 10 },
]

export function sourcePriority(id: string): number {
  return SOURCES.find((s) => s.id === id)?.priority ?? 50
}

export function sourceInfo(id: string): SourceInfo | undefined {
  return SOURCES.find((s) => s.id === id)
}

/** Notes shared by every entry of a source (stored once, not per entry). */
export const DEFAULT_NOTES: Record<string, string> = {
  'planetary-computer': 'Assets need a free SAS token from the PC data API (keyless signing); items via /search.',
  cdse: 'STAC search is public; downloads need a free Copernicus Data Space account (S3 keys or token).',
  cmr: 'NASA CMR-STAC; granule download needs a free Earthdata Login (bearer token or netrc). Asset formats vary (HDF5/NetCDF/GeoTIFF).',
  opentopography: 'Per-survey record on OpenTopography; point-cloud/raster download or API access needs an API key; licence is set per survey (see its DOI page).',
  gfw: 'GFW Data API; queries need a free API key (x-api-key header). Dataset-level metadata only; spatial extent is not machine-readable here, so it is shown as a global bbox.',
  'openeo-cdse': 'Copernicus Data Space openEO back end; processing needs a free CDSE account (OIDC).',
}

/** Providers implied by the source, so they need not be stored per entry. */
export const DEFAULT_PROVIDERS: Record<string, string[]> = {
  opentopography: ['OpenTopography'],
}

/** Access URL implied by (source, local id); null when the source has no rule. */
export function derivedUrl(source: string, local: string, themes: readonly string[] = []): string | null {
  const s = sourceInfo(source)
  if (!s) return null
  switch (source) {
    case 'planetary-computer': case 'element84': case 'landsatlook': case 'eodc': case 'cdse': case 'openeo-cdse':
      return `${s.root}/collections/${encodeURIComponent(local)}`
    case 'cmr': {
      const i = local.indexOf('/')
      return i < 0 ? null : `${s.root}/${local.slice(0, i)}/collections/${encodeURIComponent(local.slice(i + 1))}`
    }
    case 'gee': return `https://developers.google.com/earth-engine/datasets/catalog/${local.replace(/\//g, '_')}`
    case 'gfw': return `${s.root}/dataset/${encodeURIComponent(local)}`
    case 'opentopography':
      // Point-cloud surveys carry the lidar theme (forced by the mapper); rasters do not unless their text says lidar.
      return `https://portal.opentopography.org/${themes.includes('lidar') ? 'lidarDataset' : 'rasterDataset'}?opentopoID=${encodeURIComponent(local)}`
    default: return null
  }
}

/** Most common access kind for a source; entries differing from it store theirs. */
export const DEFAULT_KIND: Record<string, string> = {
  'planetary-computer': 'stac-cog', element84: 'stac-cog', landsatlook: 'stac-cog', eodc: 'stac-other', cdse: 'stac-other',
  'openeo-cdse': 'openeo', gee: 'earthengine', cmr: 'stac-other', gfw: 'rest', opentopography: 'rest',
}
