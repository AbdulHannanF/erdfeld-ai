/** Cloud-masked, polygon-clipped expression grids at near-native resolution — the
 *  raster side of the digitizing tools (`vectorize_raster`, `delineate_fields`).
 *
 *  One titiler `feature.npy` request carries the bands AND the SCL asset so the data
 *  and the cloud mask sit on one common grid (the same reason `analysis/grid-source`
 *  does it: `max_size` is a cap, and a 10 m band and the 20 m SCL come back at
 *  different shapes when requested separately). The formula is evaluated here, after
 *  the DN→reflectance transform, never by titiler (ISS-131).
 */

import { cachedFetchJson } from '../cache'
import { CLEAR_CLASSES, SCL, geomBboxOf } from '../cloud'
import { compileBandExpression } from '../analysis/band-expression'
import { getLogger } from '../logger'
import { fetchFeatureGrid } from '../pixels'
import { buildIndexValues, resolveBandSetReflectance } from '../reflectance'
import { getStacItemHref, pickAssetKey, STAC_SEARCH_URL, toRfc3339Interval } from '../stac'
import { makeGeoref, type BBox } from '../vectorize'

const log = getLogger('agent/digitize')

/** Sentinel-2 native pixel the digitizing tools target. */
export const S2_GSD_M = 10

/** Band names accepted in user expressions → candidate STAC asset keys (Earth Search, then B-numbers). */
const BAND_ALIASES: Record<string, string[]> = {
  blue: ['blue', 'B02'], b02: ['blue', 'B02'],
  green: ['green', 'B03'], b03: ['green', 'B03'],
  red: ['red', 'B04'], b04: ['red', 'B04'],
  rededge1: ['rededge1', 'B05'], b05: ['rededge1', 'B05'],
  rededge2: ['rededge2', 'B06'], b06: ['rededge2', 'B06'],
  rededge3: ['rededge3', 'B07'], b07: ['rededge3', 'B07'],
  nir: ['nir', 'B08'], b08: ['nir', 'B08'],
  nir08: ['nir08', 'B8A'], b8a: ['nir08', 'B8A'],
  swir16: ['swir16', 'B11'], swir1: ['swir16', 'B11'], b11: ['swir16', 'B11'],
  swir22: ['swir22', 'B12'], swir2: ['swir22', 'B12'], b12: ['swir22', 'B12'],
}

export interface ResolvedExpression {
  /** One candidate-key list per positional band (b1, b2, …). */
  bandKeys: string[][]
  evaluate: (bands: ArrayLike<number>) => number
  /** The expression with band names (for display). */
  display: string
}

/** Turn "(nir - red) / (nir + red)" into a compiled positional expression. Throws a
 *  user-surfaceable Error for unknown bands or anything the evaluator cannot parse. */
export function resolveExpression(expr: string): ResolvedExpression {
  const display = String(expr || '').trim()
  if (!display) throw new Error('empty expression')
  if (!/^[A-Za-z0-9_.+\-*/() \t]+$/.test(display)) {
    throw new Error('expressions may only use band names, numbers, + - * / and parentheses')
  }
  const order: string[] = []
  const positional = display.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name) => {
    const key = name.toLowerCase()
    if (!BAND_ALIASES[key]) {
      throw new Error(`unknown band "${name}" (use: ${[...new Set(Object.keys(BAND_ALIASES).filter((k) => !/^b\d/.test(k)))].join(', ')})`)
    }
    let i = order.indexOf(key)
    if (i < 0) { order.push(key); i = order.length - 1 }
    return `b${i + 1}`
  })
  return { bandKeys: order.map((k) => BAND_ALIASES[k]), evaluate: compileBandExpression(positional), display }
}

/** Longest-edge pixel budget that lands near `targetGsdM`, capped at `cap` px. */
export function chooseMaxSize(geom: any, targetGsdM = S2_GSD_M, cap = 1000) {
  const bbox = geomBboxOf(geom)
  if (!bbox) return null
  const [minLng, minLat, maxLng, maxLat] = bbox
  const wM = (maxLng - minLng) * 111_320 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180)
  const hM = (maxLat - minLat) * 110_540
  const longest = Math.max(wM, hM)
  const wanted = Math.ceil(longest / targetGsdM)
  const maxSize = Math.max(32, Math.min(cap, wanted))
  return { maxSize, extentM: [wM, hM] as [number, number], gsdM: longest / maxSize, capped: wanted > cap, bbox }
}

export type SearchOutcome = { ok: true; items: any[] } | { ok: false; message: string }

/** Cached Sentinel-2 L2A search. A failed request is `ok:false`, distinct from `ok:true` with no items. */
export async function searchSentinel2(bbox: BBox, datetime: string, limit = 100): Promise<SearchOutcome> {
  const body = {
    collections: ['sentinel-2-l2a'],
    bbox,
    datetime: toRfc3339Interval(datetime),
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    limit,
  }
  try {
    const data = await cachedFetchJson(`digitize-stac:${JSON.stringify(body)}`, 10 * 60 * 1000, async () => {
      const res = await fetch(STAC_SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25_000),
      })
      if (!res.ok) throw new Error(`STAC HTTP ${res.status}`)
      return res.json()
    })
    return { ok: true, items: (data?.features as any[]) ?? [] }
  } catch (err: any) {
    log.warn({ err: err?.message }, 'sentinel-2 search failed')
    return { ok: false, message: `The Sentinel-2 catalogue search failed (${err?.message ?? 'unknown error'}).` }
  }
}

export interface MaskedGrid {
  /** Expression values; NaN where cloud / shadow / cirrus / invalid / outside the polygon. */
  values: Float32Array
  /** 1 where the pixel is inside the polygon and observed (SCL ≠ no-data). */
  inside: Uint8Array
  width: number
  height: number
  bbox: BBox
  cellXm: number
  cellYm: number
  insidePx: number
  clearPx: number
  clearPct: number
  sceneId: string
  date: string
  reflectanceNote: string
  /** Second index over the same bands and mask (see `extra` in `readMaskedGrid`), when asked for. */
  extraValues?: Float32Array
}

export type MaskedGridOutcome =
  | { ok: true; grid: MaskedGrid }
  | { ok: false; reason: 'missing_assets' | 'fetch_failed' | 'no_pixels'; message: string }

/**
 * Read `evaluate(bands)` for one scene on the polygon's grid, with cloud/shadow/cirrus
 * (and optionally snow) masked per pixel from the SCL band of the same request.
 */
export async function readMaskedGrid(opts: {
  item: any
  geom: any
  bandKeys: string[][]
  evaluate: (bands: ArrayLike<number>) => number
  /** Label for plausibility bounds / logs (e.g. "NDVI"). */
  label: string
  maxSize: number
  bounds?: [number, number]
  dropSnow?: boolean
  cacheTag?: string
  /** A second index computed from the same bands in the same read (shares the cloud mask). */
  extra?: { label: string; evaluate: (bands: ArrayLike<number>) => number }
}): Promise<MaskedGridOutcome> {
  const { item, geom, maxSize } = opts
  const bbox = geomBboxOf(geom)
  const itemHref = getStacItemHref(item)
  const keys = opts.bandKeys.map((k) => pickAssetKey(item, k))
  const sclKey = pickAssetKey(item, ['scl', 'SCL'])
  if (!bbox || !itemHref || !sclKey || keys.some((k) => k === null)) {
    return {
      ok: false,
      reason: 'missing_assets',
      message: `Scene ${String(item?.id ?? 'unknown')} lacks the band or SCL assets needed for ${opts.label}.`,
    }
  }

  let raw
  try {
    raw = await fetchFeatureGrid({
      itemHref,
      assets: [...(keys as string[]), sclKey],
      geom,
      maxSize,
      cacheTag: opts.cacheTag ?? `digitize-${opts.label}-${maxSize}`,
    })
  } catch (err: any) {
    return { ok: false, reason: 'fetch_failed', message: `titiler could not return the clipped pixels (${err?.message ?? 'unknown error'}).` }
  }

  const nBands = keys.length
  if (raw.bands < nBands + 2) {
    return {
      ok: false,
      reason: 'fetch_failed',
      message: `titiler returned ${raw.bands} bands for a ${nBands}-band + SCL read; the cloud mask cannot be matched to the data.`,
    }
  }
  const px = raw.width * raw.height
  const scl = raw.raw.subarray(nBands * px, (nBands + 1) * px)
  const inside = new Uint8Array(px)
  const clear = new Uint8Array(px)
  let insidePx = 0
  for (let i = 0; i < px; i++) {
    if (!raw.mask[i]) continue
    const cls = Math.round(scl[i])
    if (cls === SCL.NO_DATA) continue
    inside[i] = 1
    insidePx++
    if (CLEAR_CLASSES.has(cls) && !(opts.dropSnow && cls === SCL.SNOW)) clear[i] = 1
  }
  if (insidePx === 0) {
    return { ok: false, reason: 'no_pixels', message: `Scene ${String(item?.id ?? 'unknown')} returned no observed pixels inside the polygon.` }
  }

  const reflectance = resolveBandSetReflectance(item, keys as string[], { isSentinel2: true })
  const built = buildIndexValues({
    raw: raw.raw,
    px,
    nBands,
    transforms: reflectance.transforms,
    index: opts.label,
    evaluate: opts.evaluate as (b: Float64Array) => number,
    include: (i) => clear[i] === 1,
    baseNote: reflectance.note,
    bounds: opts.bounds,
  })
  const values = new Float32Array(built.values)
  const extraValues = opts.extra
    ? new Float32Array(buildIndexValues({
      raw: raw.raw,
      px,
      nBands,
      transforms: reflectance.transforms,
      index: opts.extra.label,
      evaluate: opts.extra.evaluate as (b: Float64Array) => number,
      include: (i) => clear[i] === 1,
      baseNote: reflectance.note,
    }).values)
    : undefined
  const geo = makeGeoref(bbox, raw.width, raw.height)
  return {
    ok: true,
    grid: {
      values,
      inside,
      width: raw.width,
      height: raw.height,
      bbox,
      cellXm: geo.cellXm,
      cellYm: geo.cellYm,
      insidePx,
      clearPx: built.validCount,
      clearPct: (built.validCount / insidePx) * 100,
      sceneId: String(item?.id ?? 'unknown'),
      date: String(item?.properties?.datetime ?? '').slice(0, 10),
      reflectanceNote: built.note,
      extraValues,
    },
  }
}
