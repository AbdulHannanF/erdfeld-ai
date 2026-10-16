/** Dataset registry schema (stage 1).
 *
 *  One record per public geospatial dataset, whatever catalog it came from, so
 *  the agent can search "everything" offline and instantly. Stage 2 builds the
 *  readers; this module only describes what exists and how it is reached.
 */

/** Controlled theme vocabulary. Every entry gets 0..N of these. */
export const THEMES = [
  'elevation', 'lidar', 'sar', 'optical', 'land-cover', 'vegetation', 'forest', 'agriculture',
  'soil', 'climate', 'weather', 'precipitation', 'temperature', 'water', 'hydrology', 'snow-ice',
  'ocean', 'air-quality', 'fire', 'population', 'urban', 'buildings', 'infrastructure',
  'nightlights', 'geology', 'biodiversity', 'hazards', 'boundaries', 'embeddings',
] as const
export type Theme = (typeof THEMES)[number]

/** `zarr` and `cog` are additions for bare file stores with no STAC in front
 *  (an ARCO Zarr bucket, static GeoTIFF/COG tiles on HTTP/S3/GCS). */
export type AccessKind =
  | 'stac-cog' | 'stac-zarr' | 'stac-other'
  | 'earthengine' | 'rest' | 'geoparquet' | 'ept' | 'openeo' | 'tiles'
  | 'zarr' | 'cog'

export type AuthKind = 'earthdata' | 'earthengine' | 'copernicus' | 'opentopography' | 'api-key'

export interface DatasetAccess {
  kind: AccessKind
  /** Collection / endpoint URL (STAC collection, REST root, bucket, ...). */
  url: string
  requires_auth: AuthKind | null
  notes: string
}

export interface DatasetVariable {
  name: string
  unit?: string
}

/** Another route to the same dataset, kept on the primary entry by the deduper. */
export interface DatasetAlternate {
  /** Catalog id of the alternate. */
  source: string
  /** Entry id the alternate would have had (`<source>:<collection>`). */
  id: string
  access: DatasetAccess
}

export interface DatasetEntry {
  /** Stable: `<source>:<collection>`. */
  id: string
  title: string
  /** Trimmed (~400 chars), markdown stripped. */
  description: string
  /** Catalog id this entry was harvested from. */
  source: string
  providers: string[]
  themes: Theme[]
  /** Bands / variables with units where the catalog declares them. */
  variables: DatasetVariable[]
  spatial: {
    /** [minLon, minLat, maxLon, maxLat]; minLon > maxLon means the box crosses the antimeridian. */
    bbox: [number, number, number, number]
    global: boolean
  }
  /** `start` is null only when the catalog states no temporal extent at all. */
  temporal: { start: string | null; end: string | null }
  /** Best-effort ground sample distance, metres. null = unknown. */
  resolution_m: number | null
  /** SPDX-ish id, or 'proprietary' / 'various'. */
  license: string
  access: DatasetAccess
  keywords: string[]
  /** Hand-written, URL-verified entry (as opposed to harvested). */
  curated?: boolean
  alternates?: DatasetAlternate[]
}

export interface SourceReport {
  source: string
  count: number
  harvested_at: string
  ok: boolean
  /** Per-source failures that did not abort the source (and the fatal one, if any). */
  failures: string[]
  note?: string
}

export const GLOBAL_BBOX: [number, number, number, number] = [-180, -90, 180, 90]
