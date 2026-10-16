/**
 * The hands: Playwright driving the real app.
 *
 * There is not a single data-testid in the 42 UI components, so nothing here can
 * lean on test hooks — every selector is something a USER could see (visible
 * text, aria-label, role, placeholder). That is harder and occasionally flakier,
 * but it means a passing journey is evidence the real interface works, not
 * evidence that a hidden attribute still exists.
 */
import fs from 'fs'
import path from 'path'
import { chromium } from 'playwright'

const BASE = process.env.QA_APP_BASE || 'http://localhost:3000'
export const SHOTS = path.resolve(process.cwd(), 'qa-out', 'shots')
fs.mkdirSync(SHOTS, { recursive: true })

/** Launch a browser and wire up passive defect collection (console + network). */
export async function launch({ width = 1600, height = 1000, headless = true, theme = 'dark' } = {}) {
  const browser = await chromium.launch({
    headless,
    // The map is WebGL. On this box the hardware path emitted "GPU stall due to
    // ReadPixels" storms and took a long run down with it, so render through
    // SwiftShader: slower, but it survives multi-minute sessions and still
    // rasterises the map correctly for visual review.
    args: [
      '--disable-dev-shm-usage',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
  })
  browser.on('disconnected', () => console.error('!! browser disconnected'))
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
  })
  const page = await context.newPage()

  const defects = { console: [], pageErrors: [], failedRequests: [], httpErrors: [] }
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return
    const text = m.text().slice(0, 400)
    // React's dev-only hydration/act noise is real but drowns the signal; keep
    // it separate rather than dropping it silently.
    defects.console.push({ type: m.type(), text })
  })
  page.on('pageerror', (e) => defects.pageErrors.push(String(e?.message || e).slice(0, 400)))
  page.on('requestfailed', (r) => {
    const url = r.url()
    if (url.startsWith('data:') || url.startsWith('blob:')) return
    defects.failedRequests.push({ url: url.slice(0, 200), error: r.failure()?.errorText })
  })
  page.on('response', (r) => {
    if (r.status() >= 400) defects.httpErrors.push({ url: r.url().slice(0, 200), status: r.status() })
  })

  return { browser, context, page, defects }
}

export async function goHome(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(2500) // map style + hydration
}

/** The 6-step onboarding tour blocks everything behind a z-9999 overlay. */
export async function dismissTour(page) {
  for (let i = 0; i < 3; i++) {
    const skip = page.getByRole('button', { name: /^skip$/i }).first()
    if (await skip.isVisible().catch(() => false)) {
      await skip.click({ timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(600)
    } else break
  }
  // Some builds gate the tour on localStorage; make sure a reload stays clean.
  await page.evaluate(() => {
    try {
      for (const k of Object.keys(localStorage)) {
        if (/tour|onboard|welcome|first/i.test(k)) localStorage.setItem(k, 'true')
      }
    } catch {}
  }).catch(() => {})
  return !(await page.getByRole('button', { name: /^skip$/i }).first().isVisible().catch(() => false))
}

/** In the narrow/tabbed layout the chat panel is not mounted until its tab is active. */
export async function ensureChatVisible(page) {
  const tab = page.getByRole('tab', { name: /chat/i }).first()
  if (await tab.isVisible().catch(() => false)) {
    const selected = await tab.getAttribute('aria-selected').catch(() => null)
    if (selected !== 'true') { await tab.click().catch(() => {}); await page.waitForTimeout(800) }
  }
}

export async function ensureMapVisible(page) {
  const tab = page.getByRole('tab', { name: /^map$/i }).first()
  if (await tab.isVisible().catch(() => false)) {
    const selected = await tab.getAttribute('aria-selected').catch(() => null)
    if (selected !== 'true') { await tab.click().catch(() => {}); await page.waitForTimeout(800) }
  }
}

/** Find the chat composer wherever it lives. Returns a locator or null. */
export async function findComposer(page) {
  await ensureChatVisible(page)
  const candidates = [
    page.locator('textarea').filter({ hasNot: page.locator('[readonly]') }),
    page.getByPlaceholder(/ask|question|query|message|analy|what/i),
    page.locator('input[type="text"]').filter({ hasNotText: /search location/i }),
  ]
  for (const c of candidates) {
    const n = await c.count().catch(() => 0)
    for (let i = 0; i < n; i++) {
      const el = c.nth(i)
      if (!(await el.isVisible().catch(() => false))) continue
      const ph = (await el.getAttribute('placeholder').catch(() => '')) || ''
      if (/search location/i.test(ph)) continue
      return el
    }
  }
  return null
}

/** Geometry of the map canvas in page coordinates. */
export async function mapBox(page) {
  return page.evaluate(() => {
    const c = document.querySelector('canvas.maplibregl-canvas')
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
}

/**
 * Move the map via the app's own "Jump to coordinates" control — the map
 * instance is not exposed on window, and driving a real control means the fly-to
 * feature gets tested as a side effect. The dialog's three number inputs are
 * lng, lat, zoom in that order.
 */
export async function flyTo(page, { lng, lat, zoom = 13 }) {
  await ensureMapVisible(page)
  const btn = page.getByRole('button', { name: /jump to coordinates/i }).first()
  try { await btn.click({ timeout: 8000 }) } catch { return { flown: false, reason: 'no jump control' } }
  await page.waitForTimeout(900)

  const nums = page.locator('input[type="number"]')
  // Wait for the dialog to actually mount — under software rendering it lags,
  // and a silent miss here left the map at zoom 2, which produced a
  // 23-MILLION-km² "AOI" that the app then happily analysed.
  try { await nums.first().waitFor({ state: 'visible', timeout: 8000 }) } catch {}
  const n = await nums.count().catch(() => 0)
  if (n < 2) return { flown: false, reason: `expected lng/lat/zoom inputs, saw ${n}` }

  await nums.nth(0).fill(String(lng))
  await nums.nth(1).fill(String(lat))
  if (n > 2) await nums.nth(2).fill(String(zoom))
  await page.waitForTimeout(200)

  const go = page.getByRole('button', { name: /^(go|jump|fly|navigate)\b/i }).first()
  if (await go.count().catch(() => 0)) await go.click({ timeout: 5000 }).catch(() => {})
  else await nums.nth(n > 2 ? 2 : 1).press('Enter').catch(() => {})

  await page.waitForTimeout(4000) // fly animation + tile load
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(800)

  const readout = async () => page.evaluate(() => {
    const t = document.body.innerText || ''
    const m = t.match(/Lng[\s|]*(-?\d+\.\d+)[\s\S]{0,60}?Lat[\s|]*(-?\d+\.\d+)[\s\S]{0,60}?Z[\s|]*(\d+\.?\d*)/i)
    return m ? { lng: Number(m[1]), lat: Number(m[2]), z: Number(m[3]) } : null
  }).catch(() => null)

  const at = await readout()
  // Verify we actually arrived; the readout is the app's own statement of where
  // it is, so it is the right thing to trust.
  const arrived = at && Math.abs(at.lng - lng) < 1.5 && Math.abs(at.lat - lat) < 1.5
  return { flown: !!arrived, at, wanted: { lng, lat, zoom } }
}

/**
 * Fly to a place, then draw a rectangle AOI over the middle of the map.
 * Uses the real TerraDraw toolbar — this IS one of the features under test.
 */
export async function drawAoi(page, { center, zoom = 13 } = {}) {
  await ensureMapVisible(page)
  let fly = null
  if (center) {
    fly = await flyTo(page, { lng: center.lng, lat: center.lat, zoom })
    if (!fly.flown) {
      await page.waitForTimeout(1500)
      fly = await flyTo(page, { lng: center.lng, lat: center.lat, zoom })
    }
  }

  // TerraDraw mounts its own control group straight onto the map — the
  // "Drawing panel" toolbar button is a different feature entirely.
  //
  // NB: do NOT gate this on isVisible(). The control group expands lazily, so an
  // instantaneous visibility check reads false while click() — which waits for
  // actionability — succeeds. Gating on it silently skipped the mode switch and
  // every later click landed on a map with no draw mode armed.
  const rect = page.locator('.maplibregl-terradraw-add-rectangle-button').first()
  let usedRect = true
  try {
    await rect.click({ timeout: 8000 })
  } catch {
    usedRect = false
    // Collapsed control: open the group, then retry once.
    for (const sel of ['.maplibregl-terradraw-render-button', '.maplibregl-terradraw-add-control']) {
      const t = page.locator(sel).first()
      if (await t.count().catch(() => 0)) {
        await t.click({ timeout: 4000 }).catch(() => {})
        await page.waitForTimeout(500)
      }
    }
    usedRect = await rect.click({ timeout: 5000 }).then(() => true).catch(() => false)
  }
  await page.waitForTimeout(700)

  const box = await mapBox(page)
  if (!box) return { drawn: false, reason: 'no map canvas' }

  const x1 = box.x + box.w * 0.36, y1 = box.y + box.h * 0.36
  const x2 = box.x + box.w * 0.64, y2 = box.y + box.h * 0.64

  // TerraDraw's rectangle mode is click → move → click, NOT a drag.
  await page.mouse.move(x1, y1); await page.waitForTimeout(200)
  await page.mouse.click(x1, y1); await page.waitForTimeout(500)
  await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 10 }); await page.waitForTimeout(300)
  await page.mouse.move(x2, y2, { steps: 10 }); await page.waitForTimeout(300)
  await page.mouse.click(x2, y2)
  await page.waitForTimeout(2000)

  if (!(await aoiPresent(page))) {
    // Fall back to polygon mode: click each corner, double-click to close.
    const poly = page.locator('.maplibregl-terradraw-add-polygon-button').first()
    if (await poly.isVisible().catch(() => false)) {
      await poly.click().catch(() => {})
      await page.waitForTimeout(600)
      for (const [x, y] of [[x1, y1], [x2, y1], [x2, y2]]) {
        await page.mouse.move(x, y, { steps: 5 }); await page.waitForTimeout(200)
        await page.mouse.click(x, y); await page.waitForTimeout(400)
      }
      await page.mouse.move(x1, y2, { steps: 5 }); await page.waitForTimeout(200)
      await page.mouse.click(x1, y2); await page.waitForTimeout(400)
      await page.mouse.dblclick(x1, y2)
      await page.waitForTimeout(2000)
    }
  }

  // The area readout lands a beat after the geometry closes; poll briefly.
  let drawn = false
  for (let i = 0; i < 10 && !drawn; i++) {
    drawn = await aoiPresent(page)
    if (!drawn) await page.waitForTimeout(700)
  }

  // Report the app's own area readout so a nonsense AOI (a failed fly-to leaves
  // the map at world zoom) is visible in the record instead of silently
  // poisoning every downstream result.
  const areaKm2 = await page.evaluate(() => {
    const m = (document.body.innerText || '').match(/([\d,]+(?:\.\d+)?)\s*km²/i)
    return m ? Number(m[1].replace(/,/g, '')) : null
  }).catch(() => null)

  return { drawn, box, usedRect, fly, areaKm2, areaSane: areaKm2 !== null && areaKm2 < 5000 }
}

/**
 * Did an AOI actually register? Two independent signals, because either alone
 * has been unreliable: the app prints an area readout, and the composer
 * placeholder stops saying "draw an area first" once one exists.
 */
export async function aoiPresent(page) {
  return page.evaluate(() => {
    const t = document.body.innerText || ''
    const hasArea = /\b\d[\d,.]*\s*(km²|km2|sq km|hectare|ha)\b/i.test(t)
    const composers = [...document.querySelectorAll('textarea,input[type="text"]')]
    const stillPrompting = composers.some((c) => /draw an area/i.test(c.placeholder || ''))
    const composerReady = composers.some(
      (c) => (c.placeholder || '') && !/draw an area|search location/i.test(c.placeholder),
    )
    return hasArea || (composerReady && !stillPrompting)
  }).catch(() => false)
}

/**
 * Type a question and submit it — then PROVE it was submitted.
 *
 * Uses fill(), not type(): character-by-character typing hangs for 30 s on this
 * composer because React re-renders and detaches the element mid-type, and the
 * fallback path that produced left the previous text in place, so a run could
 * silently measure a question nobody asked.
 */
export async function askQuestion(page, text) {
  const composer = await findComposer(page)
  if (!composer) return { asked: false, reason: 'no composer found' }
  await composer.click({ timeout: 10_000 }).catch(() => {})
  await composer.fill('').catch(() => {})
  await page.waitForTimeout(200)
  await composer.fill(text).catch(() => {})
  await page.waitForTimeout(500)

  const typed = await composer.inputValue().catch(() => '')
  if (typed.trim() !== text.trim()) {
    return { asked: false, reason: `composer holds ${JSON.stringify(typed.slice(0, 60))}, expected the question` }
  }

  // Submit with Enter — the app's own hint says "Press Enter to send".
  //
  // Do NOT hunt for a button matching /analyz/: the start screen carries
  // suggested-prompt chips like "Analyze vegetation", and matching one of those
  // submitted the SUGGESTION instead of the typed question, so the run measured
  // a query nobody asked for. Only an exact Send control is acceptable here.
  await composer.press('Enter').catch(() => {})
  await page.waitForTimeout(1500)

  let cleared = (await composer.inputValue().catch(() => '')) === ''
  if (!cleared) {
    const send = page.getByRole('button', { name: /^(send|submit)$/i }).first()
    if (await send.count().catch(() => 0)) {
      await send.click({ timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(1200)
      cleared = (await composer.inputValue().catch(() => '')) === ''
    }
  }

  // The chat must now contain OUR question, not a suggestion chip's.
  const echoed = await page.evaluate((q) => (document.body.innerText || '').includes(q.slice(0, 40)), text).catch(() => false)
  return { asked: cleared || echoed, submittedText: text, composerCleared: cleared, echoedInChat: echoed }
}

/**
 * Wait for the agent to finish. There is no "done" signal in the DOM, so this
 * watches the answer text stabilise and the busy affordances disappear.
 */
export async function waitForAnswer(page, { timeoutMs = 420_000, quietMs = 9000 } = {}) {
  const t0 = Date.now()
  let lastLen = -1
  let lastChange = Date.now()
  let sawGrowth = false

  while (Date.now() - t0 < timeoutMs) {
    await page.waitForTimeout(2000)
    const state = await page.evaluate(() => {
      const text = document.body.innerText || ''
      const busy = !!document.querySelector('[aria-busy="true"], .animate-spin, [class*="typing"], [class*="streaming"]')
      const stop = [...document.querySelectorAll('button')].some((b) => /stop|cancel|abort/i.test(b.innerText || ''))
      return { len: text.length, busy, stop }
    }).catch(() => ({ len: lastLen, busy: false, stop: false }))

    if (state.len !== lastLen) {
      if (state.len > lastLen) sawGrowth = true
      lastLen = state.len
      lastChange = Date.now()
    }
    const quiet = Date.now() - lastChange > quietMs
    if (quiet && !state.busy && !state.stop && sawGrowth) {
      return { finished: true, ms: Date.now() - t0 }
    }
  }
  return { finished: false, ms: Date.now() - t0, reason: 'timeout waiting for answer' }
}

/** Screenshot to qa-out/shots/<name>.png; returns the path. */
export async function shot(page, name, { fullPage = false } = {}) {
  const p = path.join(SHOTS, `${name}.png`)
  await page.screenshot({ path: p, fullPage }).catch(() => {})
  return p
}

/**
 * Set-of-marks: outline every visible interactive element and stamp it with a
 * number, so a vision model can say "click 7" and be understood exactly. Returns
 * the element list; call clearMarks() before the next real interaction.
 */
export async function markElements(page) {
  return page.evaluate(() => {
    document.querySelectorAll('.qa-mark-overlay').forEach((n) => n.remove())
    const SEL = 'button,a[href],input,textarea,select,[role="button"],[role="tab"],[role="switch"],[role="checkbox"],[role="menuitem"],[role="slider"]'
    const out = []
    const overlay = document.createElement('div')
    overlay.className = 'qa-mark-overlay'
    overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'

    let i = 0
    for (const el of document.querySelectorAll(SEL)) {
      const r = el.getBoundingClientRect()
      if (r.width < 6 || r.height < 6) continue
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue
      const st = getComputedStyle(el)
      if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.05) continue

      i++
      const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 80)

      const box = document.createElement('div')
      box.style.cssText = `position:absolute;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;border:2px solid #ff2d95;box-sizing:border-box`
      const tag = document.createElement('div')
      tag.textContent = String(i)
      tag.style.cssText = `position:absolute;left:${Math.max(0, r.x - 1)}px;top:${Math.max(0, r.y - 15)}px;background:#ff2d95;color:#fff;font:bold 12px/1.1 monospace;padding:1px 4px;border-radius:2px`
      overlay.appendChild(box); overlay.appendChild(tag)

      el.setAttribute('data-qa-mark', String(i))
      out.push({
        index: i,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || undefined,
        label,
        box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      })
    }
    document.body.appendChild(overlay)
    return out
  }).catch(() => [])
}

export async function clearMarks(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.qa-mark-overlay').forEach((n) => n.remove())
  }).catch(() => {})
}

/** Act on a marked element by its number. */
export async function actOnMark(page, index, action, text) {
  const el = page.locator(`[data-qa-mark="${index}"]`).first()
  if (!(await el.count().catch(() => 0))) return { ok: false, reason: `no element ${index}` }
  try {
    if (action === 'type') {
      await el.click({ timeout: 8000 })
      await el.fill(text ?? '')
    } else {
      await el.click({ timeout: 8000 })
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: String(err?.message || err).slice(0, 200) }
  }
}
