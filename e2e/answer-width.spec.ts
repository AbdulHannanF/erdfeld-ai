import { expect, test } from '@playwright/test'

/**
 * A cited answer stays inside the inspector, whatever it holds. One unbroken token (a Sentinel-1 scene
 * id, a URL) or a long chart title used to widen the answer column to its own length, so the whole answer was laid out wider
 * than the panel and clipped at the right edge. The agent stream is answered at the network edge.
 */

const AOI = {
  type: 'Rectangle',
  geometry: { type: 'Polygon', coordinates: [[[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]]] },
  center: { lng: 74.065, lat: 31.135 },
}
const RID = 'r_a1b2c3d4e5f60718'
const SUMMARY = { flooded_area_km2: 12.34, flooded_area_km2_low: 9.81, flooded_area_km2_high: 15.07, buildings_affected: 1234, water_fraction_pct: 23.4 }
const ANSWER = [
  `Radar shows [[${RID}#flooded_area_km2]] of standing water on 4 Sep 2025 (range [[${RID}#flooded_area_km2_low]] to [[${RID}#flooded_area_km2_high]] across thresholds).`,
  '',
  `About [[${RID}#buildings_affected]] buildings sit inside the water mask; water covers [[${RID}#water_fraction_pct]] of the area.`,
  '',
  'Scenes: S1A_IW_GRDH_1SDV_20250904T005822_20250904T005847_060812_078E1F and S1A_IW_GRDH_1SDV_20250823T005821_20250823T005846_060637_0787A2.',
].join('\n')
const sse = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`
const STREAM =
  sse('tool_call', { tool_name: 'map_flood', status: 'running', label: 'Map flood extent from radar' }) +
  sse('tool_call', { tool_name: 'map_flood', status: 'completed', label: 'Map flood extent from radar', result_id: RID, summary_data: SUMMARY }) +
  sse('chart', {
    chart_id: 'c_water_fraction',
    title: 'Sentinel-1 water fraction per scene (before and after) at -15.0 dB, share of the area of interest in percent',
    spec: { $schema: 'https://vega.github.io/schema/vega-lite/v5.json', data: { values: [{ d: '2025-07-30', v: 2.1 }, { d: '2025-09-04', v: 17.4 }] }, mark: 'line', encoding: { x: { field: 'd', type: 'temporal' }, y: { field: 'v', type: 'quantitative' } } },
  }) +
  sse('token', { content: ANSWER }) +
  sse('done', {})

for (const size of [{ width: 1920, height: 1080 }, { width: 2304, height: 1296 }, { width: 2560, height: 1440 }]) {
  test(`a cited answer with a long unbroken token stays inside the inspector at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size)
    await page.addInitScript((aoi) => {
      localStorage.setItem('erdfeld-onboarding-completed', 'true')
      localStorage.setItem('erdfeld-settings', JSON.stringify({ aiProvider: 'openai', aiApiKey: 'unused' }))
      localStorage.setItem('erdfeld-aoi', JSON.stringify(aoi))
    }, AOI)
    await page.route('**/api/agent', (r) => (r.request().method() === 'POST' ? r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: STREAM }) : r.continue()))
    await page.route(`**/api/results/${RID}`, (r) => r.fulfill({ json: { result: { summary: 'Flood extent', status: 'ok', stats: SUMMARY } } }))
    await page.goto('/')
    await expect(page.locator('.maplibregl-canvas')).toBeVisible()
    await page.locator('#chat-composer').fill('How much of this area flooded in September 2025?')
    await page.locator('#chat-composer').press('Enter')
    await expect(page.getByTestId('answer-headline')).toBeVisible()

    const fit = await page.evaluate(() => {
      const body = document.getElementById('inspector-body')!
      const panel = body.getBoundingClientRect()
      const view = document.querySelector('[data-testid="answer-view"]')!.getBoundingClientRect()
      return { overflowX: body.scrollWidth - body.clientWidth, viewRight: view.right, panelRight: panel.right }
    })
    expect(fit.overflowX).toBeLessThanOrEqual(0)
    expect(fit.viewRight).toBeLessThanOrEqual(fit.panelRight)
  })
}
