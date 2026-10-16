/** Elevation and its derivatives. */

import { z } from 'zod'

import { DEM_DATASET_LABEL, fetchDem, fetchElevationDerivatives } from '../../tools/terrain'
import { DAY, defineOperation, type AnyOperation } from '../operation'

export const terrainOps: AnyOperation[] = [
  defineOperation({
    name: 'fetch_dem',
    label: 'Fetching DEM...',
    version: '1.0.0',
    description: `Fetch Digital Elevation Model (DEM) from ${DEM_DATASET_LABEL} data (opentopodata.org) for the AOI. Returns elevation statistics.`,
    params: z.object({}),
    output: 'raster',
    sensors: ['dem'],
    resolution_m: 30,
    cost: { typicalSeconds: 6 },
    cacheTtl: { liveMs: 30 * DAY },
    limitations: [
      'The source and its resolution depend on the configured elevation endpoint (the description names it); it is a surface model, not a survey.',
      'Statistics come from a sampled grid over the AOI, not every DEM cell.',
      'Vertical error of a global DEM is several metres, larger in steep or forested terrain.',
    ],
    confidence: 'medium: a published global DEM sampled over the AOI; it does not know local surveying error.',
    run: (ctx) => fetchDem(ctx),
  }),
  defineOperation({
    name: 'fetch_elevation_derivatives',
    label: 'Computing slope, aspect, and contours...',
    version: '1.0.0',
    description: 'Compute slope (%), aspect (compass bearing), and/or elevation contour lines from the existing DEM grid (same source as fetch_dem) — no new data fetch required. Use for: "how steep is this?", "show me the slope", "north or south-facing?", "aspect map", "draw contours", "topographic contours", "contour lines every Xm", "is this flat or hilly?", "where are the steep slopes?", "which way does the land face?", "elevation profile".',
    params: z.object({
      kind: z.enum(['slope', 'aspect', 'contours', 'all']).optional().describe('Which derivatives to compute. "all" (default) returns slope raster + aspect raster + contour lines as three separate layers.'),
      contour_interval: z.number().optional().describe('Contour interval in meters (default: auto-selected based on terrain relief — 5/10/25/50/100 m). Minimum 5 m.'),
    }),
    output: 'mixed',
    sensors: ['dem'],
    resolution_m: 30,
    cost: { typicalSeconds: 3 },
    cacheTtl: { liveMs: 30 * DAY },
    limitations: [
      'Derived from the same DEM grid as fetch_dem, at that grid\'s resolution: macro-scale terrain, not metre-scale roughness.',
      'Slope and aspect are undefined on flat ground and unreliable at the grid edge; contours are interpolated.',
    ],
    confidence: 'medium: inherits the DEM\'s vertical error, which dominates slope on gentle terrain.',
    run: (ctx, args) => fetchElevationDerivatives(ctx, args),
  }),
]
