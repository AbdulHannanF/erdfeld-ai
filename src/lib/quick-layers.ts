/** Quick layers: one click, no LLM round-trip (Q-15).
 *
 *  Each is a fixed call of a registered operation with fixed arguments. The server runs it through
 *  the same engine executor as an agent step (`POST /api/quick-layer`), so static and dynamic
 *  validation, provenance and the `GeoResult` envelope apply unchanged; the client draws the
 *  result through the same store path as an agent layer. The request schema is in
 *  `lib/api-schemas.ts` with every other API input.
 */

export const QUICK_LAYERS = {
  true_colour: { label: 'True colour', operation: 'render_raster', args: { bands: ['B04', 'B03', 'B02'] } },
  ndvi: { label: 'NDVI', operation: 'fetch_ndvi', args: { product: 'ndvi' } },
  elevation: { label: 'Elevation', operation: 'fetch_dem', args: {} },
} as const satisfies Record<string, { label: string; operation: string; args: Record<string, unknown> }>

export type QuickLayerId = keyof typeof QUICK_LAYERS
export const QUICK_LAYER_IDS = Object.keys(QUICK_LAYERS) as [QuickLayerId, ...QuickLayerId[]]
