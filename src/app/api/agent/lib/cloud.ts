/** AOI-local cloud screening for Sentinel-2 L2A, via the SCL scene-classification band.
 *
 *  WHY THIS EXISTS (measured 2026-08-09, AOI 16.9 km² at 31.52 N / 74.32 E):
 *  scene-wide `eo:cloud_cover` is nearly uncorrelated with cloud over the user's polygon.
 *
 *    scene date    eo:cloud_cover    AOI-local clear
 *    2026-08-09          87.2 %              0.0 %
 *    2026-08-04          48.9 %             12.8 %
 *    2026-07-27          51.8 %             25.0 %
 *    2026-07-20          60.5 %              0.0 %
 *
 *  The pre-v2 stack picked the newest scene with `eo:cloud_cover < 30` and reported
 *  whatever was there. On 2026-07-15 that scene was 20.1 % cloudy scene-wide while the
 *  AOI sat under 100 % cloud — so NDVI came back −0.072, which is the reflectance of a
 *  cloud top (NIR 6597 / Red 7621: bright, red > NIR), and land cover, change detection
 *  and deforestation all inherited it. Every one of those numbers shipped with full
 *  provenance and a citation pill.
 *
 *  Rule: screen on the polygon, mask per pixel, and when nothing is clear say so
 *  instead of returning a number.
 */

import turfArea from '@turf/area'
import { fetchCogFeatureGrid, fetchFeatureGrid, gridStats, type PixelGrid } from './pixels'
import { getLogger } from './logger'
import { getStacItemHref, pickAssetKey } from './stac'
import { resolveBandSetReflectance } from './reflectance'

const log = getLogger('agent/cloud')

// ---------------------------------------------------------------------------
// AOI coverage — is this scene even LOOKING at the polygon? (ISS-125)
//
// Clear-sky percentages are computed over the pixels a scene RETURNED, not over
// the polygon. A Sentinel-2 tile clipping one corner therefore scores "100%
// clear" while observing 2% of the AOI — measured 2026-08-11 at 5 184 of
// 262 144 px. A mean over that sliver, labelled as the AOI's value, is ISS-102
// wearing a different hat: a real number describing a different area than the
// one asked about.
//
// Phase 2.5 fixed this inside `analyze_raster` / `inspect_imagery`. It lives
// here now so the Phase 0 tools inherit it at the one place they all pass
// through — scene selection.
// ---------------------------------------------------------------------------

/** Minimum share of the polygon a scene must actually observe to be usable. */
export const MIN_AOI_COVERAGE_PCT = 60

/** % of the polygon's area actually observed, from the returned pixel count. */
export function aoiCoveragePct(
  geom: any,
  observedPixels: number,
  cellXm: number,
  cellYm: number,
): number {
  const pixelAreaM2 = cellXm * cellYm
  if (!(pixelAreaM2 > 0)) return 0
  let polygonAreaM2 = 0
  try {
    polygonAreaM2 = turfArea({ type: 'Feature', properties: {}, geometry: geom } as any)
  } catch {
    return 0
  }
  if (!(polygonAreaM2 > 0)) return 0
  // Discretisation makes the count slightly exceed the area at the boundary;
  // cap at 100 rather than reporting 103% coverage.
  return Math.min(100, (observedPixels * pixelAreaM2 / polygonAreaM2) * 100)
}

/** Bounding box of a Polygon/MultiPolygon, or null when it has no usable ring. */
export function geomBboxOf(geom: any): [number, number, number, number] | null {
  const coords = geom?.coordinates
  if (!Array.isArray(coords)) return null
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
  const walk = (node: any) => {
    if (!Array.isArray(node)) return
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      if (node[0] < minLng) minLng = node[0]
      if (node[0] > maxLng) maxLng = node[0]
      if (node[1] < minLat) minLat = node[1]
      if (node[1] > maxLat) maxLat = node[1]
      return
    }
    for (const child of node) walk(child)
  }
  walk(coords)
  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) return null
  return [minLng, minLat, maxLng, maxLat]
}

/**
 * % of the polygon a grid of `observedPx` in-polygon pixels covers.
 *
 * The grid comes back clipped to the geometry's own bounds, so the cell size is
 * that bbox divided by the returned shape — which is why this needs no extra
 * metadata from titiler (and must not assume `max_size`, a cap, was honoured;
 * see ISS-126).
 */
export function gridCoveragePct(
  geom: any,
  observedPx: number,
  width: number,
  height: number,
): number {
  if (!(width > 0) || !(height > 0)) return 0
  const bbox = geomBboxOf(geom)
  if (!bbox) return 0
  const [minLng, minLat, maxLng, maxLat] = bbox
  const midLat = (minLat + maxLat) / 2
  const cellXm = ((maxLng - minLng) / width) * 111_320 * Math.cos((midLat * Math.PI) / 180)
  const cellYm = ((maxLat - minLat) / height) * 110_540
  return aoiCoveragePct(geom, observedPx, cellXm, cellYm)
}

/** Sentinel-2 L2A Scene Classification Layer values. */
export const SCL = {
  NO_DATA: 0,
  SATURATED: 1,
  DARK_AREA: 2,
  CLOUD_SHADOW: 3,
  VEGETATION: 4,
  NOT_VEGETATED: 5,
  WATER: 6,
  UNCLASSIFIED: 7,
  CLOUD_MEDIUM_PROB: 8,
  CLOUD_HIGH_PROB: 9,
  THIN_CIRRUS: 10,
  SNOW: 11,
} as const

export const SCL_LABELS: Record<number, string> = {
  0: 'no data', 1: 'saturated', 2: 'dark area', 3: 'cloud shadow',
  4: 'vegetation', 5: 'not vegetated', 6: 'water', 7: 'unclassified',
  8: 'cloud (medium prob.)', 9: 'cloud (high prob.)', 10: 'thin cirrus', 11: 'snow',
}

/** Pixels usable for surface analysis. Snow is "clear" (a real surface) but callers
 *  doing vegetation work should check `snowPct` before trusting an index. */
export const CLEAR_CLASSES: ReadonlySet<number> = new Set([
  SCL.VEGETATION, SCL.NOT_VEGETATED, SCL.WATER, SCL.UNCLASSIFIED, SCL.SNOW,
])

/** Pixels that contaminate any surface measurement. */
export const CONTAMINATED_CLASSES: ReadonlySet<number> = new Set([
  SCL.CLOUD_SHADOW, SCL.CLOUD_MEDIUM_PROB, SCL.CLOUD_HIGH_PROB, SCL.THIN_CIRRUS, SCL.SATURATED,
])

export interface SceneClarity {
  /** Which quality band produced this score — decides how pixels are re-tested. */
  kind: 'scl' | 'landsat-qa'
  /** % of in-polygon pixels usable for surface analysis. */
  clearPct: number
  /** % obscured by cloud, cirrus or cloud shadow. */
  cloudPct: number
  snowPct: number
  waterPct: number
  /** In-polygon pixel count (mask > 0). */
  totalPx: number
  clearPx: number
  /**
   * % of the drawn polygon this scene actually observed (ISS-125), or `null`
   * when it was scored without the geometry — the pure grid scorers cannot
   * know it, and `null` is never read as "fine". Every path the scene pickers
   * use measures it.
   */
  coveragePct: number | null
  /** Per-class percentages, highest first — for honest reporting. */
  breakdown: Array<{ label: string; pct: number }>
  /** The quality grid, reusable as a mask for statistics on the same scene. */
  grid: PixelGrid
}

/** Minimum AOI-local clear fraction for a scene to be considered usable. Below this,
 *  an index mean is dominated by cloud and must not be reported as a surface value. */
export const MIN_USABLE_CLEAR_PCT = 40

/**
 * Score one Sentinel-2 scene by how much of the AOI polygon is actually clear.
 * Returns null when the item has no SCL asset or titiler cannot serve the grid.
 */
export async function sceneClarity(
  item: any,
  geom: any,
  maxSize = 96,
): Promise<SceneClarity | null> {
  const sclKey = pickAssetKey(item, ['scl', 'SCL'])
  const itemHref =
    (item?.links as any[] | undefined)?.find((l: any) => l.rel === 'self')?.href ??
    (item?.collection && item?.id
      ? `https://earth-search.aws.element84.com/v1/collections/${item.collection}/items/${item.id}`
      : null)
  if (!sclKey || !itemHref) return null

  let grid: PixelGrid
  try {
    grid = await fetchFeatureGrid({
      itemHref, assets: [sclKey], geom, maxSize, cacheTag: 'scl',
    })
  } catch (err: any) {
    log.warn({ scene: item?.id, err: err?.message }, 'SCL fetch failed')
    return null
  }

  const counts = new Map<number, number>()
  let totalPx = 0
  const px = grid.width * grid.height
  for (let i = 0; i < px; i++) {
    if (!grid.mask[i]) continue
    const cls = Math.round(grid.values[i])
    if (cls === SCL.NO_DATA) continue
    totalPx++
    counts.set(cls, (counts.get(cls) ?? 0) + 1)
  }
  if (totalPx === 0) return null

  const pctOf = (pred: (c: number) => boolean) => {
    let n = 0
    for (const [cls, c] of counts) if (pred(cls)) n += c
    return (n / totalPx) * 100
  }

  const clearPx = Math.round((pctOf((c) => CLEAR_CLASSES.has(c)) / 100) * totalPx)
  const breakdown = [...counts.entries()]
    .map(([cls, c]) => ({ label: SCL_LABELS[cls] ?? `class ${cls}`, pct: (c / totalPx) * 100 }))
    .sort((a, b) => b.pct - a.pct)

  return {
    kind: 'scl',
    clearPct: pctOf((c) => CLEAR_CLASSES.has(c)),
    cloudPct: pctOf((c) => CONTAMINATED_CLASSES.has(c)),
    snowPct: pctOf((c) => c === SCL.SNOW),
    waterPct: pctOf((c) => c === SCL.WATER),
    totalPx,
    clearPx,
    coveragePct: gridCoveragePct(geom, totalPx, grid.width, grid.height),
    breakdown,
    grid,
  }
}

// ---------------------------------------------------------------------------
// Landsat Collection-2 QA_PIXEL — the same screening for the thermal path.
//
// `fetch_thermal` had no cloud masking. Measured live 2026-08-10 on the audit AOI:
// the tool picked the newest scene under the scene-wide 40% gate (2026-08-02,
// 27.5% cloud) and reported **−3.2 °C**. QA_PIXEL scores that AOI 0% clear —
// every pixel cloud, cirrus or shadow. Cloud tops are COLD, so contamination
// drags LST down rather than up: the 0.3%-cloud scene reads **+44.3 °C**
// (σ 2.5 K). A 47-degree error that inverts any heat answer.
// ---------------------------------------------------------------------------

/** Landsat C2 QA_PIXEL bit flags (L8/L9 OLI-TIRS, USGS DFCB-004). */
export const LANDSAT_QA = {
  FILL: 1 << 0,
  DILATED_CLOUD: 1 << 1,
  CIRRUS: 1 << 2,
  CLOUD: 1 << 3,
  CLOUD_SHADOW: 1 << 4,
  SNOW: 1 << 5,
  CLEAR: 1 << 6,
  WATER: 1 << 7,
} as const

/** Bits that make a pixel unusable for a surface measurement. */
const LANDSAT_CONTAMINATED =
  LANDSAT_QA.DILATED_CLOUD | LANDSAT_QA.CIRRUS | LANDSAT_QA.CLOUD | LANDSAT_QA.CLOUD_SHADOW

/** True when a QA_PIXEL value describes real ground (or water/snow), not cloud.
 *  Fill is excluded: a fill LST pixel is DN 0, which decodes to −124 °C. */
export function landsatQaIsClear(qa: number): boolean {
  const v = Math.round(qa)
  if (!Number.isFinite(v) || v === 0) return false
  if (v & LANDSAT_QA.FILL) return false
  return (v & LANDSAT_CONTAMINATED) === 0
}

/** Human label for a QA_PIXEL value — most significant contaminant first. */
export function landsatQaLabel(qa: number): string {
  const v = Math.round(qa)
  if (!Number.isFinite(v) || v === 0 || v & LANDSAT_QA.FILL) return 'no data'
  if (v & LANDSAT_QA.CLOUD) return 'cloud'
  if (v & LANDSAT_QA.CLOUD_SHADOW) return 'cloud shadow'
  if (v & LANDSAT_QA.CIRRUS) return 'cirrus'
  if (v & LANDSAT_QA.DILATED_CLOUD) return 'dilated cloud'
  if (v & LANDSAT_QA.SNOW) return 'snow'
  if (v & LANDSAT_QA.WATER) return 'water'
  return 'clear'
}

/** Score a decoded QA_PIXEL grid. Pure — the fetch lives in `landsatClarity`. */
export function landsatQaClarity(grid: PixelGrid): SceneClarity | null {
  const counts = new Map<string, number>()
  let totalPx = 0
  let clearPx = 0
  let cloudPx = 0
  let snowPx = 0
  let waterPx = 0
  const px = grid.width * grid.height

  for (let i = 0; i < px; i++) {
    if (!grid.mask[i]) continue
    const v = Math.round(grid.values[i])
    if (v === 0 || v & LANDSAT_QA.FILL) continue
    totalPx++
    const label = landsatQaLabel(v)
    counts.set(label, (counts.get(label) ?? 0) + 1)
    if (landsatQaIsClear(v)) clearPx++
    if (v & LANDSAT_CONTAMINATED) cloudPx++
    if (v & LANDSAT_QA.SNOW) snowPx++
    if (v & LANDSAT_QA.WATER) waterPx++
  }
  if (totalPx === 0) return null

  const breakdown = [...counts.entries()]
    .map(([label, c]) => ({ label, pct: (c / totalPx) * 100 }))
    .sort((a, b) => b.pct - a.pct)

  return {
    kind: 'landsat-qa',
    clearPct: (clearPx / totalPx) * 100,
    cloudPct: (cloudPx / totalPx) * 100,
    snowPct: (snowPx / totalPx) * 100,
    waterPct: (waterPx / totalPx) * 100,
    totalPx,
    clearPx,
    // Pure: no geometry here, so coverage is genuinely unknown rather than 100.
    // `landsatClarity` attaches the real value.
    coveragePct: null,
    breakdown,
    grid,
  }
}

/**
 * Score one Landsat C2 L2 scene by AOI-local clear sky, via its QA_PIXEL asset.
 *
 * `signAsset` is injected (rather than imported) so this module stays free of the
 * Planetary Computer signing dependency and remains trivially testable.
 */
export async function landsatClarity(
  item: any,
  geom: any,
  signAsset: (href: string) => Promise<string>,
  maxSize = 96,
): Promise<SceneClarity | null> {
  const qaHref: string | undefined = item?.assets?.qa_pixel?.href ?? item?.assets?.QA_PIXEL?.href
  if (!qaHref) return null

  try {
    const signed = await signAsset(qaHref)
    const grid = await fetchCogFeatureGrid({ cogUrl: signed, geom, maxSize, cacheTag: 'lsqa' })
    const clarity = landsatQaClarity(grid)
    if (!clarity) return null
    return { ...clarity, coveragePct: gridCoveragePct(geom, clarity.totalPx, grid.width, grid.height) }
  } catch (err: any) {
    log.warn({ scene: item?.id, err: err?.message }, 'Landsat QA_PIXEL fetch failed')
    return null
  }
}

/**
 * Pick the Landsat scene with the most AOI-local clear sky. Mirrors
 * `pickClearestScene`; see it for the ranking rationale.
 */
export async function pickClearestLandsatScene(
  items: any[],
  geom: any,
  signAsset: (href: string) => Promise<string>,
  opts: SceneChoiceOptions = {},
): Promise<ClearSceneChoice | null> {
  const { maxSize = 96, maxCandidates = 5 } = opts
  const candidates = items.slice(0, maxCandidates)
  if (candidates.length === 0) return null

  const scored = await Promise.all(
    candidates.map(async (item) => ({
      item,
      clarity: await landsatClarity(item, geom, signAsset, maxSize),
    })),
  )
  return chooseScene(scored, opts)
}

export interface SceneChoiceOptions {
  /** Started for each candidate at the moment its reflectance gate starts, so the reads that
   *  follow a chosen scene (statistics, pixel grid) overlap the gate instead of waiting for
   *  it. It never influences which scene wins; the promise of the winning candidate comes
   *  back as `ClearSceneChoice.speculative`, the others are abandoned (their rejection is
   *  swallowed). A rejected gate therefore costs requests, never latency or correctness. */
  speculate?: (item: any, clarity: SceneClarity) => Promise<unknown>
  maxSize?: number
  minClearPct?: number
  maxCandidates?: number
  /** Minimum share of the polygon the scene must observe (ISS-125). 0 opts out. */
  minCoveragePct?: number
}

export interface ExaminedScene {
  id: string
  date: string
  sceneCloudPct: number | null
  aoiClearPct: number
  /** % of the polygon the scene observed, or null when it could not be scored. */
  aoiCoveragePct: number | null
  /** Why a scene that SCL called clear was still rejected (see `reflectanceGate`). */
  rejection?: string
}

/** A scene SCL scored as clear that the reflectance plausibility gate refused. */
export interface RejectedScene {
  id: string
  date: string
  reason: string
}

export interface ClearSceneChoice {
  item: any
  clarity: SceneClarity
  /** Scenes examined, best-first, for an honest "we looked at N scenes" line. */
  examined: ExaminedScene[]
  /** Higher-ranked candidates refused by the plausibility gate — surface these to the user. */
  rejected: RejectedScene[]
  /** The winner's `SceneChoiceOptions.speculate` promise, already running. */
  speculative?: Promise<unknown>
}

// ---------------------------------------------------------------------------
// Reflectance plausibility gate (Q-60)
//
// SCL is a classifier and misses cloud (measured 2026-10-12 over Kasur: SCL-"clear"
// pixels with NIR p98 up to 1.35). Land surfaces in Sentinel-2 L2A essentially never have a
// MEDIAN visible/NIR reflectance above ~0.5 (snow and salt pans are the exceptions), while
// cloud tops sit at 0.8+. So after SCL screening, the AOI's median over its clear pixels is
// checked, in reflectance units resolved per producer (earth-search: scale 1e-4, offset 0;
// Planetary Computer: offset -0.1 removed here).
// ---------------------------------------------------------------------------

/** AOI median reflectance above this in blue, red or NIR means the scene is clouded. */
export const MAX_PLAUSIBLE_MEDIAN_REFLECTANCE = 0.5

/** Snow is legitimately bright; above this share the gate cannot tell snow from cloud. */
const GATE_SNOW_SKIP_PCT = 50

const GATE_BANDS: Array<[string, string[]]> = [
  ['B02', ['blue', 'B02']], ['B04', ['red', 'B04']], ['B08', ['nir', 'B08']],
]

/**
 * Null when the scene is plausible, could not be checked (no band assets, snow scene, or a
 * failed read — the SCL verdict then stands), or a rejection reason string.
 */
export async function reflectanceGate(
  item: any,
  geom: any,
  clarity: SceneClarity,
  maxSize = 96,
): Promise<string | null> {
  if (clarity.kind !== 'scl' || clarity.snowPct > GATE_SNOW_SKIP_PCT) return null
  const itemHref = getStacItemHref(item)
  const bands = GATE_BANDS
    .map(([name, keys]) => ({ name, key: pickAssetKey(item, keys) }))
    .filter((b): b is { name: string; key: string } => !!b.key)
  if (!itemHref || bands.length === 0) return null

  let grid: PixelGrid
  try {
    grid = await fetchFeatureGrid({
      itemHref, assets: bands.map((b) => b.key), geom, maxSize, cacheTag: 'plaus',
    })
  } catch (err: any) {
    log.warn({ scene: item?.id, err: err?.message }, 'plausibility band read failed; SCL verdict stands')
    return null
  }
  const px = grid.width * grid.height
  if (grid.bands < bands.length + 1) return null
  // Only pixels SCL called clear: those are the ones an anomaly would corrupt. The SCL
  // grid is the same polygon at the same maxSize, so indices align; if not, mask only.
  const sameGrid = clarity.grid.width === grid.width && clarity.grid.height === grid.height
  const { transforms } = resolveBandSetReflectance(item, bands.map((b) => b.key), {
    isSentinel2: true,
    fallback: { scale: 0.0001, offset: 0, note: 'Sentinel-2 default' },
  })

  const offending: string[] = []
  bands.forEach((b, bi) => {
    const t = transforms[bi]
    const vals: number[] = []
    for (let i = 0; i < px; i++) {
      if (!grid.mask[i]) continue
      if (sameGrid && !CLEAR_CLASSES.has(Math.round(clarity.grid.values[i]))) continue
      const dn = grid.raw[bi * px + i]
      if (!Number.isFinite(dn) || dn === 0) continue
      vals.push(dn * t.scale + t.offset)
    }
    if (vals.length === 0) return
    vals.sort((x, y) => x - y)
    const median = vals[Math.floor(vals.length / 2)]
    if (median > MAX_PLAUSIBLE_MEDIAN_REFLECTANCE) offending.push(`${b.name} median ${median.toFixed(2)}`)
  })
  return offending.length
    ? `SCL called it clear but AOI ${offending.join(', ')} reflectance exceeds ${MAX_PLAUSIBLE_MEDIAN_REFLECTANCE} — cloud-like, not a land surface`
    : null
}

function examinedRow(item: any, clarity: SceneClarity | null, rejection?: string): ExaminedScene {
  return {
    ...(rejection ? { rejection } : {}),
    id: String(item?.id ?? 'unknown'),
    date: String(item?.properties?.datetime ?? '').slice(0, 10),
    sceneCloudPct: typeof item?.properties?.['eo:cloud_cover'] === 'number'
      ? item.properties['eo:cloud_cover'] : null,
    aoiClearPct: clarity ? Number(clarity.clearPct.toFixed(1)) : 0,
    aoiCoveragePct: clarity?.coveragePct != null ? Number(clarity.coveragePct.toFixed(1)) : null,
  }
}

/**
 * Score scenes without gating — for a refusal message that can name WHY each
 * candidate was rejected. A caller that only gets `null` back from a picker
 * cannot tell "all clouded" from "all clipping the AOI", and those need
 * different advice (wait for an overpass vs redraw the polygon).
 */
export async function examinedScenes(
  items: any[],
  geom: any,
  opts: { maxSize?: number; maxCandidates?: number } = {},
): Promise<ExaminedScene[]> {
  const { maxSize = 96, maxCandidates = 6 } = opts
  const scored = await Promise.all(
    items.slice(0, maxCandidates).map(async (item) => ({
      item, clarity: await sceneClarity(item, geom, maxSize),
    })),
  )
  return Promise.all(scored.map(async ({ item, clarity }) => {
    const rejection = clarity && clarity.clearPct >= MIN_USABLE_CLEAR_PCT
      ? await reflectanceGate(item, geom, clarity, maxSize)
      : null
    return examinedRow(item, clarity, rejection ?? undefined)
  }))
}

/** Shared ranking for both sensors: gate on clarity AND coverage, then rank. */
async function chooseScene(
  scored: Array<{ item: any; clarity: SceneClarity | null }>,
  opts: SceneChoiceOptions,
  gate?: (item: any, clarity: SceneClarity) => Promise<string | null>,
  /** Accumulator, so a caller scoring in batches keeps rejections from batches that yield nothing. */
  rejected: RejectedScene[] = [],
): Promise<ClearSceneChoice | null> {
  const {
    minClearPct = MIN_USABLE_CLEAR_PCT,
    minCoveragePct = MIN_AOI_COVERAGE_PCT,
  } = opts
  const examined = scored.map(({ item, clarity }) => examinedRow(item, clarity))

  const usable = scored.filter(
    (s): s is { item: any; clarity: SceneClarity } => {
      if (!s.clarity || s.clarity.clearPct < minClearPct) return false
      // A measured coverage below the floor is a reject. An unmeasured one
      // (null) cannot be judged — but every path that reaches here measures it,
      // which `cloud-coverage.test.ts` pins.
      const cov = s.clarity.coveragePct
      return !(minCoveragePct > 0 && cov != null && cov < minCoveragePct)
    },
  )
  if (usable.length === 0) return null

  // Rank by clarity, but treat scenes within 10 points as equivalent and prefer the
  // newer one — freshness matters and marginal clarity gains do not.
  usable.sort((a, b) => {
    const d = b.clarity.clearPct - a.clarity.clearPct
    if (Math.abs(d) > 10) return d
    const da = String(a.item?.properties?.datetime ?? '')
    const db = String(b.item?.properties?.datetime ?? '')
    return db.localeCompare(da)
  })

  // Walk down the ranking; a scene the plausibility gate refuses is recorded and skipped.
  for (const cand of usable) {
    const speculative = opts.speculate?.(cand.item, cand.clarity)
    speculative?.catch(() => {}) // an abandoned candidate's failure is not an error
    const reason = gate ? await gate(cand.item, cand.clarity) : null
    if (!reason) return { item: cand.item, clarity: cand.clarity, examined, rejected, ...(speculative ? { speculative } : {}) }
    log.warn({ scene: cand.item?.id, reason }, 'scene rejected by reflectance plausibility gate')
    const row = examined.find((e) => e.id === String(cand.item?.id ?? 'unknown'))
    if (row) row.rejection = reason
    rejected.push({
      id: String(cand.item?.id ?? 'unknown'),
      date: String(cand.item?.properties?.datetime ?? '').slice(0, 10),
      reason,
    })
  }
  return null
}

/** Caveat line for a result whose chosen scene displaced gate-rejected candidates. */
export function rejectedScenesNote(choice: Pick<ClearSceneChoice, 'rejected'>): string | null {
  if (!choice.rejected.length) return null
  return `Skipped ${choice.rejected.map((r) => `${r.date} (${r.id})`).join(', ')}: ${choice.rejected[0].reason}.`
}

/**
 * Pick the scene with the most AOI-local clear sky.
 *
 * Candidates are scored concurrently in batches of `maxCandidates` and ranked by clear fraction, with a
 * mild recency preference between scenes of comparable clarity — a 5-point clarity
 * gain does not justify a much older scene when both are usable.
 *
 * Returns `null` when no candidate reaches `MIN_USABLE_CLEAR_PCT` **or observes at
 * least `MIN_AOI_COVERAGE_PCT` of the polygon** (ISS-125) — a scene that is 100%
 * clear over the 2% of the AOI it clips is not a usable scene. The caller must
 * then refuse honestly and report `examined` so the user sees what was tried.
 */
export async function pickClearestScene(
  items: any[],
  geom: any,
  opts: SceneChoiceOptions = {},
): Promise<ClearSceneChoice | null> {
  const { maxSize = 96, maxCandidates = 6 } = opts
  if (items.length === 0) return null

  // Score in batches (newest first) and stop at the first batch that yields a usable
  // scene. Looking at only the first `maxCandidates` items was the Q-60 root cause: a
  // date carries one item per MGRS tile, so six items spanned three dates, all clouded or
  // clipping the AOI, and the clear scene one batch further down was never scored.
  const examined: ExaminedScene[] = []
  const rejected: RejectedScene[] = []
  for (let start = 0; start < items.length; start += maxCandidates) {
    const batch = items.slice(start, start + maxCandidates)
    const scored = await Promise.all(
      batch.map(async (item) => ({ item, clarity: await sceneClarity(item, geom, maxSize) })),
    )
    const choice = await chooseScene(scored, opts, (item, clarity) => reflectanceGate(item, geom, clarity, maxSize), rejected)
    if (choice) return { ...choice, examined: [...examined, ...choice.examined] }
    for (const { item, clarity } of scored) examined.push(examinedRow(item, clarity))
  }
  // Nothing usable anywhere; callers build the refusal from `examinedScenes`.
  return null
}

/**
 * Build a per-pixel predicate keeping only clear pixels, for use with `gridStats`.
 * The quality grid and the data grid must come from the same scene at the same
 * `maxSize`, so their pixel arrays align index-for-index.
 */
export function clearPixelFilter(clarity: SceneClarity): (index: number) => boolean {
  const q = clarity.grid.values
  if (clarity.kind === 'landsat-qa') return (i: number) => landsatQaIsClear(q[i])
  return (i: number) => CLEAR_CLASSES.has(Math.round(q[i]))
}

/** One-line, user-facing description of scene quality over the AOI. */
export function clarityNote(clarity: SceneClarity): string {
  const top = clarity.breakdown.slice(0, 3)
    .map((b) => `${b.label} ${b.pct.toFixed(0)}%`)
    .join(', ')
  return `${clarity.clearPct.toFixed(0)}% of the AOI was clear (${top})`
}

/** Honest refusal text when every candidate scene is clouded over the AOI. */
export function noClearSceneMessage(
  examined: ClearSceneChoice['examined'],
  windowLabel: string,
): string {
  const rows = examined
    .map((e) => `- ${e.date}: ${e.aoiClearPct.toFixed(0)}% clear over your AOI` +
      (e.aoiCoveragePct != null ? `, covering ${e.aoiCoveragePct.toFixed(0)}% of it` : '') +
      (e.sceneCloudPct != null ? ` (scene-wide cloud ${e.sceneCloudPct.toFixed(0)}%)` : '') +
      (e.rejection ? ` — REJECTED: ${e.rejection}` : ''))
    .join('\n')

  // Two different failures need two different pieces of advice: waiting helps
  // cloud, and nothing about waiting helps an AOI that straddles a tile edge.
  const clipping = examined.some(
    (e) => e.aoiCoveragePct != null && e.aoiCoveragePct < MIN_AOI_COVERAGE_PCT
      && e.aoiClearPct >= MIN_USABLE_CLEAR_PCT,
  )
  const headline = clipping
    ? `**No usable Sentinel-2 scene — every candidate was either clouded over the AOI or only clipped it.**`
    : `**No usable Sentinel-2 scene — the AOI was under cloud in every candidate.**`
  const advice = clipping
    ? `**What to do:** a scene that observes under ${MIN_AOI_COVERAGE_PCT}% of the polygon is rejected even when ` +
      `that sliver is clear, because its mean would be labelled as the whole AOI's value. Widen the date range ` +
      `so a fully-covering overpass is available, or draw the AOI inside one scene footprint.`
    : `**What to do:** widen the date range, wait for the next clear overpass, or use ` +
      `\`fetch_sar\` — Sentinel-1 radar penetrates cloud and works in any weather.`

  return [
    headline,
    '',
    `Scenes checked (${windowLabel}), scored on cloud **over your polygon** rather than scene-wide metadata:`,
    rows || '- (none returned)',
    '',
    `A spectral index computed here would measure cloud-top reflectance, not the ground, so no value is reported.`,
    '',
    advice,
  ].join('\n')
}

export { gridStats }
