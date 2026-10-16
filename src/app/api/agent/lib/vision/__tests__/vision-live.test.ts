/**
 * LIVE imagery-inspection verification (opt-in: VISION_LIVE=1).
 *
 *   VISION_LIVE=1 npx vitest run vision-live
 *
 * Two halves, deliberately separable:
 *
 *  1. THE RENDER — hits AWS Earth Search + titiler.xyz and checks the PICTURE
 *     itself. This half needs no vision model, and it is where the Phase 2.5
 *     "the agent can see a cloud" claim is actually measured: over a clouded
 *     AOI the rendered true-colour frame must be bright and desaturated (what
 *     cloud looks like), and over a clear AOI it must not be. If the render
 *     were wrong, a VLM looking at it would be confidently describing the
 *     wrong scene — so this is checked before anything is asked to look.
 *
 *  2. THE MODEL — opt-in separately (VLM_LIVE=1 plus VLM_ENDPOINT/VLM_MODEL or
 *     a provider key), because a vision backend is not always reachable.
 *
 * WHY THIS FILE SWEEPS FOR CLOUD INSTEAD OF NAMING A CLOUDY PLACE
 * --------------------------------------------------------------
 * It used to hardcode "Lahore in monsoon — every recent scene is clouded over
 * this polygon" and assert `cloudPct > 50`. On 2026-08-16 the newest scene
 * there was **90.6% clear**, so the suite failed against entirely correct code:
 * the fixture encoded the weather on the day it was written. A test whose
 * verdict depends on today's cloud cover cannot distinguish a broken renderer
 * from a sunny Tuesday.
 *
 * Swept the same day, 4 places x 5 date windows: Loch Tay 5/5 clouded (4 of
 * them >=99.9%), Kerala 3/5, Amazon 2/5, Lahore 1/5. So the cloudy frame is now
 * FOUND rather than assumed — candidates are scored by SCL until one is
 * genuinely clouded over a polygon it actually covers, and if none is the test
 * fails with the full sweep log rather than passing on a clear sky.
 */

import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { renderAoi, type RenderedAoi } from '../render-aoi'
import { describeImage, resolveVlm } from '../vlm'

const LIVE = !!process.env.VISION_LIVE
const suite = LIVE ? describe : describe.skip

function box(bbox: [number, number, number, number]) {
  const [a, b, c, d] = bbox
  return { type: 'Polygon', coordinates: [[[a, b], [c, b], [c, d], [a, d], [a, b]]] }
}

/** Nile floodplain at Luxor — reliably clear, and the negative control for the
 *  vision model: a frame it must NOT call clouded. */
const CLEAR_BBOX: [number, number, number, number] = [32.62, 25.68, 32.66, 25.72]
const CLEAR = box(CLEAR_BBOX)

/** Places/windows to try for a genuinely clouded frame, best-first by the
 *  2026-08-16 sweep. `date` undefined = newest scene in the last 120 days. */
const CLOUD_CANDIDATES: Array<{
  name: string
  bbox: [number, number, number, number]
  date?: string
}> = [
  { name: 'Loch Tay, Scotland', bbox: [-4.30, 56.60, -4.24, 56.66] },
  { name: 'Loch Tay, Scotland (Jun)', bbox: [-4.30, 56.60, -4.24, 56.66], date: '2026-06-10' },
  { name: 'Kerala, India', bbox: [76.30, 10.00, 76.36, 10.06] },
  { name: 'Kerala, India (Jul)', bbox: [76.30, 10.00, 76.36, 10.06], date: '2026-07-10' },
  { name: 'Amazon, Manaus (Mar)', bbox: [-60.05, -3.15, -59.99, -3.09], date: '2026-03-10' },
  { name: 'Lahore, Pakistan', bbox: [74.30, 31.50, 74.36, 31.56] },
]

/** A clouded frame must be mostly cloud AND actually show the polygon — a 2%
 *  sliver scoring 100% cloud proves nothing (ISS-125). */
const MIN_CLOUD_PCT = 50
const MIN_COVERAGE_PCT = 50

/** Mean brightness and mean saturation over the OPAQUE pixels of a PNG.
 *  Cloud is bright and near-grey; land is darker and more saturated. */
async function imageStats(base64: string) {
  const buf = Buffer.from(base64, 'base64')
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let n = 0, brightness = 0, saturation = 0, veryBright = 0
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3] < 128) continue
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    n++
    brightness += (r + g + b) / 3
    saturation += max === 0 ? 0 : (max - min) / max
    if (min > 170) veryBright++
  }
  if (n === 0) return null
  return {
    pixels: n,
    brightness: brightness / n,
    saturation: saturation / n,
    veryBrightPct: (veryBright / n) * 100,
    width: info.width,
    height: info.height,
  }
}

type ImageStats = NonNullable<Awaited<ReturnType<typeof imageStats>>>

/**
 * Find a frame SCL genuinely scores as clouded over a polygon the scene covers.
 * Throws with everything it tried rather than returning a clear frame — a
 * "cloud is visible" gate that silently runs on blue sky is worse than no gate.
 */
async function findCloudedRender(): Promise<{ name: string; render: RenderedAoi; stats: ImageStats }> {
  const tried: string[] = []
  for (const cand of CLOUD_CANDIDATES) {
    const out = await renderAoi({
      aoi: box(cand.bbox), bbox: cand.bbox, subject: 'truecolor',
      scene: 'newest', date: cand.date, maxSize: 512,
    })
    if (!out.ok) { tried.push(`${cand.name}: render failed — ${out.message.slice(0, 80)}`); continue }
    const cloud = out.render.clarity?.cloudPct ?? 0
    const cov = out.render.coveragePct
    tried.push(`${cand.name}: scene ${out.render.sceneDate}, cloud ${cloud.toFixed(1)}%, coverage ${cov.toFixed(1)}%`)
    if (cloud < MIN_CLOUD_PCT || cov < MIN_COVERAGE_PCT) continue
    const stats = await imageStats(out.render.imageBase64)
    if (!stats) { tried.push(`${cand.name}: no opaque pixels`); continue }
    console.log('clouded frame found —', cand.name, {
      scene: out.render.sceneDate,
      cloudPct: cloud.toFixed(1),
      clearPct: out.render.clarity?.clearPct?.toFixed(1),
      coveragePct: cov.toFixed(1),
      ...stats,
    })
    return { name: cand.name, render: out.render, stats }
  }
  throw new Error(
    `No candidate AOI was clouded over a polygon it covers (needed >=${MIN_CLOUD_PCT}% cloud ` +
    `and >=${MIN_COVERAGE_PCT}% coverage). Tried:\n  ${tried.join('\n  ')}`,
  )
}

/** One sweep shared by every test that needs a clouded frame. */
let cloudedOnce: Promise<{ name: string; render: RenderedAoi; stats: ImageStats }> | null = null
const clouded = () => (cloudedOnce ??= findCloudedRender())

suite('LIVE imagery render — the picture carries the evidence', () => {
  it('renders real true colour over a clear AOI', async () => {
    const out = await renderAoi({ aoi: CLEAR, bbox: CLEAR_BBOX, subject: 'truecolor', maxSize: 512 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const s = await imageStats(out.render.imageBase64)
    console.log('CLEAR true colour:', { scene: out.render.sceneDate, clearPct: out.render.clarity?.clearPct?.toFixed(1), ...s })
    expect(s).not.toBeNull()
    expect(s!.pixels).toBeGreaterThan(10_000)
    expect(out.render.clarity!.clearPct).toBeGreaterThan(80)
    // Land: not a white sheet.
    expect(s!.veryBrightPct).toBeLessThan(20)
  }, 180_000)

  it('GATE: a clouded AOI renders as a bright, desaturated frame — cloud is VISIBLE, not masked away', async () => {
    const { render, stats } = await clouded()

    // The numbers say it is cloud, over a scene that actually shows the polygon
    // rather than a clipping corner — both are enforced by findCloudedRender.
    expect(render.clarity).not.toBeNull()
    expect(render.clarity!.cloudPct).toBeGreaterThan(MIN_CLOUD_PCT)
    expect(render.coveragePct).toBeGreaterThan(MIN_COVERAGE_PCT)

    // ...and the picture shows it: cloud is bright and near-grey. This is the
    // signal a vision model reads. If the renderer silently masked cloud out,
    // these would look like land and the whole inspection path would be blind
    // to the one thing it exists to catch.
    expect(stats.brightness).toBeGreaterThan(120)
    expect(stats.saturation).toBeLessThan(0.35)
    expect(stats.veryBrightPct).toBeGreaterThan(30)
  }, 300_000)

  it('the clouded frame is measurably brighter and greyer than the clear one', async () => {
    const [cloudy, clear] = await Promise.all([
      clouded(),
      renderAoi({ aoi: CLEAR, bbox: CLEAR_BBOX, subject: 'truecolor', maxSize: 512 }),
    ])
    expect(clear.ok).toBe(true)
    if (!clear.ok) return
    const a = cloudy.stats
    const b = (await imageStats(clear.render.imageBase64))!
    console.log('cloudy vs clear:', {
      brightness: [a.brightness.toFixed(1), b.brightness.toFixed(1)],
      saturation: [a.saturation.toFixed(3), b.saturation.toFixed(3)],
      veryBrightPct: [a.veryBrightPct.toFixed(1), b.veryBrightPct.toFixed(1)],
    })
    expect(a.brightness).toBeGreaterThan(b.brightness)
    expect(a.veryBrightPct).toBeGreaterThan(b.veryBrightPct)
    expect(a.saturation).toBeLessThan(b.saturation)
  }, 300_000)

  it('renders an index map with its own colormap', async () => {
    const out = await renderAoi({
      aoi: CLEAR, bbox: CLEAR_BBOX, subject: 'index', index: 'NDWI', maxSize: 384,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const s = await imageStats(out.render.imageBase64)
    console.log('NDWI render:', { scene: out.render.sceneDate, ...s })
    expect(s!.pixels).toBeGreaterThan(5_000)
    expect(out.render.index).toBe('NDWI')
  }, 180_000)

  it('refuses an unsupported index instead of rendering something else', async () => {
    const out = await renderAoi({ aoi: CLEAR, bbox: CLEAR_BBOX, subject: 'index', index: 'NDXX' })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.message).toContain('NDXX')
  }, 60_000)
})

// ---------------------------------------------------------------------------
// The model half — needs a reachable vision backend.
//
// This is a DISCRIMINATION test, not a keyword test. Asserting only that the
// answer contains /cloud/ over a cloudy frame is an assertion a model that says
// "cloud" about everything passes — the exact shape that let ISS-122's phantom
// detections through ("either it decodes or it errors"). A text-only model
// handed an image does not fail either; it describes what it imagines, and
// "satellite image" imagines clouds. So the same model gets the same prompt on
// BOTH frames and has to rank them correctly.
// ---------------------------------------------------------------------------

const MODEL_LIVE = LIVE && !!process.env.VLM_LIVE
const modelSuite = MODEL_LIVE ? describe : describe.skip

const CLOUD_PROMPT =
  'This is a nadir Sentinel-2 true-colour image clipped to an analysis polygon. ' +
  'Estimate how much of it is obscured by cloud. Reply with exactly one line in the form ' +
  '"CLOUD: <integer>%" and then one sentence describing only what is visible.'

/** The percentage the model committed to. Null when it gave none — which is a
 *  failure to answer, never silently read as zero. */
function parseCloudPct(text: string): number | null {
  const tagged = text.match(/CLOUD:\s*(\d+(?:\.\d+)?)\s*%?/i)
  if (tagged) return Number(tagged[1])
  const loose = text.match(/(\d+(?:\.\d+)?)\s*%/)
  return loose ? Number(loose[1]) : null
}

modelSuite('LIVE vision model — the agent describes what it sees', () => {
  it('rates a clouded AOI as far cloudier than a clear one — same model, same prompt', async () => {
    const vlm = await resolveVlm({
      provider: process.env.VLM_TEST_PROVIDER,
      apiKey: process.env.VLM_TEST_KEY,
      baseUrl: process.env.VLM_TEST_BASE,
      model: process.env.VLM_TEST_MODEL,
    })
    expect(vlm.ok, vlm.ok ? '' : (vlm as any).reason).toBe(true)
    if (!vlm.ok) return

    const cloudy = await clouded()
    const clear = await renderAoi({ aoi: CLEAR, bbox: CLEAR_BBOX, subject: 'truecolor', maxSize: 512 })
    expect(clear.ok).toBe(true)
    if (!clear.ok) return

    const [cloudySaid, clearSaid] = await Promise.all([
      describeImage({ images: [cloudy.render.imageBase64], prompt: CLOUD_PROMPT, config: vlm.config }),
      describeImage({ images: [clear.render.imageBase64], prompt: CLOUD_PROMPT, config: vlm.config }),
    ])

    console.log(`${cloudySaid.model} on the CLOUDED frame (${cloudy.name}):`, cloudySaid.text)
    console.log('  SCL says: cloud', cloudy.render.clarity?.cloudPct?.toFixed(1), '%')
    console.log(`${clearSaid.model} on the CLEAR frame (Luxor):`, clearSaid.text)
    console.log('  SCL says: cloud', clear.render.clarity?.cloudPct?.toFixed(1), '%')

    const cloudyPct = parseCloudPct(cloudySaid.text)
    const clearPct = parseCloudPct(clearSaid.text)
    expect(cloudyPct, `no percentage in: ${cloudySaid.text}`).not.toBeNull()
    expect(clearPct, `no percentage in: ${clearSaid.text}`).not.toBeNull()

    // It must SEE the cloud...
    expect(cloudySaid.text).toMatch(/cloud|overcast|haze/i)
    expect(cloudyPct!).toBeGreaterThan(50)
    // ...and, decisively, NOT see it where there is none. Absolute calibration
    // is loose (a model called 9.4% SCL cloud "approximately 30%"), so the
    // claim under test is the ordering and the gap, not the number.
    expect(clearPct!).toBeLessThan(25)
    expect(cloudyPct! - clearPct!).toBeGreaterThan(40)
  }, 600_000)
})
