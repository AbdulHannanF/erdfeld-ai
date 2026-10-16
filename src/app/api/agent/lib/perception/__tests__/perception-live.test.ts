/**
 * LIVE Phase 2 gate (opt-in: PERCEPTION_LIVE=1).
 *
 *   PERCEPTION_LIVE=1 npx vitest run perception-live
 *
 * Real Esri imagery, real ONNX weights (81 MB, downloaded once), real inference,
 * driven through the real tool dispatcher. Nothing mocked but nothing.
 *
 * The spec's gate is *"find every car in this AOI returns real georeferenced
 * vectors"*. That is only half a test, because a pipeline that returns vectors
 * everywhere is exactly the failure mode this codebase keeps rediscovering — a
 * fallback that fires on every request looks like a feature that works. So the
 * gate is checked in BOTH directions against two AOIs whose imagery differs:
 *
 *   Manhattan  Esri serves z20 → a car is ~40 px → Tier A must return vectors.
 *   Lahore     Esri stops at z19 → a car is ~18 px → Tier A must REFUSE, and the
 *              report must say "not resolvable here", never "no cars here".
 *
 * Same query, same code, opposite answers, both correct. If either AOI produced
 * the other's answer the pipeline would be worthless, and no assertion here can
 * pass for both.
 */

import { describe, expect, beforeAll, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { executeTool } from '../../../tools'
import { fetchTileImage } from '../../cv'
import { isPlaceholderTile, metersPerPixel, planImagery } from '../imagery-plan'

const LIVE = !!process.env.PERCEPTION_LIVE
const suite = LIVE ? describe : describe.skip

/**
 * vitest does not read `.env`, so a live test needing a credential has to load it
 * deliberately. Doing it here rather than globally keeps the unit suite honest:
 * unit tests must pass with no credentials at all.
 */
function loadEnvFile(): void {
  const file = path.join(process.cwd(), '.env')
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}

/** ~250 m box over midtown Manhattan — Esri serves real z20 here. */
const MANHATTAN = {
  type: 'Polygon',
  coordinates: [[[-73.9865, 40.7535], [-73.9825, 40.7535], [-73.9825, 40.7565], [-73.9865, 40.7565], [-73.9865, 40.7535]]],
}
/** ~250 m box over central Lahore — Esri stops at z19 here. */
const LAHORE = {
  type: 'Polygon',
  coordinates: [[[74.3185, 31.5185], [74.3215, 31.5185], [74.3215, 31.5215], [74.3185, 31.5215], [74.3185, 31.5185]]],
}

function insideBbox(lon: number, lat: number, aoi: any): boolean {
  const ring = aoi.coordinates[0] as number[][]
  const lons = ring.map((c) => c[0])
  const lats = ring.map((c) => c[1])
  return (
    lon >= Math.min(...lons) - 1e-4 && lon <= Math.max(...lons) + 1e-4 &&
    lat >= Math.min(...lats) - 1e-4 && lat <= Math.max(...lats) + 1e-4
  )
}

suite('LIVE — Esri placeholder tile and escalation ceiling', () => {
  it('recognises the real placeholder tile served above the ceiling', async () => {
    // z22 over Lahore: measured 2026-08-10 as the 2,521-byte blank tile.
    const bytes = Buffer.from(await fetchTileImage(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/22/1747282/2946742',
    ))
    console.log(`   → z22 Lahore tile: ${bytes.length} bytes`)
    expect(isPlaceholderTile(bytes)).toBe(true)
  }, 120_000)

  it('does NOT flag a real tile as a placeholder', async () => {
    const bytes = Buffer.from(await fetchTileImage(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/19/213732/370380',
    ))
    console.log(`   → z19 Lahore tile: ${bytes.length} bytes`)
    expect(bytes.length).toBeGreaterThan(5000)
    expect(isPlaceholderTile(bytes)).toBe(false)
  }, 120_000)

  it('finds a HIGHER ceiling in Manhattan than in Lahore — the ceiling is per-location', async () => {
    const fetchTile = async (url: string) => Buffer.from(await fetchTileImage(url))
    const car = 4.5

    const nyc = await planImagery({ lat: 40.7549, lon: -73.9845, footprintM: car, minPx: 20, fetchTile })
    const lhr = await planImagery({ lat: 31.52, lon: 74.32, footprintM: car, minPx: 20, fetchTile })

    console.log(`   → Manhattan: ok=${nyc.ok} zoom=${nyc.zoom} mpp=${nyc.mpp?.toFixed(3)} objectPx=${nyc.objectPx?.toFixed(0)}`)
    console.log(`   → Lahore:    ok=${lhr.ok} ceiling=z${lhr.ceilingZoom} mpp=${lhr.ceilingMpp?.toFixed(3)}`)

    expect(nyc.ok).toBe(true)
    expect(nyc.zoom).toBe(20)
    expect(nyc.objectPx!).toBeGreaterThan(35)

    expect(lhr.ok).toBe(false)
    expect(lhr.ceilingZoom).toBe(19)
    expect(lhr.wouldNeed).toBeTruthy()
  }, 300_000)
})

suite('LIVE GATE — "find every car in this AOI"', () => {
  it('Manhattan: returns real georeferenced car vectors from Tier A', async () => {
    const res = await executeTool('detect_objects', MANHATTAN, { target: 'every car' })
    console.log(`\n--- Manhattan ---\n${res.summary}\n`)

    expect(res.stats?.tier_used).toBe('A')
    const count = Number(res.stats?.detection_count ?? 0)
    expect(count).toBeGreaterThan(0)

    // Real vectors, not a bbox rectangle or a placeholder.
    const features = res.layers[0]?.geojson?.features ?? []
    expect(features.length).toBe(count)
    for (const f of features) {
      expect(f.geometry.type).toBe('Polygon')
      const ring = f.geometry.coordinates[0]
      expect(ring).toHaveLength(5)
      const [lon, lat] = ring[0]
      expect(insideBbox(lon, lat, MANHATTAN)).toBe(true)
    }

    // The imagery actually used must be the fine one — this is what makes it work.
    expect(Number(res.stats?.object_px)).toBeGreaterThanOrEqual(32)
    expect(Number(res.stats?.imagery_m_per_px)).toBeLessThan(0.2)
    console.log(`   → ${count} cars, ${res.stats?.object_px} px each at ${res.stats?.imagery_m_per_px} m/px`)
  }, 600_000)

  it('Lahore: refuses, and says "not resolvable" — never "no cars here"', async () => {
    const res = await executeTool('detect_objects', LAHORE, { target: 'every car' })
    console.log(`\n--- Lahore ---\n${res.summary}\n`)

    expect(Number(res.stats?.detection_count ?? 0)).toBe(0)
    expect(res.layers).toHaveLength(0)

    // The whole point: the reason must be resolution, and the report must offer
    // what would work. An assertion that accepted "0 cars found" as well would
    // be worthless — that is the sentence this test exists to forbid.
    expect(res.summary).toMatch(/cannot resolve|not resolvable|spans only/i)
    expect(res.summary).toMatch(/what would work/i)
    expect(res.summary).not.toMatch(/no cars detected/i)

    // And it must name the measured ceiling rather than a guess.
    expect(res.summary).toMatch(/z19/)
  }, 600_000)

  it('a sub-metre target is refused everywhere, naming street-level imagery', async () => {
    const res = await executeTool('detect_objects', MANHATTAN, { target: 'utility poles' })
    console.log(`\n--- utility pole ---\n${res.summary}\n`)

    expect(Number(res.stats?.detection_count ?? 0)).toBe(0)
    expect(res.summary).toMatch(/cannot resolve|spans only/i)
    // Tier C should contribute the shadow reasoning rather than nothing at all.
    expect(res.summary).toMatch(/shadow/i)
  }, 600_000)

  it('the arithmetic behind the two verdicts is the measured ground resolution', () => {
    // Not a network test — it pins the numbers the two outcomes hinge on, so a
    // regression in the projection math fails loudly rather than silently
    // flipping a verdict.
    expect(metersPerPixel(40.7549, 20)).toBeCloseTo(0.1132, 3)
    expect(4.5 / metersPerPixel(40.7549, 20)).toBeGreaterThan(35)
    expect(metersPerPixel(31.52, 19)).toBeCloseTo(0.2545, 3)
    expect(4.5 / metersPerPixel(31.52, 19)).toBeLessThan(20)
  })
})

/**
 * LIVE ISS-110 — segment_feature must return the mask's OUTLINE, not its bbox.
 *
 * The defect returned a 5-coordinate rectangle while promising "the exact
 * boundary". "Returns a polygon" was true of the broken version, so the
 * assertions below are on the properties only a real outline has: many vertices,
 * not axis-aligned, and enclosing meaningfully less area than its own bbox.
 */
suite('LIVE ISS-110 — segment_feature returns a real outline', () => {
  beforeAll(loadEnvFile)

  it('outlines an aircraft at Schiphol with a non-rectangular ring', async () => {
    const aoi = {
      type: 'Polygon',
      coordinates: [[[4.7660, 52.3070], [4.7690, 52.3070], [4.7690, 52.3090], [4.7660, 52.3090], [4.7660, 52.3070]]],
    }
    const res = await executeTool('segment_feature', aoi, { lat: 52.30798, lon: 4.76733, label: 'aircraft' })
    console.log(`\n--- segment_feature ---\n${res.summary}\n`)

    expect(res.layers.length).toBeGreaterThan(0)
    const ring = res.layers[0]!.geojson.features[0].geometry.coordinates[0] as number[][]

    // The defect produced exactly 5; the real outline measured 400 (thinned from 642).
    expect(ring.length).toBeGreaterThan(50)
    expect(Number(res.stats?.vertices)).toBeGreaterThan(50)

    // Closed.
    expect(ring[0]).toEqual(ring[ring.length - 1])

    // Not a bounding box: a rectangle has exactly two distinct x and y values.
    const xs = new Set(ring.map((c) => c[0].toFixed(9)))
    const ys = new Set(ring.map((c) => c[1].toFixed(9)))
    expect(xs.size).toBeGreaterThan(2)
    expect(ys.size).toBeGreaterThan(2)

    // And it encloses real area, strictly less than its own bbox.
    const lons = ring.map((c) => c[0])
    const lats = ring.map((c) => c[1])
    const bboxArea = (Math.max(...lons) - Math.min(...lons)) * (Math.max(...lats) - Math.min(...lats))
    let shoelace = 0
    for (let i = 0; i < ring.length - 1; i++) {
      shoelace += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    }
    const area = Math.abs(shoelace / 2)
    expect(area).toBeGreaterThan(0)
    // Measured 2026-08-10 on this aircraft: 0.18. A bounding rectangle scores
    // exactly 1.0, so a regression to the ISS-110 behaviour cannot slip past
    // this threshold the way a lenient 0.95 would.
    expect(area).toBeLessThan(bboxArea * 0.5)

    console.log(`   → ${ring.length - 1} vertices, area/bbox = ${(area / bboxArea).toFixed(2)}, ${res.stats?.area_m2} m²`)
  }, 600_000)
})
