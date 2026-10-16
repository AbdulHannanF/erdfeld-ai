// Dev helper: which small AOIs near the Sutlej have two Sentinel-1 scenes covering >= 80%?
//   node eval/ops/probe-flood.mjs lon,lat lon,lat ...   (0.65 km half-size, the UI's drawn rectangle)
import { Http, runJob, boxAoi } from './lib.mjs'
const http = new Http(process.env.BASE || 'https://erdfeld-web-707586221016.us-central1.run.app')
const pts = process.argv.slice(2).map((s) => s.split(',').map(Number))
const runs = await Promise.all(pts.map((p) => runJob(http, { op: 'map_flood', args: { before: '2025-07-20', after: '2025-09-02', include_roads: false }, aoi: boxAoi(p[0], p[1], 0.65) })))
runs.forEach((r, i) => console.log(pts[i].join(","), JSON.stringify(r.job), r.error, r.result?.status, r.result?.layers?.length, (r.result?.summary || r.error || '').slice(0, 160).replace(/\n/g, ' ')))
