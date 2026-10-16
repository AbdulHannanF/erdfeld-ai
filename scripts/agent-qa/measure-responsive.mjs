/**
 * Measure the responsive defects instead of guessing at them.
 *
 * The reported clipping only appears once the analysis panel has a real answer
 * in it, so this draws an AOI, asks a question, waits for the answer, and only
 * then measures at each width. Reports:
 *   - whether the page scrolls sideways,
 *   - every element whose box extends past the viewport edge,
 *   - every leaf element whose text cannot fit its own box (sr-only excluded —
 *     those are clipped deliberately and are not defects),
 *   - overlapping floating panels.
 */
import { launch, goHome, dismissTour, drawAoi, askQuestion, waitForAnswer, shot } from './browser.mjs'
 
import { AOIS } from './probes.mjs'

const c = AOIS.farmland.geom.coordinates[0]
const xs = c.map((p) => p[0]), ys = c.map((p) => p[1])
const CENTER = { lng: (Math.min(...xs) + Math.max(...xs)) / 2, lat: (Math.min(...ys) + Math.max(...ys)) / 2 }

const MEASURE = () => {
  const vw = innerWidth
  const doc = document.scrollingElement
  const isSrOnly = (el) => {
    const s = getComputedStyle(el)
    // sr-only is intentionally a 1px clipped box — never a defect.
    return (el.className || '').toString().includes('sr-only') ||
      (s.position === 'absolute' && parseFloat(s.width) <= 1 && parseFloat(s.height) <= 1)
  }
  const desc = (el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(/\s+/).slice(0, 3).join('.')}`.slice(0, 70)

  // An element inside a scrollable/clipping ancestor is CONTAINED, even though
  // its own box extends past the viewport — that is what scrolling means. Only
  // content that actually escapes onto the page is a defect.
  const isContained = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true
    }
    return false
  }

  const overflow = []
  const clipped = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0 || isSrOnly(el)) continue
    if ((r.right > vw + 1 || r.left < -1) && !isContained(el)) {
      overflow.push({ el: desc(el), left: Math.round(r.left), right: Math.round(r.right), over: Math.round(r.right - vw) })
    }
    if (el.children.length === 0 && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 4) {
      const t = (el.textContent || '').trim()
      if (t) clipped.push({ el: desc(el), scrollW: el.scrollWidth, clientW: el.clientWidth, text: t.slice(0, 45) })
    }
  }

  // Floating panels that sit on top of one another.
  const floats = [...document.querySelectorAll('body *')].filter((el) => {
    const s = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return (s.position === 'fixed' || s.position === 'absolute') && r.width > 60 && r.height > 30 && !isSrOnly(el)
  })
  const overlaps = []
  for (let i = 0; i < floats.length; i++) {
    for (let j = i + 1; j < floats.length; j++) {
      const a = floats[i], b = floats[j]
      if (a.contains(b) || b.contains(a)) continue
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
      if (ox > 12 && oy > 12) overlaps.push({ a: desc(a), b: desc(b), overlap: `${Math.round(ox)}x${Math.round(oy)}` })
    }
  }

  // Did the app actually render? A build error replaces the page with Next's
  // overlay, and every "count the overflowing elements" check then reports a
  // triumphant ZERO. That exact false green nearly passed a broken build:
  // the numbers were clean because there was no app on screen to measure.
  const buildError = /Build Error|Failed to compile|Unhandled Runtime Error/i.test(document.body.innerText || '')
  // At mobile widths the app switches to a tabbed layout and the composer is not
  // mounted until the Chat tab is active — so requiring it here reported "app did
  // not render" on a perfectly healthy 375px page. Accept the tab as proof too.
  const hasChatSurface = !!document.getElementById('chat-composer') ||
    [...document.querySelectorAll('[role="tab"]')].some((t) => /chat/i.test(t.textContent || ''))
  const rendered = !!document.querySelector('canvas.maplibregl-canvas') && hasChatSurface

  return {
    viewport: vw,
    buildError,
    rendered,
    trustworthy: !buildError && rendered,
    pageScrollsSideways: doc.scrollWidth > doc.clientWidth,
    scrollWidth: doc.scrollWidth,
    overflow: overflow.slice(0, 10),
    overflowCount: overflow.length,
    clipped: clipped.slice(0, 10),
    clippedCount: clipped.length,
    overlaps: overlaps.slice(0, 8),
    overlapCount: overlaps.length,
  }
}

const { browser, page } = await launch({ headless: true, width: 1600, height: 1000 })
try {
  await goHome(page)
  await dismissTour(page)
  await drawAoi(page, { center: CENTER, zoom: 13 })
  await askQuestion(page, 'What is the average NDVI here?')
  await waitForAnswer(page, { timeoutMs: 420_000 })
  console.log('answer captured — measuring\n')

  for (const [w, h] of [[1600, 1000], [768, 1024], [375, 812]]) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForTimeout(2200)
    const m = await page.evaluate(MEASURE)
    await shot(page, `resp-${w}`)
    if (!m.trustworthy) {
      console.log(`═══ ${w}px — RESULTS NOT TRUSTWORTHY: buildError=${m.buildError} appRendered=${m.rendered}`)
      console.log('    Zeros below would mean "nothing on screen to measure", not "no defects". Fix the app first.\n')
      continue
    }
    console.log(`═══ ${w}px — scrollsSideways=${m.pageScrollsSideways} (scrollWidth ${m.scrollWidth}) overflow=${m.overflowCount} clipped=${m.clippedCount} overlaps=${m.overlapCount}`)
    m.overflow.forEach((o) => console.log(`   OVERFLOW +${o.over}px  ${o.el}`))
    m.clipped.forEach((x) => console.log(`   CLIPPED  ${x.clientW}<${x.scrollW}  ${x.el}  "${x.text}"`))
    m.overlaps.forEach((o) => console.log(`   OVERLAP  ${o.overlap}  ${o.a}  ×  ${o.b}`))
    console.log()
  }
} finally {
  await browser.close()
}
