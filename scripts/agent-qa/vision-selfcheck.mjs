/**
 * Can the vision judge actually SEE a bug?
 *
 * A screenshot reviewer that answers PASS to everything would make the whole UI
 * phase worthless while looking like a clean bill of health — the same failure
 * mode the text judge's self-check exists to prevent. So before its verdicts
 * count, it is shown the real app deliberately broken in four ways it claims to
 * detect, and it must reject them while still passing the untouched screen.
 *
 * The breakages are injected as CSS/DOM over the live app, so these are real
 * screenshots of a real interface, not synthetic images.
 */
import fs from 'fs'
import path from 'path'
import { launch, goHome, dismissTour, shot } from './browser.mjs'
import { judgeScreenshot } from './vision.mjs'

const OUT = path.resolve(process.cwd(), 'qa-out')
const INTENT = 'The app shell: map, chat panel and toolbars. All text legible, nothing overlapping, '
  + 'nothing clipped, no placeholder or debug text visible to the user.'

const CASES = [
  {
    name: 'control: untouched app',
    expect: 'PASS',
    break: async () => {},
  },
  {
    name: 'invisible text (foreground == background)',
    expect: 'FAIL',
    break: async (page) => {
      await page.addStyleTag({ content: `
        *, *::before, *::after { color: #0a0d12 !important; }
        input, textarea { color: #0a0d12 !important; -webkit-text-fill-color: #0a0d12 !important; }
      ` })
    },
  },
  {
    name: 'overlapping / colliding panels',
    expect: 'FAIL',
    break: async (page) => {
      await page.addStyleTag({ content: `
        [class*="panel"], aside, section, main > div { transform: translateX(-90px) rotate(-2.5deg) !important; }
        button { transform: translateY(26px) scale(1.5) !important; }
      ` })
    },
  },
  {
    name: 'visible placeholder / debug junk',
    expect: 'FAIL',
    break: async (page) => {
      await page.evaluate(() => {
        const bar = document.createElement('div')
        bar.style.cssText = 'position:fixed;top:80px;left:60px;right:60px;z-index:99999;background:#111318;'
          + 'color:#e5e7eb;font:16px/1.6 monospace;padding:18px;border:1px solid #333'
        bar.textContent = 'NDVI: undefined · Mean: NaN · Source: [object Object] · Area: null km² · [[result_id#mean_ndvi]]'
        document.body.appendChild(bar)
      })
    },
  },
  {
    name: 'content clipped at the edge',
    expect: 'FAIL',
    break: async (page) => {
      await page.addStyleTag({ content: `
        body { overflow: hidden !important; }
        [class*="chat"], aside, main { width: 190px !important; max-width: 190px !important;
          white-space: nowrap !important; overflow: hidden !important; }
      ` })
    },
  },
]

const results = []
for (const c of CASES) {
  const { browser, page } = await launch({ headless: true, width: 1600, height: 1000 })
  try {
    await goHome(page)
    await dismissTour(page)
    await page.waitForTimeout(1200)
    await c.break(page)
    await page.waitForTimeout(1200)

    const slug = c.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)
    const shotPath = await shot(page, `vcheck-${slug}`)
    const v = await judgeScreenshot({ stepId: `vision-selfcheck:${c.name}`, intent: INTENT, shotPath })
    const ok = v.verdict === c.expect
    results.push({ name: c.name, expect: c.expect, got: v.verdict, ok, looks_like: v.looks_like, bugs: v.bugs, error: v.error, shot: shotPath })
    console.log(`  ${ok ? 'ok  ' : 'MISS'}  ${c.name.padEnd(44)} → ${v.verdict} (expected ${c.expect})`)
    if (!ok && v.looks_like) console.log(`        saw: ${v.looks_like}`)
  } catch (err) {
    results.push({ name: c.name, expect: c.expect, got: 'ERROR', ok: false, error: String(err?.message || err).slice(0, 200) })
    console.log(`  ERR   ${c.name}: ${err?.message || err}`)
  } finally {
    await browser.close()
  }
}

const passed = results.filter((r) => r.ok).length
console.log(`\nvision judge scored ${passed}/${results.length}`)
fs.appendFileSync(path.join(OUT, 'verdicts.jsonl'), JSON.stringify({
  phase: 'visioncheck', id: 'vision-judge', passed, total: results.length, results,
}) + '\n')
