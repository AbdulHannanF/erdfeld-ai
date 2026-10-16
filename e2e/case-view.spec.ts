import { expect, test } from '@playwright/test'

/**
 * Q-27: the case view and the "Verify a claim" entry point, with the API mocked at the app's own
 * edge (the verdict itself is computed server-side and covered by unit tests).
 */

const RING = [[74.5, 31.0], [74.503, 31.0], [74.503, 30.997], [74.5, 30.997], [74.5, 31.0]]
const GEOMETRY = { type: 'Polygon', coordinates: [RING] }

const CASE = {
  id: 'case_e2e', claim_type: 'flooded_on', claim: 'This plot was flooded on 2025-09-04 (within 7 days).',
  recipe: 'flooded_on@1.0.0', verdict: 'supported', confidence: 0.84,
  decision: { rule: 'flooded', reason: '81.2% of the plot was newly under water on a pass 1 days from 2025-09-04 (the claim needs 30%).', inputs: { flood_pct: 81.2 } },
  params: { date: '2025-09-04', tolerance_days: 7 }, geometry: GEOMETRY, run_id: 'run_e2e', created_at: '2026-10-13T04:00:00.000Z',
  timeline: [{
    step: 0, op: 'map_flood', version: '1.0.0', status: 'ok', date: '2025-09-03', result_id: 'r_e2eflood0001',
    stats: { flood_pct_of_observed: 81.2, valid_pixel_pct: 99.1, after_date: '2025-09-03', before_date: '2025-08-05', orbit_match: 'orbit' }, summary: null,
  }],
  explain: [
    { text: 'Claim: This plot was flooded on 2025-09-04 (within 7 days). Checked with recipe flooded_on@1.0.0. Verdict: Supported (confidence 84%, a heuristic score, not a probability).', cites: [] },
    { text: 'Step 0 (map_flood@1.0.0): The Sentinel-1 pass used was 2025-09-03; 81.2% of the plot was newly under water.', cites: ['r_e2eflood0001'] },
    { text: 'Limit: Radar sees open, smooth water.', cites: [] },
  ],
  bundle_url: '/api/ledger/run_e2e/bundle',
}
const RESULT = {
  result: {
    schema: 'geo-result/1', result_id: 'r_e2eflood0001', op: { name: 'map_flood', version: '1.0.0' }, status: 'ok', summary: 's',
    layers: [{ id: 'flood-polygons', name: 'Flood extent: 0.07 km2 new', type: 'geojson', geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { color: '#1d4ed8' }, geometry: GEOMETRY }] }, bounds: [74.5, 30.997, 74.503, 31.0] }],
    provenance: { sources: [], items: [], method: 'm', inputs_hash: 'h' }, validation: [],
  },
  computed_at: '2026-10-13T04:00:00.000Z',
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('erdfeld-onboarding-completed', 'true'))
})

for (const [name, size] of [['desktop', { width: 1600, height: 1000 }], ['phone', { width: 390, height: 844 }]] as const) {
  test(`case view shows claim, verdict, timeline, narration and the bundle download on a ${name}`, async ({ page }) => {
    await page.setViewportSize(size)
    await page.route('**/api/cases/case_e2e', (r) => r.fulfill({ json: CASE }))
    await page.route('**/api/results/r_e2eflood0001', (r) => r.fulfill({ json: RESULT }))
    let bundleOwner = ''
    await page.route('**/api/ledger/run_e2e/bundle', (r) => {
      bundleOwner = r.request().headers()['x-owner-token'] ?? ''
      return r.fulfill({ json: { schema: 'geoagent.evidence-bundle', body: { claim: { recipe: 'flooded_on@1.0.0', verdict: 'supported' } } } })
    })
    await page.goto('/cases/case_e2e')

    await expect(page.getByRole('heading', { name: CASE.claim })).toBeVisible()
    await expect(page.getByTestId('verdict-badge')).toHaveText('Supported')
    await expect(page.getByTestId('confidence')).toContainText('84%')
    await expect(page.getByTestId('timeline-node')).toHaveCount(1)
    await expect(page.getByTestId('timeline-node')).toContainText('map_flood')
    await expect(page.getByTestId('timeline-node')).toContainText('r_e2eflood0001')
    await expect(page.getByTestId('explain')).toContainText('2025-09-03')
    await expect(page.getByTestId('explain').getByText('r_e2eflood0001')).toBeVisible()
    await expect(page.locator('.maplibregl-canvas')).toBeVisible()
    await expect(page.getByLabel('Flood extent: 0.07 km2 new')).toBeAttached()

    const download = page.waitForEvent('download')
    await page.getByTestId('download-bundle').click()
    expect((await download).suggestedFilename()).toBe('erdfeld-evidence-run_e2e.json')
    expect(bundleOwner).not.toBe('')

    // no horizontal page scroll
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}

test('Cannot determine is a first-class verdict with its reason, and no confidence', async ({ page }) => {
  await page.route('**/api/cases/case_cd', (r) => r.fulfill({
    json: { ...CASE, id: 'case_cd', verdict: 'cannot_determine', confidence: null, timeline: [], run_id: null, bundle_url: null,
      decision: { rule: 'pass_outside_tolerance', kind: 'data_unavailable', reason: 'The nearest Sentinel-1 pass was 11 days from 2025-09-04; the tolerance is 7 days.', inputs: {} } },
  }))
  await page.goto('/cases/case_cd')
  await expect(page.getByTestId('verdict-badge')).toHaveText('Cannot determine')
  await expect(page.getByTestId('confidence')).toHaveCount(0)
  await expect(page.getByText('No usable data for this plot and date')).toBeVisible()
  await expect(page.getByTestId('download-bundle')).toHaveCount(0)
})

test('a case of another owner is reported, not shown', async ({ page }) => {
  await page.route('**/api/cases/case_x', (r) => r.fulfill({ status: 403, json: { error: 'Forbidden' } }))
  await page.goto('/cases/case_x')
  await expect(page.getByTestId('case-error')).toContainText('another owner')
})

test('Verify a claim posts the claim type, its parameters and the drawn plot, then opens the case', async ({ page }) => {
  await page.addInitScript((geometry) => localStorage.setItem('erdfeld-aoi', JSON.stringify({ type: 'Rectangle', geometry, center: { lng: 74.5015, lat: 30.9985 } })), GEOMETRY)
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.route('**/api/cases', (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({ json: { claim_types: [
        { ref: 'flooded_on@1.0.0', id: 'flooded_on', version: '1.0.0', title: 'Flooded on a date', description: 'Sentinel-1 flood check.', claim: 'x', params: { date: { type: 'date', required: true, description: 'The day.' }, tolerance_days: { type: 'integer', required: false, default: 7, description: '' } } },
      ] } })
    }
    return r.fulfill({ status: 201, json: CASE })
  })
  await page.route('**/api/cases/case_e2e', (r) => r.fulfill({ json: CASE }))
  await page.route('**/api/results/*', (r) => r.fulfill({ json: RESULT }))
  await page.goto('/')
  await page.waitForSelector('.maplibregl-canvas', { timeout: 30_000 })

  // Verify a claim is in the toolbox; the inspector opens on Erdfeld
  await page.getByRole('tab', { name: /^Tools/ }).click()
  await page.getByTestId('verify-claim').click()
  await expect(page.getByTestId('verify-claim-dialog')).toBeVisible()
  await page.getByTestId('verify-claim-dialog').getByLabel(/date/i).first().fill('2025-09-04')
  const posted = page.waitForRequest((q) => q.method() === 'POST' && q.url().endsWith('/api/cases'))
  await page.getByTestId('verify-claim-submit').click()
  const body = (await posted).postDataJSON()
  expect(body).toEqual({ claim_type: 'flooded_on@1.0.0', params: { date: '2025-09-04' }, geometry: GEOMETRY })
  await expect(page).toHaveURL(/\/cases\/case_e2e$/)
  await expect(page.getByTestId('verdict-badge')).toHaveText('Supported')
})
