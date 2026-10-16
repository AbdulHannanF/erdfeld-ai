/** map_flood — "what went under water, and what was hit", from Sentinel-1 radar.
 *
 *  Open water is dark, smooth backscatter and radar sees through monsoon cloud, so the
 *  boundary is sharper than optical water indices give in flood season. Method:
 *
 *    scenes   Planetary Computer sentinel-1-rtc (gamma-nought, 10 m). Explicit dates pick
 *             the scene nearest each date (same relative orbit as the after-scene where
 *             possible). A window scans every scene over the AOI, charts water fraction
 *             per scene, takes the peak as "after" and the nearest earlier dry scene on
 *             the same orbit as "before".
 *    water    VV dB -> 3x3 median -> ONE threshold for the whole comparison (Otsu on the pooled
 *             AOI histogram, clamped to -23..-15 dB, -18 dB when the histogram is not bimodal)
 *             -> 1 px open+close.
 *    flood    water(after) AND NOT water(before); permanent = both; receded = before only.
 *    vectors  lib/vectorize (holes kept, min area 1 000 m2 default).
 *    impact   Overture buildings whose footprint centroid is inside a flood polygon;
 *             Overture road length inside flood polygons.
 */

import turfArea from '@turf/area'
import { validateVegaLite } from '../lib/chart-data'
import { chooseMaxSize } from '../lib/digitize/scene-grid'
import { geomBboxOf } from '../lib/cloud'
import { buildPolygonIndex, buildingsInFlood, floodedRoadLength } from '../lib/flood/impact'
import {
  CHANGE, chooseWaterThreshold, classifyChange, classMask, cleanMask, medianFilter3, openMask, resampleNearest, waterFraction, waterMask,
  type ThresholdChoice,
} from '../lib/flood/sar'
import {
  DAY_MS, MIN_COVERAGE_PCT, dayMs, footprintCoverage, groupScenes, mapLimit, nearestLike, nearestScene, pickPair, readSceneDb, sarTileUrl, sceneLabel,
  searchS1Rtc, type DbRead, type PairChoice, type Polarization, type S1Scene, type SeriesPoint,
} from '../lib/flood/scenes'
import { withDeadline } from '../lib/deadline'
import { genId } from '../lib/geometry'
import { getLogger } from '../lib/logger'
import { toGeometry } from '../lib/pixels'
import { readOvertureTheme } from '../lib/registry/readers/overture'
import { makeGeoref, vectorizeLabels } from '../lib/vectorize'
import type { ChartItem } from '@/lib/chart-spec'
import type { RasterDescriptor } from '@/lib/raster-style'
import type { VectorStyle } from '@/lib/vector-style'
import type { Confidence, Provenance, ResultLayer, SummaryDatum, ToolCtx, ToolOutput } from '../lib/types'

const log = getLogger('agent/flood')

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const fmt = (v: number, d = 1) => v.toLocaleString('en-US', { maximumFractionDigits: d })

/** Target pixel and the cap on the longest edge of the analysis grid. */
const TARGET_GSD_M = 10
/** Memory budget for the full-resolution stage (two scenes plus their masks, vectors and the sensitivity
 *  re-runs). The longest edge of the grid is derived from it, so the footprint is a stated number rather than
 *  whatever the AOI happens to need. FLOOD_BYTES_PER_PIXEL is the measured working set per grid pixel
 *  (scripts/perf/flood-memory.mts), not a guess. */
const FULL_GRID_BUDGET_BYTES = 80 * 1024 * 1024
const FLOOD_BYTES_PER_PIXEL = 64
const MAX_GRID = Math.min(1000, Math.floor(Math.sqrt(FULL_GRID_BUDGET_BYTES / FLOOD_BYTES_PER_PIXEL)))
/** Budget for the coarse scan of a window: one Float32 dB grid per scene is kept until the pair is chosen. */
const SCAN_BUDGET_BYTES = 24 * 1024 * 1024
const MIN_SCAN_GRID = 64
/** An AOI that would need a coarser grid than this is refused: the boundary would no longer be "sharp". */
const MAX_GSD_M = 40
const MAX_SCENES = 60
const READ_CONCURRENCY = 3
/** Explicit dates: how far from the requested day a scene may be. */
const DATE_SLACK_DAYS = 15
/** Share of the AOI a scene's footprint must contain to be a candidate in explicit-date mode. */
const FOOTPRINT_MIN_COVERAGE = 0.9
const DEFAULT_MIN_AREA_M2 = 1000
const MAX_FLOOD_POLYGONS = 5000
/** Memory guard on the Overture read. Deliberately well above a city AOI's building count: a lower cap
 *  would test an arbitrary subset (the first rows of the file), which biases the affected count low. */
export const MAX_BUILDINGS_READ = 250_000
const MAX_ROAD_SEGMENTS = 150_000
/** Footprints are drawn up to this many; beyond it the layer carries centroid points. */
const MAX_BUILDING_FOOTPRINTS = 5000
const MAX_BUILDING_POINTS = 20_000
/** Each Overture read (buildings, roads) may take this long. The flood extent is already measured by then, so a slow
 *  parquet host costs the impact figures, which are reported as not counted, never the whole answer. */
const OVERTURE_READ_MS = 40_000

const FLOOD_COLOR = '#1d4ed8'
const PERM_COLOR = '#7dd3fc'
const BUILDING_COLOR = '#dc2626'

function unavailable(message: string): ToolOutput {
  return { summary: `Real data unavailable: ${message}` }
}

/** The upstream could not be reached or read: a fetch failure, not an absence of data. */
function unreachable(message: string): ToolOutput {
  return { ...unavailable(message), failed: true }
}

const round5 = (v: number) => Math.round(v * 1e5) / 1e5
function roundCoords(node: any): any {
  return typeof node?.[0] === 'number' ? [round5(node[0]), round5(node[1])] : node.map(roundCoords)
}

function wrapAoiGeom(bbox: number[]) {
  return { type: 'Polygon', coordinates: [[[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]], [bbox[0], bbox[1]]]] }
}

interface ReadScene { scene: S1Scene; db: Float32Array; width: number; height: number; coveragePct: number }
interface SceneSet { loaded: ReadScene[]; width: number; height: number; gridGeo: ReturnType<typeof makeGeoref> }

/** Longest edge of the scan grid: shrinks as the number of scenes grows so the kept dB grids fit SCAN_BUDGET_BYTES. */
export function scanMaxSize(fullMaxSize: number, sceneCount: number): number {
  const fit = Math.floor(Math.sqrt(SCAN_BUDGET_BYTES / (4 * Math.max(1, sceneCount))))
  return Math.max(Math.min(MIN_SCAN_GRID, fullMaxSize), Math.min(fullMaxSize, fit))
}

/** Reads scenes with bounded concurrency. Each scene is turned into its median-filtered dB grid the moment it
 *  arrives, so the raw read (Float64 values + mask) is garbage as soon as it is processed. Returns null when no
 *  scene could be read. Scenes that fail, or whose grid differs from the first one's, are appended to `failed`. */
async function readSceneSet(
  scenes: S1Scene[],
  maxSize: number,
  o: { geom: any; bbox: [number, number, number, number]; pol: Polarization; aoiKm2: number; failed: Array<{ scene: S1Scene; reason: string }> },
): Promise<SceneSet | null> {
  let ref: { width: number; height: number; gridGeo: ReturnType<typeof makeGeoref>; aoiPx: number } | null = null
  const out = await mapLimit(scenes, READ_CONCURRENCY, async (scene): Promise<ReadScene | null> => {
    let r: DbRead
    try {
      r = await readSceneDb(scene, o.geom, maxSize, o.pol)
    } catch (err: any) {
      o.failed.push({ scene, reason: err?.message ?? 'read failed' })
      return null
    }
    if (!ref) {
      const gridGeo = makeGeoref(o.bbox, r.width, r.height)
      ref = { width: r.width, height: r.height, gridGeo, aoiPx: Math.max(1, (o.aoiKm2 * 1e6) / gridGeo.pixelAreaM2) }
    }
    // Passes cut at slightly different frames can differ by a pixel row; more than that is a different grid.
    if (Math.abs(r.width - ref.width) > 2 || Math.abs(r.height - ref.height) > 2) {
      o.failed.push({ scene, reason: `grid ${r.width}x${r.height} differs from ${ref.width}x${ref.height}` })
      return null
    }
    const db = medianFilter3(resampleNearest(r.db, r.width, r.height, ref.width, ref.height), ref.width, ref.height)
    let valid = 0
    for (let k = 0; k < db.length; k++) if (db[k] === db[k]) valid++
    return { scene, db, width: ref.width, height: ref.height, coveragePct: Math.min(100, (valid / ref.aoiPx) * 100) }
  })
  const base = ref as { width: number; height: number; gridGeo: ReturnType<typeof makeGeoref> } | null
  if (!base) return null
  const loaded = out.filter((x): x is ReadScene => x != null)
  if (loaded.length === 0) return null
  return { loaded, width: base.width, height: base.height, gridGeo: base.gridGeo }
}

/** Series chart: water fraction per scene with the chosen before / after marked. */
function buildSeriesChart(points: SeriesPoint[], beforeKey: string, afterKey: string, thresholdDb: number): ChartItem | null {
  const rows = points.filter((p) => p.fraction != null).map((p) => ({
    date: p.scene.date,
    water_pct: Number((p.fraction! * 100).toFixed(2)),
    role: p.scene.key === afterKey ? 'After (flood peak)' : p.scene.key === beforeKey ? 'Before (dry)' : 'Other scene',
    orbit: `${p.scene.orbit}${p.scene.relativeOrbit != null ? ` #${p.scene.relativeOrbit}` : ''}`,
  }))
  if (rows.length < 2) return null
  const domain = ['After (flood peak)', 'Before (dry)', 'Other scene']
  const range = [FLOOD_COLOR, '#d97706', '#94a3b8']
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    data: { values: rows },
    layer: [
      { mark: { type: 'line', color: '#cbd5e1', strokeWidth: 1 }, encoding: { x: { field: 'date', type: 'temporal' }, y: { field: 'water_pct', type: 'quantitative' } } },
      {
        mark: { type: 'point', filled: true, size: 70, opacity: 1 },
        encoding: {
          x: { field: 'date', type: 'temporal', axis: { title: null, format: '%b %d' } },
          y: { field: 'water_pct', type: 'quantitative', axis: { title: `Water share of AOI (%) at ${thresholdDb.toFixed(1)} dB` }, scale: { zero: true } },
          color: { field: 'role', type: 'nominal', scale: { domain, range }, legend: { title: null } },
          tooltip: [
            { field: 'date', type: 'temporal', title: 'Date' }, { field: 'water_pct', type: 'quantitative', title: 'Water %' },
            { field: 'orbit', title: 'Orbit' }, { field: 'role', title: 'Role' },
          ],
        },
      },
    ],
  }
  const v = validateVegaLite(spec)
  if (!v.ok) {
    log.warn({ error: v.error }, 'flood series chart rejected')
    return null
  }
  return { id: `chart-${genId()}`, title: 'Sentinel-1 water fraction per scene (before and after marked)', spec }
}

export async function mapFlood(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const geom = toGeometry(ctx.aoi)
  if (!geom) return unavailable('map_flood needs a polygon AOI (draw a polygon, rectangle, or circle).')
  const bbox = geomBboxOf(geom)
  const sizing = chooseMaxSize(geom, TARGET_GSD_M, MAX_GRID)
  if (!bbox || !sizing) return unavailable('the AOI polygon has no usable extent.')
  if (sizing.gsdM > MAX_GSD_M) {
    return unavailable(
      `the AOI is ${fmt(Math.max(...sizing.extentM) / 1000, 0)} km across, which would need ${sizing.gsdM.toFixed(0)} m pixels ` +
      `(limit ${MAX_GSD_M} m) for a ${MAX_GRID}-pixel grid. Draw a smaller area so the flood edge stays sharp.`,
    )
  }

  // ---- arguments (dates and polarization are validated by the operation's contract) --------
  const pol: Polarization = args.polarization ?? 'VV'
  const minAreaM2 = Number.isFinite(Number(args.min_area_m2)) && Number(args.min_area_m2) >= 0 ? Number(args.min_area_m2) : DEFAULT_MIN_AREA_M2
  const wantRoads = args.include_roads !== false

  const explicit = typeof args.before === 'string' && typeof args.after === 'string'
  const endDay: string = args.end ?? (typeof args.after === 'string' ? isoDay(dayMs(args.after) + 3 * DAY_MS) : isoDay(Date.now()))
  const startDay: string = args.start ?? (typeof args.before === 'string' ? args.before : isoDay(dayMs(endDay) - 120 * DAY_MS))
  if (!explicit && dayMs(startDay) >= dayMs(endDay)) return unavailable('`start` must be earlier than `end`.')

  const centre = { lng: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 }
  const aoiKm2 = turfArea({ type: 'Feature', properties: {}, geometry: geom } as any) / 1e6

  // ---- 1. scenes --------------------------------------------------------------
  let scenesToRead: S1Scene[]
  let windowLabel: string
  let explicitPick: { before: S1Scene; after: S1Scene } | null = null
  if (explicit) {
    ctx.emit?.('token', { type: 'token', content: `Searching Sentinel-1 RTC scenes near ${args.before} and ${args.after}...\n` })
    const [sa, sb] = await Promise.all([
      searchS1Rtc(bbox, isoDay(dayMs(args.after) - DATE_SLACK_DAYS * DAY_MS), isoDay(dayMs(args.after) + DATE_SLACK_DAYS * DAY_MS)),
      searchS1Rtc(bbox, isoDay(dayMs(args.before) - DATE_SLACK_DAYS * DAY_MS), isoDay(dayMs(args.before) + DATE_SLACK_DAYS * DAY_MS)),
    ])
    if (!sa.ok) return unreachable(sa.message)
    if (!sb.ok) return unreachable(sb.message)
    // A scene whose swath only clips a small AOI is not a candidate while another pass covers it fully.
    const coverageOf = new Map<string, number | null>()
    const full = (scenes: S1Scene[]) => {
      const withCov = scenes.map((s) => { const c = footprintCoverage(s, geom); coverageOf.set(s.key, c); return { s, c } })
      const good = withCov.filter((x) => x.c == null || x.c >= FOOTPRINT_MIN_COVERAGE).map((x) => x.s)
      return good
    }
    const afterAll = groupScenes(sa.items, centre)
    const afterScene = nearestScene(full(afterAll), args.after)
    if (!afterScene) {
      return unavailable(afterAll.length
        ? `no Sentinel-1 RTC scene within ${DATE_SLACK_DAYS} days of ${args.after} covers this AOI: the best footprint covers ${Math.round(100 * Math.max(...afterAll.map((s) => coverageOf.get(s.key) ?? 0)))}% of it (the swath edge cuts it). Draw the area a little away from the swath edge or pick other dates.`
        : `no Sentinel-1 RTC scene covers this AOI within ${DATE_SLACK_DAYS} days of ${args.after}.`)
    }
    const beforeAll = groupScenes(sb.items, centre).filter((s) => dayMs(s.date) < dayMs(afterScene.date))
    const beforeScene = nearestLike(full(beforeAll), args.before, afterScene)
    if (!beforeScene) {
      return unavailable(beforeAll.length
        ? `no Sentinel-1 RTC scene within ${DATE_SLACK_DAYS} days of ${args.before} covers this AOI: the best footprint covers ${Math.round(100 * Math.max(...beforeAll.map((s) => coverageOf.get(s.key) ?? 0)))}% of it. Draw the area a little away from the swath edge or pick other dates.`
        : `no Sentinel-1 RTC scene covers this AOI within ${DATE_SLACK_DAYS} days of ${args.before}.`)
    }
    explicitPick = { before: beforeScene, after: afterScene }
    scenesToRead = [beforeScene, afterScene]
    windowLabel = `${args.before} and ${args.after}`
  } else {
    ctx.emit?.('token', { type: 'token', content: `Scanning Sentinel-1 RTC scenes over the AOI, ${startDay} to ${endDay}...\n` })
    const found = await searchS1Rtc(bbox, startDay, endDay)
    if (!found.ok) return unreachable(found.message)
    scenesToRead = groupScenes(found.items, centre)
    windowLabel = `${startDay} to ${endDay}`
    if (scenesToRead.length === 0) return unavailable(`no Sentinel-1 RTC scene covers this AOI in ${windowLabel}.`)
    if (scenesToRead.length < 2) return unavailable(`only one Sentinel-1 RTC scene covers this AOI in ${windowLabel}; a flood needs a before and an after. Widen the window.`)
    if (scenesToRead.length > MAX_SCENES) {
      return unavailable(`${scenesToRead.length} Sentinel-1 scenes fall in ${windowLabel} (limit ${MAX_SCENES}); narrow the window.`)
    }
  }

  // ---- 2. pixels --------------------------------------------------------------
  // Memory is bounded and does NOT grow with the number of scenes. A window is scanned at a coarse grid sized
  // from SCAN_BUDGET_BYTES (every scene kept as one small dB grid, only long enough to pick the pair), then
  // ONLY the chosen before and after scenes are read at the full grid. Holding a full-resolution grid per
  // scene (60 x ~10 MB with its masks) is what ran the 1 GiB container out of heap.
  const failed: Array<{ scene: S1Scene; reason: string }> = []
  const ctxRead = { geom, bbox, pol, aoiKm2, failed }
  let series: SeriesPoint[]
  let seriesThresholdDb: number | null = null
  let scanGsdM: number | null = null
  let scannedCount: number
  let windowPair: PairChoice | null = null
  if (!explicitPick) {
    const scanSize = scanMaxSize(sizing.maxSize, scenesToRead.length)
    scanGsdM = (sizing.gsdM * sizing.maxSize) / scanSize
    ctx.emit?.('token', { type: 'token', content: `Scanning ${scenesToRead.length} Sentinel-1 ${pol} scene(s) at ~${scanGsdM.toFixed(0)} m to find the flood peak...
` })
    let scan: SceneSet | null = await readSceneSet(scenesToRead, scanSize, ctxRead)
    if (!scan) {
      return unreachable(`titiler could not read any Sentinel-1 scene (${failed[0]?.reason ?? 'unknown error'}). The public titiler.xyz instance is rate-limited, so retry shortly.`)
    }
    const usableScan = scan.loaded.filter((s) => s.coveragePct >= MIN_COVERAGE_PCT)
    if (usableScan.length < 2) return unavailable(`fewer than two Sentinel-1 scenes observed at least ${MIN_COVERAGE_PCT}% of the AOI in ${windowLabel}.`)
    seriesThresholdDb = chooseWaterThreshold(usableScan.map((s) => s.db)).thresholdDb
    series = scan.loaded.map((s) => {
      const wm = cleanMask(waterMask(s.db, seriesThresholdDb!), scan!.width, scan!.height)
      return { scene: s.scene, fraction: waterFraction(wm, s.db), coveragePct: s.coveragePct }
    })
    scannedCount = scan.loaded.length
    scan = null // release every scan grid before the full-resolution read
    const picked = pickPair(series, { after: args.after, before: args.before })
    if ('error' in picked) return unavailable(`${picked.error}.`)
    windowPair = picked
    scenesToRead = [picked.before.scene, picked.after.scene]
  } else {
    series = []
    scannedCount = scenesToRead.length
  }

  ctx.emit?.('token', { type: 'token', content: `Reading ${scenesToRead.length} Sentinel-1 ${pol} scene(s) at ~${sizing.gsdM.toFixed(0)} m...
` })
  const fine = await readSceneSet(scenesToRead, sizing.maxSize, ctxRead)
  if (!fine) {
    return unreachable(`titiler could not read any Sentinel-1 scene (${failed[0]?.reason ?? 'unknown error'}). The public titiler.xyz instance is rate-limited, so retry shortly.`)
  }
  const { loaded, width: W, height: H, gridGeo } = fine
  const px = W * H

  // ---- 3. one threshold for the comparison -------------------------------------
  const usable = loaded.filter((s) => s.coveragePct >= MIN_COVERAGE_PCT)
  if (usable.length < 2) {
    return unavailable(`the chosen Sentinel-1 scenes do not both cover at least ${MIN_COVERAGE_PCT}% of the AOI (${loaded.map((s) => `${s.scene.date}: ${s.coveragePct.toFixed(0)}%`).join(', ') || 'none could be read'}${failed.length ? `; unreadable: ${failed.map((f) => `${f.scene.date} (${f.reason})`).join('; ')}` : ''}).`)
  }
  const threshold: ThresholdChoice = chooseWaterThreshold(usable.map((s) => s.db))
  const thr = threshold.thresholdDb

  const waterByKey = new Map<string, Uint8Array>()
  const fineSeries: SeriesPoint[] = loaded.map((s) => {
    const wm = cleanMask(waterMask(s.db, thr), W, H)
    waterByKey.set(s.scene.key, wm)
    return { scene: s.scene, fraction: waterFraction(wm, s.db), coveragePct: s.coveragePct }
  })
  const dbByKey = new Map(loaded.map((s) => [s.scene.key, s.db]))

  // ---- 4. before / after ------------------------------------------------------
  let pair: PairChoice | { error: string }
  if (explicitPick || windowPair) {
    const want = explicitPick ?? { before: windowPair!.before.scene, after: windowPair!.after.scene }
    const b = fineSeries.find((p) => p.scene.key === want.before.key)
    const a = fineSeries.find((p) => p.scene.key === want.after.key)
    if (!a || !b) return unavailable(`could not read the chosen scene(s): ${failed.map((f) => `${f.scene.date} (${f.reason})`).join('; ')}.`)
    if (windowPair) pair = { ...windowPair, before: b, after: a }
    else {
      const sameOrbit = b.scene.relativeOrbit != null && b.scene.relativeOrbit === a.scene.relativeOrbit
      const sameDir = b.scene.orbit !== 'unknown' && b.scene.orbit === a.scene.orbit
      pair = {
        before: b, after: a, match: sameOrbit ? 'orbit' : sameDir ? 'direction' : 'any',
        how: `explicit dates: after = scene nearest ${args.after}; before = the scene nearest ${args.before} on ${sameOrbit ? 'the same relative orbit' : sameDir ? 'the same flight direction (no same-orbit scene nearby)' : 'a different geometry (no same-orbit or same-direction scene nearby)'}`,
      }
    }
  } else {
    pair = { error: 'no scene pair' }
  }
  if ('error' in pair) return unavailable(`${pair.error}.`)
  if (explicitPick) series = fineSeries
  const { before, after } = pair
  const bKey = before.scene.key
  const aKey = after.scene.key

  // ---- 5. change classes + vectors -------------------------------------------
  const wb = waterByKey.get(bKey)!
  const wa = waterByKey.get(aKey)!
  const dbB = dbByKey.get(bKey)!
  const dbA = dbByKey.get(aKey)!
  const both = new Uint8Array(px)
  let bothValid = 0
  for (let i = 0; i < px; i++) if (dbB[i] === dbB[i] && dbA[i] === dbA[i]) { both[i] = 1; bothValid++ }
  const cls = classifyChange(wb, wa, both)
  const floodPx = openMask(classMask(cls, CHANGE.FLOOD), W, H)
  const recededPx = openMask(classMask(cls, CHANGE.RECEDED), W, H)
  const permPx = classMask(cls, CHANGE.PERMANENT)
  const labels = new Uint8Array(px)
  for (let i = 0; i < px; i++) labels[i] = permPx[i] ? CHANGE.PERMANENT : floodPx[i] ? CHANGE.FLOOD : 0
  const vec = vectorizeLabels(labels, W, H, { bbox, minAreaM2, background: 0 })
  const floodPolys = vec.polygons.filter((p) => p.value === CHANGE.FLOOD)
  const permPolys = vec.polygons.filter((p) => p.value === CHANGE.PERMANENT)
  const floodKm2 = floodPolys.reduce((s, p) => s + p.areaM2, 0) / 1e6
  const permKm2 = permPolys.reduce((s, p) => s + p.areaM2, 0) / 1e6
  let recededN = 0
  for (let i = 0; i < px; i++) recededN += recededPx[i]
  const recededKm2 = (recededN * gridGeo.pixelAreaM2) / 1e6
  const observedKm2 = (bothValid * gridGeo.pixelAreaM2) / 1e6

  // How much the answer leans on the threshold: new-flood pixel area (after clean-up, before the min-area
  // filter) at the chosen threshold and at 1.5 and 3 dB stricter. Backscatter thresholds are the dominant uncertainty.
  const countPx = (m: Uint8Array) => { let n = 0; for (let i = 0; i < m.length; i++) n += m[i]; return n }
  const sensitivity = [0, -1.5, -3].map((d) => {
    const t = thr + d
    let f = floodPx
    if (d !== 0) {
      const c = classifyChange(cleanMask(waterMask(dbB, t), W, H), cleanMask(waterMask(dbA, t), W, H), both)
      f = openMask(classMask(c, CHANGE.FLOOD), W, H)
    }
    return { label: `${t.toFixed(1)} dB${d === 0 ? ' (used)' : ''}`, value: Number(((countPx(f) * gridGeo.pixelAreaM2) / 1e6).toFixed(2)) }
  })

  // ---- 6. impact ----------------------------------------------------------------
  const impactNotes: string[] = []
  let buildingsAffected: number | null = null
  let buildingsScanned: number | null = null
  let buildingsInBox: number | null = null
  let buildingsCapped = false
  let overtureRelease = ''
  let roads: ReturnType<typeof floodedRoadLength> | null = null
  let overtureFailed = false
  let affected: ReturnType<typeof buildingsInFlood> = []
  if (floodPolys.length > 0) {
    const index = buildPolygonIndex(floodPolys.map((p) => p.coordinates))
    const fb = index.bbox!
    const pad = 0.0005
    const readBox = [fb[0] - pad, fb[1] - pad, fb[2] + pad, fb[3] + pad]
    ctx.emit?.('token', { type: 'token', content: `Intersecting ${floodPolys.length} flood polygon(s) with Overture buildings...\n` })
    try {
      // Each batch of rows is reduced to the buildings inside a flood polygon as it arrives: a dense city's
      // quarter of a million footprints (nested coordinate arrays) are never all held at once.
      const rb = await withDeadline(OVERTURE_READ_MS, ctx.signal, 'reading Overture buildings', () =>
        readOvertureTheme('buildings', readBox, { limit: MAX_BUILDINGS_READ, columns: ['id', 'geometry', 'bbox'], select: (rows) => buildingsInFlood(rows, index) }))
      overtureRelease = rb.release
      buildingsInBox = rb.scanned ?? rb.rows.length
      buildingsCapped = rb.capped === true
      buildingsScanned = buildingsInBox
      affected = rb.rows
      buildingsAffected = affected.length
      if (buildingsCapped) {
        impactNotes.push(`Building count is a lower bound: reading stopped at ${fmt(MAX_BUILDINGS_READ, 0)} Overture buildings in the flooded area's bounding box (the box holds more).`)
      }
      if (buildingsInBox === 0) impactNotes.push('Overture has no buildings in the flooded area (searched, not a read failure).')
    } catch (err: any) {
      log.warn({ err: err?.message }, 'overture buildings read failed')
      overtureFailed = true
      impactNotes.push(`Affected buildings could not be counted: Overture buildings were unavailable (${err?.message ?? 'read error'}).`)
    }
    // The roads come from the same host: when the buildings read failed, a second wait would only repeat it.
    if (wantRoads && overtureFailed) impactNotes.push('Flooded road length was not attempted: the Overture buildings read had just failed.')
    if (wantRoads && !overtureFailed) {
      try {
        const rr = await withDeadline(OVERTURE_READ_MS, ctx.signal, 'reading Overture roads', () =>
          readOvertureTheme('transportation', readBox, { limit: MAX_ROAD_SEGMENTS, columns: ['id', 'geometry', 'bbox', 'subtype'] }))
        const segs = rr.rows.filter((r) => (r.subtype ?? 'road') === 'road')
        roads = floodedRoadLength(segs, index)
        if (rr.capped) impactNotes.push(`Road length is a lower bound: capped at ${fmt(MAX_ROAD_SEGMENTS, 0)} road segments.`)
      } catch (err: any) {
        log.warn({ err: err?.message }, 'overture roads read failed')
        impactNotes.push(`Flooded road length could not be computed (${err?.message ?? 'read error'}).`)
      }
    }
  }

  // ---- 7. layers ----------------------------------------------------------------
  const sarProv = (scene: S1Scene): Provenance => ({
    source: 'Sentinel-1 RTC (gamma-nought) via Microsoft Planetary Computer',
    date: scene.date,
    method: `${pol} linear power shown as 10·log10 dB (stretch -25 to 0 dB, dark = smooth water); tiles from the Planetary Computer data API`,
    clip: 'polygon (display mask)',
  })
  const sarLayer = (scene: S1Scene, role: 'after' | 'before'): ResultLayer => {
    const raster: RasterDescriptor = {
      kind: 'continuous', sensor: 'sentinel-1-rtc', collection: 'sentinel-1-rtc', sceneId: String(scene.tileItem.id),
      datetime: scene.date, bands: [pol], expression: `10*log10(${pol.toLowerCase()})`, rescale: [[-25, 0]], stretch: 'fixed',
      colormap: 'greys_r', units: 'dB',
    }
    return {
      id: `flood-sar-${role}-${genId()}`,
      name: `Sentinel-1 ${pol} ${role} (${scene.date})`,
      type: 'raster',
      tileUrl: sarTileUrl(scene, pol),
      bounds: bbox,
      aoiMask: true,
      raster,
      provenance: sarProv(scene),
      confidence: 'high',
      ...(role === 'before' ? { defaultVisible: false } : {}),
    }
  }

  const sortedFlood = [...floodPolys].sort((a, b) => b.areaM2 - a.areaM2)
  const sortedPerm = [...permPolys].sort((a, b) => b.areaM2 - a.areaM2)
  const keepFlood = sortedFlood.slice(0, MAX_FLOOD_POLYGONS)
  const keepPerm = sortedPerm.slice(0, MAX_FLOOD_POLYGONS)
  const polyFeature = (p: (typeof floodPolys)[number], kind: string, color: string, i: number) => ({
    type: 'Feature' as const,
    properties: { id: i + 1, kind, area_m2: Math.round(p.areaM2), area_ha: Number((p.areaM2 / 1e4).toFixed(3)), color },
    geometry: { type: 'Polygon' as const, coordinates: roundCoords(p.coordinates) },
  })
  const floodFeatures = [
    ...keepFlood.map((p, i) => polyFeature(p, 'New flood', FLOOD_COLOR, i)),
    ...keepPerm.map((p, i) => polyFeature(p, 'Permanent water', PERM_COLOR, i)),
  ]
  const floodStyle: VectorStyle = {
    property: 'kind', kind: 'categorical',
    classes: [
      { value: 'New flood', label: 'New flood (water after, dry before)', color: FLOOD_COLOR },
      { value: 'Permanent water', label: 'Permanent water (both dates)', color: PERM_COLOR },
    ],
  }
  const floodProv: Provenance = {
    source: 'Sentinel-1 RTC (Microsoft Planetary Computer), change between two scenes',
    date: after.scene.date,
    method:
      `${pol} dB, 3x3 median, threshold ${thr.toFixed(1)} dB (${threshold.method}), 1 px open+close; flood = water(${after.scene.date}) AND NOT water(${before.scene.date}); ` +
      `4-connected components traced to polygons with holes (Douglas-Peucker 0.7 px), groups under ${fmt(minAreaM2, 0)} m² dropped`,
    clip: 'polygon',
    resolution_limit:
      `Sentinel-1 RTC at 10 m, read at ${((gridGeo.cellXm + gridGeo.cellYm) / 2).toFixed(1)} m here. Edges are good to about one pixel; ` +
      'flooding under dense vegetation or among buildings is mostly invisible to this method, so extents are lower bounds there.',
  }

  const confidence: Confidence = threshold.method === 'fallback' || pair.match === 'any' || after.coveragePct < 90 ? 'low' : 'medium'
  const layers: ResultLayer[] = [sarLayer(after.scene, 'after'), sarLayer(before.scene, 'before')]
  if (floodFeatures.length > 0) {
    layers.push({
      id: `flood-polygons-${genId()}`,
      name: `Flood extent: ${fmt(floodKm2, 2)} km² new, ${fmt(permKm2, 2)} km² permanent`,
      type: 'geojson',
      geojson: { type: 'FeatureCollection', features: floodFeatures },
      bounds: bbox,
      provenance: floodProv,
      confidence,
      vectorStyle: floodStyle,
    })
  }
  if (affected.length > 0) {
    const asFootprints = affected.length <= MAX_BUILDING_FOOTPRINTS
    const shown = asFootprints ? affected : affected.slice(0, MAX_BUILDING_POINTS)
    layers.push({
      id: `flood-buildings-${genId()}`,
      name: `Flooded buildings (${fmt(affected.length, 0)})`,
      type: 'geojson',
      geojson: {
        type: 'FeatureCollection',
        features: shown.map((b) => ({
          type: 'Feature' as const,
          properties: { id: b.id, status: 'Affected building', color: BUILDING_COLOR },
          geometry: asFootprints
            ? { type: b.geometry.type, coordinates: roundCoords(b.geometry.coordinates) }
            : { type: 'Point' as const, coordinates: [round5(b.centroid[0]), round5(b.centroid[1])] },
        })),
      },
      bounds: bbox,
      provenance: {
        source: `Overture Maps buildings, release ${overtureRelease}`,
        date: after.scene.date,
        method: 'building footprints whose centroid lies inside a flood polygon (point-in-polygon, holes respected)',
        clip: 'polygon',
        resolution_limit: 'Overture is conflated from OSM, Microsoft and Google footprints; completeness varies. Whether a building was actually inundated (and how deeply) is not known from radar.',
      },
      confidence,
      vectorStyle: { property: 'status', kind: 'categorical', classes: [{ value: 'Affected building', label: 'Building inside flood extent', color: BUILDING_COLOR }] },
    })
    if (!asFootprints) impactNotes.push(`The map shows ${fmt(shown.length, 0)} affected buildings as centroid points (${fmt(affected.length, 0)} is too many to draw as footprints).`)
  }

  const chart = buildSeriesChart(series, bKey, aKey, seriesThresholdDb ?? thr)

  // ---- 8. figures + words -------------------------------------------------------
  const pct = (p: SeriesPoint) => Number((p.fraction! * 100).toFixed(2))
  const seriesData = series
    .filter((p) => p.fraction != null)
    .map((p) => ({ label: `${p.scene.date} ${p.scene.orbit === 'ascending' ? 'asc' : p.scene.orbit === 'descending' ? 'desc' : ''}${p.scene.relativeOrbit != null ? ` #${p.scene.relativeOrbit}` : ''}`.trim(), value: pct(p) }))
  const gsd = (gridGeo.cellXm + gridGeo.cellYm) / 2
  const summary_data: Record<string, SummaryDatum> = {
    flood_area_km2: Number(floodKm2.toFixed(4)),
    permanent_water_km2: Number(permKm2.toFixed(4)),
    receded_area_km2: Number(recededKm2.toFixed(4)),
    flood_polygon_count: floodPolys.length,
    permanent_polygon_count: permPolys.length,
    aoi_km2: Number(aoiKm2.toFixed(1)),
    observed_km2: Number(observedKm2.toFixed(1)),
    valid_pixel_pct: Number(Math.min(100, (observedKm2 / aoiKm2) * 100).toFixed(1)),
    flood_pct_of_observed: observedKm2 > 0 ? Number(((floodKm2 / observedKm2) * 100).toFixed(2)) : 0,
    threshold_db: Number(thr.toFixed(2)),
    threshold_method: threshold.method,
    polarization: pol,
    before_date: before.scene.date,
    before_scene_id: String(before.scene.tileItem.id),
    before_orbit: before.scene.orbit,
    before_relative_orbit: before.scene.relativeOrbit ?? 'unknown',
    before_water_pct: pct(before),
    after_date: after.scene.date,
    after_scene_id: String(after.scene.tileItem.id),
    after_orbit: after.scene.orbit,
    after_relative_orbit: after.scene.relativeOrbit ?? 'unknown',
    after_water_pct: pct(after),
    orbit_match: pair.match,
    scenes_scanned: scannedCount,
    scenes_failed: failed.length,
    grid_gsd_m: Number(gsd.toFixed(1)),
    min_area_m2: minAreaM2,
    dropped_small_groups: vec.droppedSmall,
    selection: pair.how,
  }
  if (threshold.otsuDb != null) summary_data.otsu_db = Number(threshold.otsuDb.toFixed(2))
  if (threshold.separability != null) summary_data.otsu_separability = Number(threshold.separability.toFixed(2))
  if (buildingsAffected != null) {
    summary_data.affected_buildings = buildingsAffected
    summary_data.buildings_scanned = buildingsScanned ?? 0
    summary_data.buildings_read_capped = buildingsCapped ? 'yes' : 'no'
  }
  if (roads) {
    summary_data.flooded_road_km = Number(roads.floodedKm.toFixed(2))
    summary_data.road_segments_touched = roads.segmentsTouched
  }
  summary_data.flood_area_km2_by_threshold = sensitivity
  if (!explicitPick) {
    summary_data.water_fraction_series_pct = seriesData
    if (scanGsdM != null) summary_data.scan_grid_gsd_m = Number(scanGsdM.toFixed(1))
    if (seriesThresholdDb != null) summary_data.scan_threshold_db = Number(seriesThresholdDb.toFixed(2))
  }
  if (overtureRelease) summary_data.overture_release = overtureRelease

  const lines: string[] = []
  const headline = floodPolys.length > 0
    ? `**${fmt(floodKm2, 2)} km² newly flooded** in ${floodPolys.length.toLocaleString()} polygon${floodPolys.length === 1 ? '' : 's'} (${observedKm2 > 0 ? ((floodKm2 / observedKm2) * 100).toFixed(1) : '0'}% of the ${fmt(observedKm2, 1)} km² observed), ` +
      `against ${fmt(permKm2, 2)} km² of permanent water; ${fmt(recededKm2, 2)} km² of water present before had gone by the after-date.`
    : `**No new flooding found** between ${before.scene.date} and ${after.scene.date}: water(after) AND NOT water(before) is empty after clean-up and the ${fmt(minAreaM2, 0)} m² filter. This is a measured absence, not a fetch failure.`
  lines.push(headline)
  lines.push('')
  lines.push(`- **After:** ${sceneLabel(after.scene)}, ${pct(after)}% of the AOI is water. **Before:** ${sceneLabel(before.scene)}, ${pct(before)}%. Geometry match: ${pair.match === 'orbit' ? 'same relative orbit (like with like)' : pair.match === 'direction' ? 'same flight direction, different relative orbit' : '**different orbit geometry**, so incidence-angle differences add noise'}.`)
  lines.push(`- **How chosen:** ${pair.how}.`)
  lines.push(`- **Threshold:** ${thr.toFixed(1)} dB (${pol}) shared by both scenes. ${threshold.note}`)
  lines.push(`- **Threshold sensitivity** (new-flood area before the min-area filter): ${sensitivity.map((x) => `${x.label} ${x.value} km²`).join(', ')}. Treat the extent as a range, not a single number.`)
  if (buildingsAffected != null) {
    lines.push(`- **Buildings hit:** ${fmt(buildingsAffected, 0)} Overture building footprints have their centroid inside a flood polygon (of ${fmt(buildingsScanned ?? 0, 0)} scanned, release ${overtureRelease}).`)
  }
  if (roads) lines.push(`- **Roads:** about ${fmt(roads.floodedKm, 1)} km of Overture road across ${fmt(roads.segmentsTouched, 0)} segments crosses the flood extent (10 m stepping; includes bridges and embankments the radar sees as water).`)
  if (!explicitPick) {
    const dates = series.filter((p) => p.fraction != null)
    lines.push(`- **Water fraction by scene (${dates.length}, scanned at ~${(scanGsdM ?? gsd).toFixed(0)} m with a ${(seriesThresholdDb ?? thr).toFixed(1)} dB threshold):** ${dates.map((p) => `${p.scene.date}${p.scene.relativeOrbit != null ? `/${p.scene.relativeOrbit}` : ''} ${pct(p)}%`).join(', ')}.`)
  }
  for (const n of impactNotes) lines.push(`- ${n}`)
  const partial = series.filter((p) => p.coveragePct < MIN_COVERAGE_PCT)
  if (partial.length) lines.push(`- ${partial.length} scene(s) covered under ${MIN_COVERAGE_PCT}% of the AOI and were left out of the threshold and selection: ${partial.map((p) => p.scene.date).join(', ')}.`)
  if (failed.length) lines.push(`- ${failed.length} scene(s) could not be read and are missing from the series: ${failed.map((f) => `${f.scene.date} (${f.reason})`).join('; ')}.`)
  if (floodPolys.length > MAX_FLOOD_POLYGONS) lines.push(`- The map shows the ${fmt(MAX_FLOOD_POLYGONS, 0)} largest of ${fmt(floodPolys.length, 0)} flood polygons; totals count all of them.`)
  lines.push('')
  lines.push(
    '**Caveats.** (1) Radar sees only open, smooth water: flooding under dense vegetation or tree canopy is largely missed, and in built-up areas ' +
    'double-bounce off walls makes flooded streets bright, so **urban flooding is under-detected** and the building count is a lower bound. ' +
    '(2) Wind-roughened water can look like land and be missed. (3) Radar shadow and steep slopes can look like water; no terrain (DEM/HAND) mask was applied here, ' +
    'so check any flood polygons on hills or behind tall structures. (4) Wet or smooth bare ground, sand and tarmac can fall below the threshold. ' +
    '(5) A building counts when its footprint centroid is inside the flood extent; depth and actual damage are not known. ' +
    `(6) The extent is a snapshot at ${after.scene.date}, not the maximum extent of the event.`,
  )

  return {
    summary: lines.join('\n'),
    summary_data,
    layer: layers[0],
    layers: layers.slice(1),
    ...(chart ? { charts: [chart] } : {}),
    provenance_items: [
      String(before.scene.tileItem.id),
      String(after.scene.tileItem.id),
      ...(overtureRelease ? [`overture-maps:${overtureRelease}`] : []),
    ],
    uncertainty: {
      notes: [
        'Radar misses flooding under vegetation and in dense urban areas (double bounce), so flooded area and affected buildings are lower bounds.',
        'Wind-roughened water can read as land; no terrain-shadow mask was applied.',
        ...impactNotes,
      ],
    },
  }
}
