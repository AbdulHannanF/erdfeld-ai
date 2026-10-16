/** Phase 4 — multi-sensor, multi-decade index grids on ONE common grid.
 *
 *  WHY THIS MODULE EXISTS, AND WHY IT REFUSES TO MIX SENSORS
 *  --------------------------------------------------------
 *  The spec asks to "compare any two dates at the best resolution available for
 *  **both**". That last word is the whole design, and it is a correctness
 *  constraint rather than a nicety. Measured 2026-08-16 over one polygon at
 *  Luxor, same day, both scenes clear over the AOI:
 *
 *      date          Sentinel-2 NDVI   Landsat NDVI   difference
 *      2026-07-15         0.2029          0.3103        -0.107
 *      2026-07-23         0.2342          0.3129        -0.079
 *      2026-08-07/08      0.2921          0.3127        -0.021
 *
 *  Sentinel-2 rose 0.203 -> 0.292 across three weeks while Landsat sat flat at
 *  ~0.31 over the same ground. The disagreement is not a constant either, so no
 *  single harmonisation coefficient removes it — and at 0.02-0.11 it is larger
 *  than most of the multi-decade signals a change vector is asked to find. A
 *  cross-sensor comparison would therefore report *the instrument* as land-cover
 *  change. So a pair is answered by ONE sensor covering BOTH dates, and mixing
 *  is possible only when the caller explicitly asks and accepts the caveat.
 *
 *  Two further things this module gets right that a naive port would not:
 *
 *  - **Explicit `width`/`height`, never `max_size`.** `max_size` is a CAP
 *    (ISS-126), so two reads of the same polygon can return different shapes —
 *    and across sensors at 10 m and 30 m they certainly would. Both dates are
 *    requested at the same explicit grid, verified honoured: a request for
 *    80x80 returns `shape (4, 80, 80)`.
 *  - **Landsat surface reflectance is scaled.** C2 L2 is `DN * 0.0000275 - 0.2`.
 *    An index is a ratio, so the SCALE cancels — but the OFFSET does not.
 *    Measured on one scene: NDVI 0.157 unscaled vs 0.313 scaled. Skipping it is
 *    a factor-of-two error, not a rounding detail.
 *
 *  Everything reads through Planetary Computer's own titiler, which signs its
 *  blobs internally and is key-free, so both sensors share one code path.
 */

import { cachedFetchJson } from '../cache'
import { landsatQaIsClear, CLEAR_CLASSES, SCL } from '../cloud'
import { getLogger } from '../logger'
import { parseNpy } from '../npy'
import { toGeometry } from '../pixels'
import { buildIndexValues, resolveBandSetReflectance } from '../reflectance'
import { toRfc3339Interval } from '../stac'
import { SPECTRAL_INDEX_TILE_CONFIG } from '../titiler'
import { compileBandExpression, toPositionalExpression } from './band-expression'

const log = getLogger('agent/sensors')

export const PC_STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1/search'
export const PC_DATA = 'https://planetarycomputer.microsoft.com/api/data/v1'

export type SensorId = 'sentinel-2-l2a' | 'landsat-c2-l2'
export type QualityKind = 'scl' | 'landsat-qa'

export interface SensorSpec {
  id: SensorId
  label: string
  /** Planetary Computer collection id. */
  collection: string
  /** First acquisition in the archive (ISO date). */
  from: string
  /** Native ground sample distance of the optical bands, in metres. */
  nativeResM: number
  /** DN -> surface reflectance. The offset is what makes this load-bearing. */
  scale: number
  offset: number
  /** Quality band asset name and how to read it. */
  qualityAsset: string
  qualityKind: QualityKind
  /** Index band name -> this sensor's asset key. */
  bandAlias: Record<string, string>
}

/** Ordered finest-first, which is also the preference order. */
export const SENSORS: SensorSpec[] = [
  {
    id: 'sentinel-2-l2a',
    label: 'Sentinel-2 L2A',
    collection: 'sentinel-2-l2a',
    from: '2015-06-27',
    nativeResM: 10,
    // ISS-131. This used to read `scale: 1, offset: 0` with a comment claiming
    // "L2A is already 0..10000 reflectance with no additive offset on the
    // baselines PC serves". That was measured and found false: on one Lake
    // Nasser AOI, SCL-classified water reads 97 DN in a baseline-02.12 scene
    // and 1215 DN in a baseline-05.12 scene — the BOA_ADD_OFFSET of -1000 that
    // baseline 04.00 introduced, which PC does not declare anywhere in its STAC
    // metadata. Left uncorrected it made a processing-baseline change look like
    // a -0.26 NDVI change, which is precisely the artefact-as-change failure
    // this module exists to prevent.
    //
    // These stay as the FALLBACK only. The transform actually applied is
    // resolved per item by `resolveReflectance` from the PRODUCER, because the
    // STAC metadata cannot be trusted here: PC declares no `raster:bands` while
    // serving the offset, and earth-search declares `offset: -0.1` while serving
    // pixels that no longer contain it. See lib/reflectance.ts.
    scale: 0.0001,
    offset: 0,
    qualityAsset: 'SCL',
    qualityKind: 'scl',
    bandAlias: {
      blue: 'B02', green: 'B03', red: 'B04', nir: 'B08',
      swir16: 'B11', swir22: 'B12',
    },
  },
  {
    id: 'landsat-c2-l2',
    label: 'Landsat Collection-2 Level-2',
    collection: 'landsat-c2-l2',
    // Landsat 4/5 TM opens the Collection-2 L2 archive. Verified live: a search
    // over Luxor for 1984-1986 returns landsat-5 scenes.
    from: '1982-08-22',
    nativeResM: 30,
    scale: 0.0000275,
    offset: -0.2,
    qualityAsset: 'qa_pixel',
    qualityKind: 'landsat-qa',
    // PC normalises band names across the whole Landsat archive, so one alias
    // table covers TM, ETM+ and OLI — the reason a 1986 scene and a 2026 scene
    // can be read by identical code.
    bandAlias: {
      blue: 'blue', green: 'green', red: 'red', nir: 'nir08',
      swir16: 'swir16', swir22: 'swir22',
    },
  },
]

export function sensorById(id: string): SensorSpec | null {
  return SENSORS.find((s) => s.id === id) ?? null
}

/** The canonical band names an index needs, from its shared config. */
export function indexBandNames(index: string): string[] | null {
  const cfg = SPECTRAL_INDEX_TILE_CONFIG[index.toUpperCase()]
  if (!cfg) return null
  // bandKeys are [canonicalName, S2Name] pairs; the canonical name leads.
  return cfg.bandKeys.map((keys) => keys[0])
}

/** True when this sensor can supply every band the index needs. */
export function sensorSupportsIndex(sensor: SensorSpec, index: string): boolean {
  const names = indexBandNames(index)
  if (!names) return false
  return names.every((n) => !!sensor.bandAlias[n])
}

export type SensorChoice =
  | { ok: true; sensor: SensorSpec; reason: string }
  | { ok: false; message: string }

/**
 * Choose ONE sensor able to observe BOTH dates, finest resolution first.
 *
 * This is the function that keeps an instrument difference from being reported
 * as change — see the module header for the measured offsets.
 */
export function pickSensorForPair(
  dateA: string,
  dateB: string,
  index: string,
  opts: { allowCrossSensor?: boolean } = {},
): SensorChoice {
  const a = String(dateA).slice(0, 10)
  const b = String(dateB).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) {
    return { ok: false, message: `Both dates must be YYYY-MM-DD (got "${dateA}" and "${dateB}").` }
  }
  const earliest = a < b ? a : b

  const capable = SENSORS.filter((s) => sensorSupportsIndex(s, index))
  if (capable.length === 0) {
    return {
      ok: false,
      message:
        `No sensor here carries the bands ${index} needs. Supported indices: ` +
        `${Object.keys(SPECTRAL_INDEX_TILE_CONFIG).join(', ')}.`,
    }
  }

  const covering = capable.filter((s) => s.from <= earliest)
  if (covering.length > 0) {
    const best = covering.reduce((x, y) => (x.nativeResM <= y.nativeResM ? x : y))
    const finer = capable.find((s) => s.nativeResM < best.nativeResM)
    const why = finer
      ? `${finer.label} is finer (${finer.nativeResM} m) but its archive starts ${finer.from}, after ${earliest}`
      : `it is the finest archive covering both dates`
    return {
      ok: true,
      sensor: best,
      reason:
        `Both dates read from **${best.label}** at ${best.nativeResM} m — ${why}. ` +
        `One sensor answers both dates on purpose: measured on coincident clear scenes, ` +
        `Sentinel-2 and Landsat NDVI disagree by 0.02–0.11 over the same polygon, which is ` +
        `larger than most multi-decade signals, so mixing them would report the instrument as change.`,
    }
  }

  const oldest = capable.reduce((x, y) => (x.from <= y.from ? x : y))
  if (!opts.allowCrossSensor) {
    return {
      ok: false,
      message:
        `No sensor observed ${earliest}. The deepest archive available here is ` +
        `**${oldest.label}**, which starts ${oldest.from}. Pick a later date, or use a dataset ` +
        `found via \`find_dataset\` if you need earlier coverage.`,
    }
  }
  return { ok: true, sensor: oldest, reason: `Falling back to ${oldest.label} (${oldest.from}+).` }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface SensorGrid {
  /** Per-pixel index values; only `valid` entries are meaningful. */
  values: Float64Array
  valid: Uint8Array
  width: number
  height: number
  /** Pixels inside the polygon before the quality mask. */
  insidePolygon: number
  /** Pixels that survived the quality mask. */
  clearPixels: number
  /** How DN was converted to reflectance before the index formula ran (ISS-131).
   *  Load-bearing for a temporal pair: two dates must be told apart by their
   *  surface, not by a processing-baseline change between them. */
  reflectanceNote: string
  sceneId: string
  sceneDate: string
  sensor: SensorSpec
}

export type SensorGridOutcome =
  | { ok: true; grid: SensorGrid }
  | { ok: false; message: string }

/** Search a Planetary Computer collection over the AOI. */
export async function searchSensor(
  sensor: SensorSpec,
  bbox: [number, number, number, number],
  datetime: string,
  limit = 12,
): Promise<any[]> {
  const body = {
    collections: [sensor.collection],
    bbox,
    datetime: toRfc3339Interval(datetime),
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    limit,
  }
  try {
    const data = await cachedFetchJson(`pc-search:${JSON.stringify(body)}`, 10 * 60 * 1000, async () => {
      const res = await fetch(PC_STAC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`PC STAC HTTP ${res.status}`)
      return res.json()
    })
    return (data?.features as any[]) ?? []
  } catch (err: any) {
    log.warn({ sensor: sensor.id, err: err?.message }, 'PC STAC search failed')
    return []
  }
}

/** True when a quality value means "usable ground" for this sensor. */
export function isClearValue(kind: QualityKind, v: number): boolean {
  if (kind === 'landsat-qa') return landsatQaIsClear(v)
  const cls = Math.round(v)
  return cls !== SCL.NO_DATA && CLEAR_CLASSES.has(cls)
}

/**
 * Read one scene's index grid at an EXPLICIT width/height, quality-masked.
 *
 * The bands and the quality asset ride in ONE request, which is what forces a
 * common grid (ISS-126) — and the explicit width/height is what makes two
 * different sensors land on the *same* grid so their difference is per-pixel.
 */
export async function readSensorIndexGrid(opts: {
  sensor: SensorSpec
  item: any
  index: string
  aoi: any
  width: number
  height: number
}): Promise<SensorGridOutcome> {
  const { sensor, item, index, width, height } = opts
  const key = index.toUpperCase()
  const cfg = SPECTRAL_INDEX_TILE_CONFIG[key]
  const names = indexBandNames(key)
  if (!cfg || !names) return { ok: false, message: `Unsupported index "${index}".` }

  const geom = toGeometry(opts.aoi)
  if (!geom) return { ok: false, message: 'A polygon AOI is required.' }

  const assets = names.map((n) => sensor.bandAlias[n])
  if (assets.some((a) => !a)) {
    return { ok: false, message: `${sensor.label} does not carry every band ${key} needs.` }
  }

  let evaluate: (bands: Float64Array) => number
  try {
    evaluate = compileBandExpression(toPositionalExpression(cfg.exprTemplate))
  } catch (err: any) {
    return { ok: false, message: `The ${key} formula could not be evaluated (${err?.message}).` }
  }

  // ISS-131: resolve DN->reflectance from the item. PC declares no `raster:bands`,
  // so for Sentinel-2 this lands on the processing-baseline rule — which is the
  // only thing that distinguishes a pre-04.00 scene from a post-04.00 one, and
  // therefore the only thing keeping a baseline change out of a change detection.
  const reflectance = resolveBandSetReflectance(item, assets as string[], {
    isSentinel2: sensor.id === 'sentinel-2-l2a',
    fallback: { scale: sensor.scale, offset: sensor.offset, note: `${sensor.label} sensor default` },
  })
  const transforms = reflectance.transforms

  const qs = new URLSearchParams({
    collection: sensor.collection,
    item: String(item?.id ?? ''),
    width: String(width),
    height: String(height),
  })
  for (const a of assets) qs.append('assets', a!)
  qs.append('assets', sensor.qualityAsset)

  let buf: Buffer
  try {
    const res = await fetch(`${PC_DATA}/item/feature.npy?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'Feature', properties: {}, geometry: geom }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        ok: false,
        message:
          `Planetary Computer could not return the clipped ${key} array for ` +
          `${String(item?.id ?? 'unknown')} (HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}).`,
      }
    }
    buf = Buffer.from(await res.arrayBuffer())
  } catch (err: any) {
    return { ok: false, message: `Reading ${sensor.label} failed: ${err?.message ?? 'unknown error'}.` }
  }

  let shape: number[]
  let data: Float64Array
  try {
    ({ shape, data } = parseNpy(buf))
  } catch (err: any) {
    return { ok: false, message: `Could not parse the ${sensor.label} pixel array (${err?.message}).` }
  }

  const nBands = assets.length
  // Layout: [band1 … bandN, quality, validity-mask].
  if (shape.length !== 3 || shape[0] < nBands + 2) {
    return {
      ok: false,
      message:
        `${sensor.label} returned ${shape[0] ?? '?'} bands for a ${nBands}-band + quality read; ` +
        `the mask cannot be matched to the data, so no value is reported.`,
    }
  }
  const h = shape[1]
  const w = shape[2]
  if (h !== height || w !== width) {
    // Explicit width/height is the whole reason two dates align. If the server
    // ever stops honouring it, refuse rather than difference mismatched grids.
    return {
      ok: false,
      message: `${sensor.label} returned a ${w}x${h} grid for an explicit ${width}x${height} request.`,
    }
  }

  const px = w * h
  const quality = data.subarray(nBands * px, (nBands + 1) * px)
  const validity = data.subarray((nBands + 1) * px, (nBands + 2) * px)

  let insidePolygon = 0
  const usable = new Uint8Array(px)
  for (let i = 0; i < px; i++) {
    if (!validity[i]) continue
    insidePolygon++
    if (!isClearValue(sensor.qualityKind, quality[i])) continue
    usable[i] = 1
  }

  // DN -> reflectance, then the formula. On Planetary Computer the BOA offset IS
  // present in the pixels and is declared nowhere, so this is what keeps a
  // processing-baseline change from being differenced as ground change (ISS-131).
  const built = buildIndexValues({
    raw: data,
    px,
    nBands,
    transforms,
    index: key,
    evaluate,
    include: (i) => usable[i] === 1,
    baseNote: reflectance.note,
  })
  const values = built.values
  const valid = new Uint8Array(px)
  for (let i = 0; i < px; i++) if (Number.isFinite(values[i])) valid[i] = 1
  const clearPixels = built.validCount

  if (insidePolygon === 0) {
    return { ok: false, message: `${sensor.label} returned no in-polygon pixels for ${String(item?.id ?? 'unknown')}.` }
  }

  return {
    ok: true,
    grid: {
      values, valid, width: w, height: h,
      insidePolygon, clearPixels,
      reflectanceNote: built.note,
      sceneId: String(item?.id ?? 'unknown'),
      sceneDate: String(item?.properties?.datetime ?? '').slice(0, 10),
      sensor,
    },
  }
}

/** Minimum share of in-polygon pixels that must survive the quality mask. */
export const MIN_SENSOR_CLEAR_PCT = 60

/**
 * The scene nearest `date` that is actually usable over the polygon.
 *
 * Scenes are tried newest-first within a window and accepted on measured clear
 * pixels, not on scene-wide metadata — the Phase 0 rule (`eo:cloud_cover` is
 * nearly uncorrelated with cloud over the AOI) applies just as much to a 1990
 * Landsat scene as to a 2026 Sentinel-2 one.
 */
export async function loadSensorGridNear(opts: {
  sensor: SensorSpec
  index: string
  aoi: any
  bbox: [number, number, number, number]
  date: string
  width: number
  height: number
  padDays?: number
  maxCandidates?: number
}): Promise<SensorGridOutcome> {
  const { sensor, index, aoi, bbox, date, width, height } = opts
  const padDays = opts.padDays ?? 45
  const maxCandidates = opts.maxCandidates ?? 8

  const centre = new Date(`${String(date).slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(centre.getTime())) return { ok: false, message: `"${date}" is not a valid date.` }
  const from = new Date(centre); from.setUTCDate(from.getUTCDate() - padDays)
  const to = new Date(centre); to.setUTCDate(to.getUTCDate() + padDays)
  const window = `${from.toISOString().slice(0, 10)}/${to.toISOString().slice(0, 10)}`

  const items = await searchSensor(sensor, bbox, window, 12)
  if (items.length === 0) {
    return {
      ok: false,
      message: `No ${sensor.label} scene covers this AOI within ±${padDays} days of ${date}.`,
    }
  }

  const tried: string[] = []
  let best: SensorGrid | null = null
  for (const item of items.slice(0, maxCandidates)) {
    const out = await readSensorIndexGrid({ sensor, item, index, aoi, width, height })
    if (!out.ok) { tried.push(`${String(item?.id ?? '?')}: ${out.message.slice(0, 60)}`); continue }
    const clearPct = (out.grid.clearPixels / Math.max(1, out.grid.insidePolygon)) * 100
    tried.push(`${out.grid.sceneDate}: ${clearPct.toFixed(0)}% clear`)
    if (clearPct >= MIN_SENSOR_CLEAR_PCT) return out
    if (!best || out.grid.clearPixels > best.clearPixels) best = out.grid
  }

  return {
    ok: false,
    message:
      `No ${sensor.label} scene within ±${padDays} days of ${date} was at least ` +
      `${MIN_SENSOR_CLEAR_PCT}% clear over your polygon` +
      (best ? ` (best: ${best.sceneDate} at ${((best.clearPixels / Math.max(1, best.insidePolygon)) * 100).toFixed(0)}%)` : '') +
      `. Scenes checked:\n${tried.map((t) => `- ${t}`).join('\n')}`,
  }
}
