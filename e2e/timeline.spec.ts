import { expect, test, type Page } from '@playwright/test'

/**
 * The imagery archive on the map: pick a sensor, read the scene list, scrub and play oldest to newest,
 * choose scenes, analyse them on the job queue, compare two in the swipe view, plot the archive and jump
 * from a chart point to its scene. The catalogue, the job queue and the tiles are answered at the network
 * edge (a fixed archive of six Sentinel-2 days), so this checks the real client and map, not the weather.
 */

const AOI = {
  type: 'Rectangle',
  geometry: { type: 'Polygon', coordinates: [[[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]]] },
  center: { lng: 74.065, lat: 31.135 },
}
const DATES = ['2017-03-02', '2018-06-10', '2020-01-15', '2022-09-09', '2024-02-20', '2026-10-05']
const scene = (date: string, i: number) => ({
  id: `S2A_43RDQ_${date.replaceAll('-', '')}_0_L2A`,
  datetime: `${date}T05:40:00Z`,
  date,
  sensor: 'sentinel-2',
  platform: 'sentinel-2a',
  collection: 'sentinel-2-l2a',
  cloudPct: i * 8,
  cloudBasis: 'scene',
  coveragePct: 100,
  thumbnail: null,
  tileUrl: `https://tiles.test/${date}/{z}/{x}/{y}.png`,
  itemIds: [`S2A_43RDQ_${date.replaceAll('-', '')}_0_L2A`],
})
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

async function setup(page: Page) {
  const jobs: { op: string; args: Record<string, unknown>; label: string }[] = []
  await page.addInitScript((aoi) => {
    localStorage.setItem('erdfeld-onboarding-completed', 'true')
    localStorage.setItem('erdfeld-sidebar', 'expanded')
    localStorage.setItem('erdfeld-aoi', JSON.stringify(aoi))
  }, AOI)
  await page.route('https://tiles.test/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await page.route('**/api/scenes**', (r) => {
    const u = new URL(r.request().url())
    const render = u.searchParams.get('render') ?? 'true_colour'
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sensor: u.searchParams.get('sensor'), label: 'Sentinel-2 L2A', provider: 'AWS Element84 Earth Search',
        render: { mode: render, label: render === 'ndvi' ? 'NDVI (fixed range)' : 'True colour', units: 'x', rescale: render === 'ndvi' ? [-0.1, 0.9] : null, colormap: null },
        window: { from: '2015-06-23', to: '2026-10-16' }, total: DATES.length, first: DATES[0], last: DATES[DATES.length - 1], truncated: false, itemsRead: DATES.length,
        scenes: DATES.map(scene), next: null,
      }),
    })
  })
  await page.route('**/api/jobs', async (r) => {
    if (r.request().method() !== 'POST') return r.continue()
    const body = r.request().postDataJSON()
    for (const j of body.jobs) jobs.push({ op: j.op, args: j.args, label: body.label })
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: `batch-${jobs.length}` }) })
  })
  await page.route('**/api/jobs/batch-**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'finished', progress: { total: 1, queued: 0, running: 0, done: 1, failed: 0 }, jobs: [{ idx: 0, op: 'scene_series', status: 'done', resultId: 'r_series', resultStatus: 'ok', error: null }] }) }))
  await page.route('**/api/results/r_series', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        result: {
          summary: 'NDVI per Sentinel-2 acquisition', status: 'ok',
          charts: [{ id: 'c1', title: 'NDVI per Sentinel-2 acquisition', spec: {
            $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
            data: { values: DATES.map((d, i) => ({ date: d, value: 0.2 + i * 0.05, clear_pct: 90, scene_id: scene(d, i).id, sensor: 'Sentinel-2' })) },
            mark: { type: 'point', filled: true, size: 400 },
            encoding: { x: { field: 'date', type: 'temporal' }, y: { field: 'value', type: 'quantitative' } },
          } }],
        },
      }),
    }))
  return jobs
}

async function openArchive(page: Page) {
  await page.goto('/?lat=31.135&lng=74.065&zoom=13')
  await expect(page.locator('.maplibregl-canvas')).toBeVisible()
  await page.getByTestId('open-archive').click()
  await expect(page.getByTestId('archive-status')).toContainText('6 scenes')
}

test.describe('imagery archive timeline', () => {
  test('lists the archive oldest first and shows the scene on the map with its date and sensor', async ({ page }) => {
    await setup(page)
    await openArchive(page)
    await expect(page.getByTestId('scene-row')).toHaveCount(6)
    await expect(page.getByTestId('scene-row').first()).toContainText('2 Mar 2017')
    await expect(page.getByTestId('scene-row').last()).toContainText('5 Oct 2026')
    await expect(page.getByTestId('scene-badge')).toContainText('2 Mar 2017')
    await expect(page.getByTestId('scene-badge')).toContainText('Sentinel-2')
    await expect(page.getByTestId('scene-position')).toHaveText('1/6')
    // the scene is a raster layer on the map
    await expect(page.getByTestId('scene-caption')).toContainText('scene cloud')
  })

  test('arrow keys step and Space plays from the oldest scene to the newest, then stops', async ({ page }) => {
    await setup(page)
    await openArchive(page)
    const bar = page.getByRole('group', { name: 'Time navigation' })
    await bar.focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('scene-position')).toHaveText('2/6')
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('scene-position')).toHaveText('1/6')
    await page.keyboard.press('End')
    await expect(page.getByTestId('scene-position')).toHaveText('6/6')
    await expect(page.getByTestId('scene-badge')).toContainText('5 Oct 2026')
    await page.keyboard.press('Space') // at the end: restarts from the oldest
    await expect(page.getByTestId('scene-play')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('scene-position')).toHaveText('6/6', { timeout: 20_000 }) // played through
    await expect(page.getByTestId('scene-play')).toHaveAttribute('aria-pressed', 'false')
  })

  test('chosen scenes are analysed on the job queue pinned to their exact id and date', async ({ page }) => {
    const jobs = await setup(page)
    await openArchive(page)
    const rows = page.getByTestId('scene-row')
    await rows.nth(0).getByRole('checkbox').check()
    await rows.nth(4).getByRole('checkbox').check()
    await expect(page.getByTestId('scene-selected')).toHaveText('2 chosen')
    await page.getByTestId('scene-analyse').click()
    await page.getByTestId('analyse-ndvi').click()
    await expect.poll(() => jobs.length).toBe(2)
    expect(jobs.map((j) => j.op)).toEqual(['fetch_ndvi', 'fetch_ndvi'])
    expect(jobs[0].args).toEqual({ scene_id: 'S2A_43RDQ_20170302_0_L2A', date: '2017-03-02' })
    expect(jobs[1].args).toEqual({ scene_id: 'S2A_43RDQ_20240220_0_L2A', date: '2024-02-20' })
  })

  test('any dated operation opens the tool dialog pinned to the chosen scenes', async ({ page }) => {
    const jobs = await setup(page)
    await openArchive(page)
    await page.getByTestId('scene-row').nth(1).getByRole('checkbox').check()
    await page.getByTestId('scene-analyse').click()
    await page.getByTestId('analyse-compute_spectral_index').click()
    await expect(page.getByTestId('tool-pinned')).toContainText('Pinned to 1 scene')
    await expect(page.getByTestId('tool-pinned')).toContainText('2018-06-10')
    await page.locator('#tool-f-index').selectOption('NDWI')
    await page.getByTestId('tool-run').click()
    await expect.poll(() => jobs.length).toBe(1)
    expect(jobs[0].op).toBe('compute_spectral_index')
    expect(jobs[0].args).toEqual({ index: 'NDWI', scene_id: 'S2A_43RDQ_20180610_0_L2A', date: '2018-06-10' })
  })

  test('two scenes are compared in the swipe view, each half labelled with its date', async ({ page }) => {
    await setup(page)
    await openArchive(page)
    const rows = page.getByTestId('scene-row')
    await rows.nth(5).getByRole('checkbox').check()
    await expect(page.getByTestId('scene-compare')).toBeDisabled()
    await rows.nth(2).getByRole('checkbox').check()
    await page.getByTestId('scene-compare').click()
    await expect(page.getByText('15 Jan 2020 · Sentinel-2')).toBeVisible()
    await expect(page.getByText('5 Oct 2026 · Sentinel-2')).toBeVisible()
  })

  test('the archive chart is a job; clicking a point opens that scene on the timeline', async ({ page }) => {
    await setup(page)
    await openArchive(page)
    await page.getByTestId('scene-series-run').click()
    const chart = page.getByTestId('scene-series').locator('svg').first()
    await expect(chart).toBeVisible({ timeout: 20_000 })
    // the fourth point (2022-09-09)
    const points = page.getByTestId('scene-series').locator('svg path[role="graphics-symbol"]')
    await expect(points).toHaveCount(6)
    await points.nth(3).click({ force: true })
    await expect(page.getByTestId('scene-position')).toHaveText('4/6')
    await expect(page.getByTestId('scene-badge')).toContainText('9 Sep 2022')
  })
})

test.describe('imagery archive layout', () => {
  for (const size of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 2560, height: 1440 }]) {
    test(`the panel and the bar are fully reachable at ${size.width}x${size.height}`, async ({ page }) => {
      await page.setViewportSize(size)
      await setup(page)
      await openArchive(page)
      const bad = await page.evaluate(() => {
        const out: string[] = []
        const dock = document.querySelector('[data-testid="data-dock"]')!.getBoundingClientRect()
        for (const root of ['archive-panel', 'time-nav']) {
          const host = document.querySelector(`[data-testid="${root}"]`)!
          const hr = host.getBoundingClientRect()
          if (hr.bottom > dock.top + 1) out.push(`${root} runs into the dock`)
          if (hr.right > innerWidth || hr.left < 0) out.push(`${root} is off screen`)
          for (const el of Array.from(host.querySelectorAll('button, input, select, [role=slider]'))) {
            el.scrollIntoView({ block: 'nearest' })
            const r = el.getBoundingClientRect()
            if (r.width < 4 || r.height < 4) continue
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
            if (top && top !== el && !el.contains(top) && !top.contains(el)) out.push(`${root}: ${(el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 30)} is covered by ${top.tagName.toLowerCase()}`)
          }
        }
        return out
      })
      expect(bad).toEqual([])
    })
  }
})
