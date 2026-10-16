// Usage: start the stack (app with AGENT_ALLOW_STUB=1, Postgres, GEO_SERVICE_URL), warm the results once,
//   then: CASE_ID=<case> BATCH_ID=<batch> node scripts/demo/record-demo.mjs   (clips in $DEMO_OUT)
// Demo recording: the real Erdfeld AI app on live data (production build, Postgres, geo service).
// The LLM planning step is scripted (no provider key in the sandbox): each natural question is
// mapped to the tool plan below and executed by the real engine. Results were computed live
// beforehand and are served from the content-hash result cache (provenance shows cached:true).
import { chromium } from 'playwright'
import fs from 'node:fs'

const BASE = process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:3300'
const OUT = process.env.DEMO_OUT ?? 'demo-clips'
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true })
const CASE_ID = process.env.CASE_ID
const KASUR = { type: 'Polygon', coordinates: [[[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]]] }

const PLANS = [
  [/sutlej|under water|flood/i, [{ tool: 'map_flood', args: { start: '2025-06-15', end: '2025-10-15' } }]],
  [/near-infrared|B08/i, [{ tool: 'render_raster', args: { bands: ['B08'], start: '2026-09-01', end: '2026-09-30' } }]],
  [/cloud-free|median/i, [{ tool: 'composite', args: { expression: 'NDVI', start: '2026-09-01', end: '2026-09-30' } }]],
  [/unusual|expected/i, [{ tool: 'detect_anomaly', args: { month: '2026-09' } }]],
  [/B99/i, [{ tool: 'render_raster', args: { bands: ['B99'], start: '2026-09-01', end: '2026-09-30' } }]],
]

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
})

async function scene(name, viewport, fn, init = {}) {
  const ctx = await browser.newContext({ viewport, recordVideo: { dir: OUT, size: viewport }, deviceScaleFactor: 1 })
  await ctx.addInitScript((init) => {
    localStorage.setItem('erdfeld-settings', JSON.stringify({ aiProvider: 'openai', aiApiKey: 'unused' }))
    localStorage.setItem('erdfeld-owner-token', 'demo')
    localStorage.setItem('erdfeld-onboarding-completed', 'true')
    if (init.aoi) localStorage.setItem('erdfeld-aoi', JSON.stringify({ type: 'Rectangle', geometry: init.aoi }))
  }, init)
  await ctx.route('**/api/agent', async (route) => {
    const req = route.request()
    if (req.method() !== 'POST') return route.continue()
    const body = req.postDataJSON()
    const plan = PLANS.find(([re]) => re.test(body.query))
    const query = plan ? `stub-run: ${JSON.stringify(plan[1])}` : body.query
    await route.continue({ postData: JSON.stringify({ ...body, aiProvider: 'stub', query }) })
  })
  const page = await ctx.newPage()
  await fn(page)
  const video = page.video()
  await ctx.close()
  fs.renameSync(await video.path(), `${OUT}/${name}.webm`)
  console.log('recorded', name)
}

async function caption(page, text, sub = '') {
  await page.evaluate(({ text, sub }) => {
    let el = document.getElementById('demo-caption')
    if (!el) {
      el = document.createElement('div')
      el.id = 'demo-caption'
      el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;max-width:min(92vw,980px);background:rgba(23,27,28,0.92);color:#F2F6F5;border:1px solid rgba(92,191,166,0.45);border-radius:10px;padding:12px 18px;font:500 17px/1.4 Inter,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.35);pointer-events:none;text-align:center'
      document.body.appendChild(el)
    }
    el.innerHTML = `<div>${text}</div>${sub ? `<div style="margin-top:4px;font-size:13px;color:#9FB3AE">${sub}</div>` : ''}`
  }, { text, sub })
}

async function ask(page, q) {
  const input = page.getByPlaceholder('Ask about the selected area...')
  await input.click()
  await input.pressSequentially(q, { delay: 28 })
  await input.press('Enter')
}

const W = { width: 1600, height: 900 }

// 1. Welcome + flood sample case
await scene('01-flood', W, async (page) => {
  await page.goto(BASE + '/')
  await page.waitForTimeout(2500)
  await caption(page, 'Erdfeld AI: ask questions of a place, answered from free open satellite data', 'Every number comes with its source, its uncertainty and a way to reproduce it')
  await page.waitForTimeout(4000)
  await caption(page, 'Sample case: what went under water in the 2025 Sutlej flood, and what did it hit?')
  await page.getByText('2025 Sutlej flood', { exact: true }).click()
  await page.getByText(/Flood extent/).first().waitFor({ timeout: 180_000 })
  await page.waitForTimeout(2500)
  await caption(page, 'Sentinel-1 radar before vs after: 18.0 km² newly flooded, 124 buildings and 15.3 km of road hit', 'Reported as a range across thresholds (8.6–18 km²), with caveats on what radar cannot see')
  await page.waitForTimeout(9000)
})

// 2. NIR from the clearest scene (Q-60 fix: the cloudy 09-28 scene is rejected)
await scene('02-nir', W, async (page) => {
  await page.goto(BASE + '/')
  await page.waitForTimeout(1500)
  await page.getByText('Near-infrared, one clear scene', { exact: true }).click()
  await caption(page, 'Any band, any expression: near-infrared (B08) from the clearest September scene')
  await page.getByText(/B08/).first().waitFor({ timeout: 120_000 })
  await page.waitForTimeout(2500)
  await caption(page, 'The scene picker scans every candidate and rejects cloudy ones: 23 Sep chosen, 28 Sep (cloud) rejected', 'Stretch from the area’s own pixels; the legend shows the real min/max')
  await page.waitForTimeout(8000)
})

// 3. One-click layer + cloud-free composite + anomaly
await scene('03-composite-anomaly', W, async (page) => {
  await page.goto(BASE + '/')
  await page.waitForTimeout(2500)
  await caption(page, 'One-click layers run straight through the engine, no LLM round-trip')
  await page.getByTestId('quick-layer-ndvi').click()
  await page.waitForTimeout(7000)
  await caption(page, 'A cloud-free median of a whole month, computed by the Python geo service')
  await ask(page, 'Make a cloud-free median NDVI for September 2026')
  await page.getByText(/median|composite/i).first().waitFor({ timeout: 120_000 })
  await page.waitForTimeout(6000)
  await caption(page, 'Is this month unusual? Observed vs the expected range from the site’s own history')
  await ask(page, 'Is NDVI here unusual for September, compared with what is expected?')
  await page.getByText(/WITHIN the expected range|expected range/i).first().waitFor({ timeout: 180_000 })
  await page.waitForTimeout(2000)
  await caption(page, 'Observed 0.587 vs expected 0.535–0.636: within range', 'Climatology baseline, chosen because it beat TimesFM 2.5 on our 6-site backtest (coverage 83%)')
  await page.waitForTimeout(8000)
}, { aoi: KASUR })

// 4. Honest refusal
await scene('04-refusal', W, async (page) => {
  await page.goto(BASE + '/')
  await page.waitForTimeout(2500)
  await caption(page, 'Invalid requests are refused before anything runs, with the reason')
  await ask(page, 'Show band B99 for this area')
  await page.getByText(/B99/).nth(1).waitFor({ timeout: 60_000 }).catch(() => {})
  await page.waitForTimeout(6000)
}, { aoi: KASUR })

// 5. Claim verification case view
if (CASE_ID) await scene('05-claim', W, async (page) => {
  await page.goto(`${BASE}/cases/${CASE_ID}`)
  await page.getByText(/Supported/).first().waitFor({ timeout: 60_000 })
  await caption(page, 'Claim verification: “this plot was flooded on 4 Sep 2025” → Supported, 90%', 'Versioned recipe, evidence timeline, and an explanation built only from recorded results')
  await page.waitForTimeout(6000)
  await page.mouse.wheel(0, 700)
  await page.waitForTimeout(2500)
  await caption(page, 'Every sentence cites the result id it rests on; the bundle is Ed25519-signed and re-runnable')
  await page.waitForTimeout(6000)
})

// 5b. Batch verification
if (process.env.BATCH_ID) await scene('05b-batch', W, async (page) => {
  await page.goto(`${BASE}/cases/batch/${process.env.BATCH_ID}`)
  await page.getByText(/Contradicted/).first().waitFor({ timeout: 60_000 })
  await caption(page, 'Batch: upload many plots; each claim runs on the job queue', '3 Supported · 2 Contradicted · 1 Cannot determine — exportable as CSV, GeoJSON, KML, Shapefile, plus signed bundles')
  await page.waitForTimeout(9000)
})

// 6. Vector import
await scene('06-vector', W, async (page) => {
  await page.goto(BASE + '/')
  await page.waitForTimeout(2500)
  await caption(page, 'Bring your own plots: GeoJSON, Shapefile, KML, GPX or CSV, reprojected and validated in the browser')
  const plots = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Plot 7' }, geometry: { type: 'Polygon', coordinates: [[[74.06, 31.13], [74.07, 31.13], [74.07, 31.14], [74.06, 31.14], [74.06, 31.13]]] } }] }
  const dt = await page.evaluateHandle((content) => { const d = new DataTransfer(); d.items.add(new File([content], 'plots.geojson', { type: 'application/geo+json' })); return d }, JSON.stringify(plots))
  const panel = page.locator('.maplibregl-canvas').locator('xpath=ancestor::div[contains(@class,"relative")][1]')
  for (const type of ['dragenter', 'dragover', 'drop']) await panel.dispatchEvent(type, { dataTransfer: dt })
  await page.getByText('plots', { exact: true }).first().waitFor({ timeout: 30_000 })
  await page.waitForTimeout(2500)
  await page.getByRole('button', { name: 'Use plots as AOI' }).click()
  await caption(page, 'Use it as the area of interest, or export results back as GeoJSON, Shapefile, KML or CSV')
  await page.waitForTimeout(6000)
})

// 7. Mobile
await scene('07-mobile', { width: 390, height: 844 }, async (page) => {
  await page.goto(BASE + '/')
  await page.waitForTimeout(2500)
  await page.getByRole('tab', { name: /Chat/ }).click()
  await page.waitForTimeout(800)
  await page.getByText('2025 Sutlej flood', { exact: true }).click()
  await page.waitForTimeout(6000)
  await page.waitForTimeout(3000)
  await page.getByRole('tab', { name: /Map/ }).click().catch(() => {})
  await caption(page, 'Works on a phone: no overlapping controls at 390 px')
  await page.waitForTimeout(6000)
})

await browser.close()
