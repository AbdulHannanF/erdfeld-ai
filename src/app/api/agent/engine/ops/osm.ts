/** OpenStreetMap vector queries. */

import { z } from 'zod'

import { query3dTiles, queryOsm } from '../../tools/osm'
import { HOUR, defineOperation, type AnyOperation } from '../operation'

export const osmOps: AnyOperation[] = [
  defineOperation({
    name: 'query_osm',
    label: 'Querying OpenStreetMap...',
    version: '1.0.0',
    description: 'Query OpenStreetMap for objects and infrastructure within the AOI. Returns GeoJSON features with correct geometry types: rivers/roads as LineStrings, buildings/farms/orchards as Polygons. If no results found, suggests using computer vision.',
    params: z.object({
      query: z.string().describe('What to search for (e.g., "hospitals", "buildings", "rivers", "orchards")'),
    }),
    output: 'vector',
    sensors: ['openstreetmap'],
    cost: { typicalSeconds: 8 },
    cacheTtl: { liveMs: HOUR },
    limitations: [
      'OpenStreetMap records what volunteers have mapped, not everything that exists: zero results can mean "not mapped".',
      'Dense areas are fetched in quadrants; a still-saturated quadrant is reported as truncated and the count is then a lower bound.',
    ],
    confidence: 'high when the query completed for every quadrant; medium when quadrants were truncated or failed (the output says which).',
    run: (ctx, args) => queryOsm(ctx, args),
  }),
  defineOperation({
    name: 'query_3d_tiles',
    label: 'Loading 3D Buildings...',
    version: '1.0.0',
    description: 'Fetch building footprints with height data from OpenStreetMap for the AOI. Heights are derived from explicit tags, floor-count estimates, or type defaults. Returns colored polygons with height, levels, and building type. Use for urban density, skyline analysis, or building inventory requests.',
    params: z.object({}),
    output: 'vector',
    sensors: ['openstreetmap'],
    cost: { typicalSeconds: 8 },
    cacheTtl: { liveMs: HOUR },
    limitations: [
      'Building heights come from explicit OSM tags, floor-count estimates (levels x 3.5 m) or type defaults, so many are estimates.',
      'Only buildings mapped in OSM; unmapped buildings are absent.',
    ],
    confidence: 'medium: footprints are as complete as OSM; heights are partly estimated.',
    run: (ctx) => query3dTiles(ctx),
  }),
]
