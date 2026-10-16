/**
 * C2 — Honest data tiers (pure, no I/O).
 *
 * Classifies a layer's data source into an explicit tier + native resolution so the
 * app can state, per layer, exactly what it is looking at:
 *
 *   - Tier 0 (free, default):   Sentinel-2 10 m, Landsat 30 m, ESA WorldCover 10 m,
 *                               SRTM/Copernicus DEM, JRC GSW 30 m, OSM, ERA5, etc.
 *   - Tier 1 (commercial):      sub-meter keyed imagery (Planet / Maxar / Mapbox /
 *                               Esri premium) — only when a key is configured.
 *   - Tier 2 (user upload):     a GeoTIFF/orthomosaic the user uploaded (resolution
 *                               is whatever they provide — this is the only path where
 *                               sub-meter / species-level questions become honest).
 *
 * Classification is derived from the `provenance.source` string the tools already
 * emit, so no tool has to be rewritten — the tier is computed centrally at the SSE
 * layer emit + in the reproducible export. Honesty: an unrecognized source is labeled
 * `unknown` (never silently assumed free/high-res).
 */

export type DataTier = 'free-10m' | 'commercial-submeter' | 'user-upload' | 'unknown'

export interface TierInfo {
  tier: DataTier
  /** Short human label for a legend/badge. */
  label: string
  /** Representative native resolution in meters/pixel, or null when caller-supplied. */
  resolutionM: number | null
  /** True when this tier needs no API key (the free core). */
  free: boolean
}

/** Source-name fragments (lowercased) that identify each tier. Ordered: user-upload
 *  and commercial are checked before free so a more specific match wins. */
const USER_UPLOAD_HINTS = ['user upload', 'uploaded geotiff', 'user-uploaded', 'user geotiff', 'drone orthomosaic', 'uploaded cog']
const COMMERCIAL_HINTS = ['maxar', 'planet labs', 'planetscope', 'skysat', 'mapbox satellite', 'esri premium', 'airbus', 'pléiades', 'pleiades', 'nearmap', 'vexcel']
/** Free open-EO sources we recognize, with a representative resolution (m). */
const FREE_SOURCE_RES: Array<{ hints: string[]; resM: number }> = [
  { hints: ['sentinel-2', 'esa worldcover', 'worldcover'], resM: 10 },
  { hints: ['sentinel-1'], resM: 10 },
  { hints: ['landsat'], resM: 30 },
  { hints: ['jrc global surface water', 'jrc gsw', 'global surface water'], resM: 30 },
  { hints: ['copernicus dem', 'cop-dem', 'glo-30', 'glo30'], resM: 30 },
  { hints: ['srtm'], resM: 90 },
  { hints: ['modis'], resM: 1000 },
  { hints: ['worldpop', 'ghs-pop', 'ghsl'], resM: 100 },
  { hints: ['soilgrids'], resM: 250 },
  { hints: ['era5', 'open-meteo', 'chirps'], resM: 11000 },
  { hints: ['viirs', 'gibs', 'firms'], resM: 375 },
  { hints: ['openstreetmap', 'overpass', 'osm'], resM: 0 }, // vector — resolution N/A (0 = vector)
  { hints: ['valhalla', 'opensky'], resM: 0 },
  { hints: ['esri world imagery'], resM: 1 }, // pretty basemap (display only, sub-meter in places)
]

/**
 * Classify a `provenance.source` string into a data tier + resolution.
 * `uploadResolutionM` (optional) supplies the real resolution for user uploads.
 */
export function classifyDataTier(source: string | null | undefined, uploadResolutionM?: number | null): TierInfo {
  const s = (source ?? '').toLowerCase()

  if (!s) return { tier: 'unknown', label: 'Unknown source', resolutionM: null, free: true }

  if (USER_UPLOAD_HINTS.some((h) => s.includes(h))) {
    return {
      tier: 'user-upload',
      label: 'User upload',
      resolutionM: uploadResolutionM ?? null,
      free: true, // serving the user's own data needs no commercial key
    }
  }

  const commercial = COMMERCIAL_HINTS.find((h) => s.includes(h))
  if (commercial) {
    return {
      tier: 'commercial-submeter',
      label: `Commercial (${commercial})`,
      resolutionM: null, // varies by provider/product; not asserted
      free: false,
    }
  }

  for (const { hints, resM } of FREE_SOURCE_RES) {
    if (hints.some((h) => s.includes(h))) {
      return {
        tier: 'free-10m',
        label: resM > 0 ? `Free open data (${resM} m)` : 'Free open data (vector)',
        resolutionM: resM > 0 ? resM : null,
        free: true,
      }
    }
  }

  return { tier: 'unknown', label: 'Unknown source', resolutionM: null, free: true }
}

/** Whether a commercial (Tier 1) imagery provider is configured via env keys.
 *  Pure check used to gate Tier 1 — the free core never depends on these. */
export function commercialImageryConfigured(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; provider: string | null } {
  if (env.MAPBOX_TOKEN?.trim()) return { enabled: true, provider: 'Mapbox Satellite' }
  if (env.MAXAR_API_KEY?.trim()) return { enabled: true, provider: 'Maxar' }
  if (env.PLANET_API_KEY?.trim()) return { enabled: true, provider: 'Planet Labs' }
  return { enabled: false, provider: null }
}
