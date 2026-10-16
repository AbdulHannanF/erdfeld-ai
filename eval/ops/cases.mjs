// One case per operation (analyze_raster once per sub-operation). Each case picks a small real AOI
// and arguments that satisfy the operation's contract in GET /api/operations (required params,
// date limits, max area). `needs` names an earlier case whose result this one is chained after;
// `args(ctx)` receives { prev: GeoResult } for chained cases.
import { boxAoi } from './lib.mjs'

const P = {
  kasur: [74.45, 31.12],
  phoenix: [-112.07, 33.45],
  sutlej: [74.57, 30.99], // Sutlej at Ganda Singh Wala, Kasur district
  alps: [7.66, 45.98], // Matterhorn / Zermatt
  lahore: [74.3436, 31.5497],
  indus: [68.85, 27.7], // Indus at Sukkur
  nile: [31.0, 31.2], // Nile delta
  dhaka: [90.41, 23.81],
  rondonia: [-63.05, -9.55],
  punjabIn: [75.5, 30.9], // post-monsoon stubble burning
}
const at = (p, km) => boxAoi(p[0], p[1], km)

/** Each: { id, op, place, aoi, args | args(ctx), needs?, timeoutMs?, expect? } */
export const CASES = [
  { id: 'fetch_ndvi', op: 'fetch_ndvi', place: 'Kasur', aoi: at(P.kasur, 4), args: { product: 'ndvi' } },
  { id: 'fetch_ndvi_imagery', op: 'fetch_ndvi', place: 'Kasur', aoi: at(P.kasur, 4), args: { product: 'imagery' } },
  { id: 'compute_spectral_index', op: 'compute_spectral_index', place: 'Kasur', aoi: at(P.kasur, 4), args: { index: 'NDWI' } },
  { id: 'fetch_temporal_stack', op: 'fetch_temporal_stack', place: 'Kasur', aoi: at(P.kasur, 3), args: { months: 6 } },
  { id: 'fetch_thermal', op: 'fetch_thermal', place: 'Phoenix AZ, summer 2024', aoi: at(P.phoenix, 5), args: { start: '2024-06-01', end: '2024-08-31' } },
  { id: 'fetch_sar', op: 'fetch_sar', place: 'Sutlej near Kasur', aoi: at(P.sutlej, 6), args: {} },
  { id: 'fetch_surface_water', op: 'fetch_surface_water', place: 'Indus at Sukkur', aoi: at(P.indus, 8), args: {} },
  { id: 'fetch_active_fires', op: 'fetch_active_fires', place: 'Kern County CA (CYRUS wildfire, EONET event 2026-10-09)', aoi: at([-118.418, 35.699], 20), args: { days: 10 }, expectLayers: true },
  { id: 'fetch_active_fires_punjab', op: 'fetch_active_fires', place: 'Punjab (India), stubble-burning season (satellite hotspots need FIRMS)', aoi: at(P.punjabIn, 25), args: { days: 10 } },
  { id: 'fetch_built_surface', op: 'fetch_built_surface', place: 'Lahore', aoi: at(P.lahore, 6), args: {} },
  { id: 'render_raster', op: 'render_raster', place: 'Kasur (false colour)', aoi: at(P.kasur, 4), args: { bands: ['B08', 'B04', 'B03'], start: '2026-09-01', end: '2026-10-14' } },
  { id: 'render_raster_expr', op: 'render_raster', place: 'Kasur (band-math NDVI, viridis)', aoi: at(P.kasur, 4), args: { expression: '(B08-B04)/(B08+B04)', colormap: 'viridis', start: '2026-09-01', end: '2026-10-14' } },
  { id: 'analyze_raster:stats', op: 'analyze_raster', place: 'Kasur', aoi: at(P.kasur, 3), args: { operation: 'stats', index: 'NDVI', date: '2026-10-05' } },
  { id: 'analyze_raster:histogram', op: 'analyze_raster', place: 'Kasur', aoi: at(P.kasur, 3), args: { operation: 'histogram', index: 'NDVI', date: '2026-10-05', bins: 20 } },
  { id: 'analyze_raster:variogram', op: 'analyze_raster', place: 'Kasur', aoi: at(P.kasur, 3), args: { operation: 'variogram', index: 'NDVI', date: '2026-10-05', lag_m: 40 } },
  { id: 'analyze_raster:transect', op: 'analyze_raster', place: 'Kasur', aoi: at(P.kasur, 3), args: { operation: 'transect', index: 'NDVI', date: '2026-10-05', line: [[74.43, 31.12], [74.47, 31.12]], samples: 60 } },
  { id: 'analyze_raster:correlate', op: 'analyze_raster', place: 'Kasur', aoi: at(P.kasur, 3), args: { operation: 'correlate', index: 'NDVI', index2: 'NDBI', date: '2026-10-05' } },
  { id: 'analyze_raster:texture', op: 'analyze_raster', place: 'Kasur', aoi: at(P.kasur, 3), args: { operation: 'texture', index: 'NDVI', date: '2026-10-05', window: 3, metric: 'stddev' } },
  { id: 'analyze_raster:cluster', op: 'analyze_raster', place: 'Kasur', aoi: at(P.kasur, 3), args: { operation: 'cluster', index: 'NDVI', date: '2026-10-05', k: 4 } },
  { id: 'analyze_raster:change', op: 'analyze_raster', place: 'Kasur', aoi: at(P.kasur, 3), args: { operation: 'change', index: 'NDVI', date: '2025-10-05', date2: '2026-10-05' } },
  { id: 'inspect_imagery', op: 'inspect_imagery', place: 'Kasur (needs a VLM; may be unconfigured)', aoi: at(P.kasur, 3), args: { subject: 'truecolor', date: '2026-10-05' } },
  { id: 'composite', op: 'composite', place: 'Kasur', aoi: at(P.kasur, 4), args: { expression: 'NDVI', start: '2026-09-01', end: '2026-10-10', resolution: 20 } },
  { id: 'detect_anomaly', op: 'detect_anomaly', place: 'Kasur', aoi: at(P.kasur, 3), args: { month: '2026-09', expression: 'NDVI', history_years: 5 } },
  { id: 'fetch_dem', op: 'fetch_dem', place: 'Alps (Matterhorn)', aoi: at(P.alps, 6), args: {} },
  { id: 'fetch_elevation_derivatives', op: 'fetch_elevation_derivatives', place: 'Alps (Matterhorn)', aoi: at(P.alps, 6), args: { kind: 'all', contour_interval: 100 } },
  { id: 'fetch_weather_history', op: 'fetch_weather_history', place: 'Dhaka', aoi: at(P.dhaka, 5), args: {} },
  { id: 'fetch_precipitation_history', op: 'fetch_precipitation_history', place: 'Dhaka', aoi: at(P.dhaka, 5), args: { months_back: 12, include_raster: true }, expectLayers: true },
  { id: 'query_osm', op: 'query_osm', place: 'Lahore', aoi: at(P.lahore, 2), args: { query: 'hospitals' } },
  { id: 'query_3d_tiles', op: 'query_3d_tiles', place: 'Lahore', aoi: at(P.lahore, 1), args: {} },
  { id: 'classify_land_cover', op: 'classify_land_cover', place: 'Nile delta', aoi: at(P.nile, 8), args: {} },
  { id: 'classify_vegetation', op: 'classify_vegetation', place: 'Nile delta', aoi: at(P.nile, 8), args: {} },
  { id: 'detect_change', op: 'detect_change', place: 'Rondonia', aoi: at(P.rondonia, 8), args: { before: '2020-07-15', after: '2025-07-15' } },
  { id: 'detect_deforestation', op: 'detect_deforestation', place: 'Rondonia', aoi: at(P.rondonia, 8), args: { before: '2020-07-15', after: '2025-07-15' } },
  { id: 'vectorize_raster', op: 'vectorize_raster', place: 'Indus at Sukkur (NDWI > 0.2)', aoi: at(P.indus, 6), args: { index: 'NDWI', op: '>', threshold: 0.2 } },
  { id: 'delineate_fields', op: 'delineate_fields', place: 'Kasur (rabi season)', aoi: at(P.kasur, 4), args: { start: '2025-11-01', end: '2026-04-15', max_scenes: 4 } },
  { id: 'map_flood', op: 'map_flood', place: 'Sutlej near Kasur, Aug-Sep 2025', aoi: at(P.sutlej, 8), args: { before: '2025-07-20', after: '2025-09-02', include_roads: false } },
  // The UI's drawn rectangle (~1.7 km2) at two spots: one where Sentinel-1 coverage is short, one that crashed a worker.
  { id: 'map_flood_small_nodata', op: 'map_flood', place: 'Sutlej, 1.7 km2 rectangle as the UI draws it', aoi: at([74.5685, 30.991], 0.65), args: { before: '2025-07-20', after: '2025-09-02', include_roads: false }, expectLayers: true },
  { id: 'map_flood_small_b', op: 'map_flood', place: 'Sutlej, 1.7 km2 rectangle', aoi: at([74.56, 30.995], 0.65), args: { before: '2025-07-20', after: '2025-09-02', include_roads: false }, expectLayers: true },
  { id: 'digitize_features', op: 'digitize_features', place: 'Indus at Sukkur (lakes)', aoi: at(P.indus, 6), args: { feature: 'lakes' } },
  // chained: need an earlier result
  { id: 'make_chart', op: 'make_chart', place: 'Kasur (chart over fetch_temporal_stack)', aoi: at(P.kasur, 3), needs: 'fetch_temporal_stack',
    args: ({ prev }) => {
      const key = Object.entries(prev.stats || {}).find(([, v]) => Array.isArray(v))?.[0]
      if (!key) return null
      return { title: 'NDVI by month', result_id: prev.result_id, spec: JSON.stringify({ mark: 'line', data: { name: `${prev.result_id}#${key}` }, encoding: { x: { field: 'label', type: 'ordinal' }, y: { field: 'value', type: 'quantitative' } } }) }
    } },
  { id: 'style_layer', op: 'style_layer', place: 'Lahore (colour buildings by height)', aoi: at(P.lahore, 1), needs: 'query_3d_tiles',
    args: ({ prev }) => {
      const f = prev.layers?.[0]?.geojson?.features?.[0]
      const prop = f && Object.keys(f.properties || {}).find((k) => typeof f.properties[k] === 'number' && /height|level/i.test(k))
      return prop ? { result_id: prev.result_id, property: prop, kind: 'graduated', colormap: 'viridis', num_classes: 5 } : null
    } },
  { id: 'find_dataset', op: 'find_dataset', place: 'Alps', aoi: at(P.alps, 6), args: { query: '30 m DEM elevation', themes: ['elevation'] } },
  { id: 'use_dataset', op: 'use_dataset', place: 'Alps (first DEM found by find_dataset)', aoi: at(P.alps, 6), needs: 'find_dataset',
    args: ({ prev }) => {
      const ids = [...(prev.summary || '').matchAll(/`?\b([a-z0-9][a-z0-9-]*:[A-Za-z0-9_.\/-]+)`?/g)].map((m) => m[1]).filter((s) => !/^https?$/.test(s.split(':')[0]))
      return ids.length ? { dataset_id: ids[0], hillshade: true } : null
    } },
]
