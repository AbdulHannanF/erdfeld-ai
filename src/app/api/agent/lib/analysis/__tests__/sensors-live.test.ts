/**
 * Phase 4 GATE — a multi-decade change vector, live (opt-in: TEMPORAL_LIVE=1).
 *
 *   TEMPORAL_LIVE=1 npx vitest run sensors-live
 *
 * The spec's gate for Phase 4 is "multi-decade change vectors". This measures
 * one against the real archive: the eastern basin of the Aral Sea, which was
 * open water in 1990 and dry lakebed by 2020 — a change no model needs to
 * interpret and no reader can mistake.
 *
 * Both dates are read from the SAME sensor at the SAME explicit grid, because
 * mixing Sentinel-2 and Landsat would report the instrument as change (see the
 * offsets in `sensors.ts`). For a 1990 endpoint that means Landsat for both.
 */

import { describe, it, expect } from 'vitest'
import {
  pickSensorForPair,
  readSensorIndexGrid,
  searchSensor,
  type SensorGrid,
  type SensorSpec,
} from '../sensors'

const LIVE = !!process.env.TEMPORAL_LIVE
const suite = LIVE ? describe : describe.skip

/** Eastern basin of the South Aral Sea — open water in 1990, desert by 2020. */
const ARAL = {
  type: 'Polygon',
  coordinates: [[[59.90, 45.10], [60.10, 45.10], [60.10, 45.28], [59.90, 45.28], [59.90, 45.10]]],
}
const ARAL_BBOX: [number, number, number, number] = [59.90, 45.10, 60.10, 45.28]

const GRID = 128

function mean(g: SensorGrid): number {
  let s = 0, n = 0
  for (let i = 0; i < g.values.length; i++) if (g.valid[i]) { s += g.values[i]; n++ }
  return n ? s / n : NaN
}

/** Fraction of in-polygon pixels whose index exceeds a threshold. */
function pctAbove(g: SensorGrid, t: number): number {
  let hit = 0, n = 0
  for (let i = 0; i < g.values.length; i++) if (g.valid[i]) { n++; if (g.values[i] > t) hit++ }
  return n ? (hit / n) * 100 : 0
}

/** Newest scene in the window that comes back mostly clear over the polygon. */
async function clearestIn(
  sensor: SensorSpec, index: string, window: string,
): Promise<SensorGrid> {
  const items = await searchSensor(sensor, ARAL_BBOX, window, 12)
  if (items.length === 0) throw new Error(`no ${sensor.id} scenes in ${window}`)
  const tried: string[] = []
  let best: SensorGrid | null = null
  for (const item of items.slice(0, 8)) {
    const out = await readSensorIndexGrid({ sensor, item, index, aoi: ARAL, width: GRID, height: GRID })
    if (!out.ok) { tried.push(`${item.id}: ${out.message.slice(0, 60)}`); continue }
    const clearPct = (out.grid.clearPixels / Math.max(1, out.grid.insidePolygon)) * 100
    tried.push(`${out.grid.sceneDate} ${clearPct.toFixed(0)}% clear`)
    if (clearPct >= 80) return out.grid
    if (!best || out.grid.clearPixels > best.clearPixels) best = out.grid
  }
  if (best && best.clearPixels / Math.max(1, best.insidePolygon) >= 0.5) return best
  throw new Error(`no usable ${sensor.id} scene in ${window}. Tried:\n  ${tried.join('\n  ')}`)
}

suite('Phase 4 GATE — multi-decade change over the Aral Sea', () => {
  it('reads 1990 and 2020 from ONE sensor on ONE grid, and sees water become desert', async () => {
    const choice = pickSensorForPair('1990-08-01', '2020-08-01', 'NDWI')
    expect(choice.ok, choice.ok ? '' : (choice as any).message).toBe(true)
    if (!choice.ok) return
    console.log('sensor:', choice.sensor.label, `${choice.sensor.nativeResM} m`)
    console.log('reason:', choice.reason.split('—')[1]?.trim().slice(0, 90))
    // A 1990 endpoint cannot come from Sentinel-2, so BOTH dates must be Landsat.
    expect(choice.sensor.id).toBe('landsat-c2-l2')

    const before = await clearestIn(choice.sensor, 'NDWI', '1990-06-01/1990-09-30')
    const after = await clearestIn(choice.sensor, 'NDWI', '2020-06-01/2020-09-30')

    const wBefore = pctAbove(before, 0)   // NDWI > 0 is water
    const wAfter = pctAbove(after, 0)
    console.log(`before ${before.sceneDate}: NDWI mean ${mean(before).toFixed(3)}, water ${wBefore.toFixed(1)}%, ` +
      `${before.clearPixels}/${before.insidePolygon} clear px`)
    console.log(`after  ${after.sceneDate}: NDWI mean ${mean(after).toFixed(3)}, water ${wAfter.toFixed(1)}%, ` +
      `${after.clearPixels}/${after.insidePolygon} clear px`)
    console.log(`CHANGE VECTOR: NDWI ${mean(before).toFixed(3)} → ${mean(after).toFixed(3)} ` +
      `(Δ ${(mean(after) - mean(before)).toFixed(3)}), water ${wBefore.toFixed(0)}% → ${wAfter.toFixed(0)}%`)

    // Identical explicit grids — this is what makes the difference per-pixel
    // rather than a comparison of two differently-shaped reads (ISS-126).
    expect(before.width).toBe(GRID); expect(before.height).toBe(GRID)
    expect(after.width).toBe(GRID); expect(after.height).toBe(GRID)
    expect(before.sensor.id).toBe(after.sensor.id)

    // The measurement: open water in 1990, essentially none in 2020.
    expect(wBefore, 'the 1990 basin should read as water').toBeGreaterThan(60)
    expect(wAfter, 'the 2020 basin should have lost its water').toBeLessThan(25)
    expect(mean(before)).toBeGreaterThan(mean(after))
    expect(mean(before) - mean(after)).toBeGreaterThan(0.15)
  }, 900_000)

  it('END TO END: analyze_raster answers a 30-year change vector through the dispatcher', async () => {
    const { executeTool } = await import('../../../tools')
    const r = await executeTool('analyze_raster', ARAL, {
      operation: 'change', index: 'NDWI', date: '1990-08-01', date2: '2020-08-01',
    })
    const d = r.stats as any
    console.log('summary:', r.summary.replace(/\s+/g, ' ').slice(0, 300))
    console.log('data:', JSON.stringify({
      sensor: d?.sensor, res: d?.sensor_resolution_m, before: d?.date_before, after: d?.date_after,
      mean_delta: d?.mean_delta, decreased_pct: d?.decreased_pct, px: d?.pixels_clear_both,
    }))

    expect(r.summary, r.summary).not.toMatch(/Real data unavailable/)
    // Both endpoints from the deeper archive — never a 10 m/30 m mix.
    expect(d.sensor).toMatch(/Landsat/)
    expect(d.sensor_resolution_m).toBe(30)
    expect(String(d.date_before).startsWith('199')).toBe(true)
    expect(String(d.date_after).startsWith('20')).toBe(true)
    // Water disappearing is a large NEGATIVE NDWI change over most of the AOI.
    expect(d.mean_delta).toBeLessThan(-0.15)
    expect(d.decreased_pct).toBeGreaterThan(80)
    expect(d.pixels_clear_both).toBeGreaterThan(1000)
    // The answer must say which instrument it used and why one covers both.
    expect(r.summary).toMatch(/Landsat/)
    expect(r.layers.length, 'a change raster should be attached').toBeGreaterThan(0)
    expect((r.layers[0] as any).provenance.clip).toBe('polygon')
  }, 900_000)

  it('per-pixel change is computed only where BOTH dates are clear', async () => {
    const choice = pickSensorForPair('1990-08-01', '2020-08-01', 'NDWI')
    if (!choice.ok) throw new Error(choice.message)
    const before = await clearestIn(choice.sensor, 'NDWI', '1990-06-01/1990-09-30')
    const after = await clearestIn(choice.sensor, 'NDWI', '2020-06-01/2020-09-30')

    let both = 0, dried = 0
    for (let i = 0; i < before.values.length; i++) {
      if (!before.valid[i] || !after.valid[i]) continue
      both++
      if (before.values[i] > 0 && after.values[i] <= 0) dried++
    }
    console.log(`both-clear pixels: ${both} of ${GRID * GRID}; water→land: ${dried} (${((dried / both) * 100).toFixed(1)}%)`)
    expect(both, 'no pixel was clear in both dates').toBeGreaterThan(1000)
    // A difference measured where one date is cloud is not change.
    expect(both).toBeLessThanOrEqual(Math.min(before.clearPixels, after.clearPixels))
    expect(dried / both).toBeGreaterThan(0.5)
  }, 900_000)
})
