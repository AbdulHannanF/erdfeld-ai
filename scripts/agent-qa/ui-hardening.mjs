/**
 * PHASE D5 — the checks that are not about the happy path.
 *
 * Accessibility, keyboard reachability, state persistence across a reload,
 * cancelling a running analysis, and — the one that matters most for a product
 * whose central claim is honesty — what the interface tells the user when the
 * backend fails. An app that invents a reassuring empty state when its API is
 * down is lying in exactly the way this project says it never does.
 *
 * Deterministic: no model is consulted here, though the screenshots it captures
 * are handed to the vision judge afterwards.
 */
import fs from 'fs'
import path from 'path'
import { launch, goHome, dismissTour, drawAoi, askQuestion, waitForAnswer, shot, findComposer } from './browser.mjs'
 
import { AOIS } from './probes.mjs'

const OUT = path.resolve(process.cwd(), 'qa-out')
const JSONL = path.join(OUT, 'ui-hardening.jsonl')
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(JSONL, '')

const rec = (r) => { fs.appendFileSync(JSONL, JSON.stringify(r) + '\n'); console.log(`  · ${r.check}: ${r.headline}`) }
const centerOf = (key) => {
  const c = AOIS[key].geom.coordinates[0]
  const xs = c.map((p) => p[0]), ys = c.map((p) => p[1])
  return { lng: (Math.min(...xs) + Math.max(...xs)) / 2, lat: (Math.min(...ys) + Math.max(...ys)) / 2 }
}
const fatal = (k) => (e) => { console.error(`FATAL(${k})`, e?.message || e); process.exit(1) }
process.on('unhandledRejection', fatal('rejection'))
process.on('uncaughtException', fatal('exception'))

// ===========================================================================
// 1. Accessibility audit (hand-rolled: the project has no axe dependency and
//    adding one to test it would change what is under test).
// ===========================================================================
{
  const { browser, page } = await launch({ headless: true })
  await goHome(page); await dismissTour(page)
  await page.waitForTimeout(1500)

  const a11y = await page.evaluate(() => {
    const visible = (e) => {
      const r = e.getBoundingClientRect(); const s = getComputedStyle(e)
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
    }
    const name = (e) => (
      e.getAttribute('aria-label') || e.getAttribute('title') || (e.innerText || '').trim()
      || (e.getAttribute('aria-labelledby') ? 'via-labelledby' : '')
    ).trim()

    const btns = [...document.querySelectorAll('button,[role="button"]')].filter(visible)
    const unnamed = btns.filter((b) => !name(b) && !b.querySelector('img[alt]:not([alt=""])'))
    const imgs = [...document.querySelectorAll('img')].filter(visible)
    const noAlt = imgs.filter((i) => !i.hasAttribute('alt'))
    const inputs = [...document.querySelectorAll('input,textarea,select')].filter(visible)
    const unlabelled = inputs.filter((i) => {
      if (i.getAttribute('aria-label') || i.getAttribute('aria-labelledby') || i.placeholder) return false
      return !(i.id && document.querySelector(`label[for="${CSS.escape(i.id)}"]`)) && !i.closest('label')
    })
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible)
    const dialogs = [...document.querySelectorAll('[role="dialog"]')]

    return {
      buttonsTotal: btns.length,
      buttonsWithoutAccessibleName: unnamed.length,
      unnamedSample: unnamed.slice(0, 8).map((b) => (b.className || '').toString().slice(0, 60)),
      imagesWithoutAlt: noAlt.length,
      inputsWithoutLabel: unlabelled.length,
      h1Count: headings.filter((h) => h.tagName === 'H1').length,
      headingOrder: headings.slice(0, 12).map((h) => h.tagName),
      dialogsWithoutDescription: dialogs.filter((d) => !d.getAttribute('aria-describedby')).length,
      langAttr: document.documentElement.lang || null,
      viewportMeta: !!document.querySelector('meta[name="viewport"]'),
    }
  })
  rec({ check: 'accessibility', headline: `${a11y.buttonsWithoutAccessibleName}/${a11y.buttonsTotal} buttons unnamed, ${a11y.inputsWithoutLabel} inputs unlabelled, lang=${a11y.langAttr}`, ...a11y })

  // Keyboard reachability: can a keyboard user get to the composer at all?
  const kb = await page.evaluate(() => ({ start: document.activeElement?.tagName }))
  const seq = []
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab')
    seq.push(await page.evaluate(() => {
      const a = document.activeElement
      if (!a) return 'none'
      const s = getComputedStyle(a)
      const ring = s.outlineStyle !== 'none' && s.outlineWidth !== '0px'
      return `${a.tagName.toLowerCase()}:${(a.getAttribute('aria-label') || a.placeholder || (a.innerText || '').trim() || '').slice(0, 24)}${ring ? '' : ' [no-focus-ring]'}`
    }))
  }
  // Exclude two stops that are not app defects and were being counted as such:
  // `nextjs-portal` is Next's dev-only overlay (absent from a production build),
  // and <body> taking focus does not want a focus ring. Counting them made a
  // clean result look like it still had two outstanding a11y problems.
  const noRing = seq.filter(
    (s) => s.includes('[no-focus-ring]') && !/^nextjs-portal|^body:/.test(s),
  ).length

  // The real acceptance test is not "does Tab eventually land on the textarea"
  // — a skip link is designed to be ACTIVATED, not tabbed past. Reload, tab to
  // the skip link, press Enter, and see where focus actually goes.
  //
  // Assert on the ELEMENT, never on activeElement.innerText: <body>'s innerText
  // begins with "Skip to question box", so a text match reported success while
  // focus was still on the body, and Enter did nothing. That false positive had
  // me calling a working fix broken.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  const skip = { tabbedTo: false, focusAfterEnter: null }
  for (let i = 0; i < 8 && !skip.tabbedTo; i++) {
    await page.keyboard.press('Tab')
    skip.tabbedTo = await page.evaluate(() => {
      const a = document.activeElement
      return a?.tagName === 'A' && /skip to/i.test(a.textContent || '')
    })
  }
  if (skip.tabbedTo) {
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)
    skip.focusAfterEnter = await page.evaluate(() => {
      const a = document.activeElement
      return a ? `${a.tagName}${a.id ? '#' + a.id : ''}` : null
    })
  }
  const reachedComposer = /TEXTAREA/.test(skip.focusAfterEnter || '')

  rec({
    check: 'keyboard-nav',
    headline: `skip link reachable=${skip.tabbedTo}, activating it lands on ${skip.focusAfterEnter ?? 'nothing'} — composer reachable=${reachedComposer}; ${noRing}/25 stops without a focus ring`,
    start: kb.start, sequence: seq, stopsWithoutFocusRing: noRing,
    skipLinkTabbable: skip.tabbedTo, focusAfterSkipLink: skip.focusAfterEnter,
    reachedComposer,
  })
  await shot(page, 'hard-01-focus')
  await browser.close()
}

// ===========================================================================
// 2. What does the UI say when the agent API fails?
// ===========================================================================
for (const [id, status, body] of [
  ['api-500', 500, JSON.stringify({ error: 'internal error' })],
  ['api-timeout-abort', 'abort', null],
]) {
  const { browser, page, defects } = await launch({ headless: true })
  await page.route('**/api/agent', async (route) => {
    if (status === 'abort') return route.abort('failed')
    return route.fulfill({ status, contentType: 'application/json', body })
  })
  await goHome(page); await dismissTour(page)
  await drawAoi(page, { center: centerOf('farmland'), zoom: 13 })
  await askQuestion(page, 'What is the average NDVI here?')
  await page.waitForTimeout(12_000)

  const shown = await page.evaluate(() => {
    const t = document.body.innerText || ''
    return {
      mentionsError: /(error|failed|unable|could not|went wrong|try again|unavailable)/i.test(t),
      stuckSpinner: !!document.querySelector('.animate-spin,[aria-busy="true"]'),
      tail: t.slice(-700),
    }
  })
  rec({
    check: `backend-failure:${id}`,
    headline: `user told something went wrong = ${shown.mentionsError}; spinner still running = ${shown.stuckSpinner}`,
    mentionsError: shown.mentionsError, stuckSpinner: shown.stuckSpinner,
    tail: shown.tail, shot: await shot(page, `hard-02-${id}`),
    consoleErrors: defects.console.filter((c) => c.type === 'error').length,
  })
  await browser.close()
}

// ===========================================================================
// 3. Cancelling a running analysis
// ===========================================================================
{
  const { browser, page } = await launch({ headless: true })
  await goHome(page); await dismissTour(page)
  await drawAoi(page, { center: centerOf('lahore'), zoom: 13 })
  await askQuestion(page, 'Compare vegetation health against built-up density and elevation here.')
  await page.waitForTimeout(6000)

  const stop = page.getByRole('button', { name: /stop|cancel|abort/i }).first()
  const hadStop = await stop.count().catch(() => 0) > 0
  let stopped = false
  if (hadStop) {
    await stop.click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(5000)
    stopped = await page.evaluate(() => !document.querySelector('.animate-spin,[aria-busy="true"]'))
  }
  rec({
    check: 'cancel-running-query',
    headline: hadStop ? `stop control present; analysis halted = ${stopped}` : 'NO stop/cancel control offered while a query was running',
    hadStopControl: hadStop, halted: stopped, shot: await shot(page, 'hard-03-cancel'),
  })
  await browser.close()
}

// ===========================================================================
// 4. Does anything survive a reload?
// ===========================================================================
{
  const { browser, page } = await launch({ headless: true })
  await goHome(page); await dismissTour(page)
  await drawAoi(page, { center: centerOf('farmland'), zoom: 13 })
  await askQuestion(page, 'What is the average NDVI here?')
  await waitForAnswer(page, { timeoutMs: 420_000 })

  const before = await page.evaluate(() => {
    const t = document.body.innerText || ''
    return { chars: t.length, hasAnswer: /NDVI/i.test(t), storageKeys: Object.keys(localStorage).length }
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)
  await dismissTour(page)
  const after = await page.evaluate(() => {
    const t = document.body.innerText || ''
    return {
      chars: t.length,
      keptAoi: /\d[\d,.]*\s*km²/i.test(t),
      keptChat: /NDVI/i.test(t),
      tourReappeared: [...document.querySelectorAll('button')].some((b) => /^skip$/i.test(b.innerText.trim())),
    }
  })
  rec({
    check: 'reload-persistence',
    headline: `after reload — AOI kept=${after.keptAoi}, conversation kept=${after.keptChat}, tour reappeared=${after.tourReappeared}`,
    before, after, shot: await shot(page, 'hard-04-reload'),
  })
  await browser.close()
}

// ===========================================================================
// 5. Page-load performance
// ===========================================================================
{
  const { browser, page } = await launch({ headless: true })
  const t0 = Date.now()
  await goHome(page)
  const perf = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] || {}
    const res = performance.getEntriesByType('resource')
    const paint = performance.getEntriesByType('paint')
    return {
      domContentLoaded: Math.round(n.domContentLoadedEventEnd || 0),
      loadEvent: Math.round(n.loadEventEnd || 0),
      firstContentfulPaint: Math.round(paint.find((p) => p.name === 'first-contentful-paint')?.startTime || 0),
      resourceCount: res.length,
      transferKB: Math.round(res.reduce((a, r) => a + (r.transferSize || 0), 0) / 1024),
      slowestResources: res.slice().sort((a, b) => b.duration - a.duration).slice(0, 5)
        .map((r) => `${Math.round(r.duration)}ms ${r.name.split('/').pop().slice(0, 50)}`),
      jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    }
  })
  rec({ check: 'page-load-performance', headline: `FCP ${perf.firstContentfulPaint}ms, ${perf.resourceCount} resources, ${perf.transferKB}KB, wall ${Date.now() - t0}ms`, ...perf })
  await browser.close()
}

console.log(`\nhardening complete → ${JSONL}`)
