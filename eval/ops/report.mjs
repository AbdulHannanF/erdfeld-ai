// Builds eval/OPS.md from <out>/results.json (+ ui-results.json); the hand-written root-cause
// section after the marker in eval/OPS.md is kept.
//   node eval/ops/report.mjs [--out DIR]
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(arg('out', path.join(HERE, 'out')))
const R = JSON.parse(readFileSync(path.join(OUT, 'results.json'), 'utf8'))
const UI = existsSync(path.join(OUT, 'ui-results.json')) ? JSON.parse(readFileSync(path.join(OUT, 'ui-results.json'), 'utf8')) : []
// The hand-written root-cause analysis lives in eval/OPS.md itself, after this marker, and
// survives a re-run of this script.
const MARKER = '<!-- ROOT-CAUSES: hand-written below, preserved by report.mjs -->'
const OPS_PATH = path.resolve(HERE, '..', 'OPS.md')
const prior = existsSync(OPS_PATH) ? readFileSync(OPS_PATH, 'utf8') : ''
const analysis = prior.includes(MARKER) ? prior.slice(prior.indexOf(MARKER)) : MARKER + '\n\n_(no root-cause notes yet)_'

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
const mark = { pass: 'PASS', partial: 'PARTIAL', fail: 'FAIL' }
const all = [...R.operations, ...R.quick_layers]

function renderable(r) {
  if (!r.layers?.length && !r.charts?.length) return r.result_status && !['failed', 'refused'].includes(r.result_status) ? 'no layer (figures only)' : '-'
  const parts = []
  for (const l of r.layers) {
    const kind = l.type === 'geojson' || l.type === 'heatmap' ? 'vector' : l.type === 'raster' ? (l.tiles ? (l.static_image ? 'image' : 'tiles') : 'raster') : l.type
    const t = l.tiles ? ` ${l.tiles.map((x) => x.status ?? 'err').join('/')}` : l.feature_count != null ? ` ${l.feature_count} feat` : ''
    parts.push(`${kind}${t} ${l.verdict === 'pass' ? 'OK' : l.verdict.toUpperCase()}`)
  }
  for (const c of r.charts || []) parts.push(`chart ${c.rows} rows ${c.verdict === 'pass' ? 'OK' : c.verdict.toUpperCase()}`)
  return parts.join('; ')
}
const plaus = (r) => (!r.plausibility ? '-' : r.plausibility.issues.length ? `NO: ${r.plausibility.issues.slice(0, 2).join(', ')}` : `ok (${r.plausibility.checked} ranges checked)`)
const coldPath = path.join(OUT, 'cold-times.json')
const cold = existsSync(coldPath) ? JSON.parse(readFileSync(coldPath, 'utf8')) : {}
const timeCell = (r) => {
  if (!r.ms) return '-'
  const t = (r.ms / 1000).toFixed(1) + ' s'
  if (r.cached) return cold[r.id] ? `${(cold[r.id] / 1000).toFixed(1)} s cold (${t} cache hit)` : `${t} (result-cache hit)`
  return t
}
const row = (r) => `| ${esc(r.id)} | ${esc(r.place)} (${r.aoi_km2 ?? '?'} km2) | ${esc([r.job?.status, r.result_status].filter(Boolean).join('/'))} | ${esc(renderable(r))} | ${esc(plaus(r))} | ${timeCell(r)} | ${esc([...(r.failures || []).map((f) => f.what), ...(r.notes || [])].join(' ; ').slice(0, 300))} | **${mark[r.verdict]}** |`

const tally = all.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] || 0) + 1), m), {})
const lines = []
lines.push('# Operations and map-layer end-to-end evaluation', '')
lines.push(`Target: ${R.base}  `, `Run: ${R.started} to ${R.finished}  `, `Harness: \`node eval/ops/run.mjs [--base URL] [--only id1,op2]\` (Node 22, no new dependencies; \`eval/ops/\`).`, '')
lines.push(`**Totals (${all.length} cases: ${R.operations.length} operation runs over ${R.coverage.operations_listed} registered operations, ${R.quick_layers.length} quick layers): ${tally.pass || 0} pass, ${tally.partial || 0} partial, ${tally.fail || 0} fail.**`, '')
if (R.coverage.without_case.length) lines.push(`Operations with no case: ${R.coverage.without_case.join(', ')}`, '')
lines.push('## Method', '')
lines.push('- Every operation runs through the job queue: `POST /api/jobs`, poll `GET /api/jobs/:id`, `GET /api/results/:resultId`, with a fixed `x-owner-token`, sequentially, 429/503 retried with backoff, after polling `/api/health` until every dependency is ok.')
lines.push('- Raster layers: 3 tiles at the AOI zoom (centre plus neighbours inside the layer bounds) fetched through the layer\'s real `tileUrl` (including `/api/geo/tiles` where used), HTTP 200 + image content-type + decoded with `sharp`; fail if the centre tile is fully transparent or one flat colour. Static image overlays and `imageBase64` layers are decoded the same way. A legend/colour ramp (`layer.raster` or `layer.palette`) is required for non-RGB rasters.')
lines.push('- Vector layers: valid FeatureCollection, features > 0, geometries valid, >= 90% inside the AOI (+25%). Charts: Vega-Lite shape, data rows > 0, encoding present.')
lines.push('- Plausibility is a heuristic range check on `summary_data` keys (indices in [-1, 1], percentages in [0, 100], elevation, slope, temperature, precipitation, dB, areas not larger than the AOI).')
lines.push('- Verdicts: PASS = ran, validated, renders, plausible; PARTIAL = usable but flagged, a weak check or a missing legend; FAIL = did not run, did not render, or implausible.', '')
lines.push('## Results by operation', '')
lines.push('| op | AOI | status (job/result) | layer renderable | data plausible | time | notes | verdict |', '|---|---|---|---|---|---|---|---|')
for (const r of R.operations) lines.push(row(r))
lines.push('', '## Quick layers (`POST /api/quick-layer`)', '', '| op | AOI | status | layer renderable | data plausible | time | notes | verdict |', '|---|---|---|---|---|---|---|---|')
for (const r of R.quick_layers) lines.push(row(r))

lines.push('', '## UI spot check (Playwright, live URL)', '')
if (!UI.length) lines.push('Not run (use `node eval/ops/run.mjs` without `--no-ui`, or `node eval/ops/ui.mjs`).')
else {
  lines.push('Screenshots: `C:\\Users\\Abdul\\erdfeld-shots\\ops\\<id>.png` (full page) and `<id>-map.png` (map only). "Map changed" is the share of map pixels that differ from a screenshot of the same view before the layer was added.', '')
  lines.push('| layer | place | layer rows | map changed | layer tile 200s / non-200 | verdict | notes |', '|---|---|---|---|---|---|---|')
  for (const u of UI) lines.push(`| ${esc(u.label)} | ${esc(u.place)} | ${u.layer_rows ?? '-'} | ${u.map_changed_frac != null ? (u.map_changed_frac * 100).toFixed(1) + '%' : '-'} | ${u.tiles ? u.tiles.ok + ' / ' + u.tiles.failed_count : '-'} | **${mark[u.status] || u.status.toUpperCase()}** | ${esc(u.notes.join(' ; ').slice(0, 200))} |`)
  const manual = path.join(HERE, 'ui-review.md')
  if (existsSync(manual)) lines.push('', readFileSync(manual, 'utf8').trim())
}

lines.push('', '## Failure and partial evidence', '')
const bad = all.filter((r) => r.verdict !== 'pass')
if (!bad.length) lines.push('None.')
for (const r of bad) {
  lines.push(`### ${r.id} - ${mark[r.verdict]}`, '')
  lines.push(`Request: \`${r.request?.path || '/api/jobs'}\` op \`${r.op}\` args \`${JSON.stringify(r.args)}\` AOI bbox \`${(r.aoi_bbox || []).join(',')}\` (${r.aoi_km2} km2). Job \`${JSON.stringify(r.job || {})}\`.`, '')
  for (const f of r.failures) {
    lines.push(`- **${f.level}**: ${f.what}`)
    if (f.evidence) lines.push('  ```json', '  ' + JSON.stringify(f.evidence).slice(0, 900), '  ```')
  }
  if (r.summary) lines.push('', `  Summary excerpt: ${esc(r.summary.slice(0, 280))}`)
  lines.push('')
}
lines.push('', analysis.trim(), '')
writeFileSync(OPS_PATH, lines.join('\n') + '\n')
console.log(`wrote eval/OPS.md (${all.length} cases: ${JSON.stringify(tally)})`)
