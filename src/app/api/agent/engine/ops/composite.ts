/** Composite operation: a cloud-masked median over a date window, run by the Python geo service
 *  (services/geo). Present in the registry only while GEO_SERVICE_URL is configured; without it
 *  the planner never sees the tool (ADR-0001 §1, Q-22 backend routing). */

import { z } from 'zod'

import type { ValidationCheck } from '@/lib/geo-result'

import { isGeoServiceConfigured } from '../../lib/geo-service'
import { COLORMAP_CHOICES, normalizeColormap, parseRasterSpec, parseRescale } from '../../lib/raster-render'
import { COMPOSITE_INDICES, MAX_SPAN_DAYS, THIN_OBS, resolveCompositeWindow, runComposite, spanDays } from '../../tools/composite'
import { HOUR, DAY, defineOperation, type AnyOperation } from '../operation'
import { checkRasterBands, fail, pass, warn } from '../validate'

const S2_EARLIEST = '2015-06-23'

export const compositeOps: AnyOperation[] = [
  defineOperation({
    name: 'composite',
    label: 'Building a cloud-free median composite...',
    version: '1.0.0',
    description: 'Cloud-FREE Sentinel-2 composite for a date window: the per-pixel MEDIAN of every clear observation (cloud, shadow and cirrus masked per pixel) between `start` and `end`, shown as a map layer with the real p2–p98 range. Use for "cloud-free", "median", "seasonal / monthly / growing-season average", "best available picture of September", or any window where a single scene would be cloudy or unrepresentative. Pass an `expression` (NDVI, NDWI, NDBI, EVI, NBR, SAVI, or band math such as "(B11-B08)/(B11+B08)") OR `bands` (1 band, or 3 in R,G,B order). The result is NOT one acquisition date: it reports how many scenes and clear observations per pixel it rests on. For a specific day use fetch_ndvi / render_raster instead.',
    params: z.object({
      expression: z.string().optional().describe(`A named index (${COMPOSITE_INDICES.join(', ')}) or band math over Sentinel-2 bands with + - * / and parentheses, e.g. "(B08-B04)/(B08+B04)". The index is computed on the median reflectance.`),
      bands: z.array(z.string()).optional().describe('1 band (single-band map) or 3 bands in R,G,B order, e.g. ["B04","B03","B02"] for a true-colour composite. Use instead of `expression`.'),
      start: z.string().optional().describe(`YYYY-MM-DD window start (default: 30 days before end). The window may span at most ${MAX_SPAN_DAYS} days.`),
      end: z.string().optional().describe('YYYY-MM-DD window end, inclusive (default: today).'),
      colormap: z.string().optional().describe('Single band / expression only: rdylgn (default for indices), viridis (default otherwise), magma, inferno, plasma, cividis, greys, rdbu, spectral, terrain, blues, ylgn (append _r to reverse).'),
      rescale: z.array(z.number()).optional().describe('[min, max] display stretch for a single band / expression. Omit to use the composite\'s own p2–p98.'),
      resolution: z.number().optional().describe('Pixel size in metres, 10–100 (default 10). Raise it for a large AOI.'),
      max_cloud: z.number().optional().describe('Optional scene-level cloud-cover ceiling in % (pixels are masked regardless). Omit unless the user asks.'),
    }),
    output: 'raster',
    sensors: ['sentinel-2-l2a'],
    resolution_m: 10,
    limits: { maxAreaKm2: 2500, earliest: S2_EARLIEST, needsDates: true },
    // Tiles are served by content id through /api/geo/tiles, not signed URLs, so the result keeps.
    cacheTtl: { liveMs: 6 * HOUR, settledMs: 30 * DAY },
    cost: { typicalSeconds: 15 },
    limitations: [
      'A median of the clear observations in the window, not an acquisition: change inside the window (harvest, flood, burn) is blended, and the result carries no single date.',
      'Cloud, shadow, cirrus, saturated and "dark area" pixels are masked per pixel with the SCL layer, so very dark surfaces can be under-represented; a pixel with no clear observation stays empty, never filled.',
      `A window of at most ${MAX_SPAN_DAYS} days and an AOI of at most 2,500 km² (25 million pixels at 10 m); a long window over a large AOI can still exceed the service's memory cap, which is reported, not truncated; Sentinel-2 L2A only, data from ${S2_EARLIEST}.`,
      'The first call for a new window takes tens of seconds (it reads every scene); an identical repeat is served from the service cache.',
    ],
    confidence: 'high: at least 90% of the AOI has a clear observation and every pixel has at least 3; medium at 60% valid and 3 clear observations on average; low otherwise (the median is then close to a single, possibly unrepresentative, date).',
    staticChecks: (ctx, args) => {
      const checks: ValidationCheck[] = []
      const expr = typeof args.expression === 'string' ? args.expression.trim() : ''
      if (expr && !args.bands && (COMPOSITE_INDICES as readonly string[]).includes(expr.toUpperCase())) {
        checks.push(pass('static', 'bands_exist', `${expr.toUpperCase()} is a supported index.`))
      } else {
        checks.push(checkRasterBands('sentinel-2-l2a', args))
      }

      const rgb = !expr && Array.isArray(args.bands) && args.bands.length === 3
      if (rgb && (args.colormap || args.rescale)) checks.push(fail('static', 'colormap', 'A colormap or rescale does not apply to a 3-band RGB composite. Omit them, or pass one band / an expression.'))
      else {
        if (args.colormap && !normalizeColormap(args.colormap)) checks.push(fail('static', 'colormap', `Unknown colormap "${args.colormap}". Choose one of: ${COLORMAP_CHOICES.join(', ')} (append _r to reverse).`))
        if (args.rescale) {
          const r = parseRescale(args.rescale, 1)
          if (!r.ok) checks.push(fail('static', 'rescale', r.error))
        }
      }

      const { start, end } = resolveCompositeWindow(args)
      for (const [k, v] of [['start', start], ['end', end]] as const) {
        if (v < S2_EARLIEST) checks.push(fail('static', 'dates_after_earliest', `\`${k}\` (${v}) is before Sentinel-2 data begins (${S2_EARLIEST}).`))
      }
      if (Date.parse(`${start}T00:00:00Z`) <= Date.parse(`${end}T00:00:00Z`)) {
        const days = spanDays(start, end)
        checks.push(days > MAX_SPAN_DAYS
          ? fail('static', 'window_span', `The window ${start}..${end} is ${days} days; composite takes at most ${MAX_SPAN_DAYS}. Shorten it or run two composites.`)
          : pass('static', 'window_span', `The window ${start}..${end} is ${days} days (limit ${MAX_SPAN_DAYS}).`))
      }

      const res = args.resolution
      if (res != null && (!Number.isFinite(res) || res < 10 || res > 100)) checks.push(fail('static', 'resolution', 'resolution must be between 10 and 100 metres.'))
      if (args.max_cloud != null && (args.max_cloud < 0 || args.max_cloud > 100)) checks.push(fail('static', 'max_cloud', 'max_cloud is a percentage between 0 and 100.'))
      return checks
    },
    dynamicChecks: (output) => {
      const d = output.summary_data
      const mean = d?.obs_per_pixel_mean
      if (typeof mean !== 'number') return []
      return [mean < THIN_OBS
        ? warn('dynamic', 'observations_per_pixel', `Only ${mean} clear observations per pixel on average: this "median" is close to a single date.`)
        : pass('dynamic', 'observations_per_pixel', `${mean} clear observations per pixel on average.`)]
    },
    run: (ctx, args) => runComposite(ctx, args),
    enabled: isGeoServiceConfigured,
  }),
]
