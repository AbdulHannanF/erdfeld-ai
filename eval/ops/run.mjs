// Operations + map-layer harness for a deployed Erdfeld AI.
//   node eval/ops/run.mjs [--base URL] [--only id1,op2] [--no-ui] [--no-report] [--out DIR]
//
// For every operation in GET /api/operations: run it through the job queue
// (POST /api/jobs -> poll /api/jobs/:id -> GET /api/results/:id), record status / validation /
// summary / figures / provenance / timing, then prove every returned layer renders:
// raster tiles (3 tiles through the layer's real URL, decoded with sharp), vector GeoJSON, chart
// specs, legends. Quick layers (true colour / NDVI / elevation) are tested the same way. Finally
// eval/ops/ui.mjs drives the live UI (Playwright) and eval/ops/report.mjs writes eval/OPS.md.
// Results: <out>/results.json (default eval/ops/out). Sequential and polite; no dependencies.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CASES } from './cases.mjs'
import { Http, REPO, boxAoi, checkTiles, geomBbox, judgeImage, runJob, warm } from './lib.mjs'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const flag = (n) => process.argv.includes(`--${n}`)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASE = arg('base', process.env.BASE || 'https://erdfeld-web-707586221016.us-central1.run.app').replace(/\/$/, '')
const OUT = path.resolve(arg('out', path.join(HERE, 'out')))
const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean)
mkdirSync(OUT, { recursive: true })
const http = new Http(BASE)
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

// ── plausibility (physical ranges) ────────────────────────────────────────────────────────────
const INDEX_OPS = /ndvi|spectral|composite|anomaly|vectoriz|analyze|temporal|vegetation/i
function rangeFor(op, key) {
  const k = key.toLowerCase()
  if (/anom|delta|diff|change|trend/.test(k) && !/pct|percent/.test(k)) return null
  // Percent slope is tan(angle)·100, so cliffs exceed 100% (a 70° face is 275%); cap it at 90° in practice.
  if (/slope/.test(k) && /(pct|percent)/.test(k)) return [0, 2000]
  if (/(^|_)(pct|percent)(_|$)|_pct$|percent/.test(k)) return [0, 100]
  if (/cloud/.test(k)) return [0, 100]
  if (/area|_m2$|_ha$|_km2$|length|count|^n_|^n$|num|total|scenes|pixels|points|gaps|features|polygons|events/.test(k)) return [0, Infinity]
  if (/slope/.test(k)) return /elevation|dem|terrain/.test(op) ? [0, 90] : null
  if (/aspect/.test(k)) return /elevation|dem|terrain/.test(op) ? [0, 360] : null
  if (/(^|_)(elev|elevation|dem|altitude)/.test(k) || (op === 'fetch_dem' && /^(min|max|mean|median|p\d+)$/.test(k))) return [-450, 8900]
  if (/height/.test(k)) return [0, 900]
  if (/backscatter|_db$|(^|_)db(_|$)/.test(k)) return [-50, 10]
  if (/temp|lst|celsius|_c$/.test(k) && !/_k$/.test(k)) return [-60, 75]
  if (/_k$|kelvin/.test(k)) return [200, 360]
  if (/precip|rain|_mm$/.test(k)) return [0, 3000]
  if (/area|_m2$|_ha$|_km2$|length|count|^n_|^n$|num|total|scenes|pixels|features|polygons/.test(k)) return [0, Infinity]
  if (/correlation|(^|_)r$|pearson|spearman/.test(k)) return [-1, 1]
  if (/^r2$|r_squared|confidence|fraction|probability/.test(k)) return [0, 1]
  if (/^(p\d+|mean|median|min|max|std|stddev|stdev)$|ndvi|ndwi|ndbi|nbr|savi|^evi/.test(k)) {
    if (INDEX_OPS.test(op)) return /evi/.test(k) ? [-2.5, 3] : [-1.05, 1.05]
  }
  return null
}
function plausibility(op, stats, aoiKm2, maxArea) {
  const issues = []
  let checked = 0
  for (const [key, v] of Object.entries(stats || {})) {
    const nums = typeof v === 'number' ? [v] : Array.isArray(v) ? v.map((x) => x.value) : []
    for (const n of nums) {
      if (typeof n !== 'number') continue
      if (!Number.isFinite(n)) { issues.push(`${key} is not finite (${n})`); continue }
      const r = rangeFor(op, key)
      if (!r) continue
      checked++
      if (n < r[0] || n > r[1]) issues.push(`${key}=${n} outside [${r[0]}, ${r[1]}]`)
    }
    if (typeof v === 'string' && /\b(NaN|undefined|Infinity)\b/.test(v)) issues.push(`${key} string contains NaN/undefined`)
  }
  if (typeof stats?.area_km2 === 'number' && aoiKm2 && stats.area_km2 > aoiKm2 * 1.5) issues.push(`area_km2 ${stats.area_km2} exceeds AOI ${aoiKm2.toFixed(1)}`)
  return { issues, checked }
}

const areaKm2 = (aoi) => {
  const [w, s, e, n] = geomBbox(aoi)
  return (e - w) * 111.32 * Math.cos((((s + n) / 2) * Math.PI) / 180) * (n - s) * 110.574
}

// ── layer checks ──────────────────────────────────────────────────────────────────────────────
const bboxHit = (a, b, pad = 0) => {
  const dx = (b[2] - b[0]) * pad, dy = (b[3] - b[1]) * pad
  return a[0] <= b[2] + dx && a[2] >= b[0] - dx && a[1] <= b[3] + dy && a[3] >= b[1] - dy
}
const rank = { pass: 0, partial: 1, fail: 2 }
const worst = (a, b) => (rank[b] > rank[a] ? b : a)

async function checkLayer(layer, aoi) {
  const aoiBb = geomBbox(aoi)
  const out = { id: layer.id, name: layer.name, type: layer.type, verdict: 'pass', checks: [], evidence: [] }
  const add = (name, ok, note, level = 'fail', evidence) => {
    out.checks.push({ name, ok, note })
    if (!ok) { out.verdict = worst(out.verdict, level); if (evidence) out.evidence.push(evidence) }
  }
  if (layer.bounds) add('bounds_intersect_aoi', bboxHit(layer.bounds, aoiBb, 0.2), `bounds ${layer.bounds.map((x) => +x.toFixed(4))}`)
  if (layer.type === 'raster' || layer.type === 'heatmap' && layer.tileUrl) {
    if (layer.imageBase64) {
      const buf = Buffer.from(layer.imageBase64.replace(/^data:[^,]+,/, ''), 'base64')
      const j = await judgeImage(buf).catch((e) => ({ decode_error: String(e) }))
      out.image = j
      add('image_decodes', !j.decode_error, j.decode_error || `${j.w}x${j.h}`)
      add('image_not_blank', !j.transparent && !j.uniform, `opaque ${j.opaque_frac}, colours ${j.colours}, sd ${j.max_sd}`, 'fail', { imageBase64: `${buf.length} bytes`, judge: j })
    } else if (layer.tileUrl) {
      const tpl = layer.tileUrl
      out.tile_template = tpl.slice(0, 600)
      if (!/\{z\}/.test(tpl)) {
        // A single georeferenced image overlay (the client draws it as a MapLibre image source).
        out.static_image = true
        const r = await http.fetch(tpl, {}, { retries: 2 }).catch((e) => ({ status: 0, error: String(e) }))
        const buf = r.arrayBuffer ? Buffer.from(await r.arrayBuffer()) : Buffer.alloc(0)
        const j = r.status === 200 ? await judgeImage(buf).catch((e) => ({ decode_error: String(e) })) : {}
        out.tiles = [{ url: tpl.slice(0, 400), status: r.status, type: r.headers?.get('content-type'), bytes: buf.length, ...j }]
        add('static_image_http_200', r.status === 200, `HTTP ${r.status}`, 'fail', { url: tpl, status: r.status })
        add('static_image_informative', r.status === 200 && !j.decode_error && !j.transparent && !j.uniform, `opaque ${j.opaque_frac}, colours ${j.colours}, sd ${j.max_sd}`, 'fail', { judge: j })
        add('static_image_has_bounds', !!layer.bounds, 'image overlay needs layer.bounds to be placed', 'fail')
      } else {
        const tiles = await checkTiles(http, tpl, layer.bounds || aoiBb)
        out.tiles = tiles
        const httpBad = tiles.filter((t) => t.status !== 200 && t.status !== 204)
        const holes = httpBad.filter((t) => t.status === 404 && /outside bounds/i.test(t.body || ''))
        add('tiles_http_200', !httpBad.length, `${tiles.map((t) => t.status ?? t.error).join('/')}${holes.length ? ' (tile inside layer bounds but outside the source raster: coverage hole)' : ''}`, holes.length === httpBad.length ? 'partial' : 'fail', httpBad.length ? { tile: httpBad[0] } : undefined)
        const img = tiles.filter((t) => t.status === 200)
        add('tiles_image_type', img.every((t) => /^image\/(png|webp|jpeg)/.test(t.type || '')), img.map((t) => t.type).join(','), 'fail', img.find((t) => !/^image\//.test(t.type || '')) && { tile: img.find((t) => !/^image\//.test(t.type || '')) })
        add('tiles_decode', img.every((t) => !t.decode_error), 'sharp decode', 'fail')
        const good = img.filter((t) => !t.transparent && !t.uniform && !t.decode_error)
        const centre = tiles[0]
        add('centre_tile_informative', !!centre && centre.status === 200 && !centre.transparent && !centre.uniform, centre ? `status ${centre.status}, opaque ${centre.opaque_frac}, colours ${centre.colours}, sd ${centre.max_sd}` : 'no tile', 'fail', { tile: centre })
        add('all_tiles_informative', good.length === tiles.length || httpBad.length > 0, `${good.length}/${tiles.length} informative`, 'partial', good.length < tiles.length ? { tiles: tiles.filter((t) => !good.includes(t)) } : undefined)
        add('tiles_nontrivial_size', img.every((t) => t.bytes > 200), img.map((t) => t.bytes).join('/'), 'partial')
      }
    } else add('raster_has_source', false, 'raster layer has neither tileUrl nor imageBase64', 'fail')
    const rgb = layer.raster?.kind === 'rgb' || /rgb|true.?colou?r|hillshade|imagery|before|scene/i.test(`${layer.id} ${layer.name}`)
    if (layer.bounds) {
      const a = (b) => (b[2] - b[0]) * (b[3] - b[1])
      const ratio = a(layer.bounds) / Math.max(a(aoiBb), 1e-12)
      out.bounds_ratio = +ratio.toFixed(1)
      add('bounds_tight', ratio <= 20, `layer bounds are ${ratio.toFixed(1)}x the AOI`, 'partial')
    }
    add('legend_present', rgb || !!(layer.raster || layer.palette), layer.raster ? `raster.kind=${layer.raster.kind} colormap=${layer.raster.colormap ?? '-'}` : layer.palette ? 'palette' : 'no raster descriptor / palette', 'partial')
  } else if (layer.type === 'geojson' || layer.type === 'heatmap') {
    const fc = layer.geojson
    const feats = fc?.type === 'FeatureCollection' ? fc.features : null
    add('geojson_valid', !!feats, feats ? `${feats.length} features` : 'geojson missing or not a FeatureCollection', 'fail')
    if (feats) {
      out.feature_count = feats.length
      add('features_gt_0', feats.length > 0, `${feats.length} features`, 'partial')
      let inside = 0, bad = 0
      const types = {}
      for (const f of feats) {
        if (!f?.geometry?.type || !f.geometry.coordinates) { bad++; continue }
        types[f.geometry.type] = (types[f.geometry.type] || 0) + 1
        try {
          const bb = geomBbox(f.geometry)
          if (!bb.every(Number.isFinite)) { bad++; continue }
          if (bboxHit(bb, aoiBb, 0.25)) inside++
        } catch { bad++ }
      }
      out.geometry_types = types
      if (feats.length) {
        add('geometries_valid', bad === 0, `${bad} bad of ${feats.length}`, 'fail')
        add('coords_in_aoi', inside / feats.length >= 0.9, `${inside}/${feats.length} within AOI(+25%)`, inside === 0 ? 'fail' : 'partial')
      }
      if (layer.type === 'heatmap' && layer.intensityProperty && feats.length) add('intensity_property', feats.some((f) => f.properties?.[layer.intensityProperty] != null), layer.intensityProperty, 'partial')
    }
  } else if (layer.type === '3dtiles') {
    const r = layer.tileUrl && (await http.fetch(layer.tileUrl, {}, { retries: 2 }))
    add('3dtiles_reachable', !!r && r.status === 200, r ? `HTTP ${r.status}` : 'no tileUrl', 'fail')
  } else add('known_type', false, `unknown layer type ${layer.type}`, 'partial')
  return out
}

function checkChart(c) {
  const out = { id: c.id, verdict: 'pass', checks: [] }
  const add = (name, ok, note, level = 'fail') => { out.checks.push({ name, ok, note }); if (!ok) out.verdict = worst(out.verdict, level) }
  const s = c.spec || {}
  const hasMark = !!(s.mark || s.layer || s.vconcat || s.hconcat || s.concat || s.facet || s.repeat)
  add('vega_lite_shape', hasMark, hasMark ? `$schema ${String(s.$schema || '-').split('/').slice(-2).join('/')}` : 'no mark/layer/concat')
  const rowsOf = (sp) => (sp.data?.values?.length ?? 0) + Object.values(sp.datasets || {}).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0)
  const kids = [s, ...(s.layer || []), ...(s.vconcat || []), ...(s.hconcat || []), ...(s.concat || [])]
  const rows = kids.reduce((n, k) => n + rowsOf(k), 0)
  out.rows = rows
  add('data_rows_gt_0', rows > 0, `${rows} rows`)
  const enc = s.encoding || s.layer?.[0]?.encoding || s.vconcat?.[0]?.encoding
  add('has_encoding', !!enc || !!(s.facet || s.repeat), enc ? Object.keys(enc).join(',') : 'none', 'partial')
  return out
}

// ── one case ──────────────────────────────────────────────────────────────────────────────────
const maxAreaOf = {}
async function evaluate(c, run, contract) {
  const rec = { id: c.id, op: c.op, place: c.place, aoi_bbox: geomBbox(c.aoi).map((x) => +x.toFixed(4)), aoi_km2: +areaKm2(c.aoi).toFixed(1), args: c.argsUsed ?? c.args, ms: run.ms, verdict: 'pass', notes: [], failures: [], layers: [], charts: [] }
  const fail = (level, what, evidence) => { rec.verdict = worst(rec.verdict, level); rec.failures.push({ level, what, evidence }) }
  rec.job = run.job
  rec.request = { path: '/api/jobs', body: { jobs: [{ op: c.op, args: rec.args, aoi: '<polygon bbox ' + rec.aoi_bbox.join(',') + '>' }] } }
  const res = run.result
  if (!res) {
    fail('fail', run.error || 'no result', { job: run.job, submit: run.submit, error: run.error })
    return rec
  }
  rec.result_id = res.result_id
  rec.result_status = res.status
  rec.validation = res.validation.map((v) => ({ id: v.id, status: v.status, message: v.message?.slice(0, 220) }))
  rec.validation_summary = res.validation.reduce((m, v) => ((m[v.status] = (m[v.status] || 0) + 1), m), {})
  rec.summary = res.summary
  rec.stats = res.stats
  rec.stats_keys = Object.keys(res.stats || {})
  rec.provenance = { sources: res.provenance?.sources, items: res.provenance?.items?.slice(0, 5), method: res.provenance?.method?.slice(0, 200), date: res.provenance?.date, has_hash: !!res.provenance?.inputs_hash, cached: res.provenance?.cached }
  rec.uncertainty_notes = res.uncertainty?.notes?.slice(0, 3)
  rec.cached = !!res.provenance?.cached
  rec.provenance_present = !!(res.provenance?.sources?.length && res.provenance?.inputs_hash)
  if (!rec.provenance_present && contract.sensors.length && !['failed', 'refused'].includes(res.status)) fail('partial', 'provenance missing (no data source named)', res.provenance)
  if (res.status === 'failed' && /No vision model/i.test(res.summary)) fail('partial', 'result_status failed: no vision model configured on this deployment (honest refusal; nothing was described)', { summary: res.summary.slice(0, 250) })
  else if (res.status === 'refused' || res.status === 'failed') fail('fail', `result_status ${res.status}`, { summary: res.summary.slice(0, 600), validation: rec.validation.filter((v) => v.status !== 'pass') })
  else if (res.status === 'flagged') fail('partial', 'result_status flagged', { validation: rec.validation.filter((v) => v.status === 'fail') })
  const failedChecks = res.validation.filter((v) => v.status === 'fail')
  if (failedChecks.length && res.status === 'ok') fail('partial', 'validation has failing checks', failedChecks.map((v) => v.id + ': ' + v.message))
  const p = plausibility(c.op, res.stats, rec.aoi_km2, contract.limits.maxAreaKm2)
  rec.plausibility = p
  if (p.issues.length) fail('fail', 'implausible figures', p.issues)
  if (/\b(NaN|undefined|\[object Object\])\b/.test(res.summary)) fail('partial', 'summary contains NaN/undefined', res.summary.slice(0, 300))
  if (!res.summary?.trim()) fail('fail', 'empty summary')

  if (res.status !== 'refused' && res.status !== 'failed') {
    for (const l of res.layers) {
      const lc = await checkLayer(l, c.aoi)
      rec.layers.push(lc)
      if (lc.verdict !== 'pass') fail(lc.verdict, `layer ${l.id} (${l.type}): ${lc.checks.filter((k) => !k.ok).map((k) => k.name + ' [' + k.note + ']').join('; ')}`, lc.evidence)
    }
    for (const ch of res.charts || []) {
      const cc = checkChart(ch)
      rec.charts.push(cc)
      if (cc.verdict !== 'pass') fail(cc.verdict, `chart ${ch.id}: ${cc.checks.filter((k) => !k.ok).map((k) => k.name + ' [' + k.note + ']').join('; ')}`)
    }
    if (res.layer_style) {
      const ok = res.layer_style.legend?.length > 0
      rec.layer_style = { layer_id: res.layer_style.layer_id, legend_items: res.layer_style.legend?.length }
      if (!ok) fail('fail', 'layer_style has no legend')
    }
    const out = contract.output
    if (c.op === 'style_layer' && !res.layer_style) fail('fail', 'style_layer returned no layer_style (nothing was restyled); result status is still reported ok', { summary: res.summary.slice(0, 300) })
    if (c.op === 'make_chart' && /^Cannot make a chart/i.test(res.summary)) fail('fail', 'make_chart cannot see earlier results through the job queue; result status is still reported ok', { summary: res.summary.slice(0, 300) })
    if (c.expectLayers && !res.layers.length) fail('partial', 'no map layer returned although the arguments asked for one / events exist', { stats: res.stats, summary_tail: res.summary.slice(-260) })
    const rasters = res.layers.filter((l) => l.type === 'raster'), vecs = res.layers.filter((l) => l.type === 'geojson' || l.type === 'heatmap')
    const anyVisual = res.layers.length > 0
    if (out === 'raster' && !rasters.length && anyVisual) fail('partial', `contract output is raster but the layer returned is ${res.layers.map((l) => l.type).join('/')} (no per-pixel raster)`, { layers: res.layers.map((l) => ({ id: l.id, type: l.type, name: l.name })), summary_tail: res.summary.slice(-300) })
    else if (out === 'raster' && !rasters.length) fail('fail', 'contract output is raster but no raster layer was returned', { layers: res.layers.map((l) => l.type), summary: res.summary.slice(0, 300) })
    if (out === 'vector' && !vecs.length && c.op !== 'style_layer' && res.status === 'ok' && !res.layers.length) fail('partial', 'vector operation returned no layer (zero features / no data source)', { stats: res.stats, summary: res.summary.slice(0, 400) })
    else if (out === 'vector' && !vecs.length && c.op !== 'style_layer') fail('fail', 'contract output is vector but no vector layer was returned', { summary: res.summary.slice(0, 300) })
    const hasSeries = Object.values(res.stats || {}).some((v) => Array.isArray(v) && v.length > 1)
    if (out === 'chart' && !(res.charts || []).length && hasSeries) fail('partial', 'contract output is chart but charts[] is empty (a series exists in stats, drawn client-side only)', { series: Object.entries(res.stats).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k}[${v.length}]`) })
    else if (out === 'chart' && !(res.charts || []).length) fail('fail', 'contract output is chart but no chart was returned', { layers: res.layers.map((l) => l.type), summary: res.summary.slice(0, 300) })
    if (out === 'table' && !rec.stats_keys.length) fail('partial', 'table operation returned no figures', res.summary.slice(0, 300))
  }
  rec.has_layers = res.layers.length
  return rec
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────
const results = { base: BASE, started: new Date().toISOString(), operations: [], quick_layers: [], coverage: {} }
const ops = await http.json('/api/operations')
if (ops.status !== 200) { console.error('GET /api/operations failed', ops.status); process.exit(2) }
const contracts = Object.fromEntries(ops.body.operations.map((o) => [o.name, o]))
results.coverage = {
  operations_listed: ops.body.operations.length,
  without_case: ops.body.operations.map((o) => o.name).filter((n) => !CASES.some((c) => c.op === n)),
  case_op_not_listed: [...new Set(CASES.map((c) => c.op))].filter((n) => !contracts[n]),
}
log(`${ops.body.operations.length} operations listed; no case for: ${results.coverage.without_case.join(', ') || '-'}`)

const w = await warm(http)
results.warmup = { ok: w.ok, ms: w.ms, health: w.health }
log('warm-up', w.ok ? 'ok' : 'NOT ok', JSON.stringify(w.health?.checks))

const want = (c) => !only || only.includes(c.id) || only.includes(c.op)
const selected = CASES.filter(want)
const doneRuns = new Map()
async function runCase(c) {
  if (doneRuns.has(c.id)) return doneRuns.get(c.id)
  const contract = contracts[c.op]
  let args = c.args, prev
  if (c.needs) {
    const dep = CASES.find((x) => x.id === c.needs)
    prev = (await runCase(dep)).run?.result
    args = prev ? c.args({ prev }) : null
    if (!args) {
      const rec = { id: c.id, op: c.op, place: c.place, aoi_km2: +areaKm2(c.aoi).toFixed(1), verdict: 'fail', failures: [{ level: 'fail', what: `cannot build arguments: prerequisite ${c.needs} produced no usable result`, evidence: prev ? { stats_keys: Object.keys(prev.stats || {}), status: prev.status } : undefined }], layers: [], charts: [], notes: ['blocked by ' + c.needs] }
      const o = { rec, run: null }
      doneRuns.set(c.id, o)
      return o
    }
  }
  if (!contract) {
    const rec = { id: c.id, op: c.op, place: c.place, verdict: 'fail', failures: [{ level: 'fail', what: 'operation not in /api/operations' }], layers: [], charts: [] }
    const o = { rec, run: null }
    doneRuns.set(c.id, o)
    return o
  }
  log(`> ${c.id}  ${c.place}  ${JSON.stringify(args).slice(0, 120)}`)
  const run = await runJob(http, { op: c.op, args, aoi: c.aoi }, { maxMs: c.timeoutMs || 420000 })
  const rec = await evaluate({ ...c, argsUsed: args }, run, contract)
  log(`  ${rec.verdict.toUpperCase()}  ${rec.result_status ?? run.job?.status ?? 'no-result'}  ${(run.ms / 1000).toFixed(1)}s  layers ${rec.layers?.length ?? 0}  ${rec.failures.map((f) => f.what).join(' | ').slice(0, 200)}`)
  const o = { rec, run }
  doneRuns.set(c.id, o)
  return o
}
// With --only the new records replace the same ids in the previous results.json (the rest are kept).
let previous = null
if (only) { try { previous = JSON.parse(readFileSync(path.join(OUT, 'results.json'), 'utf8')) } catch {} }
const merged = () => {
  if (!previous) return results.operations
  const fresh = new Map(results.operations.map((r) => [r.id, r]))
  const kept = previous.operations.map((r) => fresh.get(r.id) || r)
  return [...kept, ...results.operations.filter((r) => !previous.operations.some((p) => p.id === r.id))]
}
for (const c of selected) {
  const o = await runCase(c)
  results.operations.push(o.rec)
  writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ ...(previous || results), operations: merged(), quick_layers: previous?.quick_layers ?? results.quick_layers }, null, 1))
}
if (previous) { results.operations = merged(); results.quick_layers = previous.quick_layers; results.warmup = previous.warmup; results.started = previous.started; results.coverage = previous.coverage; results.cross_checks = previous.cross_checks }

// cross-operation consistency (same AOI, independent sources)
{
  const by = Object.fromEntries(results.operations.map((r) => [r.id, r]))
  const lc = by.classify_land_cover, veg = by.classify_vegetation
  if (lc?.stats && veg?.stats && /urban|built/i.test(String(lc.stats.dominant_class)) && Number(veg.stats.cropland_pct) > 50) {
    const what = `classify_land_cover calls the Nile-delta AOI "${lc.stats.dominant_class}" (${(lc.stats.land_cover || []).map((x) => x.label + ' ' + x.value + '%').join(', ')}) but ESA WorldCover (classify_vegetation, same AOI) says cropland ${veg.stats.cropland_pct}%`
    lc.verdict = 'fail'
    if (!lc.failures.some((f) => f.what.startsWith('classify_land_cover calls'))) lc.plausibility.issues.push('dominant class contradicts WorldCover for the same AOI')
    if (!lc.failures.some((f) => f.what.startsWith('classify_land_cover calls'))) lc.failures.push({ level: 'fail', what, evidence: { classify_land_cover: lc.stats, classify_vegetation: { cropland_pct: veg.stats.cropland_pct, water_pct: veg.stats.water_pct, tree_cover_pct: veg.stats.tree_cover_pct } } })
  }
  const dem = by.fetch_dem, ds = by.use_dataset
  if (dem?.stats && ds?.stats && Number(dem.stats.max_elevation_m) && Number(ds.stats.max)) {
    const d = Math.abs(dem.stats.max_elevation_m - ds.stats.max) / ds.stats.max
    results.cross_checks = { dem_vs_alos_max: { fetch_dem: dem.stats.max_elevation_m, use_dataset_alos: ds.stats.max, rel_diff: +d.toFixed(3) } }
    if (d > 0.05 && !dem.notes.some((n) => n.startsWith('max elevation'))) dem.notes.push(`max elevation ${dem.stats.max_elevation_m} m (sampled grid) vs ${ds.stats.max} m from ALOS per-pixel over the same AOI (${(d * 100).toFixed(0)}% lower)`)
  }
}

// quick layers
if (!only || only.includes('quick') || only.some((s) => s.startsWith('quick_'))) {
  results.quick_layers = []
  const aoi = boxAoi(74.45, 31.12, 3)
  for (const q of ['true_colour', 'ndvi', 'elevation']) {
    if (only && !only.includes('quick') && !only.includes('quick_' + q)) continue
    log(`> quick_layer ${q}`)
    const t0 = Date.now()
    const r = await http.post('/api/quick-layer', { op: q, aoi }, { timeoutMs: 150000 })
    const ms = Date.now() - t0
    const op = q === 'true_colour' ? 'render_raster' : q === 'ndvi' ? 'fetch_ndvi' : 'fetch_dem'
    const run = { ms, result: r.status === 200 ? r.body : null, error: `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`, job: { status: String(r.status) } }
    const rec = await evaluate({ id: 'quick_' + q, op, place: 'Kasur (quick layer)', aoi, args: { quick: q } }, run, contracts[op] || { output: 'raster', sensors: [], limits: { maxAreaKm2: 5000 } })
    rec.id = 'quick_' + q
    rec.request = { path: '/api/quick-layer', body: { op: q, aoi: '<polygon>' } }
    log(`  ${rec.verdict.toUpperCase()}  ${(ms / 1000).toFixed(1)}s  ${rec.failures.map((f) => f.what).join(' | ').slice(0, 200)}`)
    results.quick_layers.push(rec)
  }
}
results.finished = new Date().toISOString()
writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1))
const all = [...results.operations, ...results.quick_layers]
const tally = all.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] || 0) + 1), m), {})
log('API/tile tally', JSON.stringify(tally))

if (!flag('no-ui') && !only) {
  log('UI spot check')
  spawnSync(process.execPath, [path.join(HERE, 'ui.mjs'), '--base', BASE, '--out', OUT], { stdio: 'inherit', cwd: REPO })
}
if (!flag('no-report')) spawnSync(process.execPath, [path.join(HERE, 'report.mjs'), '--out', OUT], { stdio: 'inherit', cwd: REPO })
