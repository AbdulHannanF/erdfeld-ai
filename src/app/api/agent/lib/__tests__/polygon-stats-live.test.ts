/**
 * LIVE polygon-clip verification (opt-in: RENDER_LIVE=1). Hits the network — NOT part
 * of the default suite. Proves the polygon-clipped mean differs from the bbox mean for
 * a non-rectangular AOI, and (ISS-102) that the bbox path is a real cutline rather than
 * titiler's `?bbox=`, which returns whole-COG statistics.
 *
 *   RENDER_LIVE=1 npx vitest run polygon-stats-live
 *   RENDER_LIVE=1 TITILER_ENDPOINT=http://localhost:8000 npx vitest run polygon-stats-live
 */
import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import {
  fetchCogBandStats,
  fetchCogPolygonStats,
  buildNdviClipPng,
  TITILER_BASE,
} from '../titiler'
import { pickAsset, S2_ASSET_KEYS } from '../stac'

const LIVE = !!process.env.RENDER_LIVE
const suite = LIVE ? describe : describe.skip

/** Central Nairobi bbox. */
const BBOX = [36.78, -1.32, 36.86, -1.24]

/** A triangle AOI inside the bbox — ~half the bbox area, so polygon stats must
 *  cover materially fewer pixels than the bbox stats. */
const TRIANGLE = {
  type: 'Polygon',
  coordinates: [[
    [36.78, -1.32],
    [36.86, -1.32],
    [36.78, -1.24],
    [36.78, -1.32],
  ]],
}

async function findS2Scene(bbox: number[]): Promise<any> {
  const res = await fetch('https://earth-search.aws.element84.com/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collections: ['sentinel-2-l2a'],
      bbox,
      datetime: '2025-01-01T00:00:00Z/2026-06-04T23:59:59Z',
      query: { 'eo:cloud_cover': { lt: 12 } },
      limit: 1,
      sortby: [{ field: 'properties.eo:cloud_cover', direction: 'asc' }],
    }),
  })
  expect(res.ok, `STAC search HTTP ${res.status}`).toBe(true)
  const fc = await res.json()
  return fc.features?.[0]
}

suite('LIVE HONESTY-001 — polygon stats differ from bbox stats (RENDER_LIVE=1)', () => {
  it(`uses TITILER_BASE = ${TITILER_BASE}`, () => {
     
    console.log('   → TITILER_BASE in use:', TITILER_BASE)
    expect(TITILER_BASE).toMatch(/^https?:\/\//)
  })

  it('per-band: polygon pixel count < bbox pixel count for a triangle AOI', async () => {
    const item = await findS2Scene(BBOX)
    expect(item, 'no Sentinel-2 scene found').toBeTruthy()
    const nirUrl = pickAsset(item, S2_ASSET_KEYS.B08)
    expect(nirUrl, 'no NIR asset').toBeTruthy()

    const bboxStats = await fetchCogBandStats(nirUrl!, BBOX)
    const polyStats = await fetchCogPolygonStats(nirUrl!, TRIANGLE)
     
    console.log(`   → NIR bbox count=${bboxStats?.count} mean=${bboxStats?.mean}  |  polygon count=${polyStats?.count} mean=${polyStats?.mean}`)

    expect(bboxStats?.mean, 'bbox mean missing').toBeTypeOf('number')
    expect(polyStats?.mean, 'polygon mean missing').toBeTypeOf('number')

    if (bboxStats?.count != null && polyStats?.count != null) {
      // The triangle is ~half the bbox → strictly fewer valid pixels.
      expect(polyStats.count).toBeLessThan(bboxStats.count)
    }
    // Means should differ (different pixel populations) — not a hard requirement on
    // magnitude, but they should not be byte-identical for a real heterogeneous scene.
    expect(polyStats!.mean).not.toBe(bboxStats!.mean)
  }, 120000)

  // ISS-102 regression, pinned to the live measurement of 2026-08-10.
  //
  // Before the fix, GET /cog/statistics?bbox= returned byte-identical statistics
  // for the AOI bbox and for a bbox 400 km away — mean 2678.7554216384888, count
  // 1 048 576 (a fixed 1024×1024 read of the entire COG) — because titiler ignores
  // the parameter. The rectangle-cutline POST cannot do that: a bbox outside the
  // scene footprint has no pixels at all.
  it('ISS-102: fetchCogBandStats distinguishes two different bboxes', async () => {
    const item = await findS2Scene(BBOX)
    expect(item, 'no Sentinel-2 scene found').toBeTruthy()
    const nirUrl = pickAsset(item, S2_ASSET_KEYS.B08)
    expect(nirUrl).toBeTruthy()

    // A quarter of the AOI bbox (south-west corner) vs the whole bbox.
    const midLng = (BBOX[0] + BBOX[2]) / 2
    const midLat = (BBOX[1] + BBOX[3]) / 2
    const quarter = [BBOX[0], BBOX[1], midLng, midLat]

    const [whole, part] = await Promise.all([
      fetchCogBandStats(nirUrl!, BBOX),
      fetchCogBandStats(nirUrl!, quarter),
    ])
    console.log(`   → whole bbox mean=${whole?.mean} count=${whole?.count}`)
    console.log(`   → quarter bbox mean=${part?.mean} count=${part?.count}`)

    expect(whole?.mean, 'whole-bbox mean missing').toBeTypeOf('number')
    expect(part?.mean, 'quarter-bbox mean missing').toBeTypeOf('number')
    // The old GET path returned the identical whole-COG number for both.
    expect(part!.mean).not.toBe(whole!.mean)
    expect(part!.count!).toBeLessThan(whole!.count!)
    // And never the fixed whole-COG read size.
    expect(whole!.count).not.toBe(1_048_576)
  }, 180000)

  it('ISS-102: a bbox outside the scene footprint yields no pixels, not a scene mean', async () => {
    const item = await findS2Scene(BBOX)
    const nirUrl = pickAsset(item, S2_ASSET_KEYS.B08)
    // ~4000 km from the Nairobi scene.
    const far = [10.0, 45.0, 10.05, 45.05]
    const stats = await fetchCogBandStats(nirUrl!, far)
    console.log(`   → far bbox → ${stats == null ? 'null' : `mean=${stats.mean} count=${stats.count}`}`)
    // Either null (no stats) or an explicitly empty read — never a real-looking mean.
    if (stats != null) expect(stats.count ?? 0).toBe(0)
  }, 180000)

  it('RENDER-004: buildNdviClipPng returns a PNG that is TRANSPARENT outside the triangle', async () => {
    const item = await findS2Scene(BBOX)
    expect(item).toBeTruthy()
    const b64 = await buildNdviClipPng(item, TRIANGLE, 256)
    expect(b64, 'cutline PNG null').toBeTruthy()

    const buf = Buffer.from(b64!, 'base64')
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const ch = info.channels // 4 (RGBA)
    const W = info.width, H = info.height
    const alphaAt = (x: number, y: number) => data[(y * W + x) * ch + (ch - 1)]

    // The TRIANGLE has vertices (36.79,-1.31),(36.85,-1.31),(36.79,-1.25) — a right
    // triangle filling the lower-left of its bbox. The TOP-RIGHT corner of the image
    // is OUTSIDE the triangle → must be transparent. The bottom-left is INSIDE.
    const topRight = alphaAt(W - 2, 1)
    const bottomLeft = alphaAt(1, H - 2)

    console.log(`   → cutline PNG ${W}x${H} ch=${ch}  alpha topRight=${topRight} bottomLeft=${bottomLeft}`)
    expect(topRight, 'outside-polygon corner should be transparent (no bbox bleed)').toBe(0)
    // somewhere inside should be opaque (real data rendered)
    let opaqueFound = false
    for (let y = 0; y < H && !opaqueFound; y += 8) {
      for (let x = 0; x < W; x += 8) { if (alphaAt(x, y) > 200) { opaqueFound = true; break } }
    }
    expect(opaqueFound, 'no opaque pixels — cutline produced an empty image').toBe(true)
  }, 120000)
})
