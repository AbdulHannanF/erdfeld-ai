/** Vector extraction: thresholded rasters, field boundaries, floods, and the digitize router. */

import { z } from 'zod'

import { delineateFields, digitizeFeatures, vectorizeRaster } from '../../tools/digitize'
import { mapFlood } from '../../tools/flood'
import { resolveExpression } from '../../lib/digitize/scene-grid'
import { isCvEnabled } from '../flags'
import { isObjectTarget } from '../../tools/digitize'
import { fail, pass } from '../validate'
import { HOUR, DAY, defineOperation, type AnyOperation } from '../operation'

export const digitizeOps: AnyOperation[] = [
  defineOperation({
    name: 'vectorize_raster',
    label: 'Thresholding Sentinel-2 pixels and tracing polygons...',
    version: '1.0.0',
    description: 'Digitize ANYTHING expressible from Sentinel-2 imagery into polygons: threshold a spectral index or band expression on real, cloud-masked, polygon-clipped 10 m pixels and trace the result as GeoJSON polygons (area_m2 and mean value per polygon, total area, honest resolution note). Use for "digitize all water bodies" (NDWI > 0.2), "map burn scars" (NBR < -0.1), "polygons where NDVI > 0.6", built-up (NDBI > 0.1), dense vegetation. Do NOT use for field/parcel mapping (use delineate_fields) or for objects like cars/buildings (detect_objects).',
    params: z.object({
      index: z.enum(['NDVI', 'NDWI', 'NDBI', 'EVI', 'NBR', 'SAVI']).optional().describe('Spectral index to threshold. Give this OR expression.'),
      expression: z.string().optional().describe('Band-name expression instead of an index, e.g. "(nir - red) / (nir + red)" or "swir16 / nir". Bands: blue green red rededge1-3 nir nir08 swir16 swir22.'),
      op: z.enum(['>', '<', 'between']).optional().describe('Comparison. Defaults to the usual one for the index (NDWI >, NBR <, NDVI >).'),
      threshold: z.number().optional().describe('Threshold (lower bound for "between"). A default is used for a bare index, and stated.'),
      threshold_upper: z.number().optional().describe('Upper bound, for op "between".'),
      date: z.string().optional().describe('YYYY-MM-DD target date; the clearest scene within ±30 days is used. Omit for the latest clear scene.'),
      min_area_m2: z.number().optional().describe('Drop polygons smaller than this (default 500 m²).'),
    }),
    output: 'vector',
    sensors: ['sentinel-2-l2a'],
    resolution_m: 10,
    limits: { maxAreaKm2: 1000, earliest: '2015-06-23', needsDates: true },
    cost: { typicalSeconds: 15 },
    cacheTtl: { liveMs: 6 * HOUR, settledMs: 30 * DAY },
    limitations: [
      'Thresholds a spectral index or band expression on cloud-masked 10 m pixels and traces the result: polygons are pixel-aligned and objects under about 100 m2 are not resolved.',
      'A default threshold for a bare index is a starting point, and the output says so.',
      'Not for fields or parcels (use delineate_fields) or objects such as cars and buildings.',
    ],
    confidence: 'medium: the pixels are measured; whether the threshold means "water" or "burn scar" is an interpretation.',
    staticChecks: (_ctx, args) => {
      if (!args.index && !args.expression) return [fail('static', 'bands_exist', 'vectorize_raster needs an `index` (NDVI, NDWI, NDBI, EVI, NBR, SAVI) or an `expression` over band names.')]
      if (args.expression) {
        try {
          resolveExpression(args.expression)
        } catch (err: any) {
          return [fail('static', 'bands_exist', `Cannot use the expression "${args.expression}": ${err?.message}.`)]
        }
        return [pass('static', 'bands_exist', 'Expression bands exist for Sentinel-2.')]
      }
      return []
    },
    run: (ctx, args) => vectorizeRaster(ctx, args),
  }),
  defineOperation({
    name: 'delineate_fields',
    label: 'Delineating fields from a season of Sentinel-2 NDVI...',
    version: '1.0.0',
    description: 'Delineate EVERY agricultural field in the AOI as polygons, labelled by seasonal behaviour. Builds a season of cloud-masked Sentinel-2 NDVI (up to max_scenes clear dates spread over the year), segments it with a multi-temporal watershed, and labels each polygon by NDVI phenology: winter (rabi) crop, summer (kharif) crop, double-cropped, perennial/orchard, fallow/sparse, non-field. Returns area_ha, NDVI profile, peak dates, growing seasons and a 0-1 confidence per polygon. Use for "map the fields/farms/parcels/plots", "field boundaries", "how many fields", "delineate croplands". It does NOT identify crop species (wheat/rice need ground truth) and says so. Sentinel-2 10 m: reliable down to ~0.5-1 ha; adjacent same-crop fields with no visible boundary merge. AOI up to ~12 km across.',
    params: z.object({
      start: z.string().optional().describe('Season start YYYY-MM-DD (default: 12 months before end).'),
      end: z.string().optional().describe('Season end YYYY-MM-DD (default: today).'),
      min_field_area_m2: z.number().optional().describe('Smallest field to keep (default 2000 m²).'),
      max_scenes: z.number().optional().describe('Dates in the season stack, 3-8 (default 6).'),
    }),
    output: 'vector',
    sensors: ['sentinel-2-l2a'],
    resolution_m: 10,
    limits: { maxAreaKm2: 150, minAreaKm2: 0.1, earliest: '2015-06-23', needsDates: true },
    cost: { typicalSeconds: 60 },
    cacheTtl: { liveMs: 6 * HOUR, settledMs: 30 * DAY },
    limitations: [
      'Sentinel-2 10 m: reliable down to about 0.5-1 ha; adjacent same-crop fields with no visible boundary merge.',
      'Labels describe seasonal behaviour (winter, summer, double-cropped, perennial, fallow); it does not identify crop species.',
      'AOI up to about 12 km across.',
    ],
    confidence: 'per-field 0-1 score from boundary contrast and NDVI-profile consistency; low for small or merged fields.',
    run: (ctx, args) => delineateFields(ctx, args),
  }),
  defineOperation({
    name: 'map_flood',
    label: 'Mapping flood extent from Sentinel-1 radar (scene scan, water threshold, buildings hit)...',
    version: '1.0.0',
    description: 'Map a FLOOD from Sentinel-1 radar: what went under water, and what was hit. Radar sees through monsoon cloud and gives the sharpest water boundary in remote sensing (open water is dark, smooth backscatter). With `before` and `after` dates it compares the Sentinel-1 RTC scene nearest each (same relative orbit where possible). With only a `start`/`end` window it scans every scene over the AOI, reports the water fraction per scene, takes the peak-water scene as the flood and the nearest earlier dry scene as the reference, and says how it chose. Water = VV dB, 3x3 median, Otsu threshold clamped to -23..-15 dB (fallback -18 dB, stated), flood = water(after) AND NOT water(before). Returns new-flood and permanent-water polygons (km²), receded water, Overture buildings whose footprint centroid is inside the flood (count + map layer), flooded road length, both SAR scenes as map layers, and a water-fraction-by-scene chart. Use for "flood", "inundation", "what went under water", "how much flooded", "which buildings were hit". Honest limits: misses flooding under vegetation and in dense urban areas (double bounce), wind-roughened water, no terrain-shadow mask. AOI up to ~40 km across.',
    params: z.object({
      before: z.string().optional().describe('YYYY-MM-DD of the dry reference; the nearest Sentinel-1 scene is used. Give together with `after`.'),
      after: z.string().optional().describe('YYYY-MM-DD during/after the flood; the nearest Sentinel-1 scene is used.'),
      start: z.string().optional().describe('Window start YYYY-MM-DD to scan when no explicit dates are given (default: 120 days before `end`).'),
      end: z.string().optional().describe('Window end YYYY-MM-DD (default: today).'),
      polarization: z.enum(['VV', 'VH']).optional().describe('Radar polarisation (default VV, the better water/land contrast).'),
      min_area_m2: z.number().optional().describe('Drop flood polygons smaller than this (default 1000 m²).'),
      include_roads: z.boolean().optional().describe('Also measure flooded road length from Overture (default true).'),
    }),
    output: 'mixed',
    sensors: ['sentinel-1-rtc'],
    resolution_m: 10,
    limits: { maxAreaKm2: 1600, earliest: '2014-10-03', needsDates: true },
    cost: { typicalSeconds: 150 },
    cacheTtl: { liveMs: 6 * HOUR, settledMs: 30 * DAY },
    limitations: [
      'Radar misses flooding under vegetation and in dense urban areas (double bounce), so flooded area and buildings hit are lower bounds.',
      'Wind-roughened water reads as land and there is no terrain-shadow mask.',
      'The water threshold is Otsu clamped to -23..-15 dB (fallback -18 dB, stated in the output), not calibrated to the site.',
      'AOI up to about 40 km across; a scene scan can take about two minutes.',
    ],
    confidence: 'medium: a real two-scene radar comparison; the output states which scenes were chosen and why.',
    staticChecks: (_ctx, args) => {
      if (Boolean(args.before) !== Boolean(args.after)) {
        return [fail('static', 'flood_dates', 'Give `before` and `after` together, or neither (use `start`/`end` to scan a window).')]
      }
      return []
    },
    run: (ctx, args) => mapFlood(ctx, args),
  }),
  defineOperation({
    name: 'digitize_features',
    label: 'Digitizing features (imagery first, OSM cross-check)...',
    version: '1.0.0',
    description: 'One-shot tool to digitize ANY geographic feature into vectors, CV-FIRST. The imagery answers the question and OpenStreetMap is used as a cross-check, not as the answer: (1) water features are measured spectrally with Sentinel-2 NDWI; (2) everything else goes through detect_objects (target profiler -> imagery planner -> detector ladder); (3) OSM is then queried and reported alongside, so the user can see how the imagery result compares with what is already mapped. Use whenever the user asks to "digitize", "find all", "extract", "delineate", "map out", or "show me the X". Prefer this over calling query_osm + detect_objects separately.',
    params: z.object({
      feature: z.string().describe('The feature to digitize (e.g. "lakes", "buildings", "cars", "solar panels"). Supports plurals and synonyms.'),
      footprint_m: z.array(z.number()).optional().describe('Optional [long, short] size of ONE such feature in metres. Supply your own estimate for unusual features so the pipeline can judge whether imagery resolves them.'),
    }),
    output: 'mixed',
    sensors: ['sentinel-2-l2a', 'sentinel-1-rtc', 'openstreetmap'],
    resolution_m: 10,
    cost: { typicalSeconds: 20 },
    cacheTtl: { liveMs: HOUR },
    limitations: [
      'Floods route to map_flood, fields to delineate_fields and water to a Sentinel-2 NDWI threshold with an OSM cross-check; these are measured, not detected.',
      'Any other object (cars, buildings, tanks) needs the computer-vision pipeline, which is off unless GEOAGENT_ENABLE_CV=1; otherwise the request is refused.',
    ],
    confidence: 'inherits the routed operation\'s confidence.',
    staticChecks: (_ctx, args) => {
      if (isCvEnabled() || !isObjectTarget(args.feature)) return []
      return [fail('static', 'cv_enabled', `"${args.feature}" is an object to detect, which needs the computer-vision pipeline; it is not enabled here (GEOAGENT_ENABLE_CV=1). Floods, fields and water are measured directly: ask for those, or use query_osm for what is already mapped.`)]
    },
    run: (ctx, args) => digitizeFeatures(ctx, args),
  }),
]
