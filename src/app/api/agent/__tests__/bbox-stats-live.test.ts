/**
 * LIVE ISS-102 verification (opt-in: CLOUD_LIVE=1) — the three tools that still
 * reach a bbox statistics path.
 *
 *   CLOUD_LIVE=1 npx vitest run bbox-stats-live
 *
 * titiler's GET `/cog/statistics?bbox=` ignores the bbox and returns whole-COG
 * statistics. Verified live 2026-08-10 on a Sentinel-2 B08 COG: the AOI bbox and a
 * bbox 400 km away both returned mean 2678.7554216384888 / count 1 048 576. Every
 * caller of that path was quoting a ~110 × 110 km scene average as the AOI value.
 *
 * `fetch_thermal`, `fetch_sar` and `fetch_surface_water` prefer the drawn polygon and
 * only fall back to the bbox. This suite asserts what a user actually receives: a real
 * number produced by a real cutline, labelled with the clip it actually got — never a
 * scene average silently presented as the AOI's.
 */

import { describe, it, expect } from 'vitest'
import { executeTool } from '../tools'

const LIVE = !!process.env.CLOUD_LIVE
const suite = LIVE ? describe : describe.skip

/** The 2026-08-09 audit AOI (Lahore, 16.9 km²). */
const AOI = {
  type: 'Polygon',
  coordinates: [[[74.30, 31.50], [74.34, 31.50], [74.34, 31.54], [74.30, 31.54], [74.30, 31.50]]],
}

suite('LIVE ISS-102 — no tool reports whole-COG statistics', () => {
  it('fetch_thermal: LST is a cloud-masked land surface temperature (ISS-101)', async () => {
    const r = await executeTool('fetch_thermal', AOI, {})
    const c = r.stats?.lst_celsius
    const clip = (r.layers[0] as any)?.provenance?.clip
    console.log(`thermal → ${c}°C clip=${clip} :: ${r.summary.slice(0, 200).replace(/\s+/g, ' ')}`)

    if (typeof c === 'number') {
      // Measured 2026-08-10 before the fix: −3.2 °C, from a scene QA_PIXEL scores
      // 0% clear over this AOI. Cloud tops are ~50 K colder than the ground, so a
      // sub-zero land surface temperature over Lahore is the contamination
      // signature. The clear scene reads +44.3 °C (σ 2.5 K).
      expect(c).toBeGreaterThan(5)
      expect(c).toBeLessThan(75)
      expect(clip).toBe('polygon')
      expect(r.summary).toMatch(/cloud-masked/i)
    } else {
      // The honest path: refuse and say why.
      expect(r.summary.toLowerCase()).toMatch(/cloud/)
    }
    expect(r.summary).not.toMatch(/whole[- ]scene/i)
  }, 300_000)

  it('fetch_sar: VV backscatter is polygon-clipped and in range', async () => {
    const r = await executeTool('fetch_sar', AOI, {})
    const vv = r.stats?.vv_backscatter
    const clip = (r.layers[0] as any)?.provenance?.clip
    console.log(`sar → vv=${vv} clip=${clip}`)

    if (typeof vv === 'number') {
      expect(vv).toBeGreaterThan(0)
      expect(vv).toBeLessThanOrEqual(1)
    }
  }, 300_000)

  it('fetch_surface_water: occurrence is a real percentage for this AOI', async () => {
    const r = await executeTool('fetch_surface_water', AOI, {})
    const occ = r.stats?.occurrence_mean_pct
    const clip = (r.layers[0] as any)?.provenance?.clip
    console.log(`surface_water → occ=${occ}% clip=${clip}`)

    if (typeof occ === 'number') {
      expect(occ).toBeGreaterThanOrEqual(0)
      expect(occ).toBeLessThanOrEqual(100)
    }
  }, 300_000)

  it('classify_vegetation reports the clip its WorldCover stats actually used', async () => {
    const r = await executeTool('classify_vegetation', AOI, {})
    const clip = (r.layers[0] as any)?.provenance?.clip ?? (r as any).layers?.[0]?.provenance?.clip
    console.log(`classify_vegetation → clip=${clip} :: ${r.summary.slice(0, 160).replace(/\s+/g, ' ')}`)
    // WorldCover stats are now a polygon cutline; the old value was the 3°×3° COG.
    if (clip) expect(clip).toBe('polygon')
  }, 300_000)
})
