/** Memory check for map_flood: runs the real tool on a case AOI from the live evaluation's cases.json
 *  and samples process.memoryUsage() while it runs.
 *
 *    NODE_USE_ENV_PROXY=1 npx vite-node --config vitest.config.ts scripts/perf/flood-memory.mts fl05
 *
 *  Prints peak heapUsed / rss and the heapUsed at each progress message. Cap the heap the way the
 *  deployed service does (`NODE_OPTIONS=--max-old-space-size=1536`) to see whether it would fit. */
import fs from 'node:fs'
import { mapFlood } from '../../src/app/api/agent/tools/flood'

const ids = (process.argv[2] ?? 'fl05').split('+') // 'fl02+fl05' runs both at once, like two job workers
const argsFlag = process.argv.find((a) => a.startsWith('--args='))
const cases = JSON.parse(fs.readFileSync('eval/live/cases.json', 'utf8'))
const list = Array.isArray(cases) ? cases : cases.cases

// The plan arguments the deployed model produced for each flood case (results-2026-10-15.jsonl).
const PLAN_ARGS: Record<string, any> = {
  fl01: { start: '2025-07-01', end: '2025-09-30' },
  fl02: { after: '2022-08-31', before: '2022-06-15', include_roads: true },
  fl03: { after: '2024-11-03', before: '2024-10-15' },
  fl04: { after: '2023-09-16', before: '2023-09-01', include_roads: true },
  fl05: { start: '2024-05-01', end: '2024-06-30' },
}
function setup(id: string) {
  const c = list.find((x: any) => x.id === id)
  if (!c) throw new Error(`no case ${id}`)
  const args = argsFlag ? JSON.parse(argsFlag.slice(7)) : PLAN_ARGS[id]
  const [lng, lat] = c.center
  const dLat = c.side_km / 2 / 110.54
  const dLng = c.side_km / 2 / (111.32 * Math.cos((lat * Math.PI) / 180))
  const bbox: [number, number, number, number] = [lng - dLng, lat - dLat, lng + dLng, lat + dLat]
  const aoi = { type: 'Polygon', coordinates: [[[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]], [bbox[0], bbox[1]]]] }
  return { id, c, args, bbox, aoi, lat, lng }
}

const mb = (n: number) => Math.round(n / 1048576)
let peakHeap = 0
let peakRss = 0
const sample = () => {
  const m = process.memoryUsage()
  peakHeap = Math.max(peakHeap, m.heapUsed)
  peakRss = Math.max(peakRss, m.rss)
}
const timer = setInterval(sample, 50)
const t0 = Date.now()
await Promise.all(ids.map(async (id) => {
  const { c, args, bbox, aoi, lat, lng } = setup(id)
  const ctx: any = {
    aoi, bbox, centroid: { lat, lng }, areaKm2: c.side_km ** 2,
    runTool: async () => { throw new Error('not available') },
    emit: (_t: string, e: any) => {
      sample()
      console.log(`[${id} ${((Date.now() - t0) / 1000).toFixed(1)}s heap ${mb(process.memoryUsage().heapUsed)} MB] ${String(e?.content ?? '').trim()}`)
    },
  }
  console.log(`${id} ${c.place} ${c.side_km} km side, args ${JSON.stringify(args)}`)
  const out = await mapFlood(ctx, args)
  sample()
  console.log(`${id}: ${out.summary.split('\n')[0]}`)
  console.log(`${id}: scenes_scanned=${out.summary_data?.scenes_scanned} grid_gsd_m=${out.summary_data?.grid_gsd_m} affected_buildings=${out.summary_data?.affected_buildings} buildings_scanned=${out.summary_data?.buildings_scanned}`)
}))
clearInterval(timer)
console.log(`PEAK heapUsed ${mb(peakHeap)} MB, PEAK rss ${mb(peakRss)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s, ${ids.length} flood run(s) at once`)
process.exit(0)
