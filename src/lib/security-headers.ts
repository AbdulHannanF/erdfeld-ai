/** Security headers for every response (applied from next.config.ts).
 *
 *  The CSP is written for what the browser really loads: MapLibre (blob workers, tiles fetched
 *  from the tile hosts below), the basemap styles/glyphs, vega charts (no `eval`: vega-embed runs
 *  with `ast: true`, i.e. the vega-interpreter) and Next's own inline bootstrap scripts.
 *
 *  Known exception: `script-src 'unsafe-inline'`. Next's App Router emits inline `<script>` tags
 *  for hydration, and a nonce-based policy needs a per-request proxy that makes every page
 *  dynamic. Everything else (no `unsafe-eval`, `object-src 'none'`, `frame-ancestors 'none'`,
 *  `base-uri 'self'`) stays strict.
 *
 *  `headers()` in next.config.ts runs at BUILD time: set TITILER_ENDPOINT (and CSP_CONNECT_EXTRA,
 *  a space-separated list of extra origins) in the environment of `next build`.
 */

const TILE_AND_STYLE_HOSTS = [
  'https://*.cartocdn.com', // basemap styles, tiles, glyphs, sprites (basemaps / tiles.basemaps / a-d)
  'https://server.arcgisonline.com', // Esri World Imagery
  'https://demotiles.maplibre.org', // glyphs
  'https://s3.amazonaws.com', // AWS terrain tiles (terrarium)
  'https://elevation-tiles-prod.s3.amazonaws.com',
  'https://titiler.xyz', // public titiler (default TITILER_ENDPOINT)
  'https://planetarycomputer.microsoft.com', // Planetary Computer STAC / tiler
  'https://*.blob.core.windows.net', // Planetary Computer assets
  'https://earth-search.aws.element84.com', // Earth Search
  'https://*.s3.us-west-2.amazonaws.com', // Sentinel COGs, Overture, USGS lidar on AWS
  'https://stac.overturemaps.org',
  'https://earthengine.googleapis.com', // Earth Engine map tiles
  'https://gibs.earthdata.nasa.gov', // NASA GIBS
]

const origin = (url: string | undefined): string[] => {
  try { return url ? [new URL(url).origin] : [] } catch { return [] }
}

export function buildCsp(env: Record<string, string | undefined> = process.env): string {
  const dev = env.NODE_ENV !== 'production'
  const extra = (env.CSP_CONNECT_EXTRA ?? '').split(/\s+/).filter(Boolean)
  const tiles = [...TILE_AND_STYLE_HOSTS, ...origin(env.TITILER_ENDPOINT), ...extra]
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // 'unsafe-eval' only in `next dev` (React refresh); never in production.
    'script-src': ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', ...tiles],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", 'blob:', 'data:', 'https://nominatim.openstreetmap.org', ...tiles],
    'worker-src': ["'self'", 'blob:'],
    'child-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  }
  return Object.entries(directives).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ')
}

export function securityHeaders(env: Record<string, string | undefined> = process.env): Array<{ key: string; value: string }> {
  return [
    { key: 'Content-Security-Policy', value: buildCsp(env) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()' },
    { key: 'X-Frame-Options', value: 'DENY' },
  ]
}
