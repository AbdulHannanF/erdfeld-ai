import { expect, test, type Page } from '@playwright/test'

/**
 * Q-15: one-click quick layers and early-layer reconciliation, with the network mocked at the
 * app's own API edge (no upstream data needed): `/api/quick-layer` returns a GeoResult, and
 * `/api/agent` streams a provisional layer followed by the final one.
 */

const RING = [[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]]
const AOI = {
  type: 'Rectangle',
  geometry: { type: 'Polygon', coordinates: [RING] },
  center: { lng: 74.065, lat: 31.135 },
}

// geojson so the map needs no tile server; the quick-layer path is identical for raster layers
const resultLayer = (name: string) => ({
  id: 'ndvi-active', name, type: 'geojson',
  geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: AOI.geometry }] },
  bounds: [74.05, 31.12, 74.08, 31.15],
  provenance: { source: 'Sentinel-2 L2A (AWS Element84 Earth Search) — NDVI', method: 'e2e fixture', clip: 'polygon' },
  confidence: 'high',
})
const geoResult = (status: 'ok' | 'refused', layers: unknown[]) => ({
  schema: 'geo-result/1', result_id: 'r_e2e', op: { name: 'fetch_ndvi', version: '1.0.0' }, status,
  summary: status === 'ok' ? 'NDVI quick layer ready.' : '**fetch_ndvi was not run.** The AOI is too large.',
  layers, stats: status === 'ok' ? { mean: 0.41 } : undefined,
  provenance: { sources: [], items: [], method: 'fetch_ndvi@1.0.0', inputs_hash: 'h' },
  validation: status === 'ok' ? [] : [{ id: 'aoi_area', phase: 'static', status: 'fail', message: 'The AOI is too large.' }],
})

async function prepare(page: Page) {
  await page.addInitScript((aoi) => {
    localStorage.setItem('erdfeld-onboarding-completed', 'true')
    localStorage.setItem('erdfeld-sidebar', 'expanded')
    localStorage.setItem('erdfeld-aoi', JSON.stringify(aoi))
  }, AOI)
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/')
  await page.waitForSelector('.maplibregl-canvas', { timeout: 30_000 })
}

test('a quick layer posts the drawn AOI, needs no model, and shows the GeoResult layer', async ({ page }) => {
  await prepare(page)
  let agentCalls = 0
  await page.route('**/api/agent', (route) => { agentCalls++; return route.abort() })
  const bodies: any[] = []
  await page.route('**/api/quick-layer', (route) => {
    bodies.push(route.request().postDataJSON())
    return route.fulfill({ json: geoResult('ok', [resultLayer('NDVI 2026-09-23')]) })
  })

  await page.getByTestId('quick-layer-ndvi').click()
  await page.getByRole('tab', { name: /^Layers/ }).click()
  await expect(page.getByTestId('layer-row').getByText('NDVI 2026-09-23', { exact: true }).first()).toBeVisible()
  expect(bodies).toEqual([{ op: 'ndvi', aoi: AOI.geometry }])
  expect(agentCalls).toBe(0)
})

test('a refused quick layer draws nothing and says why', async ({ page }) => {
  await prepare(page)
  await page.route('**/api/quick-layer', (route) => route.fulfill({ json: geoResult('refused', []) }))
  await page.getByTestId('quick-layer-elevation').click()
  await expect(page.getByText(/was not run/).first()).toBeVisible()
  await expect(page.getByRole('button', { name: /expand layers panel|collapse layers panel/i })).toHaveCount(0)
})

test('a provisional layer and its final layer are one layer in the panel', async ({ page }) => {
  await prepare(page)
  const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const layerEvent = (name: string, extra: Record<string, unknown>) => ({
    type: 'layer', layer_id: 'ndvi-active', layer_type: 'geojson', name,
    geojson: resultLayer(name).geojson, bounds: [74.05, 31.12, 74.08, 31.15], ...extra,
  })
  await page.route('**/api/agent', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body:
        sse('layer', layerEvent('NDVI 2026-09-23 · statistics computing', { provisional: true })) +
        sse('layer', layerEvent('NDVI 2026-09-23', { provisional: false, result_id: 'r_e2e' })) +
        sse('token', { type: 'token', content: 'Done.' }) +
        sse('done', { type: 'done' }),
    }),
  )
  await page.locator('#chat-composer').fill('ndvi')
  await page.locator('#chat-composer').press('Enter')
  await page.getByRole('tab', { name: /^Layers/ }).click()
  await expect(page.getByTestId('layer-row').getByText('NDVI 2026-09-23', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/statistics computing/)).toHaveCount(0)
  await expect(page.getByTestId('layer-provisional')).toHaveCount(0)
  // (that merge-by-id leaves exactly one layer is asserted in src/lib/__tests__/layer-event.test.ts)
})
