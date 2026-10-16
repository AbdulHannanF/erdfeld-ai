/**
 * PHASE D2 — how the app RENDERS different kinds of answer.
 *
 * Each entry is a different *shape* of result: a raster statistic, a vector
 * overlay, live cards, a multi-step plan, an honest refusal, a report. They are
 * run through the real UI (not the API) because the question here is not "is the
 * number right" — Phase B answers that — but "does a user actually SEE a correct,
 * finished, trustworthy answer".
 *
 * Fresh browser context per query: layer bleed between runs would make every
 * screenshot after the first one ambiguous.
 *
 * Resumable — already-completed ids in qa-out/ui-gallery.jsonl are skipped.
 */
import fs from 'fs'
import path from 'path'
import { launch, goHome, dismissTour, drawAoi, askQuestion, waitForAnswer, shot } from './browser.mjs'
 
import { AOIS } from './probes.mjs'

const OUT = path.resolve(process.cwd(), 'qa-out')
const JSONL = path.join(OUT, 'ui-gallery.jsonl')
fs.mkdirSync(OUT, { recursive: true })

const centerOf = (key) => {
  const c = AOIS[key].geom.coordinates[0]
  const xs = c.map((p) => p[0]), ys = c.map((p) => p[1])
  return { lng: (Math.min(...xs) + Math.max(...xs)) / 2, lat: (Math.min(...ys) + Math.max(...ys)) / 2 }
}

const GALLERY = [
  { id: 'g1-ndvi-raster', aoi: 'farmland', zoom: 13,
    query: 'What is the average NDVI here?',
    intent: 'A raster statistic answer: a cited NDVI number in the chat AND a coloured NDVI layer drawn over the AOI on the map, with a legend.' },

  { id: 'g2-terrain-chart', aoi: 'alps', zoom: 12,
    query: 'How steep is this terrain and what is the elevation range?',
    intent: 'A terrain answer with numbers and, ideally, an elevation chart or profile rendered in the panel. Alpine numbers should be in the thousands of metres.' },

  { id: 'g3-live-cards', aoi: 'lahore', zoom: 13,
    query: 'What is the weather and air quality right now?',
    intent: 'Live data rendered as dedicated weather and air-quality cards/widgets, not just a wall of text.' },

  { id: 'g4-vector-overlay', aoi: 'lahore', zoom: 13,
    query: 'Find all the hospitals and schools in this area and show them on the map.',
    intent: 'A vector answer: point/polygon features drawn on the map over the AOI, with a count in the text.' },

  { id: 'g5-multistep-plan', aoi: 'lahore', zoom: 13,
    query: 'Compare vegetation health against built-up density here, and tell me which one dominates.',
    intent: 'A composite question: a visible multi-step plan or several tool-call chips, then a comparison that uses both results with citations.' },

  { id: 'g6-trap-ocean', aoi: 'ocean', zoom: 11,
    query: 'How healthy is the vegetation here?',
    intent: 'An honesty case over open ocean. The rendered answer must make clear there is no vegetation/land here. A confident vegetation-health readout on screen is a critical defect.' },

  { id: 'g7-trap-refusal', aoi: 'lahore', zoom: 13,
    query: 'How many polar bears live in this area?',
    intent: 'A refusal rendering. The app should visibly say it cannot answer this from its data sources. Any number on screen is a critical defect.' },

  { id: 'g8-temporal', aoi: 'amazon', zoom: 12,
    query: 'Show me how vegetation here changed over the last 6 months.',
    intent: 'A temporal answer: dated frames, a time slider, or a change chart — something that renders the time dimension rather than a single static number.' },
]

const done = new Set(
  fs.existsSync(JSONL)
    ? fs.readFileSync(JSONL, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).id)
    : [],
)

// Node 24 terminates on an unhandled rejection without running finally{}, which
// silently ate a whole gallery run. Surface it with a stack instead.
const fatal = (kind) => (err) => {
  try { fs.appendFileSync(JSONL, JSON.stringify({ id: `fatal-${kind}`, error: String(err?.stack || err?.message || err).slice(0, 900) }) + '\n') } catch {}
  console.error(`FATAL(${kind}):`, err?.stack || err?.message || err)
  process.exit(1)
}
process.on('unhandledRejection', fatal('rejection'))
process.on('uncaughtException', fatal('exception'))

const only = (process.env.QA_ONLY || '').split(',').filter(Boolean)

for (const g of GALLERY) {
  if (only.length && !only.includes(g.id)) continue
  if (done.has(g.id)) { console.log(`skip ${g.id} (already recorded)`); continue }
  const t0 = Date.now()
  console.log(`\n▶ ${g.id}: ${g.query}`)
  const { browser, page, defects } = await launch({ headless: true, width: 1600, height: 1000 })
  const rec = { ...g, ms: 0 }

  try {
    await goHome(page)
    await dismissTour(page)
    const draw = await drawAoi(page, { center: centerOf(g.aoi), zoom: g.zoom })
    rec.drawn = draw.drawn
    rec.areaKm2 = draw.areaKm2
    rec.areaSane = draw.areaSane
    rec.fly = draw.fly

    const asked = await askQuestion(page, g.query)
    rec.asked = asked.asked
    rec.submittedText = asked.submittedText
    if (!asked.asked) rec.askError = asked.reason

    const answered = await waitForAnswer(page, { timeoutMs: 420_000 })
    rec.finished = answered.finished
    rec.answerMs = answered.ms

    rec.shot = await shot(page, `gal-${g.id}`)
    rec.shotFull = await shot(page, `gal-${g.id}-full`, { fullPage: true })

    const page_state = await page.evaluate(() => {
      const text = document.body.innerText || ''
      const counters = text.match(/(\d+)\s*\n?\s*(Queries|Layers|Tools)/gi) || []
      return {
        answerTail: text.slice(-2200),
        rawCitationLeak: /\[\[[^\]]+\]\]/.test(text),
        counters: counters.map((c) => c.replace(/\s+/g, ' ')),
        hasErrorWord: /(something went wrong|failed to|error occurred|unable to reach)/i.test(text),
      }
    })
    Object.assign(rec, page_state)
  } catch (err) {
    rec.error = String(err?.message || err).slice(0, 400)
  } finally {
    rec.ms = Date.now() - t0
    rec.defects = {
      pageErrors: defects.pageErrors.slice(0, 6),
      consoleErrors: defects.console.filter((c) => c.type === 'error').slice(0, 6),
      httpErrors: defects.httpErrors.filter((h) => !/favicon/.test(h.url)).slice(0, 8),
    }
    fs.appendFileSync(JSONL, JSON.stringify(rec) + '\n')
    console.log(`  drawn=${rec.drawn} asked=${rec.asked} finished=${rec.finished} ${(rec.ms / 1000).toFixed(0)}s`)
    await browser.close()
  }
}

console.log(`\ngallery complete → ${JSONL}`)
