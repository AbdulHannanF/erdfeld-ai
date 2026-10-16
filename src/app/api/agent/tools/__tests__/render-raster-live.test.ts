/** LIVE Q-60 check (opt-in: RASTER_LIVE=1, needs NODE_USE_ENV_PROXY=1 behind a proxy).
 *
 *    RASTER_LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run render-raster-live
 *
 *  Kasur, September 2026: the newest scenes (09-28) are cloud (B08 p2-p98 0.80-0.86); 09-23 is clear. */
import { describe, it, expect } from 'vitest'
import { executeTool } from '../index'

const suite = process.env.RASTER_LIVE ? describe : describe.skip

suite('render_raster clearest-scene pick (live)', () => {
  it('does not return a cloud-bright scene for Kasur 2026-09', async () => {
    const aoi = { type: 'Polygon', coordinates: [[[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]]] }
    const r = await executeTool('render_raster', aoi, { bands: ['B08'], start: '2026-09-01', end: '2026-09-30' })
    console.log(r.summary)
    const sd = r.stats!
    expect(sd.scene_date).not.toBe('2026-09-28')
    expect(Number(sd.p98)).toBeLessThan(0.6)
    expect(Number(sd.valid_pixel_pct)).toBeGreaterThan(40)
  }, 300_000)
})
