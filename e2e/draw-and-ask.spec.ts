import { expect, test, type Page } from '@playwright/test'

/**
 * Q-01 / Q-02 / Q-10: the draw -> ask -> layer path, driven through the real UI with the
 * offline stub LLM (server started with AGENT_ALLOW_STUB=1). `render_to_map` emits the drawn
 * AOI as a fixture layer, so the result needs no network.
 */

const LAYER_NAME = 'E2E Layer'
const STUB_QUESTION = `stub-run: [{"tool":"render_to_map","args":{"name":"${LAYER_NAME}"}}]`

async function prepare(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('erdfeld-settings', JSON.stringify({ aiProvider: 'openai', aiApiKey: 'unused' }))
    // the sidebar is an icon rail below 1440px; the layer list is read in its expanded form
    localStorage.setItem('erdfeld-sidebar', 'expanded')
  })
  // The agent endpoint is answered at the network edge with one layer event (the stub provider
  // cannot run in a production build, which refuses AGENT_ALLOW_STUB), so the draw -> ask -> layer
  // path is the real client and the real map, with a fixed reply.
  const event = (name: string, data: unknown) => `event: ${name}
data: ${JSON.stringify({ type: name, ...(data as object) })}

`
  await page.route('**/api/agent', (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const body = route.request().postDataJSON()
    const ring = body?.aoi?.coordinates ?? [[[0, 0], [0, 0.01], [0.01, 0.01], [0, 0]]]
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body:
        event('layer', { layer_id: 'e2e-layer', layer_type: 'geojson', name: LAYER_NAME, geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: ring } }] } }) +
        event('token', { content: 'Done.' }) +
        event('done', {}),
    })
  })
}

async function drawRectangleAndAsk(page: Page) {
  await page.goto('/')
  const canvas = page.locator('.maplibregl-canvas')
  await expect(canvas).toBeVisible()

  // The map starts at zoom 2; a drawn area that big is rejected as a mistake. Zoom to city scale.
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.45)
  // (the readout at the top-left of the map tracks the zoom)
  const zoomReadout = page.getByTestId('map-zoom')
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, -500)
    await page.waitForTimeout(150)
  }
  await page.mouse.move(box.x + box.width * 0.6 + 1, box.y + box.height * 0.45 + 1)
  await expect.poll(async () => Number(await zoomReadout.textContent())).toBeGreaterThan(8)
  // wheel zoom eases for a moment after the last tick: draw only once the map has stopped moving
  let last = ''
  await expect.poll(async () => {
    const now = (await zoomReadout.textContent()) ?? ''
    const settled = now === last
    last = now
    await page.waitForTimeout(400)
    return settled
  }).toBe(true)

  // The sidebar's rectangle tool: no `force`, so Playwright fails if anything covers it (Q-02).
  await page.getByTestId('draw-rectangle').click()

  const cx = box.x + box.width * 0.6
  const cy = box.y + box.height * 0.45
  // TerraDraw's rectangle mode is click (first corner), move, click (opposite corner).
  await page.mouse.click(cx - 80, cy - 60)
  await page.mouse.move(cx, cy, { steps: 8 })
  await page.mouse.move(cx + 80, cy + 60, { steps: 8 })
  await page.mouse.click(cx + 80, cy + 60)
  await expect(page.getByTestId('aoi-card')).toContainText('Rectangle area')

  const input = page.locator('#chat-composer')
  await expect(input).toBeVisible()
  await input.fill(STUB_QUESTION)
  await input.press('Enter')

  // The layer panel lists the layer by name once the agent's `layer` event has been applied.
  await page.getByRole('tab', { name: /^Layers/ }).click()
  await expect(page.getByTestId('layer-row').getByText(LAYER_NAME, { exact: true }).first()).toBeVisible()
}

for (const viewport of [
  { width: 1600, height: 1000 },
  { width: 1280, height: 720 },
]) {
  test(`draw a rectangle, ask, and get a layer at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await prepare(page)
    await drawRectangleAndAsk(page)
    await page.screenshot({ path: `test-results/e2e-${viewport.width}x${viewport.height}.png` })
  })
}

test('drawing still works when the CARTO basemap style is blocked (Q-10)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  // the CARTO vector basemap, chosen: the default is imagery
  await page.addInitScript(() => localStorage.setItem('erdfeld-basemap', 'dark'))
  await prepare(page)
  await page.route(/basemaps\.cartocdn\.com/, (route) => route.abort())
  await drawRectangleAndAsk(page)
})
