/** Live check of the DEM raster statistics against known summits.
 *    NODE_USE_ENV_PROXY=1 npx vite-node --config vitest.config.ts scripts/perf/dem-live.mts */
import { locateCopDemTiles, readCopDemStats } from '../../src/app/api/agent/lib/dem-raster'

const boxes: Array<[string, [number, number, number, number], string]> = [
  ['Matterhorn 6 km', box(7.66, 45.98, 6), 'summit 4478 m'],
  ['Everest 8 km', box(86.93, 27.99, 8), 'summit 8849 m'],
  ['Alps 144 km2 across 46N', [7.5824, 45.9257, 7.7376, 46.0343], 'Dufourspitze/Matterhorn area, ALOS read 4348 m'],
]
function box(lng: number, lat: number, km: number): [number, number, number, number] {
  const dLat = km / 2 / 110.54
  const dLng = km / 2 / (111.32 * Math.cos((lat * Math.PI) / 180))
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat]
}
for (const [name, b, truth] of boxes) {
  const aoi = { type: 'Polygon', coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]] }
  const tiles = await locateCopDemTiles(b)
  const t0 = Date.now()
  const s = tiles ? await readCopDemStats(aoi, tiles) : null
  console.log(name, '| tiles', tiles?.map((t) => t.id).join(','), '|', s ? `min ${s.minM} max ${s.maxM} mean ${s.meanM.toFixed(0)} std ${s.stdM.toFixed(0)} px ${s.pixels} gsd ${s.gsdM.toFixed(1)} tiles ${s.tiles}` : 'NULL', `| ${Date.now() - t0} ms | expected ${truth}`)
}
process.exit(0)
