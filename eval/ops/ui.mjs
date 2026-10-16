// UI spot check of six representative layers on the live app (Playwright from the repo).
//   node eval/ops/ui.mjs [--base URL] [--out DIR] [--only thermal,sar,ndvi,dem,flood,buildings]
// For each: draw an AOI at a real place, add the layer through the toolbox (quick layer button or
// tool dialog -> Run), wait for the job and the map to go idle, screenshot to
// C:\Users\Abdul\erdfeld-shots\ops\, and measure how much of the map changed against a screenshot
// of the same view before the layer was added (a blank/transparent layer changes nothing).
// Writes <out>/ui-results.json; the screenshots must still be looked at by a human.
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sharp } from './lib.mjs'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASE = arg('base', 'https://erdfeld-web-707586221016.us-central1.run.app').replace(/\/$/, '')
const OUT = path.resolve(arg('out', path.join(HERE, 'out')))
const only = arg('only')?.split(',')
const SHOTS = 'C:\\Users\\Abdul\\erdfeld-shots\\ops'
mkdirSync(SHOTS, { recursive: true })
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CASES = [
  { id: 'thermal', label: 'Thermal (Landsat LST)', place: '33.45, -112.07', tool: 'fetch_thermal' },
  { id: 'sar', label: 'SAR (Sentinel-1)', place: '30.99, 74.57', tool: 'fetch_sar' },
  { id: 'ndvi', label: 'NDVI (quick layer)', place: '31.12, 74.45', quick: 'ndvi' },
  { id: 'landcover', label: 'Land cover (WorldCover)', place: '31.2, 31.0', tool: 'classify_land_cover' },
  { id: 'dem', label: 'DEM (elevation)', place: '45.98, 7.66', tool: 'fetch_dem' },
  { id: 'flood', label: 'Flood extent (map_flood)', place: '30.985, 74.58', tool: 'map_flood', fields: { before: '2025-07-20', after: '2025-09-02', include_roads: false } },
  { id: 'buildings', label: 'Buildings (query_3d_tiles)', place: '31.5497, 74.3436', tool: 'query_3d_tiles', zoomIn: true },
]

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const results = []

async function drawAoi(page, place) {
  const search = page.getByTestId('place-search')
  const zoom = page.getByTestId('map-zoom')
  await sleep(3000)
  for (let attempt = 0; attempt < 3; attempt++) {
    await search.fill(place)
    await search.press('Enter')
    for (let i = 0; i < 30; i++) { if (Number(await zoom.textContent()) >= 12.5) break; await sleep(500) }
    if (Number(await zoom.textContent()) >= 12.5) break
  }
  await sleep(3500)
  const box = await page.locator('.maplibregl-canvas').boundingBox()
  const cx = box.x + box.width * 0.5, cy = box.y + box.height * 0.5
  await page.getByTestId('draw-rectangle').click()
  await page.mouse.click(cx - 90, cy - 70)
  await page.mouse.move(cx, cy, { steps: 8 })
  await page.mouse.move(cx + 90, cy + 70, { steps: 8 })
  await page.mouse.click(cx + 90, cy + 70)
  await page.getByTestId('aoi-card').waitFor({ timeout: 15000 })
  await sleep(800)
  return page.getByTestId('aoi-card').innerText()
}

/** Fraction of map pixels that differ noticeably between two screenshots of the map element. */
async function diffFrac(a, b) {
  const [ia, ib] = await Promise.all([a, b].map((x) => sharp(x).removeAlpha().raw().toBuffer({ resolveWithObject: true })))
  if (ia.info.width !== ib.info.width || ia.info.height !== ib.info.height) return null
  let d = 0
  const n = ia.info.width * ia.info.height
  for (let i = 0; i < n; i++) {
    const s = Math.abs(ia.data[i * 3] - ib.data[i * 3]) + Math.abs(ia.data[i * 3 + 1] - ib.data[i * 3 + 1]) + Math.abs(ia.data[i * 3 + 2] - ib.data[i * 3 + 2])
    if (s > 40) d++
  }
  return +(d / n).toFixed(4)
}

for (const c of CASES) {
  if (only && !only.includes(c.id)) continue
  const r = { id: c.id, label: c.label, place: c.place, status: 'fail', notes: [], shot: path.join(SHOTS, `${c.id}.png`) }
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await ctx.addInitScript(() => { try { localStorage.setItem('erdfeld-sidebar', 'expanded'); localStorage.setItem('erdfeld-owner-token', 'ops-eval-ui') } catch {} })
  const page = await ctx.newPage()
  const bad = [], tiles = { ok: 0, fail: [] }
  page.on('response', (res) => {
    const u = res.url()
    if (/\/tiles?\/|\/api\/geo\/tiles|titiler|\{z\}|\.png|\.webp/i.test(u) && !/basemap|openfreemap|arcgis|openstreetmap|carto|maptiler|stadia/i.test(u)) {
      if (res.status() === 200) tiles.ok++
      else tiles.fail.push(`${res.status()} ${u.slice(0, 220)}`)
    }
    if (res.status() >= 400) bad.push(`${res.status()} ${res.request().method()} ${u.slice(0, 160)}`)
  })
  const t0 = Date.now()
  try {
    await page.goto(BASE, { waitUntil: 'load' })
    await page.locator('.maplibregl-canvas').waitFor({ timeout: 30000 })
    r.aoi = (await drawAoi(page, c.place)).replace(/\s+/g, ' ').slice(0, 160)
    const mapEl = page.locator('.maplibregl-canvas')
    await page.getByTestId('nav-processing').click()
    await page.getByTestId('toolbox').waitFor({ timeout: 20000 })
    await sleep(1500)
    const before = await mapEl.screenshot()
    if (c.quick) {
      await page.getByTestId(`quick-layer-${c.quick}`).click()
    } else {
      await page.getByTestId('toolbox-search').fill(c.tool.replace(/^fetch_/, '').replace(/_/g, ' '))
      await sleep(500)
      await page.getByTestId(`tool-${c.tool}`).click()
      await page.getByTestId('tool-run').waitFor({ timeout: 15000 })
      for (const [k, v] of Object.entries(c.fields || {})) {
        const el = page.locator(`#tool-f-${k}`)
        if (typeof v === 'boolean') { if ((await el.isChecked()) !== v) await el.click() } else await el.fill(v)
      }
      await page.getByTestId('tool-run').click()
      await sleep(2000)
      await page.getByRole('tab', { name: /^Jobs/ }).click().catch(() => {})
    }
    // Wait for the layer to be added (a layer row appears) or the job to fail.
    await page.getByRole('tab', { name: /^Layers/ }).click().catch(() => {})
    const deadline = Date.now() + 300000
    let rows = 0
    while (Date.now() < deadline) {
      rows = await page.getByTestId('layer-row').count()
      if (rows > 0) break
      await sleep(3000)
    }
    r.layer_rows = rows
    r.layer_names = (await page.getByTestId('layer-row').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').slice(0, 120))
    // Map idle: network quiet and a settle period for tile decode.
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
    await sleep(8000)
    const after = await mapEl.screenshot()
    await page.screenshot({ path: r.shot })
    writeFileSync(r.shot.replace(/\.png$/, '-map.png'), after)
    r.map_changed_frac = await diffFrac(before, after)
    r.legend = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="layer-row"], [data-testid="vector-legend"]')]
      const grad = [...document.querySelectorAll('[style*="gradient"], canvas')].filter((e) => e.closest('[data-testid="layer-row"], aside, [class*="legend" i]')).length
      return { vector_legend: !!document.querySelector('[data-testid="vector-legend"]'), gradient_elements: grad, legend_text: /legend|stretch|colou?r ramp|min|max/i.test(rows.map((x) => x.textContent).join(' ')) }
    })
    r.tiles = { ok: tiles.ok, failed: tiles.fail.slice(0, 5), failed_count: tiles.fail.length }
    r.http_errors = bad.slice(0, 8)
    r.ms = Date.now() - t0
    r.notes.push(`layer rows ${rows}, map pixels changed ${(r.map_changed_frac * 100).toFixed(1)}%, layer tile responses ok ${tiles.ok} failed ${tiles.fail.length}`)
    r.status = rows > 0 && r.map_changed_frac != null && r.map_changed_frac > 0.01 && !tiles.fail.length ? 'pass' : rows > 0 ? 'partial' : 'fail'
  } catch (e) {
    r.notes.push('exception: ' + String(e?.message || e).split('\n')[0])
    r.ms = Date.now() - t0
    try { await page.screenshot({ path: r.shot }) } catch {}
    r.http_errors = bad.slice(0, 8)
  }
  console.log(`ui ${c.id}: ${r.status}  ${r.notes.join(' | ')}`)
  results.push(r)
  await ctx.close()
  writeFileSync(path.join(OUT, 'ui-results.json'), JSON.stringify(results, null, 1))
}
await browser.close()
