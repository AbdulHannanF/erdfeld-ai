import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'

/**
 * Q-13 layout check: no interactive control may be covered by another element.
 *
 * For every visible control, `document.elementFromPoint` at its centre must
 * return the control itself or one of its descendants. Run against a production
 * server; playwright.config.ts starts it and sets the base URL and browser.
 * Set LAYOUT_SHOTS=<dir> to also write a screenshot per width/state.
 */

const WIDTHS = [
  { width: 1280, height: 720 },
  { width: 1600, height: 1000 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
]

const AOI = {
  type: 'Rectangle',
  geometry: {
    type: 'Polygon',
    coordinates: [[[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]]],
  },
  center: { lng: 74.065, lat: 31.135 },
}

const CONTROLS =
  'button, input, textarea, select, a[href], [role=button], [role=tab], [role=switch], [role=checkbox]'

type Overlap = { control: string; coveredBy: string }

async function findOverlaps(page: Page): Promise<Overlap[]> {
  return page.evaluate((selector) => {
    const describe = (el: Element) => {
      const text = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '')
        .trim()
        .slice(0, 30)
      const cls = typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 3).join('.') : ''
      return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${text ? ` "${text}"` : ''}`
    }
    const out: { control: string; coveredBy: string }[] = []
    for (const el of Array.from(document.querySelectorAll(selector))) {
      // Controls inside a scrollable rail count as reachable: scroll them into view first.
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const r = el.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) continue // sr-only / hidden
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') continue
      // Invisible at rest (e.g. hover-revealed action rows): an ancestor with opacity 0.
      let hidden = false
      for (let n: Element | null = el; n; n = n.parentElement) {
        if (Number(getComputedStyle(n).opacity) === 0) hidden = true
      }
      if (hidden) continue
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
        out.push({ control: describe(el), coveredBy: 'OFF-SCREEN' })
        continue
      }
      const hit = document.elementFromPoint(x, y)
      if (!hit || el.contains(hit)) continue
      // A <label> wrapping the control also delivers the click to it.
      if (hit.closest('label')?.contains(el)) continue
      // Toasts are transient, dismissible overlays that sit on top by design (e.g. a basemap outage notice).
      if (hit.closest('[data-sonner-toaster]')) continue
      out.push({ control: describe(el), coveredBy: describe(hit) })
    }
    return out
  }, CONTROLS)
}

/** On a phone the panel is a bottom sheet that rests at its peek; open it to reach the composer. */
async function openSheet(page: Page) {
  const handle = page.getByTestId('sheet-handle')
  if (await handle.isVisible().catch(() => false)) {
    if ((await page.getByTestId('panel').getAttribute('data-snap')) === 'peek') await handle.click()
    await page.waitForTimeout(400)
  }
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

/** Add two layers through the real chat path, with the agent API mocked. `answer` is the streamed reply. */
async function loadLayers(page: Page, answer = 'Done.') {
  const ring = AOI.geometry.coordinates
  const body =
    sse('layer', {
      type: 'layer',
      layer_id: 'e2e-aoi-poly',
      layer_type: 'geojson',
      name: 'Field boundary',
      geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: ring } }] },
      bounds: [74.05, 31.12, 74.08, 31.15],
    }) +
    sse('layer', {
      type: 'layer',
      layer_id: 'e2e-heat',
      layer_type: 'geojson',
      name: 'Vegetation index',
      geojson: { type: 'FeatureCollection', features: [] },
      palette: {
        kind: 'gradient',
        label: 'NDVI',
        min: -0.2,
        max: 0.9,
        stops: [{ value: -0.2, color: '#a50026' }, { value: 0.35, color: '#ffffbf' }, { value: 0.9, color: '#006837' }],
      },
    }) +
    sse('token', { type: 'token', content: answer }) +
    sse('done', { type: 'done' })
  await page.route('**/api/agent', (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body }),
  )
  await openSheet(page)
  await page.locator('#chat-composer').fill('show layers')
  await page.locator('#chat-composer').press('Enter')
  await page.getByText('Vegetation index').first().waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {})
  await page.waitForTimeout(800)
}

for (const vp of WIDTHS) {
  test.describe(`${vp.width}px`, () => {
    test.use({ viewport: vp })

    test.beforeEach(async ({ page }) => {
      await page.addInitScript((aoi) => {
        localStorage.setItem('erdfeld-aoi', JSON.stringify(aoi))
      }, AOI)
      await page.goto('/')
      await page.waitForSelector('.maplibregl-canvas', { timeout: 30_000 })
      await page.waitForTimeout(1500)
    })

    async function check(page: Page, state: string) {
      const dir = process.env.LAYOUT_SHOTS
      if (dir) {
        fs.mkdirSync(dir, { recursive: true })
        await page.screenshot({ path: `${dir}/layout-${state}-${vp.width}.png` })
      }
      const overlaps = await findOverlaps(page)
      expect(overlaps, JSON.stringify(overlaps, null, 2)).toEqual([])
    }

    test('map with AOI loaded', async ({ page }) => {
      await check(page, 'aoi')
    })

    test('layers panel and legend open', async ({ page }) => {
      await loadLayers(page)
      await page.getByRole('button', { name: /^legend$/i }).click({ timeout: 3000 }).catch(() => {})
      await page.waitForTimeout(500)
      await check(page, 'layers')
    })

    test('chat with a long answer', async ({ page }) => {
      const answer = Array.from(
        { length: 12 },
        (_, i) => `Paragraph ${i + 1}. Water covered a large part of the floodplain on this date, with the extent given as a range across thresholds rather than one number.`,
      ).join('\n\n')
      await loadLayers(page, answer)
      await page.waitForTimeout(500)
      await check(page, 'long-answer')
    })

    test('chat view', async ({ page }) => {
      await openSheet(page)
      await check(page, 'chat')
    })
  })
}
