/** Optical, radar and gridded-product operations (Sentinel-2, Landsat, Sentinel-1, JRC, FIRMS, WorldCover). */

import { z } from 'zod'

import { sceneSeries } from '../../tools/series'
import { computeSpectralIndex, fetchActiveFires, fetchBuiltSurface, fetchSar, fetchSurfaceWater, fetchTemporalStack, fetchThermal, ndviOrImagery } from '../../tools/satellite'
import { SCENE_ID_PATTERN } from '../../lib/scenes'
import { fail, pass } from '../validate'
import { MINUTE, HOUR, DAY, defineOperation, type AnyOperation } from '../operation'

/** The arguments that pin a run to one acquisition (the timeline passes these for a chosen scene). */
const SCENE_PIN = {
  date: z.string().optional().describe('YYYY-MM-DD; use the clearest scene within +-3 days of this date instead of the latest imagery.'),
  scene_id: z.string().optional().describe('Exact STAC item id of one scene (as listed by GET /api/scenes); that scene is used, never another. Refused when it does not exist or does not cover the area.'),
}
const sceneIdCheck = (args: { scene_id?: string }) =>
  args.scene_id === undefined
    ? []
    : [SCENE_ID_PATTERN.test(args.scene_id)
        ? pass('static', 'scene_id', `scene_id ${args.scene_id} is a scene identifier.`)
        : fail('static', 'scene_id', `\`scene_id\` "${args.scene_id.slice(0, 60)}" is not a scene identifier (letters, digits, dot, dash and underscore, 6 to 100 characters).`)]

export const opticalOps: AnyOperation[] = [
  defineOperation({
    name: 'fetch_ndvi',
    label: 'Fetching NDVI...',
    version: '1.1.0',
    description: 'Sentinel-2 for the AOI. `product: "ndvi"` (default) returns cloud-masked NDVI vegetation statistics plus a red→yellow→green NDVI raster layer — use it for NDVI stats AND for any "show/colorize/map NDVI" visualization request. `product: "imagery"` returns the 10 m true-colour RGB scene instead.',
    params: z.object({
      product: z.enum(['ndvi', 'imagery']).optional().describe('ndvi (default) = NDVI statistics + colormap raster; imagery = true-colour RGB.'),
      ...SCENE_PIN,
    }),
    output: 'raster',
    sensors: ['sentinel-2-l2a'],
    resolution_m: 10,
    limits: { earliest: '2015-06-23' },
    cost: { typicalSeconds: 10 },
    cacheTtl: { liveMs: 6 * HOUR, settledMs: 30 * DAY },
    staticChecks: (_ctx, args) => sceneIdCheck(args),
    limitations: [
      'Uses the clearest recent Sentinel-2 L2A scene over the AOI (or the one named by `scene_id` / the clearest within 3 days of `date`), not a composite; Sentinel-2 data begins 2015-06-23.',
      'Cloud, shadow and cirrus are masked with the scene classification (SCL) layer; masked pixels are excluded from the statistics, not filled.',
      'The mean is read from a grid capped at 256 px, so over a large AOI its effective ground sample distance is coarser than 10 m (the output states it).',
      'If tiles cannot be rendered the map shows a flat fill derived from the real mean, labelled illustrative, or nothing when no mean exists.',
    ],
    confidence: 'high: a clear scene (at least 40% of AOI pixels clear) with rendered per-pixel tiles; medium or low when cloud, a flat fallback fill or a composite limits it.',
    run: (ctx, args) => ndviOrImagery(ctx, args.product === 'imagery' ? 'fetch_high_res_imagery' : 'fetch_ndvi', args),
  }),
  defineOperation({
    name: 'compute_spectral_index',
    label: 'Computing Spectral Index...',
    version: '1.0.0',
    description: 'Compute a spectral index from Sentinel-2 bands with its default styling. Supports NDVI, NDWI, NDBI, EVI, NBR, SAVI. For a custom colormap, stretch, sensor or date window, use render_raster with the index formula as `expression`.',
    params: z.object({
      index: z.enum(['NDVI', 'NDWI', 'NDBI', 'EVI', 'NBR', 'SAVI']),
      ...SCENE_PIN,
    }),
    output: 'raster',
    sensors: ['sentinel-2-l2a'],
    resolution_m: 10,
    cost: { typicalSeconds: 10 },
    cacheTtl: { liveMs: 6 * HOUR, settledMs: 30 * DAY },
    staticChecks: (_ctx, args) => sceneIdCheck(args),
    limitations: [
      'Sentinel-2 L2A only; fixed default colormap and a stretch fitted to the AOI\'s own p2-p98 (use render_raster for anything custom).',
      'Cloud, shadow and cirrus are masked with the SCL layer before the mean is computed.',
      'The mean comes from a grid capped at 256 px, so its effective resolution over a large AOI is coarser than 10 m.',
    ],
    confidence: 'high: a clear scene with rendered tiles; medium when cloud or a flat fallback fill limits it.',
    run: (ctx, args) => computeSpectralIndex(ctx, args),
  }),
  defineOperation({
    name: 'fetch_temporal_stack',
    label: 'Building Temporal Stack...',
    version: '1.1.0',
    description: 'Fetch a time series of NDVI data across multiple months for temporal analysis.',
    params: z.object({
      months: z.number().optional().describe('Number of months to look back (default 6, max 12)'),
    }),
    output: 'chart',
    sensors: ['sentinel-2-l2a'],
    resolution_m: 10,
    limits: { earliest: '2015-06-23', needsDates: true },
    cost: { typicalSeconds: 30 },
    cacheTtl: { liveMs: 6 * HOUR, settledMs: 30 * DAY },
    limitations: [
      'One cloud-masked NDVI mean per clear acquisition; dates with no usable clear-sky value are absent, never interpolated.',
      'At most 12 months back; each point is a single scene, so the series is irregular in time.',
    ],
    confidence: 'medium: depends on how many clear acquisitions exist in the window; fewer than three points is a weak trend.',
    run: (ctx, args) => fetchTemporalStack(ctx, args),
  }),
  defineOperation({
    name: 'scene_series',
    label: 'Charting an index over the archive...',
    version: '1.0.0',
    description: 'One cloud-masked index value per acquisition over the WHOLE archive (Sentinel-2 from 2015, Landsat from 1982), as a chart you can click through to each scene. Use for "how has NDVI changed since 2017" where fetch_temporal_stack (12 months at most) is too short. Pass `sensor`, `index`, a window (`start`/`end`, default the whole archive) and `max_cloud`; or `scene_ids` for exactly the scenes chosen on the timeline.',
    params: z.object({
      sensor: z.enum(['sentinel-2', 'landsat']).optional().describe('Default sentinel-2. One sensor per series: Sentinel-2 and Landsat NDVI disagree by 0.02 to 0.11 on the same ground.'),
      index: z.enum(['NDVI', 'NDWI', 'NDBI', 'EVI', 'NBR', 'SAVI']).optional().describe('Default NDVI.'),
      start: z.string().optional().describe('YYYY-MM-DD first day (default: the sensor archive start).'),
      end: z.string().optional().describe('YYYY-MM-DD last day (default: today).'),
      max_cloud: z.number().optional().describe('Scene-wide cloud ceiling in % for the scenes to read (default 60). Cloud over the polygon itself is masked per pixel regardless.'),
      max_scenes: z.number().optional().describe('At most this many scenes are read, evenly thinned from the oldest to the newest (default 60, at most 150).'),
      scene_ids: z.array(z.string()).optional().describe('Read exactly these scenes (STAC item ids from GET /api/scenes) instead of searching a window.'),
    }),
    output: 'chart',
    sensors: ['sentinel-2-l2a', 'landsat-c2-l2'],
    resolution_m: 10,
    limits: { earliest: '1982-08-22', needsDates: true },
    cost: { typicalSeconds: 90 },
    timeoutMs: 10 * MINUTE,
    cacheTtl: { liveMs: 6 * HOUR, settledMs: 30 * DAY },
    staticChecks: (_ctx, args) => {
      const bad = (args.scene_ids ?? []).filter((id) => !SCENE_ID_PATTERN.test(id))
      const checks = bad.length ? [fail('static', 'scene_id', `\`scene_ids\` holds ${bad.length} value(s) that are not scene identifiers (first: "${String(bad[0]).slice(0, 60)}").`)] : []
      if ((args.scene_ids ?? []).length > 150) checks.push(fail('static', 'scene_ids_count', 'At most 150 scenes can be read in one series.'))
      if (args.sensor === 'sentinel-2' && args.start && args.start < '2015-06-23') checks.push(fail('static', 'dates_after_earliest', '`start` is before Sentinel-2 data begins (2015-06-23); use sensor landsat for earlier dates.'))
      return checks
    },
    limitations: [
      'One value per acquisition day: the mean of the clear pixels inside the drawn polygon, from one scene. A day under cloud is a gap, never interpolated.',
      'Scenes covering under 90% of the area are left out, and a long archive is evenly thinned to at most max_scenes (the first and last are kept); the answer says how many.',
      'One sensor per series. Sentinel-2 values are not comparable with Landsat values.',
      'Reads each scene at a coarse grid (about 96 px along the longer side), so over a large area the mean is an effective-resolution statistic, not a 10 m one.',
    ],
    confidence: 'medium: depends on how many clear acquisitions the archive holds over the area; fewer than three points is not a trend.',
    run: (ctx, args) => sceneSeries(ctx, args),
  }),
  defineOperation({
    name: 'fetch_thermal',
    label: 'Fetching Thermal...',
    version: '1.1.0',
    description: 'Fetch Land Surface Temperature (LST, degrees Celsius) from Landsat 8/9 thermal data for the AOI. Without dates it uses the clearest recent scene; pass `start` and/or `end` to pick the clearest scene inside a period ("Phoenix summer 2024": start 2024-06-01, end 2024-08-31). Returns the cloud-masked mean and a per-pixel layer stretched to the AOI\'s own 2nd-98th percentile with a legend in degrees Celsius.',
    params: z.object({
      start: z.string().optional().describe('YYYY-MM-DD start of the period to search (default: end minus 90 days, or the clearest recent scene when neither date is given).'),
      end: z.string().optional().describe('YYYY-MM-DD end of the period to search, inclusive (default: today).'),
    }),
    output: 'raster',
    sensors: ['landsat-c2-l2'],
    resolution_m: 30,
    limits: { earliest: '2013-03-18', needsDates: true },
    cost: { typicalSeconds: 12 },
    cacheTtl: { liveMs: 6 * HOUR },
    limitations: [
      'Landsat 8/9 Collection 2 Level 2 surface temperature (acquired about 10:30 local time), so a daytime snapshot, not a daily mean.',
      'Needs a clear-sky scene; the thermal band is resampled to 30 m from a coarser native resolution.',
      'One scene, not a composite: with a period it is the clearest scene inside it. The map layer shows every pixel of that scene; only the statistics exclude cloud-flagged pixels.',
      'Land surface temperature, not air temperature, and not fire detection.',
    ],
    confidence: 'high: a clear Landsat scene over the AOI; medium or low with partial cloud or a coarser fallback source.',
    run: (ctx, args) => fetchThermal(ctx, args),
  }),
  defineOperation({
    name: 'fetch_sar',
    label: 'Fetching SAR...',
    version: '1.1.0',
    description: 'Fetch Sentinel-1 SAR (Synthetic Aperture Radar) backscatter for the AOI from the newest radiometrically terrain-corrected (RTC gamma0) pass. SAR sees through clouds and shows surface roughness and moisture. Returns the VV (and VH when available) mean in dB and per-pixel VV/VH backscatter map layers in dB, stretched to the AOI\'s own 2nd-98th percentile, with a legend. Use for radar texture, change context, or when cloud cover blocks optical sensors; use map_flood for floods.',
    params: z.object({}),
    output: 'raster',
    sensors: ['sentinel-1-rtc'],
    resolution_m: 10,
    limits: { earliest: '2014-10-03' },
    cost: { typicalSeconds: 12 },
    cacheTtl: { liveMs: 6 * HOUR },
    limitations: [
      'Sentinel-1 RTC (gamma0) VV and VH backscatter in dB: an image of surface roughness and moisture, not a flood product (use map_flood for floods).',
      'One pass, not a composite (the newest of the last three that covers the AOI best); a pass covering under 80% of the AOI is labelled with its coverage.',
      'Radar geometry distorts steep terrain (layover, shadow) and speckle is not filtered. If RTC is unavailable the GRD fallback reports an uncalibrated number with no map layer.',
    ],
    confidence: 'medium: real backscatter, but interpretation (water, urban, rough surface) depends on context the radar image alone cannot give.',
    run: (ctx) => fetchSar(ctx),
  }),
  defineOperation({
    name: 'fetch_surface_water',
    label: 'Fetching JRC Surface Water History...',
    version: '1.0.0',
    description: 'Fetch long-term surface water history from JRC Global Surface Water v1.4 (1984–2021, 30 m). Shows water occurrence (% of years each pixel held water) derived from 37 years of Landsat data. Use for: "show water history", "is this area seasonally flooded?", "permanent vs seasonal water", "has the lake shrunk?", "floodplain mapping", "flood frequency".',
    params: z.object({}),
    output: 'raster',
    sensors: ['jrc-gsw-v1.4'],
    resolution_m: 30,
    limits: { earliest: '1984-03-16' },
    cost: { typicalSeconds: 8 },
    cacheTtl: { liveMs: 30 * DAY },
    limitations: [
      'JRC Global Surface Water v1.4 covers 1984-2021 only: it says nothing about recent floods or water after 2021.',
      'Occurrence is the share of valid Landsat observations with water; cloudy or sparsely observed places carry larger uncertainty.',
      '30 m pixels: narrow channels and small ponds are missed.',
    ],
    confidence: 'high for long-term water behaviour inside 1984-2021; not applicable to current extent.',
    run: (ctx) => fetchSurfaceWater(ctx),
  }),
  defineOperation({
    name: 'fetch_active_fires',
    label: 'Detecting active fires (NASA FIRMS)...',
    version: '1.0.0',
    description: 'Detect active wildfires and thermal anomalies from NASA FIRMS satellite data (VIIRS 375 m + MODIS 1 km NRT). Returns geolocated fire hotspots with fire radiative power (FRP in MW), acquisition time, satellite, and confidence. Use for: "are there active fires?", "wildfire monitoring", "show fire hotspots", "thermal anomalies from fire", "burning areas". Requires FIRMS_MAP_KEY env var (free at firms.modaps.eosdis.nasa.gov/api/area/); gracefully explains how to get the key if absent.',
    params: z.object({
      days: z.number().optional().describe('Look-back window in days (1–10, default 7). Use 1–2 for currently active fires; 7–10 for recent fire history.'),
    }),
    output: 'vector',
    sensors: ['viirs-375m', 'modis-1km'],
    resolution_m: 375,
    cost: { typicalSeconds: 4 },
    cacheTtl: { liveMs: 15 * MINUTE },
    limitations: [
      'NASA FIRMS near-real-time hotspots: each point is a thermal anomaly in a 375 m (VIIRS) or 1 km (MODIS) pixel, not a measured fire perimeter.',
      'Requires a free FIRMS_MAP_KEY; without it the tool says so and returns nothing.',
      'Look-back window is 1-10 days; clouds and satellite overpass times mean fires can be missed.',
    ],
    confidence: 'per-hotspot: the FIRMS confidence class (low / nominal / high) reported with each detection.',
    run: (ctx, args) => fetchActiveFires(ctx, args),
  }),
  defineOperation({
    name: 'fetch_built_surface',
    label: 'Fetching ESA WorldCover built-up surface...',
    version: '1.0.0',
    description: 'Measure built-up surface coverage using ESA WorldCover 2021 (10 m Sentinel-2 derived, via Planetary Computer STAC, free, no key). Returns built-up %, tree cover %, cropland %, grassland %, water %, and dominant land class for the AOI. Renders a categorical LULC raster layer with 11-class coloring. Use for: "how urban/built-up is this area?", "impervious surface fraction", "built-up area", "urban footprint", "what percentage is developed?", "land cover from satellite".',
    params: z.object({}),
    output: 'raster',
    sensors: ['esa-worldcover-2021'],
    resolution_m: 10,
    cost: { typicalSeconds: 6 },
    cacheTtl: { liveMs: 30 * DAY },
    limitations: [
      'ESA WorldCover 2021 is a single year; it does not show change since 2021.',
      'A 10 m land-cover classification (about 75% overall accuracy globally): built-up % is a classification share, not a surveyed impervious area.',
    ],
    confidence: 'medium: a published global product with documented accuracy, applied without local validation.',
    run: (ctx) => fetchBuiltSurface(ctx),
  }),
]
