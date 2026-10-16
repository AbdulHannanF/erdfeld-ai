// Dev helper: node eval/ops/explore.mjs <op> <lon> <lat> <halfKm> '<json args>'
import { Http, runJob, boxAoi, warm } from './lib.mjs'
const http = new Http(process.env.BASE || 'https://erdfeld-web-707586221016.us-central1.run.app')
console.log(JSON.stringify((await warm(http)).health))
const [op, lon, lat, km, args] = [process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5], JSON.parse(process.argv[6] || '{}')]
const r = await runJob(http, { op, args, aoi: boxAoi(lon, lat, km) })
const res = r.result
console.log(JSON.stringify({ ...r, result: undefined }))
if (res) {
  const strip = (l) => ({ ...l, imageBase64: l.imageBase64 ? `<${l.imageBase64.length}>` : undefined, geojson: l.geojson ? { n: l.geojson.features?.length, f0: JSON.stringify(l.geojson.features?.[0]).slice(0, 300) } : undefined })
  console.log(JSON.stringify({ ...res, layers: res.layers.map(strip), charts: res.charts?.map((c) => ({ ...c, spec: JSON.stringify(c.spec).slice(0, 500) })) }, null, 1).slice(0, 7000))
}
