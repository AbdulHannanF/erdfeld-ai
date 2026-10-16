/** Reanalysis climate history. */

import { z } from 'zod'

import { fetchPrecipitationHistory, fetchWeatherHistory, MAX_WEATHER_WINDOW_DAYS, WEATHER_VARIABLES } from '../../tools/climate'
import { fail } from '../validate'
import { HOUR, DAY, defineOperation, type AnyOperation } from '../operation'

export const climateOps: AnyOperation[] = [
  defineOperation({
    name: 'fetch_weather_history',
    label: 'Fetching Weather Data...',
    version: '1.0.0',
    description: 'Fetch historical weather from ERA5 reanalysis at the AOI centroid for ANY past period since 1940: daily or monthly temperature (mean, daily maximum, daily minimum) and precipitation. Give `start` and `end` (YYYY-MM-DD) for a question about a past period ("July 2023", "the 2022 monsoon", "how many days above 43 C"); omit them for the last 12 months. Windows up to 62 days come back day by day, longer ones by month (set `daily` to override). `threshold` counts the days the first variable exceeded a value.',
    params: z.object({
      start: z.string().optional().describe('Window start YYYY-MM-DD (default: the first of the month a year ago).'),
      end: z.string().optional().describe('Window end YYYY-MM-DD (default: today). ERA5 trails the present by about 5 days.'),
      variables: z.array(z.enum(Object.keys(WEATHER_VARIABLES) as [string, ...string[]])).optional().describe('Any of temperature_2m_mean, temperature_2m_max, temperature_2m_min, precipitation_sum (default: mean temperature and precipitation).'),
      daily: z.boolean().optional().describe('Force day-by-day (true) or monthly (false) output.'),
      threshold: z.number().optional().describe('Count the days the FIRST variable was strictly above this value (e.g. 43 with temperature_2m_max).'),
    }),
    limits: { earliest: '1940-01-01' },
    output: 'table',
    sensors: ['era5'],
    resolution_m: 25000,
    cost: { typicalSeconds: 3 },
    cacheTtl: { liveMs: HOUR, settledMs: 30 * DAY },
    limitations: [
      'ERA5 reanalysis at the AOI centroid on a roughly 25 km grid: a regional climate signal, not a station measurement.',
      'No rainy-season or climatology framing (use fetch_precipitation_history for that). ERA5 trails the present by about 5 days.',
    ],
    staticChecks: (_ctx, args) => {
      if (typeof args.start === 'string' && typeof args.end === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.start) && /^\d{4}-\d{2}-\d{2}$/.test(args.end)) {
        const days = (Date.parse(args.end) - Date.parse(args.start)) / 86_400_000 + 1
        if (days > MAX_WEATHER_WINDOW_DAYS) return [fail('static', 'weather_window', `The window is ${Math.round(days)} days; fetch_weather_history takes at most ${MAX_WEATHER_WINDOW_DAYS} (about 10 years).`)]
      }
      return []
    },
    confidence: 'medium: a well-validated reanalysis, coarse relative to the AOI.',
    run: (ctx, args) => fetchWeatherHistory(ctx, args),
  }),
  defineOperation({
    name: 'fetch_precipitation_history',
    label: 'Fetching precipitation climatology + anomalies (ERA5 + CHIRPS)...',
    version: '1.0.0',
    description: 'Fetch 30-year monthly precipitation climatology (ERA5 1991–2020 reference period) and last 24 months of anomalies for the AOI centroid. Optionally adds a CHIRPS monthly rainfall raster layer to the map. Use for: "is it getting drier here?", "rainfall history", "precipitation history", "rainy season", "when does it rain?", "drought", "wet year", "dry year", "annual rainfall", "monthly rainfall", "how much rain falls here?", "climate trend", "rainfall anomaly", "below-average rain", "monsoon timing". Answers questions about whether recent rainfall is above or below the 30-year average.',
    params: z.object({
      months_back: z.number().optional().describe('How many recent months to include in the anomaly table (default: 24, max: 60).'),
      include_raster: z.boolean().optional().describe('Whether to fetch a CHIRPS monthly rainfall raster and add it to the map (default: true). Set to false for stats-only output.'),
    }),
    output: 'mixed',
    sensors: ['era5', 'chirps'],
    resolution_m: 25000,
    cost: { typicalSeconds: 5 },
    cacheTtl: { liveMs: DAY },
    limitations: [
      'The climatology and anomalies are an ERA5 grid cell at the AOI centroid (about 25 km), labelled clip "centroid"; they can miss local or orographic variation.',
      'Anomalies compare recent months to the 1991-2020 reference period.',
      'The CHIRPS raster trails the present by about 2-3 months.',
    ],
    confidence: 'medium: reanalysis-based; direction of an anomaly is more reliable than its size.',
    run: (ctx, args) => fetchPrecipitationHistory(ctx, args),
  }),
]
