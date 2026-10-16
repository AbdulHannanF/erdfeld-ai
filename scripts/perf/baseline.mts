/** Q-14 baseline: wall time + per-stage attribution of the real data tools.
 *
 *    NODE_USE_ENV_PROXY=1 npx tsx scripts/perf/baseline.mts [--aoi=kasur,lahore] [--tool=fetch_ndvi]
 *
 *  Calls the real tools through `executeTool` for 5 fixed AOIs, cold (in-process cache
 *  reset) then warm (same process, cache populated). Time is attributed to stages from
 *  OUTSIDE the app: `globalThis.fetch` is wrapped to record every request (host, path
 *  kind, start/end offset, bytes, status). Nothing under src/ is modified.
 *
 *  Writes eval/perf/baseline-<date>.json and regenerates the tables in eval/PERF.md
 *  (text after the `<!-- analysis -->` marker is preserved by hand-edits).
 *
 *  `--label=after-q15` writes eval/perf/after-q15-<date>.json and .md instead and leaves
 *  eval/PERF.md (the recorded baseline) untouched, so a later run can be compared with it.
 *  Every call also records `firstLayerMs`: when the first layer was drawable (a `layer_preview`
 *  event from the tool) or, for tools without one, when the call returned.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Module, { createRequire } from 'node:module'

// tools/index pulls in vega -> vega-canvas, whose node build uses top-level await and cannot be
// require()d under tsx's CJS transform. None of the measured tools render charts, so stub that
// one module (from outside src/) before the dynamic imports below.
const nodeRequire = createRequire(import.meta.url)
const M = Module as any
const origLoad = M._load
M._load = function (request: string, ...rest: any[]) {
  if (request === 'vega-canvas') return { canvas: () => null, image: () => null, loadImage: async () => null, saveImage: async () => null }
  return origLoad.call(this, request, ...rest)
}
void nodeRequire
const { executeTool } = await import('../../src/app/api/agent/tools/index')
const { _resetCache } = await import('../../src/app/api/agent/lib/cache')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// ---------------------------------------------------------------- AOIs
interface Aoi { id: string; name: string; why: string; bbox: [number, number, number, number] }
const AOIS: Aoi[] = [
  { id: 'kasur', name: 'Kasur, PK', why: 'Fixed baseline AOI (irrigated Punjab cropland, hazy/dusty).', bbox: [74.05, 31.12, 74.08, 31.15] },
  { id: 'lahore', name: 'Lahore edge, PK', why: 'Fixed baseline AOI (peri-urban edge, mixed built/crop).', bbox: [74.20, 31.28, 74.23, 31.31] },
  { id: 'beauce', name: 'Beauce, FR', why: 'Temperate European large-field arable; frequent cloud, different S2 tile/UTM zone (31U).', bbox: [1.80, 48.30, 1.83, 48.33] },
  { id: 'iowa', name: 'Story Co., Iowa, US', why: 'US Midwest row-crop grid; Landsat/S2 overlap region, UTM zone 15.', bbox: [-93.70, 42.00, -93.67, 42.03] },
  { id: 'kitale', name: 'Kitale, KE', why: 'East African highland maize; equatorial cloud, southern-hemisphere-adjacent tiling, high elevation.', bbox: [34.98, 1.00, 35.01, 1.03] },
]
const toPolygon = ([w, s, e, n]: number[]) => ({
  type: 'Polygon',
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
})
const bboxKm2 = ([w, s, e, n]: number[]) =>
  (e - w) * 111.32 * Math.cos(((s + n) / 2) * Math.PI / 180) * (n - s) * 110.57

// ---------------------------------------------------------------- tools
const DAY = 86_400_000
const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
const now = Date.now()
interface ToolSpec { name: string; tool: string; args: Record<string, any> }
const TOOLS: ToolSpec[] = [
  { name: 'fetch_ndvi', tool: 'fetch_ndvi', args: {} },
  { name: 'render_raster', tool: 'render_raster', args: { bands: ['B08'], start: iso(now - 30 * DAY), end: iso(now) } },
  { name: 'compute_spectral_index', tool: 'compute_spectral_index', args: { index: 'NDWI' } },
  { name: 'fetch_dem', tool: 'fetch_dem', args: {} },
]

// ---------------------------------------------------------------- fetch instrumentation
type Kind = 'stac_search' | 'titiler_npy' | 'titiler_npy_after' | 'titiler_stats' | 'titiler_png' | 'tiles' | 'dem' | 'other'
interface Req {
  host: string; path: string; method: string; kind: Kind
  startMs: number; endMs: number; ttfbMs: number; bytes: number | null; status: number | string
}
function classify(u: URL, method: string): Kind {
  const p = u.pathname
  if (/opentopodata|elevation/i.test(u.host)) return 'dem'
  if (/\/search\b|\/collections\/[^/]+\/items/.test(p) && /stac|earth-search|planetarycomputer/i.test(u.host + p)) return 'stac_search'
  if (/\/tiles\//.test(p)) return 'tiles'
  if (/statistics/.test(p)) return 'titiler_stats'
  if (/\.npy$/.test(p)) return 'titiler_npy'
  if (/\.(png|jpg|jpeg|webp)$/.test(p)) return 'titiler_png'
  void method
  return 'other'
}
let recording: Req[] | null = null
let t0 = 0
const realFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (async (input: any, init?: any) => {
  const sink = recording
  if (!sink) return realFetch(input, init)
  const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase()
  let u: URL
  try { u = new URL(urlStr) } catch { return realFetch(input, init) }
  const rec: Req = {
    host: u.host, path: u.pathname, method, kind: classify(u, method),
    startMs: performance.now() - t0, endMs: 0, ttfbMs: 0, bytes: null, status: 'pending',
  }
  sink.push(rec)
  try {
    const res = await realFetch(input, init)
    rec.status = res.status
    rec.ttfbMs = performance.now() - t0 - rec.startMs
    rec.endMs = performance.now() - t0 // overwritten once the body is drained
    // Drain a clone so duration includes body transfer and bytes are real.
    res.clone().arrayBuffer().then((b) => {
      rec.bytes = b.byteLength
      rec.endMs = performance.now() - t0
    }).catch(() => { rec.endMs = performance.now() - t0 })
    return res
  } catch (e: any) {
    rec.status = `error:${e?.cause?.code ?? e?.name ?? 'unknown'}`
    rec.endMs = performance.now() - t0
    throw e
  }
}) as typeof fetch

// ---------------------------------------------------------------- stage maths
const STAGES = ['stac_search', 'titiler_npy', 'titiler_npy_after', 'titiler_stats', 'titiler_png', 'tiles', 'dem', 'other'] as const
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Union length of [start,end] intervals (parallel requests counted once). */
function unionMs(iv: Array<[number, number]>): number {
  const s = [...iv].sort((a, b) => a[0] - b[0])
  let total = 0, curS = -1, curE = -1
  for (const [a, b] of s) {
    if (curE < a) { if (curE > curS) total += curE - curS; curS = a; curE = b }
    else if (b > curE) curE = b
  }
  if (curE > curS) total += curE - curS
  return total
}
const median = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!s.length) return NaN
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// ---------------------------------------------------------------- run one call
interface CallRec {
  totalMs: number
  ok: boolean
  failure?: string
  summaryHead: string
  layerCount: number
  tileUrl?: string
  /** ms from call start to the first layer being drawable (preview event, else the end of the call) */
  firstLayerMs: number
  requests: number
  failedRequests: number
  bytes: number
  /** wall-clock union per stage (parallel overlap counted once) */
  stageWallMs: Record<string, number>
  /** sum of request durations per stage (shows parallelism when > wall) */
  stageSumMs: Record<string, number>
  stageCount: Record<string, number>
  /** time inside the call with no request in flight (app compute / waiting) */
  noRequestMs: number
  hosts: Record<string, { requests: number; sumMs: number; bytes: number }>
  reqs: Req[]
}
async function runCall(spec: ToolSpec, aoi: Aoi): Promise<{ rec: CallRec; result: any }> {
  const reqs: Req[] = []
  recording = reqs
  t0 = performance.now()
  let result: any, failure: string | undefined
  let previewMs: number | null = null
  try {
    result = await executeTool(spec.tool, toPolygon(aoi.bbox), spec.args, (event) => {
      if (event === 'layer_preview' && previewMs == null) previewMs = performance.now() - t0
    })
  } catch (e: any) {
    failure = `threw: ${e?.message ?? e}`
  }
  const totalMs = performance.now() - t0
  await sleep(150) // let body drains of un-awaited clones settle
  recording = null
  // Split feature.npy reads: the first concurrent batch (all started before the first one
  // finished) is the scene-scoring batch; npy reads issued after it are the follow-up
  // stats / render reads that run one after another.
  const npy = reqs.filter((r) => r.kind === 'titiler_npy').sort((a, b) => a.startMs - b.startMs)
  if (npy.length) {
    const firstEnd = Math.min(...npy.map((r) => r.endMs || Infinity))
    for (const r of npy) if (r.startMs >= firstEnd) r.kind = 'titiler_npy_after'
  }
  const layers = result ? [result.layer, ...(result.layers ?? [])].filter(Boolean) : []
  const tileUrl = layers.find((l: any) => l?.tileUrl)?.tileUrl as string | undefined
  if (!failure && result && layers.length === 0) failure = 'no layer returned (see summaryHead)'
  const clip = (r: Req) => [r.startMs, Math.min(r.endMs, totalMs)] as [number, number]
  const stageWallMs: Record<string, number> = {}, stageSumMs: Record<string, number> = {}, stageCount: Record<string, number> = {}
  for (const k of STAGES) {
    const rs = reqs.filter((r) => r.kind === k)
    stageWallMs[k] = unionMs(rs.map(clip))
    stageSumMs[k] = rs.reduce((a, r) => a + (r.endMs - r.startMs), 0)
    stageCount[k] = rs.length
  }
  const hosts: CallRec['hosts'] = {}
  for (const r of reqs) {
    const h = (hosts[r.host] ??= { requests: 0, sumMs: 0, bytes: 0 })
    h.requests++; h.sumMs += r.endMs - r.startMs; h.bytes += r.bytes ?? 0
  }
  return {
    result,
    rec: {
      totalMs, ok: !failure, failure,
      summaryHead: String(result?.summary ?? '').replace(/\s+/g, ' ').slice(0, 220),
      layerCount: layers.length, tileUrl,
      firstLayerMs: previewMs ?? totalMs,
      requests: reqs.length,
      failedRequests: reqs.filter((r) => typeof r.status !== 'number' || r.status >= 400).length,
      bytes: reqs.reduce((a, r) => a + (r.bytes ?? 0), 0),
      stageWallMs, stageSumMs, stageCount,
      noRequestMs: Math.max(0, totalMs - unionMs(reqs.map(clip))),
      hosts, reqs,
    },
  }
}

// ---------------------------------------------------------------- time to first tile
interface TileRec { z: number; x: number; y: number; ms: number | null; status: number | string; bytes: number | null; error?: string }
async function fetchTile(tileUrl: string, bbox: Aoi['bbox'], z: number): Promise<TileRec> {
  const lon = (bbox[0] + bbox[2]) / 2, lat = (bbox[1] + bbox[3]) / 2
  const n = 2 ** z
  const x = Math.floor(((lon + 180) / 360) * n)
  const latR = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n)
  const url = tileUrl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
    .replace('{s}', 'a').replace('{r}', '')
  const s = performance.now()
  try {
    const res = await realFetch(url, { signal: AbortSignal.timeout(30_000) })
    const buf = await res.arrayBuffer()
    return { z, x, y, ms: performance.now() - s, status: res.status, bytes: buf.byteLength }
  } catch (e: any) {
    return { z, x, y, ms: null, status: 'error', bytes: null, error: String(e?.cause?.code ?? e?.message ?? e) }
  }
}

// ---------------------------------------------------------------- main
interface Row {
  tool: string; aoi: string
  cold: CallRec; warm: CallRec
  tileCold?: TileRec; tileRepeat?: TileRec
}
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]?.split(',')
const aoiFilter = arg('aoi'), toolFilter = arg('tool')
const rows: Row[] = []

for (const aoi of AOIS) {
  if (aoiFilter && !aoiFilter.includes(aoi.id)) continue
  for (const spec of TOOLS) {
    if (toolFilter && !toolFilter.includes(spec.name)) continue
    _resetCache()
    const cold = await runCall(spec, aoi)
    const warm = await runCall(spec, aoi) // same process, in-memory cache populated
    const row: Row = { tool: spec.name, aoi: aoi.id, cold: cold.rec, warm: warm.rec }
    if (cold.rec.tileUrl) {
      row.tileCold = await fetchTile(cold.rec.tileUrl, aoi.bbox, 14)
      row.tileRepeat = await fetchTile(cold.rec.tileUrl, aoi.bbox, 14)
    }
    rows.push(row)
    const t = row.tileCold?.ms
    console.log(
      `${aoi.id.padEnd(7)} ${spec.name.padEnd(22)} cold ${(cold.rec.totalMs / 1000).toFixed(2)}s first-layer ${(cold.rec.firstLayerMs / 1000).toFixed(2)}s (${cold.rec.requests} req) ` +
      `warm ${(warm.rec.totalMs / 1000).toFixed(2)}s (${warm.rec.requests} req) tile ${t == null ? 'n/a' : (t / 1000).toFixed(2) + 's'} ` +
      `${cold.rec.ok ? 'OK' : 'FAIL: ' + cold.rec.failure}`,
    )
  }
}

// ---------------------------------------------------------------- output
const date = iso(Date.now())
const label = arg('label')?.[0]
const outJson = path.join(ROOT, 'eval/perf', `${label ?? 'baseline'}-${date}.json`)
fs.mkdirSync(path.dirname(outJson), { recursive: true })
const slim = (c: CallRec) => ({ ...c, reqs: c.reqs.map((r) => ({ ...r, startMs: Math.round(r.startMs), endMs: Math.round(r.endMs), ttfbMs: Math.round(r.ttfbMs) })) })
fs.writeFileSync(outJson, JSON.stringify({
  date, node: process.version,
  titilerEndpoint: process.env.TITILER_ENDPOINT || 'https://titiler.xyz (default)',
  geoServiceConfigured: Boolean(process.env.GEO_SERVICE_URL),
  aois: AOIS.map((a) => ({ ...a, areaKm2: +bboxKm2(a.bbox).toFixed(1) })),
  tools: TOOLS,
  rows: rows.map((r) => ({ ...r, cold: slim(r.cold), warm: slim(r.warm) })),
}, null, 2))

const f1 = (ms: number) => (Number.isFinite(ms) ? (ms / 1000).toFixed(2) : 'n/a')
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x)}%` : 'n/a')
const toolNames = TOOLS.map((t) => t.name).filter((n) => rows.some((r) => r.tool === n))
const md: string[] = []
md.push(`<!-- generated by scripts/perf/baseline.mts on ${date}; edit only below the analysis marker -->`)
md.push(`# Performance baseline (Q-14)`, '')
md.push(`Measured ${date} from a cloud sandbox (egress via proxy) with \`NODE_USE_ENV_PROXY=1\`, Node ${process.version}. Raw data: \`eval/perf/${label ?? 'baseline'}-${date}.json\`. Raster endpoint: ${process.env.TITILER_ENDPOINT || 'public titiler.xyz (default)'}. Geo service configured: ${process.env.GEO_SERVICE_URL ? 'yes' : 'no'}.`, '')
md.push(`Method: real tools via \`executeTool\`; global \`fetch\` wrapped from outside to log each request. **Cold** = in-process cache reset (\`_resetCache\`) then call; **warm** = immediate repeat in the same process (app's L1 cache populated). \`titiler_npy\` = the first concurrent batch of \`/stac/feature.npy\` reads (scene cloud scoring); \`titiler_npy_after\` = later \`feature.npy\` reads issued one after another (masked stats, then render data). Stage time is wall-clock union (parallel requests counted once); "no request in flight" is app compute or waiting between requests. Sandbox egress adds proxy latency to every request, so absolute numbers are pessimistic versus a server near the data; the stage proportions and request counts are what carry over. "Cold" is cold for the app only: titiler.xyz and the STAC APIs keep their own caches, so repeat runs of this script on the same AOIs and dates can be faster than a truly first visit (and the first-tile numbers especially).`, '')
md.push(`## AOIs`, '', '| id | place | km² | why |', '|---|---|---|---|')
for (const a of AOIS) md.push(`| ${a.id} | ${a.name} (${a.bbox.join(', ')}) | ${bboxKm2(a.bbox).toFixed(1)} | ${a.why} |`)
md.push('')

md.push(`## Per tool × AOI, total seconds (cold / warm)`, '')
md.push(`| tool | ${AOIS.map((a) => a.id).join(' | ')} | median cold | median warm |`, `|---|${AOIS.map(() => '---').join('|')}|---|---|`)
for (const t of toolNames) {
  const cells = AOIS.map((a) => {
    const r = rows.find((x) => x.tool === t && x.aoi === a.id)
    if (!r) return 'n/a'
    const c = f1(r.cold.totalMs) + (r.cold.ok ? '' : ' (FAIL)')
    const w = f1(r.warm.totalMs) + (r.warm.ok ? '' : ' (FAIL)')
    return `${c} / ${w}`
  })
  const rs = rows.filter((x) => x.tool === t && x.cold.ok)
  md.push(`| ${t} | ${cells.join(' | ')} | **${f1(median(rs.map((r) => r.cold.totalMs)))}** | **${f1(median(rs.map((r) => r.warm.totalMs)))}** |`)
}
md.push('', 'Medians use successful cold calls only; failures are listed below.', '')

md.push(`## Time to first drawable layer, cold (seconds; a tool without an early preview draws when it returns)`, '')
md.push(`| tool | ${AOIS.map((a) => a.id).join(' | ')} | median |`, `|---|${AOIS.map(() => '---').join('|')}|---|`)
for (const t of toolNames) {
  const cells = AOIS.map((a) => {
    const r = rows.find((x) => x.tool === t && x.aoi === a.id)
    return r ? f1(r.cold.firstLayerMs) + (r.cold.ok ? '' : ' (FAIL)') : 'n/a'
  })
  md.push(`| ${t} | ${cells.join(' | ')} | **${f1(median(rows.filter((x) => x.tool === t && x.cold.ok).map((r) => r.cold.firstLayerMs)))}** |`)
}
md.push('')

md.push(`## Stage breakdown, cold calls (median across AOIs; ms and % of total call time)`, '')
const stageCols = [...STAGES]
md.push(`| tool | total ms | ${stageCols.join(' | ')} | no request in flight | requests | failed req |`, `|---|---|${stageCols.map(() => '---').join('|')}|---|---|---|`)
for (const t of toolNames) {
  const rs = rows.filter((x) => x.tool === t && x.cold.ok).map((r) => r.cold)
  if (!rs.length) { md.push(`| ${t} | all failed | | | | | | | | | | |`); continue }
  const cell = (k: string) => {
    const ms = median(rs.map((c) => c.stageWallMs[k]))
    const p = median(rs.map((c) => (c.stageWallMs[k] / c.totalMs) * 100))
    return ms > 0 ? `${Math.round(ms)} (${pct(p)})` : '-'
  }
  const np = median(rs.map((c) => (c.noRequestMs / c.totalMs) * 100))
  md.push(`| ${t} | ${Math.round(median(rs.map((c) => c.totalMs)))} | ${stageCols.map(cell).join(' | ')} | ${Math.round(median(rs.map((c) => c.noRequestMs)))} (${pct(np)}) | ${median(rs.map((c) => c.requests))} | ${median(rs.map((c) => c.failedRequests))} |`)
}
md.push('', 'Stage request counts (median per cold call) and parallelism (sum of request durations ÷ wall time; 1.0 = fully sequential):', '')
md.push(`| tool | ${stageCols.join(' | ')} |`, `|---|${stageCols.map(() => '---').join('|')}|`)
for (const t of toolNames) {
  const rs = rows.filter((x) => x.tool === t && x.cold.ok).map((r) => r.cold)
  if (!rs.length) continue
  const cell = (k: string) => {
    const n = median(rs.map((c) => c.stageCount[k]))
    if (!(n > 0)) return '-'
    const par = median(rs.map((c) => (c.stageWallMs[k] > 0 ? c.stageSumMs[k] / c.stageWallMs[k] : NaN)))
    return `${n} req, ×${par.toFixed(1)}`
  }
  md.push(`| ${t} | ${stageCols.map(cell).join(' | ')} |`)
}
md.push('')

md.push(`## Warm calls (app in-memory cache)`, '')
md.push(`| tool | median cold s | median warm s | warm requests (median) | warm / cold |`, `|---|---|---|---|---|`)
for (const t of toolNames) {
  const rs = rows.filter((x) => x.tool === t && x.cold.ok && x.warm.ok)
  if (!rs.length) continue
  const c = median(rs.map((r) => r.cold.totalMs)), w = median(rs.map((r) => r.warm.totalMs))
  md.push(`| ${t} | ${f1(c)} | ${f1(w)} | ${median(rs.map((r) => r.warm.requests))} | ${pct((w / c) * 100)} |`)
}
md.push('')

md.push(`## Time to first tile (one z14 tile at the AOI centre, fetched after the cold call)`, '')
md.push(`| tool | AOI | tile first s | tile repeat s | status | bytes | tool cold s | tool cold + tile s |`, `|---|---|---|---|---|---|---|---|`)
for (const r of rows) {
  if (!r.tileCold) continue
  const tc = r.tileCold
  md.push(`| ${r.tool} | ${r.aoi} | ${tc.ms == null ? 'error ' + tc.error : f1(tc.ms)} | ${r.tileRepeat?.ms == null ? 'n/a' : f1(r.tileRepeat.ms)} | ${tc.status} | ${tc.bytes ?? 'n/a'} | ${f1(r.cold.totalMs)} | ${tc.ms == null ? 'n/a' : f1(r.cold.totalMs + tc.ms)} |`)
}
md.push('')

md.push(`## Slowest hosts (all cold calls pooled)`, '')
const hostAgg: Record<string, { n: number; durs: number[]; bytes: number; fail: number }> = {}
for (const r of rows) for (const q of r.cold.reqs) {
  const h = (hostAgg[q.host] ??= { n: 0, durs: [], bytes: 0, fail: 0 })
  h.n++; h.durs.push(q.endMs - q.startMs); h.bytes += q.bytes ?? 0
  if (typeof q.status !== 'number' || q.status >= 400) h.fail++
}
md.push(`| host | requests | median ms | p90 ms | total s (summed) | MB | failed |`, `|---|---|---|---|---|---|---|`)
for (const [h, a] of Object.entries(hostAgg).sort((x, y) => y[1].durs.reduce((p, q) => p + q, 0) - x[1].durs.reduce((p, q) => p + q, 0))) {
  const s = [...a.durs].sort((x, y) => x - y)
  md.push(`| ${h} | ${a.n} | ${Math.round(median(s))} | ${Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.9))])} | ${(s.reduce((p, q) => p + q, 0) / 1000).toFixed(1)} | ${(a.bytes / 1e6).toFixed(2)} | ${a.fail} |`)
}
md.push('')

md.push(`## Budgets vs measured`, '')
md.push(`Budgets: first pixels on the map < 2 s; AOI statistics < 5 s; style/threshold/timeline changes < 100 ms.`, '')
md.push(`| budget | measured (median across AOIs) | gap |`, `|---|---|---|`)
const ndvi = rows.filter((r) => r.tool === 'fetch_ndvi' && r.cold.ok)
const ndviTile = ndvi.filter((r) => r.tileCold?.ms != null)
if (ndvi.length) {
  const coldM = median(ndvi.map((r) => r.cold.totalMs)), warmM = median(ndvi.map((r) => r.warm.totalMs))
  md.push(`| AOI stats < 5 s: fetch_ndvi cold (tool incl. stats; excludes LLM round-trips) | ${f1(coldM)} s | ${coldM <= 5000 ? 'within budget, margin ' + f1(5000 - coldM) + ' s' : (coldM / 5000).toFixed(1) + '× budget (' + f1(coldM - 5000) + ' s over)'} |`)
  md.push(`| AOI stats < 5 s: fetch_ndvi warm (app cache) | ${f1(warmM)} s | ${warmM <= 5000 ? 'within budget' : `${f1(warmM - 5000)} s over`} |`)
}
if (ndviTile.length) {
  const fp = median(ndviTile.map((r) => r.cold.totalMs + (r.tileCold!.ms as number)))
  md.push(`| First pixels < 2 s: fetch_ndvi cold + first z14 tile (before any LLM round-trip is added) | ${f1(fp)} s | ${(fp / 2000).toFixed(1)}× budget (${f1(fp - 2000)} s over) |`)
}
const rr = rows.filter((r) => r.tool === 'render_raster' && r.cold.ok)
if (rr.length) {
  const m = median(rr.map((r) => r.cold.totalMs))
  md.push(`| First pixels < 2 s: render_raster cold (tool only) | ${f1(m)} s | ${m <= 2000 ? 'within budget' : `${(m / 2000).toFixed(1)}× budget (${f1(m - 2000)} s over)`} |`)
}
md.push(`| Style/threshold/timeline < 100 ms | not measured (browser-side; requires refetch today per QUEUE Q-19) | n/a |`, '')

const fails = rows.flatMap((r) => (['cold', 'warm'] as const).filter((w) => !r[w].ok).map((w) => `- ${r.tool} @ ${r.aoi} (${w}): ${r[w].failure}; summary: "${r[w].summaryHead}"; failed requests: ${r[w].failedRequests}`))
md.push(`## Failures recorded`, '', fails.length ? fails.join('\n') : 'None.', '')

// geo service reference row (if present)
const geoPresent = fs.existsSync(path.join(ROOT, 'services/geo/app'))
md.push(`## Reference: geo service (measured separately)`, '')
md.push(geoPresent
  ? `\`services/geo\` exists in this repo. **Not measured by this script.** Another agent measured it separately: September NDVI composite over Kasur, **11.5 s cold / ~1.2 s warm**. Not directly comparable with the rows above (a composite over many scenes vs. a single-scene tool call; different environment and date), and the app does not call it unless \`GEO_SERVICE_URL\` is set.`
  : `\`services/geo\` not found; no reference row.`, '')
md.push(`| row | source | cold | warm |`, `|---|---|---|---|`)
if (ndvi.length) md.push(`| fetch_ndvi, Kasur (this script) | titiler.xyz path | ${f1(ndvi.find((r) => r.aoi === 'kasur')?.cold.totalMs ?? NaN)} s | ${f1(ndvi.find((r) => r.aoi === 'kasur')?.warm.totalMs ?? NaN)} s |`)
md.push(`| geo service, Sep NDVI composite, Kasur (measured separately) | other agent | 11.5 s | ~1.2 s |`, '')

const perfMd = label ? path.join(ROOT, 'eval/perf', `${label}-${date}.md`) : path.join(ROOT, 'eval/PERF.md')
const marker = '<!-- analysis -->'
let tail = ''
if (fs.existsSync(perfMd)) {
  const old = fs.readFileSync(perfMd, 'utf8')
  const i = old.indexOf(marker)
  if (i >= 0) tail = old.slice(i)
}
fs.writeFileSync(perfMd, md.join('\n') + '\n' + (tail || `${marker}\n## Where the time goes\n\n(to be written from the data above)\n`))
console.log(`wrote ${path.relative(ROOT, outJson)} and eval/PERF.md`)
