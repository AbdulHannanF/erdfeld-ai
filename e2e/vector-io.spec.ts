import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

/**
 * Vector import/export in the real UI: drop a GeoJSON polygon on the map -> a layer appears in
 * the layer panel -> "Use as AOI" sets the AOI badge -> downloading GeoJSON yields parseable
 * content. Everything is client-side, so no network or LLM is needed.
 */

const POLYGON = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'Test plot', crop: 'rice' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[77.59, 12.97], [77.6, 12.97], [77.6, 12.98], [77.59, 12.98], [77.59, 12.97]]],
      },
    },
  ],
}

async function dropFile(page: Page, name: string, mime: string, content: string) {
  const dt = await page.evaluateHandle(
    ({ name, mime, content }) => {
      const d = new DataTransfer()
      d.items.add(new File([content], name, { type: mime }))
      return d
    },
    { name, mime, content },
  )
  const canvas = page.locator('.maplibregl-canvas')
  // The drop zone is the map panel; dispatch the full enter/over/drop sequence on it.
  const panel = canvas.locator('xpath=ancestor::div[contains(@class,"relative")][1]')
  for (const type of ['dragenter', 'dragover', 'drop']) {
    await panel.dispatchEvent(type, { dataTransfer: dt })
  }
}

test.beforeEach(async ({ page }) => {
  // the sidebar is an icon rail below 1440px; layer actions live in its expanded form
  await page.addInitScript(() => localStorage.setItem('erdfeld-sidebar', 'expanded'))
})

test('drop a GeoJSON polygon, use it as the AOI, export it back', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.maplibregl-canvas')).toBeVisible()

  await dropFile(page, 'plots.geojson', 'application/geo+json', JSON.stringify(POLYGON))

  // The layer shows up in the layer panel.
  await page.getByRole('tab', { name: /^Layers/ }).click()
  await expect(page.getByRole('button', { name: 'Remove plots' })).toBeVisible()
  await expect(page.getByText('plots', { exact: true }).first()).toBeVisible()

  // The layer's actions sit in its expandable details.
  await page.getByRole('button', { name: /Style, legend, export/ }).first().click()

  // Use as AOI -> the AOI badge appears.
  await page.getByRole('button', { name: 'Use plots as AOI' }).click()
  await expect(page.getByTestId('aoi-card')).toContainText('Polygon')

  // Download GeoJSON: the file parses and holds the polygon unchanged.
  await page.getByRole('button', { name: 'Download plots' }).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'GeoJSON', exact: true }).click(),
  ])
  expect(download.suggestedFilename()).toBe('plots.geojson')
  const path = await download.path()
  const parsed = JSON.parse(readFileSync(path!, 'utf8'))
  expect(parsed.type).toBe('FeatureCollection')
  expect(parsed.features).toHaveLength(1)
  expect(parsed.features[0].properties.crop).toBe('rice')
  expect(parsed.features[0].geometry).toEqual(POLYGON.features[0].geometry)
})

test('a CSV with lat/lon imports and exports as a zipped shapefile', async ({ page }) => {
  await page.goto('/')
  await dropFile(page, 'wells.csv', 'text/csv', 'name,lat,lon\nA,12.97,77.59\nB,12.98,77.6\n')
  await page.getByRole('tab', { name: /^Layers/ }).click()
  await expect(page.getByText('wells', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: /Style, legend, export/ }).first().click()
  await page.getByRole('button', { name: 'Download wells' }).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Shapefile (zip)' }).click(),
  ])
  expect(download.suggestedFilename()).toBe('wells.zip')
  const bytes = readFileSync((await download.path())!)
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK')
})

test('an unsupported file is refused with a reason, not added', async ({ page }) => {
  await page.goto('/')
  await dropFile(page, 'notes.docx', 'application/msword', 'hello')
  await expect(page.getByText(/not imported/)).toBeVisible()
  await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0)
})
