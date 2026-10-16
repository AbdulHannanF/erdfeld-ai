/** Pixel-level operations: show any band or expression, analyse index pixels, look at the imagery. */

import { z } from 'zod'

import { renderRaster } from '../../tools/raster'
import { analyzeArgErrors, analyzeRaster } from '../../tools/analysis'
import { inspectImagery } from '../../tools/vision'
import { COLORMAP_CHOICES, normalizeColormap, parseRescale } from '../../lib/raster-render'
import { checkRasterBands, fail } from '../validate'
import { HOUR, DAY, defineOperation, type AnyOperation } from '../operation'

/** First Sentinel-2 acquisition date. */
const S2_EARLIEST = '2015-06-23'

export const rasterOps: AnyOperation[] = [
  defineOperation({
    name: 'render_raster',
    label: 'Rendering raster bands...',
    version: '1.0.0',
    description: 'Display ANY band, band composite or band-math expression of a Sentinel-2 L2A or Landsat C2 L2 scene over the AOI as a map layer (masked to the drawn polygon, stretched to the AOI\'s own p2–p98). Use for "show the NIR band", "false colour B08/B04/B03", "SWIR composite", "show (B11-B08)/(B11+B08)". Pass `bands` (1 = single-band colormap, 3 = RGB composite) OR `expression`. Unknown bands return an error naming the valid ones — never substitute another band or index.',
    params: z.object({
      sensor: z.enum(['sentinel-2-l2a', 'landsat-c2-l2']).optional().describe('Default sentinel-2-l2a. Sentinel-2 bands: B01-B09, B8A, B11, B12 (or blue/green/red/nir/swir16/swir22). Landsat bands: coastal, blue, green, red, nir08, swir16, swir22.'),
      bands: z.array(z.string()).optional().describe('1 band or 3 bands in R,G,B order, e.g. ["B08","B04","B03"] for false colour.'),
      expression: z.string().optional().describe('Band math over band names with + - * / and parentheses, e.g. "(B11-B08)/(B11+B08)". Evaluated on surface reflectance.'),
      date: z.string().optional().describe('YYYY-MM-DD; the clearest scene within +-3 days is used.'),
      start: z.string().optional().describe('YYYY-MM-DD window start (default: 90 days before end).'),
      end: z.string().optional().describe('YYYY-MM-DD window end (default: today).'),
      colormap: z.string().optional().describe('Single band / expression only: viridis (default), magma, inferno, plasma, cividis, greys, rdylgn, rdbu, spectral, terrain, blues, ylgn (append _r to reverse).'),
      rescale: z.array(z.number()).optional().describe('[min, max] display stretch. Omit to use the AOI p2–p98. Single band/expression: reflectance or index units; RGB: raw DN.'),
    }),
    output: 'raster',
    sensors: ['sentinel-2-l2a', 'landsat-c2-l2'],
    resolution_m: 10,
    limits: { earliest: '1982-08-22', needsDates: true },
    cost: { typicalSeconds: 12 },
    cacheTtl: { liveMs: 6 * HOUR, settledMs: 30 * DAY },
    limitations: [
      'Shows exactly the band, composite or expression asked for; an unknown band is refused, never replaced by another product.',
      'The default stretch is the p2-p98 of the AOI\'s own clear pixels, so colours are relative to this AOI, not comparable between AOIs.',
      'Sentinel-2 data begins 2015-06-23; Landsat Collection 2 begins 1982-08-22. Landsat is 30 m, Sentinel-2 10-20 m depending on the band.',
      'If no scene reaches the clear-sky floor the newest scene is shown unmasked and flagged.',
    ],
    confidence: 'high: a clear scene (at least 80% of AOI pixels clear) with a measured stretch; medium otherwise; low when the only scene available is cloudy and unmasked.',
    staticChecks: (_ctx, args) => {
      const sensor = (args.sensor ?? 'sentinel-2-l2a') as 'sentinel-2-l2a' | 'landsat-c2-l2'
      const checks = [checkRasterBands(sensor, args)]
      const bandCount = Array.isArray(args.bands) && args.bands.length === 3 ? 3 : 1
      if (args.colormap && bandCount === 3) checks.push(fail('static', 'colormap', 'A colormap does not apply to a 3-band RGB composite. Omit `colormap`, or pass one band / an expression.'))
      else if (args.colormap && !normalizeColormap(args.colormap)) checks.push(fail('static', 'colormap', `Unknown colormap "${args.colormap}". Choose one of: ${COLORMAP_CHOICES.join(', ')} (append _r to reverse).`))
      if (args.rescale) {
        const r = parseRescale(args.rescale, bandCount)
        if (!r.ok) checks.push(fail('static', 'rescale', r.error))
      }
      if (sensor === 'sentinel-2-l2a') {
        for (const k of ['date', 'start', 'end'] as const) {
          if (args[k] && args[k] < S2_EARLIEST) checks.push(fail('static', 'dates_after_earliest', `\`${k}\` (${args[k]}) is before Sentinel-2 data begins (${S2_EARLIEST}); use sensor landsat-c2-l2 for earlier dates.`))
        }
      }
      return checks
    },
    run: (ctx, args) => renderRaster(ctx, args),
  }),
  defineOperation({
    name: 'analyze_raster',
    label: 'Analyzing cloud-masked pixels over the AOI...',
    version: '1.0.0',
    description: 'ONE parameterised analysis capability over real, polygon-clipped, cloud-masked Sentinel-2 pixels. Pick an `operation` and pass its parameters — this is how the agent answers a SPECIFIC analytical request rather than only pre-wired ones. Operations: `stats` (mean/median/σ/percentiles); `histogram` (distribution shape; `bins`, `range`); `variogram` (spatial structure and ANISOTROPY — `lag_m` bin width in metres, `max_lag_m`, `direction_deg` azimuth 0=N/90=E, `tolerance_deg`, `model`; fits nugget/sill/range); `transect` (profile along a user-supplied `line`); `correlate` (relationship between `index` and `index2` on one scene — e.g. NDVI vs NDBI); `texture` (local heterogeneity; `window` px, `metric` stddev|range|mad); `cluster` (unsupervised zonation; `k`, `indices`); `change` (per-pixel delta between `date` and `date2`, masked on BOTH dates). Every operation uses only clear pixels (SCL cloud/shadow/cirrus masked) inside the drawn polygon. Use for: "variogram", "directional variogram", "semivariogram", "spatial autocorrelation", "how patchy", "correlation length", "distribution of NDVI", "profile along this line", "is NDVI related to built-up", "how rough is the surface", "zone this field", "percentiles".',
    params: z.object({
      operation: z.enum(['stats', 'histogram', 'variogram', 'transect', 'correlate', 'texture', 'cluster', 'change']).describe('Which analysis to run.'),
      index: z.enum(['NDVI', 'NDWI', 'NDBI', 'EVI', 'NBR', 'SAVI']).optional().describe('Spectral index to analyze (default NDVI).'),
      index2: z.string().optional().describe('Second index — `correlate` only.'),
      indices: z.array(z.string()).optional().describe('Indices to cluster jointly — `cluster` only (default: [index]).'),
      date: z.string().optional().describe('Target date YYYY-MM-DD; the clearest scene within ±30 days is used. For `change`, this is the BEFORE date.'),
      date2: z.string().optional().describe('AFTER date YYYY-MM-DD — `change` only.'),
      lag_m: z.number().optional().describe('Variogram lag-bin WIDTH in metres (e.g. 40). Must be ≥ the pixel size.'),
      max_lag_m: z.number().optional().describe('Largest variogram lag in metres (default: half the AOI diagonal).'),
      direction_deg: z.number().optional().describe('Variogram azimuth: 0 = north, 90 = east. Omit for omnidirectional.'),
      tolerance_deg: z.number().optional().describe('Half-angle admitted around `direction_deg` (default 22.5).'),
      model: z.enum(['auto', 'spherical', 'exponential', 'gaussian']).optional().describe('Variogram model to fit (default auto — best RMSE).'),
      bins: z.number().optional().describe('Histogram bin count (default 20).'),
      range: z.array(z.number()).optional().describe('Histogram [min, max] (default: data range).'),
      line: z.array(z.array(z.number())).optional().describe('Transect line as [[lon,lat],[lon,lat],…].'),
      samples: z.number().optional().describe('Transect sample count (default 100).'),
      window: z.number().optional().describe('Texture window size in pixels, odd, ≥3 (default 3).'),
      metric: z.enum(['stddev', 'range', 'mad']).optional().describe('Texture metric (default stddev).'),
      k: z.number().optional().describe('Cluster count (default 4).'),
      threshold: z.number().optional().describe('Change magnitude counted as real movement (default 0.05).'),
      bracket: z.boolean().optional().describe('`change` only: take the BEFORE scene from the 45 days up to `date` and the AFTER scene from the 45 days from `date2`, instead of the clearest scene within ±30 days of each. Use it when an event happened somewhere between the two dates, so neither scene can fall after (or before) it.'),
      baseline_min: z.number().optional().describe('`change` only: count only pixels whose `index` on the BEFORE date was at least this, e.g. NBR 0.15 to measure burn change on vegetated ground only. The result reports the share of the area this keeps; fewer than 30 pixels is refused as too few.'),
      max_size: z.number().optional().describe('Longest-edge pixel budget, 32–512 (default 256). Raise for finer lags on a large AOI.'),
    }),
    output: 'mixed',
    sensors: ['sentinel-2-l2a'],
    resolution_m: 10,
    limits: { maxAreaKm2: 1000, earliest: '2015-06-23', needsDates: true },
    cost: { typicalSeconds: 15 },
    cacheTtl: { liveMs: 6 * HOUR, settledMs: 30 * DAY },
    limitations: [
      'Every operation uses only clear pixels (SCL cloud, shadow and cirrus masked) inside the drawn polygon.',
      'Pixel budget is capped (default 256, maximum 512 on the longest edge), so over a large AOI the grid is coarser than 10 m.',
      'Variogram lags below the pixel size are refused; change detection masks pixels cloudy on either date.',
    ],
    confidence: 'high when many clear pixels support the statistic; the result reports the clear-pixel count so thin support is visible.',
    staticChecks: (ctx, args) => analyzeArgErrors(args, ctx.bbox).map((message) => fail('static', 'analyze_args', message)),
    run: (ctx, args) => analyzeRaster(ctx, args),
  }),
  defineOperation({
    name: 'inspect_imagery',
    label: 'Rendering the AOI and looking at it...',
    version: '1.0.0',
    description: 'LOOK at the AOI: render it from real Sentinel-2 pixels and have a vision model describe what is actually visible, then place that description next to the SCL cloud numbers for the same scene. Use this to sanity-check a statistic against the picture — cloud, haze, snow, sensor artefact, water — or to answer "what am I looking at here?" and "does this number make sense?". The true-colour view is deliberately NOT cloud-masked, so cloud is visible rather than removed. Requires a vision-capable model (VLM_ENDPOINT + VLM_MODEL, or an OpenAI/Claude/Gemini key in Settings); when none is configured it says so and describes nothing.',
    params: z.object({
      subject: z.enum(['truecolor', 'index']).optional().describe('What to render: true colour (default) or a spectral index map.'),
      index: z.enum(['NDVI', 'NDWI', 'NDBI', 'EVI', 'NBR', 'SAVI']).optional().describe('Index to render when subject is "index".'),
      question: z.string().optional().describe('A specific question about the picture (e.g. "is this area under cloud?").'),
      date: z.string().optional().describe('Target date YYYY-MM-DD; a scene within ±30 days is used.'),
      scene: z.enum(['clearest', 'newest']).optional().describe('"clearest" (default) inspects the same scene the statistics used; "newest" inspects the latest acquisition regardless of cloud — the right choice for "is it cloudy right now?".'),
      max_size: z.number().optional().describe('Rendered image longest edge, 256–1024 (default 768).'),
    }),
    output: 'text',
    sensors: ['sentinel-2-l2a'],
    resolution_m: 10,
    limits: { maxAreaKm2: 1000, earliest: '2015-06-23', needsDates: true },
    cost: { typicalSeconds: 20 },
    // Not cached: a vision-language model answers, so the text is not reproducible.
    limitations: [
      'Needs a vision-capable model (VLM_ENDPOINT + VLM_MODEL, or an OpenAI / Claude / Gemini key in Settings); with none configured it describes nothing.',
      'The true-colour view is deliberately not cloud-masked, so cloud stays visible.',
      'A description is an interpretation of a picture at 10 m, not a measurement.',
    ],
    confidence: 'low to medium: a vision model\'s reading of the image, shown beside the measured cloud numbers for the same scene.',
    run: (ctx, args) => inspectImagery(ctx, args),
  }),
]
