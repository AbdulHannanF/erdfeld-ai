/**
 * LIVE end-to-end fetch_ndvi behaviour (opt-in: CLOUD_LIVE=1).
 *
 *   CLOUD_LIVE=1 npx vitest run ndvi-cloud-live
 *
 * Exercises the real tool through the dispatcher, not the helpers, so a regression
 * in the wiring is caught as well as one in the math.
 */

import { describe, it, expect } from 'vitest'
import { executeTool } from '../tools'

const LIVE = !!process.env.CLOUD_LIVE
const suite = LIVE ? describe : describe.skip

const CLOUDY_AOI = {
  type: 'Polygon',
  coordinates: [[[74.30, 31.50], [74.34, 31.50], [74.34, 31.54], [74.30, 31.54], [74.30, 31.50]]],
}
const CLEAR_AOI = {
  type: 'Polygon',
  coordinates: [[[-120.04, 36.56], [-119.98, 36.56], [-119.98, 36.62], [-120.04, 36.62], [-120.04, 36.56]]],
}

suite('LIVE fetch_ndvi — cloud honesty', () => {
  it('never reports a negative NDVI mean over vegetated cropland', async () => {
    const r = await executeTool('fetch_ndvi', CLEAR_AOI, {})
    const mean = r.stats?.mean
    console.log(`clear AOI → mean=${mean} :: ${r.summary.slice(0, 140).replace(/\s+/g, ' ')}`)
    if (typeof mean === 'number') {
      // The pre-v2 stack returned −0.072 here-equivalent conditions (cloud top).
      expect(mean).toBeGreaterThan(0)
      expect(mean).toBeLessThanOrEqual(1)
    }
  }, 300_000)

  // NOTE ON THESE TWO NAMES (corrected 2026-08-16). They used to claim the AOI
  // "is fully clouded" and that the tool "refuses". Lahore's sky is not a
  // constant: on 2026-08-16 this AOI was clear and both tests exercised the
  // value branch while their names advertised the refusal branch — coverage a
  // reader would believe they had. The invariant actually enforced, in either
  // branch, is that no cloud-top artefact ever ships, so that is what they say.
  it('never reports a cloud-top NDVI over Lahore, whatever the sky is doing', async () => {
    const r = await executeTool('fetch_ndvi', CLOUDY_AOI, {})
    const mean = r.stats?.mean
    console.log(`cloudy AOI → mean=${mean} :: ${r.summary.slice(0, 160).replace(/\s+/g, ' ')}`)

    if (typeof mean === 'number') {
      // If a value IS produced the scene must have been genuinely clear; a negative
      // mean over this AOI is the exact cloud-top artefact Phase 0 removes.
      expect(mean).toBeGreaterThan(0)
    } else {
      // The honest path: refusal names the cause and points at a cloud-penetrating tool.
      expect(r.summary.toLowerCase()).toMatch(/cloud/)
      expect(r.summary).toMatch(/fetch_sar|clear/i)
    }
  }, 300_000)

  it('detect_change never manufactures a trend from a clouded endpoint', async () => {
    const r = await executeTool('detect_change', CLOUDY_AOI, {})
    const d = r.stats
    console.log(`detect_change → ${JSON.stringify(d)?.slice(0, 160) ?? 'no data'}`)

    if (!d || d.ndvi_delta == null) {
      // Refused — must say why and offer the radar route.
      expect(r.summary.toLowerCase()).toMatch(/cloud/)
      return
    }
    // A reported delta means both endpoints cleared the AOI-local bar. Both NDVI
    // values must then be physically plausible ground values, not cloud tops.
    expect(Number(d.before_ndvi)).toBeGreaterThan(-0.2)
    expect(Number(d.after_ndvi)).toBeGreaterThan(-0.2)
    expect(r.summary).toMatch(/cloud-masked/i)
  }, 300_000)

  it('classify_land_cover reports a cloud-masked NDVI or none at all', async () => {
    const r = await executeTool('classify_land_cover', CLOUDY_AOI, {})
    const ndvi = r.stats?.ndvi_mean
    console.log(`classify_land_cover → ndvi_mean=${ndvi}, dominant=${r.stats?.dominant_class}`)
    if (typeof ndvi === 'number') {
      // −0.072 (a cloud top) was the pre-v2 value here.
      expect(ndvi).toBeGreaterThan(-0.2)
    }
  }, 300_000)

  // ── compute_spectral_index — the index tool Phase 0 initially missed ───────
  // It kept the pre-v2 path: newest scene with scene-wide cloud <30%, per-band
  // means through the (bbox-ignoring) statistics endpoint, index computed from
  // the band means. Same defect class as fetch_ndvi had.

  it('compute_spectral_index states the cloud masking it applied', async () => {
    const r = await executeTool('compute_spectral_index', CLEAR_AOI, { index: 'NDVI' })
    const mean = r.stats?.index_mean
    console.log(`spectral NDVI clear AOI → mean=${mean} :: ${r.summary.slice(0, 180).replace(/\s+/g, ' ')}`)
    if (typeof mean === 'number') {
      expect(mean).toBeGreaterThan(0)
      // The claim must name the masking, so the user can see it happened.
      expect(r.summary).toMatch(/cloud-masked|clear/i)
    } else {
      expect(r.summary.toLowerCase()).toMatch(/cloud/)
    }
  }, 300_000)

  it('compute_spectral_index never measures a cloud top — value or refusal, never −0.072', async () => {
    const r = await executeTool('compute_spectral_index', CLOUDY_AOI, { index: 'NDVI' })
    const mean = r.stats?.index_mean
    console.log(`spectral NDVI cloudy AOI → mean=${mean} :: ${r.summary.slice(0, 200).replace(/\s+/g, ' ')}`)
    if (typeof mean === 'number') {
      // Measured 2026-08-10 before the fix: −0.072 from the 2026-07-15 scene —
      // the identical cloud-top artefact ISS-101 documents for fetch_ndvi.
      // Cloud-masked ground truth for this AOI is ≈ +0.12.
      expect(mean).toBeGreaterThan(0)
    } else {
      expect(r.summary.toLowerCase()).toMatch(/cloud/)
    }
  }, 300_000)

  it('compute_spectral_index never labels its statistics bbox-clipped (ISS-102)', async () => {
    const r = await executeTool('compute_spectral_index', CLEAR_AOI, { index: 'NDWI' })
    console.log(`spectral NDWI → ${JSON.stringify(r.stats)}`)
    // The bbox path returned whole-scene numbers; no result may advertise it.
    expect(r.summary).not.toMatch(/AOI bbox/)
    if (r.layers[0]) expect((r.layers[0] as any).provenance?.clip).not.toBe('bbox')
  }, 300_000)

  // ── ISS-102 — WorldCover statistics must describe the AOI, not the COG tile ─
  // A WorldCover COG is a 3°×3° (~330 km) tile. Measured 2026-08-10 on CLOUDY_AOI
  // (inside Lahore): GET ?bbox= → majority Cropland, 3.8% built-up; POST cutline
  // → majority Built-up, 82.9%. Only the second is about the AOI.

  // ── ISS-010 — the temporal stack's per-acquisition NDVI series ────────────
  it('fetch_temporal_stack returns a cloud-masked NDVI value per acquisition, with gaps left as gaps', async () => {
    const r = await executeTool('fetch_temporal_stack', CLEAR_AOI, { months: 6 })
    const d = r.stats as any
    console.log(
      `temporal_stack → ${d?.ndvi_points} NDVI points, ${d?.ndvi_gaps} gaps, ` +
      `first=${d?.ndvi_first} last=${d?.ndvi_last} delta=${d?.ndvi_delta}`,
    )
    console.log('  series:', JSON.stringify(d?.ndvi_by_date))

    // The series must exist and carry real values over irrigated cropland.
    expect(d?.ndvi_points, 'no NDVI series produced').toBeGreaterThan(0)
    expect(Array.isArray(d?.ndvi_by_date)).toBe(true)
    expect(d.ndvi_by_date.length).toBe(d.ndvi_points)

    for (const pt of d.ndvi_by_date) {
      expect(pt.label).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      // A cloud top reads negative here; that is the artefact this must never show.
      expect(pt.value, `${pt.label} looks like cloud, not ground`).toBeGreaterThan(0)
      expect(pt.value).toBeLessThanOrEqual(1)
    }

    // Gaps are omitted from the series, never interpolated — so the counts must
    // reconcile against the scenes actually examined.
    // One point per DATE, not per STAC item — a single overpass returns several
    // tile items sharing a datetime (12 items / 6 dates, measured 2026-08-16).
    const labels = d.ndvi_by_date.map((p: any) => p.label)
    expect(new Set(labels).size, `duplicate dates in series: ${labels.join(",")}`).toBe(labels.length)
    if (d.ndvi_gaps > 0) expect(r.summary).toMatch(/left as gaps rather than interpolated/i)

    // The scene-wide series must not be presented as the AOI's cloud.
    expect(d.scene_cloud_by_date, 'scene-wide cloud must be labelled as such').toBeDefined()
    expect((d as any).cloud_by_date, 'the ambiguous key must be gone').toBeUndefined()
  }, 300_000)

  it('fetch_built_surface reports urban land cover for an urban AOI', async () => {
    const r = await executeTool('fetch_built_surface', CLOUDY_AOI, {})
    const d = r.stats
    console.log(`built_surface → built=${d?.built_up_pct}% dominant=${d?.dominant_class} :: ${r.summary.slice(0, 120).replace(/\s+/g, ' ')}`)
    expect(d?.built_up_pct, 'no built_up_pct returned').toBeTypeOf('number')
    // The whole-COG answer for this tile is 3.8% built-up / dominant Cropland.
    expect(Number(d!.built_up_pct)).toBeGreaterThan(40)
    expect(String(d!.dominant_class)).toBe('Built-up')
    expect((r.layers[0] as any)?.provenance?.clip).toBe('polygon')
  }, 300_000)
})
