/**
 * PHASE D1/D4 — the critical path a first-time user walks, plus the
 * responsive/theme matrix. Every step ends in a screenshot; the screenshots are
 * judged later by qwen's vision pass (judge-pass.mjs), so this file stays
 * mechanical and fast.
 */
import fs from 'fs'
import path from 'path'
import {
  launch, goHome, dismissTour, drawAoi, aoiPresent, askQuestion, waitForAnswer,
  shot, findComposer, ensureChatVisible, flyTo,
} from './browser.mjs'
 
import { AOIS } from './probes.mjs'

const OUT = path.resolve(process.cwd(), 'qa-out')
fs.mkdirSync(OUT, { recursive: true })

const centerOf = (key) => {
  const c = AOIS[key].geom.coordinates[0]
  const xs = c.map((p) => p[0]), ys = c.map((p) => p[1])
  return { lng: (Math.min(...xs) + Math.max(...xs)) / 2, lat: (Math.min(...ys) + Math.max(...ys)) / 2 }
}

const STEPS_JSONL = path.join(OUT, 'ui-journey-steps.jsonl')
fs.writeFileSync(STEPS_JSONL, '')

const steps = []
/**
 * Persist each step as it happens. An earlier run died mid-journey and took the
 * whole record with it because results were only written at the end — a long
 * unattended sweep must never be able to lose completed work that way.
 */
const record = (id, intent, shotPath, extra = {}) => {
  const step = { id, intent, shot: shotPath, ...extra }
  steps.push(step)
  fs.appendFileSync(STEPS_JSONL, JSON.stringify(step) + '\n')
  console.log(`  · ${id}${extra.note ? ` — ${extra.note}` : ''}`)
}

// A crashed browser surfaces as an unhandled rejection, which in Node 24 kills
// the process WITHOUT running finally{} — hence the lost run. Trap it.
const fatal = (kind) => (err) => {
  try {
    fs.appendFileSync(STEPS_JSONL, JSON.stringify({ id: `fatal-${kind}`, error: String(err?.message || err).slice(0, 500) }) + '\n')
  } catch {}
  console.error(`FATAL(${kind}):`, err?.message || err)
  process.exit(1)
}
process.on('unhandledRejection', fatal('rejection'))
process.on('uncaughtException', fatal('exception'))

const { browser, context, page, defects } = await launch({ headless: true, width: 1600, height: 1000 })
const t0 = Date.now()

try {
  // ---- 1. first load, tour visible -------------------------------------
  await goHome(page)
  record('ui-tour-visible', 'The first-run onboarding tour as a brand-new user sees it: readable, not clipped, with working navigation.', await shot(page, 'ui-01-tour'))

  const tourGone = await dismissTour(page)
  record('ui-initial-load', 'App shell after dismissing the tour: map, chat panel, toolbars. No error state, nothing stuck loading, no clipped or overlapping text.', await shot(page, 'ui-02-shell'), { tourDismissed: tourGone })

  // ---- 2. asking with NO AOI (error path) -------------------------------
  await ensureChatVisible(page)
  const composer = await findComposer(page)
  const placeholderNoAoi = composer ? await composer.getAttribute('placeholder').catch(() => null) : null
  if (composer) {
    await composer.click().catch(() => {})
    await composer.type('What is the NDVI here?', { delay: 6 }).catch(() => {})
    await page.waitForTimeout(400)
    await composer.press('Enter').catch(() => {})
    await page.waitForTimeout(3500)
  }
  record('ui-no-aoi-error', 'Submitting a question with no area drawn. The app must clearly tell the user to draw an area — not hang, not fail silently, not send the query anyway.', await shot(page, 'ui-03-no-aoi'), { placeholderNoAoi })
  if (composer) await composer.fill('').catch(() => {})

  // ---- 3. draw an AOI ----------------------------------------------------
  const draw = await drawAoi(page, { center: centerOf('farmland'), zoom: 13 })
  const areaText = await page.evaluate(() => {
    const m = (document.body.innerText || '').match(/[^\n|]*\b(km²|km2)\b[^\n|]*/i)
    return m ? m[0].trim().slice(0, 80) : null
  })
  record('ui-aoi-drawn', 'After drawing a rectangle AOI over farmland: the polygon is visible on the map and the app acknowledges it with an area readout and an enabled question box.', await shot(page, 'ui-04-aoi'), { drawn: draw.drawn, areaText })

  // ---- 4. ask a real question, capture mid-stream and final --------------
  const asked = await askQuestion(page, 'What is the average NDVI here and how healthy is the vegetation?')
  await page.waitForTimeout(12_000)
  record('ui-query-streaming', 'Mid-answer: the app should visibly show it is working — streaming text, tool-call chips, a plan, or a progress indicator. A frozen-looking screen here is a defect.', await shot(page, 'ui-05-streaming'), { asked: asked.asked })

  const answered = await waitForAnswer(page, { timeoutMs: 420_000 })
  record('ui-answer-complete', 'The finished answer: readable text, citations rendered as pills rather than raw [[id#key]] markup, tool calls resolved, no error banner, no stuck spinner.', await shot(page, 'ui-06-answer'), { finished: answered.finished, ms: answered.ms })

  const answerText = await page.evaluate(() => {
    const main = document.querySelector('[class*="chat"], main') || document.body
    return (main.innerText || '').slice(-2500)
  })
  const rawCitations = /\[\[[^\]]+\]\]/.test(answerText)

  // Full-page capture of the conversation so long answers are judged whole.
  record('ui-answer-fullpage', 'The whole conversation column: the complete answer end to end, checking nothing is truncated, overlapping, or unreadable further down.', await shot(page, 'ui-07-answer-full', { fullPage: true }), { rawCitationsLeaked: rawCitations })

  // ---- 5. layers produced ------------------------------------------------
  for (const name of [/layers?$/i, /^layers/i]) {
    const b = page.getByRole('button', { name }).first()
    if (await b.count().catch(() => 0)) { await b.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(1200); break }
  }
  record('ui-layer-panel', 'The layer panel listing the layers this analysis produced: names, visibility toggles, opacity controls — legible and not overflowing.', await shot(page, 'ui-08-layers'))

  const layerInfo = await page.evaluate(() => {
    const t = document.body.innerText || ''
    const m = t.match(/(\d+)\s*\n?\s*Layers/i)
    return { layersCounter: m ? Number(m[1]) : null }
  })
  record('ui-map-layer', 'The map itself with the analysis layer drawn over the AOI: the layer must actually be visible and positioned over the drawn area, with a legend if the layer has one.', await shot(page, 'ui-09-map-layer'), layerInfo)

  // ---- 6. theme ----------------------------------------------------------
  const themeBtn = page.getByRole('button', { name: /theme|dark|light|appearance/i }).first()
  let themeToggled = false
  if (await themeBtn.count().catch(() => 0)) {
    await themeBtn.click({ timeout: 4000 }).catch(() => {})
    await page.waitForTimeout(1500)
    themeToggled = true
  } else {
    await page.emulateMedia({ colorScheme: 'light' }).catch(() => {})
    await page.evaluate(() => document.documentElement.classList.add('light')).catch(() => {})
    await page.waitForTimeout(1200)
  }
  record('ui-light-theme', 'Light theme: every piece of text must stay legible against light backgrounds — no white-on-white, no invisible icons, no dark-theme remnants bleeding through.', await shot(page, 'ui-10-light'), { themeToggledViaButton: themeToggled })

  await page.evaluate(() => document.documentElement.classList.remove('light')).catch(() => {})
  await page.emulateMedia({ colorScheme: 'dark' }).catch(() => {})
  await page.waitForTimeout(1000)

  // ---- 7. responsive -----------------------------------------------------
  for (const [id, w, h, intent] of [
    ['ui-tablet', 768, 1024, 'Tablet width 768: the layout must adapt without horizontal overflow, clipped panels, or controls stacked on top of each other.'],
    ['ui-mobile', 375, 812, 'Mobile width 375: the app must remain usable — no content cut off, no overlapping panels, the map and chat both reachable.'],
  ]) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForTimeout(2500)
    record(id, intent, await shot(page, `ui-11-${id}`))
  }
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.waitForTimeout(1500)

  // ---- 8. a second AOI + follow-up (layer memory) -----------------------
  await flyTo(page, { ...centerOf('lahore'), zoom: 13 })
  await page.waitForTimeout(1500)
  record('ui-second-aoi', 'After navigating to a different city with layers already on the map: previous layers and the new view must coexist without the map looking corrupted.', await shot(page, 'ui-12-second-view'))
} catch (err) {
  console.error('journey aborted:', err?.message || err)
  steps.push({ id: 'journey-error', error: String(err?.message || err).slice(0, 400) })
} finally {
  const out = {
    kind: 'ui-journey',
    ms: Date.now() - t0,
    steps,
    defects: {
      pageErrors: defects.pageErrors,
      consoleErrors: defects.console.filter((c) => c.type === 'error'),
      consoleWarnings: defects.console.filter((c) => c.type === 'warning').slice(0, 20),
      failedRequests: defects.failedRequests,
      httpErrors: defects.httpErrors.filter((h) => !/favicon/.test(h.url)),
    },
  }
  fs.writeFileSync(path.join(OUT, 'ui-journey.json'), JSON.stringify(out, null, 2))
  console.log(`journey: ${steps.length} steps in ${((Date.now() - t0) / 60000).toFixed(1)} min`)
  console.log(`  pageErrors=${out.defects.pageErrors.length} consoleErrors=${out.defects.consoleErrors.length} httpErrors=${out.defects.httpErrors.length}`)
  await browser.close()
}
