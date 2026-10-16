import { expect, test } from '@playwright/test'

/**
 * Q-28: upload a file of plots in "Verify a claim" -> the batch view, with the API mocked at the
 * app's own edge (the queue and the evaluator are covered by unit and database tests).
 */

const sq = (lon: number, lat: number) => ({ type: 'Polygon', coordinates: [[[lon, lat], [lon + 0.003, lat], [lon + 0.003, lat - 0.003], [lon, lat - 0.003], [lon, lat]]] })
const FILE = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'North 4', date: '2025-09-04' }, geometry: sq(74.45, 31.0) },
    { type: 'Feature', properties: { name: 'Dry 2', date: '2025-09-04' }, geometry: sq(74.52, 31.02) },
    { type: 'Feature', properties: { name: 'Far 9', date: '2025-09-04' }, geometry: sq(74.5, 31.05) },
  ],
}
const TYPES = {
  claim_types: [{ ref: 'flooded_on@1.0.0', id: 'flooded_on', title: 'Flooded on a date', description: 'd', claim: 'c', params: { date: { type: 'date', required: true, description: 'The day' }, tolerance_days: { type: 'integer', required: false, default: 7, description: '' } } }],
}
const row = (idx: number, o: Record<string, unknown>) => ({
  idx, name: FILE.features[idx].properties.name, status: 'done', attempts: 1, error: null, geometry: FILE.features[idx].geometry,
  case_id: null, verdict: null, confidence: null, kind: null, reason: null, recipe: 'flooded_on@1.0.0', run_id: null, params: { date: '2025-09-04' }, ...o,
})
const rows = (done: boolean) => [
  row(0, { verdict: 'supported', confidence: 0.84, case_id: 'case_a', run_id: 'run_a' }),
  row(1, { verdict: 'contradicted', confidence: 0.61, case_id: 'case_b', run_id: 'run_b' }),
  done ? row(2, { verdict: 'cannot_determine', kind: 'data_unavailable', case_id: 'case_c', run_id: 'run_c' }) : row(2, { status: 'running', recipe: null, params: null }),
]
const batch = (done: boolean) => ({
  id: 'batch_e2e', label: 'Flooded on a date: plots.geojson', created_at: '2026-10-13T04:00:00.000Z', claim_type: 'flooded_on@1.0.0', recipe_title: 'Flooded on a date',
  state: done ? 'finished' : 'active', progress: { total: 3, queued: 0, running: done ? 0 : 1, done: done ? 3 : 2, failed: 0 }, rows: rows(done),
})

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('erdfeld-onboarding-completed', 'true'))
})

test('upload a file of plots in Verify a claim, then follow the batch to its verdict table and exports', async ({ page }) => {
  let posted: any = null
  await page.route('**/api/cases', (r) => r.fulfill({ json: TYPES }))
  await page.addInitScript((geometry) => localStorage.setItem('erdfeld-aoi', JSON.stringify({ type: 'Rectangle', geometry, center: { lng: 74.4515, lat: 30.9985 } })), FILE.features[0].geometry)
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.route('**/api/cases/batch', (r) => {
    posted = r.request().postDataJSON()
    return r.fulfill({ status: 202, json: { id: 'batch_e2e', total: 3, recipe: 'flooded_on@1.0.0' } })
  })
  let reads = 0
  await page.route('**/api/cases/batch/batch_e2e', (r) => r.fulfill({ json: batch(++reads > 1) }))
  await page.route('**/api/jobs/batch_e2e/events*', (r) => r.fulfill({
    headers: { 'Content-Type': 'text/event-stream' },
    body: 'id: 5\nevent: job_done\ndata: {"progress":{"total":3,"queued":0,"running":0,"done":3,"failed":0}}\n\nid: 6\nevent: batch_done\ndata: {"progress":{"total":3,"queued":0,"running":0,"done":3,"failed":0}}\n\n',
  }))
  await page.route('**/api/cases/batch/batch_e2e/export?format=csv', (r) => r.fulfill({ headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="claims-batch_e2e.csv"' }, body: 'lat,lon,plot,verdict\r\n' }))

  await page.goto('/')
  await page.waitForSelector('.maplibregl-canvas', { timeout: 30_000 })
  // Verify a claim is in the toolbox; the inspector opens on Erdfeld
  await page.getByRole('tab', { name: /^Tools/ }).click()
  await page.getByTestId('verify-claim').click()
  const dialog = page.getByTestId('verify-claim-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('verify-mode-file').click()
  await expect(dialog.getByTestId('verify-batch-submit')).toBeDisabled()
  await dialog.getByTestId('batch-file').setInputFiles({ name: 'plots.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(FILE)) })
  await expect(dialog.getByTestId('batch-file-summary')).toContainText('3 plots read')
  await expect(dialog.getByTestId('batch-file-summary')).toContainText('date')
  await dialog.getByTestId('verify-batch-submit').click()

  await page.waitForURL('**/cases/batch/batch_e2e')
  expect(posted).toMatchObject({ claim_type: 'flooded_on@1.0.0', params: {} })
  expect(posted.plots).toHaveLength(3)
  expect(posted.plots[0]).toMatchObject({ name: 'North 4', params: { date: '2025-09-04' } })

  await expect(page.getByTestId('batch-title')).toHaveText('Flooded on a date: plots.geojson')
  await expect(page.getByTestId('batch-row')).toHaveCount(3)
  await expect(page.getByTestId('count-supported')).toHaveText('1')
  await expect(page.getByTestId('count-contradicted')).toHaveText('1')
  await expect(page.getByTestId('count-cannot_determine')).toHaveText('1')
  await expect(page.getByTestId('batch-progress-text')).toHaveText('3 of 3 plots')
  await expect(page.getByTestId('batch-kinds')).toContainText('No usable data')
  await expect(page.getByTestId('batch-row').nth(1)).toContainText('Contradicted')
  await expect(page.getByTestId('batch-row').nth(1).getByRole('link', { name: /Open the case for Dry 2/ })).toHaveAttribute('href', '/cases/case_b')
  await expect(page.locator('.maplibregl-canvas')).toBeVisible()

  const download = page.waitForEvent('download')
  await page.getByTestId('export-csv').click()
  expect((await download).suggestedFilename()).toBe('claims-batch_e2e.csv')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('a batch of another owner shows the 403 message', async ({ page }) => {
  await page.route('**/api/cases/batch/nobody', (r) => r.fulfill({ status: 403, json: { error: 'Forbidden' } }))
  await page.goto('/cases/batch/nobody')
  await expect(page.getByTestId('batch-error')).toHaveText('This batch belongs to another owner.')
})
