/** Season scene selection and the per-date NDVI stack that `segment.ts` consumes.
 *
 *  One scene per time window across the season (so the stack samples the whole
 *  growing calendar rather than the six clearest weeks of one month), each scored on
 *  cloud OVER THE POLYGON via SCL — never on scene-wide metadata. Every date is read
 *  as ONE titiler request carrying nir, red and SCL, so the cloud mask and the NDVI
 *  share a grid; dates are then brought onto the first date's grid.
 */

import { MIN_AOI_COVERAGE_PCT, sceneClarity } from '../cloud'
import { readMaskedGrid, type MaskedGrid } from '../digitize/scene-grid'
import { getLogger } from '../logger'
import { SPECTRAL_INDEX_TILE_CONFIG } from '../titiler'
import { compileBandExpression, toPositionalExpression } from '../analysis/band-expression'
import type { BBox } from '../vectorize'

const log = getLogger('agent/fields')

const NDVI = SPECTRAL_INDEX_TILE_CONFIG.NDVI
const ndviEval = compileBandExpression(toPositionalExpression(NDVI.exprTemplate))

/** Bands read per date: NDVI's nir (0) and red (1), plus SWIR1 / B11 (2) for NDBI.
 *  B11 is 20 m; titiler resamples it onto the same grid as the 10 m bands. */
const STACK_BAND_KEYS = [...NDVI.bandKeys, ['swir16', 'B11']]
/** NDBI = (SWIR1 − NIR) / (SWIR1 + NIR), Zha et al. 2003. */
const ndbiEval = compileBandExpression(toPositionalExpression('(BAND2-BAND0)/(BAND2+BAND0)'))

/** A scene must be at least this clear over the polygon to enter the stack. */
export const MIN_STACK_CLEAR_PCT = 50

export interface SeasonScene {
  item: any
  date: string
  clearPct: number
  coveragePct: number | null
  window: string
}

export interface SeasonSelection {
  scenes: SeasonScene[]
  /** Windows where nothing usable was found, with the reason, for an honest report. */
  skipped: string[]
  candidatesScored: number
}

const DAY = 86_400_000

/** Pick up to `maxScenes` scenes, at most one per equal-length time window. */
export async function selectSeasonScenes(
  items: any[],
  geom: any,
  start: string,
  end: string,
  maxScenes: number,
): Promise<SeasonSelection> {
  const t0 = Date.parse(`${start}T00:00:00Z`)
  const t1 = Date.parse(`${end}T23:59:59Z`)
  const span = (t1 - t0) / maxScenes
  const skipped: string[] = []
  let scored = 0
  const scenes: SeasonScene[] = []

  const windows = await Promise.all(
    Array.from({ length: maxScenes }, async (_, w) => {
      const a = t0 + w * span, b = a + span
      const label = `${new Date(a).toISOString().slice(0, 10)}…${new Date(b - DAY).toISOString().slice(0, 10)}`
      const inWin = items
        .filter((it) => {
          const t = Date.parse(String(it?.properties?.datetime ?? ''))
          return t >= a && t < b
        })
        // Scene-wide cloud only orders which candidates are worth scoring; it never gates.
        .sort((x, y) => (x.properties?.['eo:cloud_cover'] ?? 100) - (y.properties?.['eo:cloud_cover'] ?? 100))
        .slice(0, 4)
      if (inWin.length === 0) return { label, empty: true as const }
      const results = await Promise.all(inWin.map(async (item) => ({ item, clarity: await sceneClarity(item, geom, 64) })))
      scored += results.length
      const usable = results
        .filter((r) => r.clarity && r.clarity.clearPct >= MIN_STACK_CLEAR_PCT
          && (r.clarity.coveragePct ?? 100) >= MIN_AOI_COVERAGE_PCT)
        .sort((x, y) => y.clarity!.clearPct - x.clarity!.clearPct)
      if (usable.length === 0) return { label, empty: false as const, best: results }
      const pick = usable[0]
      return { label, pick }
    }),
  )

  for (const w of windows) {
    if ('pick' in w && w.pick) {
      const c = w.pick.clarity!
      scenes.push({
        item: w.pick.item,
        date: String(w.pick.item?.properties?.datetime ?? '').slice(0, 10),
        clearPct: c.clearPct,
        coveragePct: c.coveragePct,
        window: w.label,
      })
    } else if ('empty' in w && w.empty) {
      skipped.push(`${w.label}: no Sentinel-2 scene`)
    } else if ('best' in w) {
      const top = w.best?.filter((r) => r.clarity).sort((x, y) => y.clarity!.clearPct - x.clarity!.clearPct)[0]
      skipped.push(top
        ? `${w.label}: best scene ${top.clarity!.clearPct.toFixed(0)}% clear, covering ${(top.clarity!.coveragePct ?? 0).toFixed(0)}% of the AOI`
        : `${w.label}: cloud mask unreadable`)
    }
  }
  scenes.sort((x, y) => x.date.localeCompare(y.date))
  return { scenes, skipped, candidatesScored: scored }
}

export interface NdviStack {
  width: number
  height: number
  bbox: BBox
  cellXm: number
  cellYm: number
  dates: string[]
  sceneIds: string[]
  /** NDVI per date, NaN = cloud / gap. */
  layers: Float32Array[]
  /** NDBI per date on the same grid and mask as `layers`, NaN = cloud / gap. */
  ndbi: Float32Array[]
  /** Polygon ∩ observed on the reference date. */
  inside: Uint8Array
  clearPct: number[]
  resampled: number
  reflectanceNote: string
}

/** Nearest-neighbour resample of a grid over the same bbox. */
function resample<T extends Float32Array | Uint8Array>(src: T, sw: number, sh: number, dw: number, dh: number): T {
  const out = new (src.constructor as { new (n: number): T })(dw * dh)
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) / dh) * sh))
    for (let x = 0; x < dw; x++) {
      out[y * dw + x] = src[sy * sw + Math.min(sw - 1, Math.floor(((x + 0.5) / dw) * sw))]
    }
  }
  return out
}

export async function loadNdviStack(
  scenes: SeasonScene[],
  geom: any,
  maxSize: number,
): Promise<{ stack: NdviStack | null; failures: string[] }> {
  const outcomes = await Promise.all(
    scenes.map(async (s) => ({
      s,
      r: await readMaskedGrid({
        item: s.item,
        geom,
        bandKeys: STACK_BAND_KEYS,
        evaluate: ndviEval,
        extra: { label: 'NDBI', evaluate: ndbiEval },
        label: 'NDVI',
        maxSize,
        dropSnow: true,
        cacheTag: `fields-ndvi-${maxSize}`,
      }),
    })),
  )
  const failures: string[] = []
  const good: Array<{ date: string; grid: MaskedGrid }> = []
  for (const { s, r } of outcomes) {
    if (r.ok) good.push({ date: s.date, grid: r.grid })
    else {
      failures.push(`${s.date}: ${r.message}`)
      log.warn({ scene: s.item?.id, reason: r.reason }, 'ndvi stack read failed')
    }
  }
  if (good.length === 0) return { stack: null, failures }
  good.sort((a, b) => a.date.localeCompare(b.date))
  const ref = good[0].grid
  let resampled = 0
  const layers: Float32Array[] = []
  const ndbi: Float32Array[] = []
  const insideAll = new Uint8Array(ref.width * ref.height)
  for (const g of good) {
    let values = g.grid.values
    let inside = g.grid.inside
    let ndbiVals = g.grid.extraValues ?? new Float32Array(values.length).fill(NaN)
    if (g.grid.width !== ref.width || g.grid.height !== ref.height) {
      values = resample(values, g.grid.width, g.grid.height, ref.width, ref.height)
      inside = resample(inside, g.grid.width, g.grid.height, ref.width, ref.height)
      ndbiVals = resample(ndbiVals, g.grid.width, g.grid.height, ref.width, ref.height)
      resampled++
    }
    layers.push(values)
    ndbi.push(ndbiVals)
    // A pixel takes part if ANY date observed it inside the polygon.
    for (let i = 0; i < inside.length; i++) if (inside[i]) insideAll[i] = 1
  }
  const stack: NdviStack = {
    width: ref.width,
    height: ref.height,
    bbox: ref.bbox,
    cellXm: ref.cellXm,
    cellYm: ref.cellYm,
    dates: good.map((g) => g.date),
    sceneIds: good.map((g) => g.grid.sceneId),
    layers,
    ndbi,
    inside: insideAll,
    clearPct: good.map((g) => g.grid.clearPct),
    resampled,
    reflectanceNote: ref.reflectanceNote,
  }
  return { stack, failures }
}
