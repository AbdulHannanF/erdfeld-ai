/** The single substrate `analyze_raster` operates on: a polygon-clipped,
 *  cloud-masked pixel grid for a spectral index over the AOI.
 *
 *  Every operation in `operations.ts` runs on the grid this module returns, so
 *  cloud masking is not something an operation can forget — a pixel under cloud
 *  is simply not `valid`. This reuses Phase 0's `pickClearestScene` /
 *  `sceneClarity` rather than reimplementing screening (spec §3.6 B).
 *
 *  Resolution note: statistics elsewhere read at `max_size` 96, which is ample
 *  for a mean but far too coarse for spatial structure — a 4 km AOI at 96 px is
 *  43 m/px, so a "40 m lag" variogram would have one lag per pixel. This module
 *  defaults to 256 and allows 512, and always reports the cell size it actually
 *  got so the caller can refuse a lag finer than the pixel.
 */

import { cachedFetchJson } from '../cache'
import {
  pickClearestScene,
  aoiCoveragePct,
  CLEAR_CLASSES,
  CONTAMINATED_CLASSES,
  MIN_AOI_COVERAGE_PCT,
  MIN_USABLE_CLEAR_PCT,
  SCL,
  SCL_LABELS,
  type SceneClarity,
} from '../cloud'
import { fetchFailureNote } from '../fetch-failure'
import { getLogger } from '../logger'
import { fetchFeatureGrid, toGeometry } from '../pixels'
import { getStacItemHref, pickAssetKey, STAC_SEARCH_URL, toRfc3339Interval } from '../stac'
import { buildIndexValues, resolveBandSetReflectance } from '../reflectance'
import { SPECTRAL_INDEX_TILE_CONFIG } from '../titiler'
import turfArea from '@turf/area'
import { compileBandExpression, toPositionalExpression } from './band-expression'
import { makeGrid, type AnalysisGrid } from './operations'

const log = getLogger('agent/analysis')

/** Default longest-edge pixel budget for an analysis read. */
export const DEFAULT_ANALYSIS_MAX_SIZE = 256
/** Hard ceiling — 512² float64 over two bands is ~4 MB from titiler. */
export const MAX_ANALYSIS_MAX_SIZE = 512

export const SUPPORTED_INDICES = Object.keys(SPECTRAL_INDEX_TILE_CONFIG)

export interface SceneInfo {
  id: string
  date: string
  /** Scene-wide cloud from STAC metadata — context only, never a decision input. */
  sceneCloudPct: number | null
  /** % of the AOI polygon that was clear in this scene. */
  clearPct: number
}

export interface LoadedGrid {
  grid: AnalysisGrid
  scene: SceneInfo
  clarity: SceneClarity
  /** Pixels inside the polygon before the clear-sky filter. */
  insidePolygon: number
  /** Pixels that survived cloud masking. */
  clearPixels: number
  /** % of the drawn polygon's own area the scene actually observed. */
  coveragePct: number
  /** How DN was converted to reflectance before the index formula ran (ISS-131). */
  reflectanceNote: string
}

/**
 * Coverage now lives in `lib/cloud.ts`, beside scene selection — the Phase 0
 * tools needed the same guard (ISS-125) and they all pass through the pickers,
 * not through this module. Re-exported so existing importers are unaffected and
 * there is still exactly one definition.
 */
export { MIN_AOI_COVERAGE_PCT, aoiCoveragePct }

export type LoadOutcome =
  | { ok: true; loaded: LoadedGrid }
  | { ok: false; message: string }

function normalizeIndex(index: string): string | null {
  const key = String(index || '').toUpperCase().trim()
  return SPECTRAL_INDEX_TILE_CONFIG[key] ? key : null
}

/** Cached Sentinel-2 L2A search over the AOI bbox. THROWS on a failed request: an empty array
 *  means the catalogue answered and holds no scene, which callers report differently (Q-06). */
async function searchS2(
  bbox: [number, number, number, number],
  datetime: string,
  limit: number,
  direction: 'asc' | 'desc' = 'desc',
): Promise<any[]> {
  const body = {
    collections: ['sentinel-2-l2a'],
    bbox,
    datetime: toRfc3339Interval(datetime),
    sortby: [{ field: 'properties.datetime', direction }],
    limit,
  }
  try {
    const data = await cachedFetchJson(`analysis-stac:${JSON.stringify(body)}`, 10 * 60 * 1000, async () => {
      const res = await fetch(STAC_SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) throw new Error(`STAC HTTP ${res.status}`)
      return res.json()
    })
    return (data?.features as any[]) ?? []
  } catch (err: any) {
    log.warn({ err: err?.message }, 'analysis STAC search failed')
    throw err
  }
}

const S2_CATALOGUE = 'the Sentinel-2 catalogue (AWS Earth Search)'

/** Build the date window: a ±`padDays` interval around `date`, else the last
 *  `lookbackDays`. Date-only strings are normalised upstream by `toRfc3339Interval`. */
export function dateWindow(
  date?: string,
  opts: { padDays?: number; lookbackDays?: number; side?: SceneSide } = {},
): { datetime: string; label: string } {
  const lookbackDays = opts.lookbackDays ?? 120
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const centre = new Date(`${date}T00:00:00Z`)
    if (opts.side) {
      // One-sided: scenes on or before (or after) the date, so a before/after pair brackets an
      // interval instead of both scenes landing inside it.
      const padDays = opts.padDays ?? BRACKET_PAD_DAYS
      const other = new Date(centre)
      other.setUTCDate(other.getUTCDate() + (opts.side === 'before' ? -padDays : padDays))
      const [from, to] = opts.side === 'before' ? [other, centre] : [centre, other]
      return {
        datetime: `${from.toISOString().slice(0, 10)}/${to.toISOString().slice(0, 10)}`,
        label: opts.side === 'before' ? `the ${padDays} days up to ${date}` : `the ${padDays} days from ${date}`,
      }
    }
    const padDays = opts.padDays ?? 30
    const from = new Date(centre); from.setUTCDate(from.getUTCDate() - padDays)
    const to = new Date(centre); to.setUTCDate(to.getUTCDate() + padDays)
    return {
      datetime: `${from.toISOString().slice(0, 10)}/${to.toISOString().slice(0, 10)}`,
      label: `±${padDays} days around ${date}`,
    }
  }
  const to = new Date()
  const from = new Date(); from.setDate(from.getDate() - lookbackDays)
  return {
    datetime: `${from.toISOString().slice(0, 10)}/${to.toISOString().slice(0, 10)}`,
    label: `last ${lookbackDays} days`,
  }
}

/** Which side of a date a scene may come from: 'before' = on or before it, 'after' = on or after. */
export type SceneSide = 'before' | 'after'
/** One-sided search width. Sentinel-2 revisits every ~5 days, so 45 days offers about nine passes to
 *  find a clear one without drifting a season away from the date. */
export const BRACKET_PAD_DAYS = 45

export interface LoadIndexGridOptions {
  index: string
  aoi: any
  bbox: [number, number, number, number]
  /** Target date; the clearest scene within ±30 days of it is used. */
  date?: string
  /** Take the scene from one side of `date` instead of ±30 days around it. */
  side?: SceneSide
  maxSize?: number
  /** Minimum AOI-local clear fraction for a scene to be usable. */
  minClearPct?: number
  /** Reuse an already-chosen scene (change/correlate pin both reads to one scene). */
  item?: any
}

/**
 * Load one cloud-masked, polygon-clipped index grid.
 *
 * Two-stage clarity: candidates are ranked cheaply at 96 px, then the winner's
 * quality band is re-read at the analysis resolution so its mask aligns
 * pixel-for-pixel with the index grid. Reading the index at 256 px and the mask
 * at 96 px would mask the wrong pixels — silently, and everywhere.
 */
export async function loadIndexGrid(opts: LoadIndexGridOptions): Promise<LoadOutcome> {
  const key = normalizeIndex(opts.index)
  if (!key) {
    return {
      ok: false,
      message: `Unsupported index "${opts.index}". Supported: ${SUPPORTED_INDICES.join(', ')}.`,
    }
  }

  const geom = toGeometry(opts.aoi)
  if (!geom) {
    return {
      ok: false,
      message: 'A polygon AOI is required for polygon-clipped analysis (draw a polygon, rectangle, or circle).',
    }
  }

  const maxSize = Math.max(32, Math.min(MAX_ANALYSIS_MAX_SIZE, Math.round(opts.maxSize ?? DEFAULT_ANALYSIS_MAX_SIZE)))
  const minClearPct = opts.minClearPct ?? MIN_USABLE_CLEAR_PCT

  let item = opts.item ?? null
  let clarity: SceneClarity | null = null
  const window = dateWindow(opts.date, { side: opts.side })

  if (!item) {
    let items: any[]
    try {
      // Newest first, except for "on or after a date", where the passes nearest the date come first.
      items = await searchS2(opts.bbox, window.datetime, 12, opts.side === 'after' ? 'asc' : 'desc')
    } catch (err) {
      return { ok: false, message: fetchFailureNote(S2_CATALOGUE, err) }
    }
    if (items.length === 0) {
      return {
        ok: false,
        message: `No Sentinel-2 L2A scene covers this AOI in the ${window.label} (AWS Earth Search).`,
      }
    }
    const choice = await pickClearestScene(items, geom, { minClearPct, maxCandidates: 6 })
    if (!choice) {
      const rows = items.slice(0, 6)
        .map((it: any) => `- ${String(it?.properties?.datetime ?? '').slice(0, 10)}`)
        .join('\n')
      return {
        ok: false,
        message:
          `**No usable Sentinel-2 scene — the AOI was under cloud in every candidate** ` +
          `(${window.label}, scored on cloud over your polygon via SCL, not scene-wide metadata).\n${rows}\n\n` +
          `Any statistic computed here would describe cloud tops, so none is reported. ` +
          `Widen the date range, or use \`fetch_sar\` — Sentinel-1 radar sees through cloud.`,
      }
    }
    item = choice.item
  }

  const cfg = SPECTRAL_INDEX_TILE_CONFIG[key]
  const itemHref = getStacItemHref(item)
  const bandKeys = cfg.bandKeys.map((keys) => pickAssetKey(item, keys))
  const sclKey = pickAssetKey(item, ['scl', 'SCL'])
  if (!itemHref || bandKeys.some((k) => k === null) || !sclKey) {
    return {
      ok: false,
      message:
        `Scene ${String(item?.id ?? 'unknown')} is missing the band or SCL assets required for a ` +
        `cloud-masked ${key} analysis.`,
    }
  }

  let evaluate
  try {
    evaluate = compileBandExpression(toPositionalExpression(cfg.exprTemplate))
  } catch (err: any) {
    return { ok: false, message: `The ${key} formula could not be evaluated (${err?.message}).` }
  }

  // ONE request carrying the bands AND the SCL asset. Two requests do not
  // guarantee a common grid: `max_size` is a cap, so 10 m bands returned
  // 256×256 while the 20 m SCL band returned 210×210 over the same polygon
  // (measured 2026-08-11). Masking across those would mask the wrong pixels.
  let raw
  try {
    raw = await fetchFeatureGrid({
      itemHref,
      assets: [...(bandKeys as string[]), sclKey],
      geom,
      maxSize,
      cacheTag: `analyze-${key}-${maxSize}`,
    })
  } catch (err: any) {
    return {
      ok: false,
      message:
        `titiler could not return the clipped ${key} pixel array (${err?.message ?? 'unknown error'}). ` +
        `The public titiler.xyz instance is rate-limited — retry, or self-host (TITILER_ENDPOINT).`,
    }
  }

  const nBands = bandKeys.length
  // Layout: [band1 … bandN, scl, validity-mask].
  if (raw.bands < nBands + 2) {
    return {
      ok: false,
      message:
        `titiler returned ${raw.bands} bands for a ${nBands}-band + SCL ${key} read; the cloud mask cannot be ` +
        `matched to the data. No value reported.`,
    }
  }
  const px = raw.width * raw.height
  const sclBand = raw.raw.subarray(nBands * px, (nBands + 1) * px)

  // ISS-131: resolve the DN->reflectance transform from the item itself. These are
  // earth-search items, which declare `raster:bands.scale/offset` per asset; the
  // Sentinel-2 baseline rule is the fallback for any item that does not.
  const reflectance = resolveBandSetReflectance(item, bandKeys as string[], { isSentinel2: true })
  const transforms = reflectance.transforms

  const counts = new Map<number, number>()
  let insidePolygon = 0
  let cloudPx = 0
  let snowPx = 0
  let waterPx = 0

  // First pass: classify every pixel from SCL so the clarity report and the
  // clear-pixel filter are decided before any band arithmetic happens.
  const clearMask = new Uint8Array(px)
  for (let i = 0; i < px; i++) {
    if (!raw.mask[i]) continue
    const cls = Math.round(sclBand[i])
    if (cls === SCL.NO_DATA) continue
    insidePolygon++
    counts.set(cls, (counts.get(cls) ?? 0) + 1)
    if (CONTAMINATED_CLASSES.has(cls)) cloudPx++
    if (cls === SCL.SNOW) snowPx++
    if (cls === SCL.WATER) waterPx++
    if (CLEAR_CLASSES.has(cls)) clearMask[i] = 1
  }

  // Second pass: DN -> reflectance, then the formula. ISS-131 — the scale cancels in
  // a ratio but an additive BOA offset does not, and whether one is present depends on
  // which catalogue served the pixels. See lib/reflectance.ts.
  const built = buildIndexValues({
    raw: raw.raw,
    px,
    nBands,
    transforms,
    index: key,
    evaluate,
    include: (i) => clearMask[i] === 1,
    baseNote: reflectance.note,
  })
  const values = built.values
  const valid = new Uint8Array(px)
  for (let i = 0; i < px; i++) if (Number.isFinite(values[i])) valid[i] = 1
  const clearPixels = built.validCount

  if (insidePolygon === 0) {
    return { ok: false, message: `titiler returned no in-polygon pixels for scene ${String(item?.id ?? 'unknown')}.` }
  }

  const grid0 = makeGrid(values, valid, raw.width, raw.height, opts.bbox, key)
  const coveragePct = aoiCoveragePct(geom, insidePolygon, grid0.cellXm, grid0.cellYm)
  if (coveragePct < MIN_AOI_COVERAGE_PCT) {
    return {
      ok: false,
      message:
        `Scene ${String(item?.id ?? 'unknown')} (${String(item?.properties?.datetime ?? '').slice(0, 10)}) ` +
        `covers only ${coveragePct.toFixed(0)}% of the drawn polygon — its footprint clips the AOI. ` +
        `A ${key} statistic from that sliver would be labelled as the whole AOI's value while describing ` +
        `a different area, so none is reported. Try a different date, or draw the AOI inside one scene footprint.`,
    }
  }

  const clearPct = (clearPixels / insidePolygon) * 100
  if (clearPct < minClearPct) {
    return {
      ok: false,
      message:
        `Only ${clearPct.toFixed(0)}% of the AOI was clear in scene ${String(item?.id ?? 'unknown')} ` +
        `(needs ≥${minClearPct}%). A ${key} analysis here would largely measure cloud.`,
    }
  }

  clarity = {
    kind: 'scl',
    clearPct,
    cloudPct: (cloudPx / insidePolygon) * 100,
    snowPct: (snowPx / insidePolygon) * 100,
    waterPct: (waterPx / insidePolygon) * 100,
    totalPx: insidePolygon,
    clearPx: clearPixels,
    coveragePct,
    breakdown: [...counts.entries()]
      .map(([cls, c]) => ({ label: SCL_LABELS[cls] ?? `class ${cls}`, pct: (c / insidePolygon) * 100 }))
      .sort((a, b) => b.pct - a.pct),
    // The SCL values live on the same grid as the data, so this IS the mask.
    grid: { ...raw, values: Float64Array.from(sclBand) },
  }

  return {
    ok: true,
    loaded: {
      grid: grid0,
      clarity,
      insidePolygon,
      clearPixels,
      coveragePct,
      reflectanceNote: built.note,
      scene: {
        id: String(item?.id ?? 'unknown'),
        date: String(item?.properties?.datetime ?? '').slice(0, 10),
        sceneCloudPct:
          typeof item?.properties?.['eo:cloud_cover'] === 'number'
            ? item.properties['eo:cloud_cover'] : null,
        clearPct,
      },
    },
  }
}

/** Pick the clearest scene once so two reads (correlate / cluster) share it. */
export async function pickSceneForAoi(
  aoi: any,
  bbox: [number, number, number, number],
  date?: string,
  minClearPct = MIN_USABLE_CLEAR_PCT,
): Promise<{ ok: true; item: any } | { ok: false; message: string }> {
  const geom = toGeometry(aoi)
  if (!geom) return { ok: false, message: 'A polygon AOI is required for polygon-clipped analysis.' }
  const window = dateWindow(date)
  let items: any[]
  try {
    items = await searchS2(bbox, window.datetime, 12)
  } catch (err) {
    return { ok: false, message: fetchFailureNote(S2_CATALOGUE, err) }
  }
  if (items.length === 0) {
    return { ok: false, message: `No Sentinel-2 L2A scene covers this AOI in the ${window.label}.` }
  }
  const choice = await pickClearestScene(items, geom, { minClearPct, maxCandidates: 6 })
  if (!choice) {
    return {
      ok: false,
      message:
        `No usable Sentinel-2 scene — the AOI was under cloud in every candidate in the ${window.label}. ` +
        `No statistic is reported, because it would describe cloud tops.`,
    }
  }
  return { ok: true, item: choice.item }
}

/** Provenance sentence describing exactly how a grid was produced. */
export function gridMethodNote(loaded: LoadedGrid, extra?: string): string {
  const g = loaded.grid
  return (
    `per-pixel ${g.label} from titiler /stac/feature.npy, clipped to the drawn polygon at ` +
    `${g.width}×${g.height} (~${Math.round((g.cellXm + g.cellYm) / 2)} m/px); ` +
    `SCL cloud/shadow/cirrus masked (${loaded.clearPixels} clear of ${loaded.insidePolygon} observed pixels, ` +
    `${loaded.scene.clearPct.toFixed(0)}% clear); the scene covers ${loaded.coveragePct.toFixed(0)}% ` +
    `of the polygon; ${loaded.reflectanceNote}` + (extra ? `; ${extra}` : '')
  )
}
