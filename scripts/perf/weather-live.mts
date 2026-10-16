/** Live check of the four weather cases from the live evaluation, straight against Open-Meteo (no model).
 *    NODE_USE_ENV_PROXY=1 npx vite-node --config vitest.config.ts scripts/perf/weather-live.mts */
import { executeTool } from '../../src/app/api/agent/tools/index'

const sq = (lng: number, lat: number): any => ({ type: 'Polygon', coordinates: [[[lng - 0.02, lat - 0.02], [lng + 0.02, lat - 0.02], [lng + 0.02, lat + 0.02], [lng - 0.02, lat + 0.02], [lng - 0.02, lat - 0.02]]] })
const cases: Array<[string, any, Record<string, any>, string[]]> = [
  ['wx01 Dhaka July 2024 daily rain', sq(90.41, 23.81), { start: '2024-07-01', end: '2024-07-31', variables: ['precipitation_sum'] }, ['total_precip_mm', 'wettest_day_mm', 'wettest_day', 'rain_days_ge_1mm']],
  ['wx02 Niamey Jun-Sep 2023 season', sq(2.11, 13.51), { start: '2023-06-01', end: '2023-09-30', variables: ['precipitation_sum'] }, ['total_precip_mm', 'rain_days_ge_1mm']],
  ['wx03 Phoenix July 2023 max temp > 43', sq(-112.07, 33.45), { start: '2023-07-01', end: '2023-07-31', variables: ['temperature_2m_max'], threshold: 43 }, ['hottest_day_c', 'hottest_day', 'days_above_threshold', 'days_with_data']],
  ['wx04 Nairobi 2023 monthly rainfall', sq(36.82, -1.29), { start: '2023-01-01', end: '2023-12-31', variables: ['precipitation_sum'] }, ['total_precip_mm', 'annual_precip_mm']],
]
for (const [name, aoi, args, keys] of cases) {
  const r = await executeTool('fetch_weather_history', aoi, args)
  console.log(name, '|', r.status, '|', keys.map((k) => `${k}=${r.stats?.[k]}`).join(' '), '| provenance ok:', r.validation.find((c) => c.id === 'provenance_sources')?.status)
}
const p = await executeTool('fetch_precipitation_history', sq(36.82, -1.29), { include_raster: true, months_back: 12 })
console.log('precip history |', p.status, '| layers', p.layers.length, '| sources', p.provenance.sources.join('; '), '| raster note:', /could not be added/.test(p.summary) ? 'MISSING' : 'present')
process.exit(0)
