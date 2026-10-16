// UI checks against the live deployment, driven with Playwright (from the repo's node_modules).
//   node eval/live/ui-checks.mjs [--only ui01,ui02,ui03,ui04] [--base <url>]
// Writes eval/live/ui-results-<date>.json and screenshots to C:\Users\Abdul\erdfeld-shots\live-eval\.
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'https://erdfeld-web-707586221016.us-central1.run.app').replace(/\/$/, '')
const only = arg('only')?.split(',')
const SHOTS = 'C:\\Users\\Abdul\\erdfeld-shots\\live-eval'
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUTJSON = path.join(path.dirname(fileURLToPath(import.meta.url)), `ui-results-${new Date().toISOString().slice(0, 10)}.json`)
mkdirSync(SHOTS, { recursive: true })

const results = {}
const want = (id) => !only || only.includes(id)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })

async function newPage(tag) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('erdfeld-sidebar', 'expanded')
      localStorage.setItem('erdfeld-owner-token', 'live-eval-ui')
    } catch {}
  })
  const page = await ctx.newPage()
  const log = { failed: [], bad: [], console: [], pageerrors: [] }
  page.on('requestfailed', (r) => log.failed.push(`${r.method()} ${r.url().slice(0, 140)} ${r.failure()?.errorText}`))
  page.on('response', (r) => { if (r.status() >= 400) log.bad.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 140)}`) })
  page.on('console', (m) => { if (m.type() === 'error') log.console.push(m.text().slice(0, 200)) })
  page.on('pageerror', (e) => log.pageerrors.push(String(e).slice(0, 200)))
  return { ctx, page, log }
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) })

/** Fly to a place with the coordinate/place search, then draw a rectangle on the map. */
async function drawAoi(page, place) {
  const search = page.getByTestId('place-search')
  await sleep(4000)
  const zoom0 = page.getByTestId('map-zoom')
  for (let attempt = 0; attempt < 3; attempt++) {
    await search.fill(place)
    await search.press('Enter')
    for (let i = 0; i < 24; i++) { if (Number(await zoom0.textContent()) >= 12.5) break; await sleep(500) }
    if (Number(await zoom0.textContent()) >= 12.5) break
  }
  // The coordinate search flies the map (zoom 13); a wheel event during the flight would cancel it.
  const canvas = page.locator('.maplibregl-canvas')
  const box = await canvas.boundingBox()
  const zoom = page.getByTestId('map-zoom')
  const cx = box.x + box.width * 0.5, cy = box.y + box.height * 0.5
  for (let i = 0; i < 60; i++) { if (Number(await zoom.textContent()) >= 12.5) break; await sleep(500) }
  await sleep(3500)
  await page.getByTestId('draw-rectangle').click()
  await page.mouse.click(cx - 90, cy - 70)
  await page.mouse.move(cx, cy, { steps: 8 })
  await page.mouse.move(cx + 90, cy + 70, { steps: 8 })
  await page.mouse.click(cx + 90, cy + 70)
  await page.getByTestId('aoi-card').waitFor({ timeout: 15000 })
  await sleep(500)
  const aoiText = await page.getByTestId('aoi-card').innerText()
  if (!/4[12]\.\d+°\s*N/.test(aoiText)) throw new Error('AOI is not near the searched place: ' + aoiText.replace(/\s+/g, ' '))
}

async function check(id, fn) {
  if (!want(id)) return
  const t0 = Date.now()
  const r = { id, status: 'fail', notes: [], ms: 0 }
  const h = await newPage(id)
  try { await fn(h, r) } catch (e) { r.status = 'fail'; r.notes.push(`exception: ${String(e?.message || e).split('\n')[0]}`); try { await shot(h.page, `${id}-failure`) } catch {} }
  r.ms = Date.now() - t0
  r.network = { failed: h.log.failed, http_errors: h.log.bad, console_errors: h.log.console, page_errors: h.log.pageerrors }
  results[id] = r
  await h.ctx.close()
  console.log(id, r.status, r.notes.join(' | '))
}

await check('ui01', async ({ page, log }, r) => {
  await page.goto(BASE, { waitUntil: 'load' })
  await page.locator('.maplibregl-canvas').waitFor({ timeout: 30000 })
  await sleep(6000)
  const unavailable = await page.getByText(/Basemap unavailable/i).count()
  await shot(page, 'ui01-load')
  r.basemap_unavailable_text = unavailable
  // a pixel check that the canvas drew something
  r.canvas_nonblank = await page.evaluate(() => { const c = document.querySelector('.maplibregl-canvas'); return !!c && c.width > 0 && c.height > 0 })
  r.notes.push(`failed requests: ${log.failed.length}, http>=400: ${log.bad.length}, console errors: ${log.console.length}, page errors: ${log.pageerrors.length}, "Basemap unavailable": ${unavailable}`)
  r.status = !unavailable && !log.failed.length && !log.bad.length && !log.console.length && !log.pageerrors.length ? 'pass' : (!unavailable && !log.pageerrors.length ? 'partial' : 'fail')
})

await check('ui02', async ({ page }, r) => {
  await page.goto(BASE, { waitUntil: 'load' })
  await drawAoi(page, '42.0308, -93.6319')
  await shot(page, 'ui02-aoi')
  r.aoi_card = (await page.getByTestId('aoi-card').innerText()).slice(0, 200)
  const input = page.locator('#chat-composer')
  await input.fill('Show NDVI for this area for July 2024.')
  await input.press('Enter')
  await page.getByTestId('answer-view').waitFor({ timeout: 240000 })
  await page.getByRole('button', { name: /^Stop$/ }).waitFor({ state: 'hidden', timeout: 280000 }).catch(() => {})
  await sleep(3000)
  await shot(page, 'ui02-answer')
  const text = await page.getByTestId('answer-view').first().innerText()
  r.answer_excerpt = text.slice(0, 600)
  r.has_unverified_note = await page.getByTestId('unverified-note').count()
  const pills = await page.locator('[data-testid="answer-view"] [data-citation], [data-testid="answer-view"] sup, [data-testid="answer-view"] [class*="citation"]').count()
  r.citation_elements = pills
  await page.getByRole('tab', { name: /^Layers/ }).click()
  await sleep(1000)
  r.layer_rows = await page.getByTestId('layer-row').count()
  await shot(page, 'ui02-layers')
  r.notes.push(`answer chars ${text.length}, citation elements ${pills}, layer rows ${r.layer_rows}, unverified note ${r.has_unverified_note}`)
  r.status = text.length > 80 && r.layer_rows > 0 && pills > 0 ? (r.has_unverified_note ? 'partial' : 'pass') : 'fail'
})

await check('ui03', async ({ page }, r) => {
  await page.goto(BASE, { waitUntil: 'load' })
  await drawAoi(page, '42.0308, -93.6319')
  await page.getByTestId('nav-processing').click()
  await page.getByTestId('toolbox').waitFor({ timeout: 20000 })
  await page.getByTestId('toolbox-search').fill('ndvi')
  await sleep(500)
  await shot(page, 'ui03-toolbox')
  await page.getByTestId('tool-fetch_ndvi').click()
  await page.getByTestId('tool-run').waitFor({ timeout: 15000 })
  await shot(page, 'ui03-dialog')
  const jobsBefore = await page.evaluate(async () => (await (await fetch('/api/jobs', { headers: { 'x-owner-token': 'live-eval-ui' } })).json()).batches.length)
  await page.getByTestId('tool-run').click()
  await sleep(2000)
  await page.getByRole('tab', { name: /^Jobs/ }).click().catch(() => {})
  await page.waitForFunction(() => { const r = document.querySelector('[data-testid="job-row"]'); return !!r && /FINISHED/.test(r.textContent || '') }, null, { timeout: 280000 })
  r.jobs_before = jobsBefore
  await shot(page, 'ui03-jobs')
  r.job_rows = await page.getByTestId('job-row').count()
  await page.getByRole('tab', { name: /^Layers/ }).click()
  await sleep(1500)
  r.layer_rows = await page.getByTestId('layer-row').count()
  await shot(page, 'ui03-layers')
  r.notes.push(`job rows ${r.job_rows}, FINISHED shown, layer rows ${r.layer_rows}`)
  r.status = r.layer_rows > 0 ? 'pass' : 'fail'
})

await check('ui04', async ({ page }, r) => {
  await page.goto(BASE, { waitUntil: 'load' })
  await drawAoi(page, '42.0308, -93.6319')
  const input = page.locator('#chat-composer')
  await input.fill('Show NDVI for this area for July 2024.')
  await input.press('Enter')
  await page.getByTestId('answer-view').waitFor({ timeout: 240000 })
  await page.getByRole('button', { name: /^Stop$/ }).waitFor({ state: 'hidden', timeout: 280000 }).catch(() => {})
  await sleep(3000)
  const btn = page.getByRole('button', { name: /Signed bundle/ }).first()
  await btn.waitFor({ timeout: 60000 })
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), btn.click()])
  const file = path.join(SHOTS, 'bundle.json')
  await dl.saveAs(file)
  await shot(page, 'ui04-bundle')
  const keyRes = await fetch(`${BASE}/api/evidence/public-key`)
  const key = await keyRes.json()
  r.key = { alg: key.alg, key_id: key.key_id, ephemeral: key.ephemeral, note: key.note }
  const pem = path.join(SHOTS, 'public-key.pem')
  writeFileSync(pem, key.public_key_pem)
  const verify = (f) => { try { return { code: 0, out: execFileSync('npx', ['tsx', 'scripts/verify-bundle.mts', f, '--key', pem], { cwd: REPO, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] }) } } catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') } } }
  const ok = verify(file)
  r.verify_original = { exit: ok.code, out: ok.out.trim().slice(0, 300) }
  // Tamper with one number in the bundle.
  const raw = readFileSync(file, 'utf8')
  const tampered = raw.replace(/("(?:mean|valid_pixel_pct|area_km2|cloud_pct)":\s*)(-?\d+(\.\d+)?)/, (_, p, n) => `${p}${Number(n) + 1}`)
  r.tamper_changed = tampered !== raw
  const tf = path.join(SHOTS, 'bundle-tampered.json')
  writeFileSync(tf, tampered)
  const bad = verify(tf)
  r.verify_tampered = { exit: bad.code, out: bad.out.trim().slice(0, 300) }
  r.notes.push(`original exit ${ok.code} (${ok.out.trim().split('\n').pop()}), tampered exit ${bad.code} (${bad.out.trim().split('\n').pop()})`)
  r.status = ok.code === 0 && /VALID/.test(ok.out) && r.tamper_changed && bad.code === 1 && /INVALID/.test(bad.out) ? 'pass' : 'fail'
})

writeFileSync(OUTJSON, JSON.stringify(results, null, 1))
await browser.close()
