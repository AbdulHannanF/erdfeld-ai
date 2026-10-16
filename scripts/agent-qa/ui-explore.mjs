/**
 * PHASE D3 — qwen3.8 uses the app itself.
 *
 * The scripted journey only ever finds bugs on the path I thought to walk. This
 * loop hands the wheel to the model: it sees a screenshot with every interactive
 * element outlined and numbered, picks what to click next, and reports what
 * looks wrong. It goes places a written script would not.
 *
 * Guard rails: it cannot leave localhost, and anything that would sign in or
 * navigate away is bounced back.
 */
import fs from 'fs'
import path from 'path'
import {
  launch, goHome, dismissTour, drawAoi, askQuestion, waitForAnswer,
  markElements, clearMarks, actOnMark, shot,
} from './browser.mjs'
import { driveStep } from './vision.mjs'
 
import { AOIS } from './probes.mjs'

const OUT = path.resolve(process.cwd(), 'qa-out')
const JSONL = path.join(OUT, 'ui-explore.jsonl')
fs.mkdirSync(OUT, { recursive: true })

const MAX_STEPS = Number(process.env.QA_EXPLORE_STEPS || 16)
const BASE = process.env.QA_APP_BASE || 'http://localhost:3000'

const centerOf = (key) => {
  const c = AOIS[key].geom.coordinates[0]
  const xs = c.map((p) => p[0]), ys = c.map((p) => p[1])
  return { lng: (Math.min(...xs) + Math.max(...xs)) / 2, lat: (Math.min(...ys) + Math.max(...ys)) / 2 }
}

const SESSIONS = [
  {
    id: 'explore-fresh',
    goal: 'You are seeing this geospatial app for the first time, exactly as a new user would. '
      + 'Work through the onboarding, then explore the map toolbar and side panels. Open things, '
      + 'toggle things, and judge whether each one behaves and looks like a finished product.',
    setup: async () => {},
  },
  {
    id: 'explore-results',
    goal: 'An analysis has already been run and produced results. Inspect the RESULTS side of the app: '
      + 'the answer, its citations, the layer list, layer visibility and opacity controls, any legend, '
      + 'chart, data table, export or share feature. Verify the results are presented clearly and completely.',
    setup: async (page) => {
      await drawAoi(page, { center: centerOf('farmland'), zoom: 13 })
      await askQuestion(page, 'What is the average NDVI here?')
      await waitForAnswer(page, { timeoutMs: 420_000 })
    },
  },
]

const fatal = (kind) => (err) => {
  try { fs.appendFileSync(JSONL, JSON.stringify({ id: `fatal-${kind}`, error: String(err?.message || err).slice(0, 400) }) + '\n') } catch {}
  console.error(`FATAL(${kind}):`, err?.message || err)
  process.exit(1)
}
process.on('unhandledRejection', fatal('rejection'))
process.on('uncaughtException', fatal('exception'))

for (const session of SESSIONS) {
  console.log(`\n=== ${session.id}`)
  const { browser, page, defects } = await launch({ headless: true, width: 1600, height: 1000 })
  const history = []

  try {
    await goHome(page)
    if (session.id !== 'explore-fresh') await dismissTour(page)
    await session.setup(page)

    for (let step = 1; step <= MAX_STEPS; step++) {
      const elements = await markElements(page)
      const shotPath = await shot(page, `${session.id}-${String(step).padStart(2, '0')}`)

      const reply = await driveStep({ goal: session.goal, elements, shotPath, history })
      const rec = {
        session: session.id, step, shot: shotPath, elementCount: elements.length,
        observation: reply?.observation, why: reply?.why, action: reply?.action,
        bugs: Array.isArray(reply?.bugs) ? reply.bugs : [],
        modelError: reply?.error,
      }

      await clearMarks(page)

      if (reply?.error) {
        rec.executed = { ok: false, reason: 'model error' }
        fs.appendFileSync(JSONL, JSON.stringify(rec) + '\n')
        console.log(`  ${step}. model error: ${String(reply.error).slice(0, 120)}`)
        break
      }

      const a = reply?.action || {}
      const target = elements.find((e) => e.index === a.index)
      const label = target ? `${a.index}:${target.label || target.tag}` : String(a.index ?? '')

      try {
        if (a.action === 'click') rec.executed = await actOnMark(page, a.index, 'click')
        else if (a.action === 'type') rec.executed = await actOnMark(page, a.index, 'type', a.text)
        else if (a.action === 'key') { await page.keyboard.press(a.key || 'Enter'); rec.executed = { ok: true } }
        else if (a.action === 'scroll') { await page.mouse.wheel(0, a.direction === 'up' ? -600 : 600); rec.executed = { ok: true } }
        else if (a.action === 'wait') { await page.waitForTimeout(Math.min(10, Number(a.seconds) || 2) * 1000); rec.executed = { ok: true } }
        else if (a.action === 'done') { rec.executed = { ok: true, done: true } }
        else rec.executed = { ok: false, reason: `unknown action ${a.action}` }
      } catch (err) {
        rec.executed = { ok: false, reason: String(err?.message || err).slice(0, 200) }
      }

      await page.waitForTimeout(1800)

      // Guard rail: never leave the app under test.
      if (!page.url().startsWith(BASE)) {
        rec.navigatedAway = page.url().slice(0, 120)
        await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {})
        await dismissTour(page)
        await page.waitForTimeout(1500)
      }

      history.push(`step ${step}: ${a.action} ${label} → ${rec.executed?.ok ? 'ok' : 'FAILED: ' + rec.executed?.reason}`)
      fs.appendFileSync(JSONL, JSON.stringify(rec) + '\n')
      console.log(`  ${step}. ${a.action} ${label} → ${rec.executed?.ok ? 'ok' : 'fail'}${rec.bugs.length ? ` | ${rec.bugs.length} bug(s)` : ''}`)

      if (a.action === 'done') break
    }
  } catch (err) {
    fs.appendFileSync(JSONL, JSON.stringify({ session: session.id, error: String(err?.message || err).slice(0, 400) }) + '\n')
    console.error(`  session error: ${err?.message || err}`)
  } finally {
    fs.appendFileSync(JSONL, JSON.stringify({
      session: session.id, kind: 'session-defects',
      pageErrors: defects.pageErrors.slice(0, 10),
      consoleErrors: defects.console.filter((c) => c.type === 'error').slice(0, 10),
      httpErrors: defects.httpErrors.filter((h) => !/favicon/.test(h.url)).slice(0, 10),
    }) + '\n')
    await browser.close()
  }
}

console.log(`\nexploration complete → ${JSONL}`)
