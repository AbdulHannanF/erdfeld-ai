/** Sentinel-1 RTC backscatter as a map layer (fetch_sar).
 *
 *  The numbers come from the same polygon-clipped dB grid the layer is stretched to: one read,
 *  one unit (dB of gamma-nought), so the legend, the tiles and the statistics agree. Tiles are the
 *  Planetary Computer data API's, as `map_flood` uses; the client hides them outside the AOI.
 */

import type { RasterDescriptor } from '@/lib/raster-style'
import { sarTileUrl, type Polarization, type S1Scene } from './flood/scenes'
import { stretchFromSummary, summarizeValues } from './raster-render'
import type { Confidence, Provenance, ResultLayer } from './types'

export const SAR_COLORMAP = 'viridis'

export interface SarDbStats {
  /** Valid (finite, positive-power) pixels inside the polygon. */
  n: number
  /** Mean power in the linear domain, converted once to dB (the mean of dB is not the dB of the mean). */
  meanDb: number
  min: number
  max: number
  p2: number
  p98: number
  /** Share of the AOI these pixels observe, 0..100 (against the grid's own pixel area). */
  coveragePct: number
}

/** Statistics of a dB grid (NaN = outside the polygon or no data); null when nothing was observed. */
export function sarDbStats(db: ArrayLike<number>, aoiPixels: number): SarDbStats | null {
  const summary = summarizeValues(db)
  if (!summary) return null
  let power = 0
  for (let i = 0; i < db.length; i++) if (Number.isFinite(db[i])) power += 10 ** (db[i] / 10)
  return {
    n: summary.n,
    meanDb: 10 * Math.log10(power / summary.n),
    min: summary.min,
    max: summary.max,
    p2: summary.p2,
    p98: summary.p98,
    coveragePct: aoiPixels > 0 ? Math.min(100, (summary.n / aoiPixels) * 100) : 100,
  }
}

/** The AOI's own 2nd-98th percentile in dB, never narrower than 3 dB (speckle would fill a narrower ramp). */
export function sarStretch(stats: Pick<SarDbStats, 'min' | 'max' | 'p2' | 'p98' | 'n'>): [number, number] {
  const [lo, hi] = stretchFromSummary({ ...stats, mean: (stats.p2 + stats.p98) / 2 })
  if (hi - lo >= 3) return [lo, hi]
  const mid = (lo + hi) / 2
  return [Number((mid - 1.5).toFixed(1)), Number((mid + 1.5).toFixed(1))]
}

export function sarRasterLayer(o: {
  scene: Pick<S1Scene, 'tileItem' | 'date'>
  pol: Polarization
  stats: SarDbStats
  bbox: [number, number, number, number]
  provenance: Provenance
  confidence: Confidence
  id: string
  visible?: boolean
}): ResultLayer {
  const rescale = sarStretch(o.stats)
  const raster: RasterDescriptor = {
    kind: 'continuous',
    sensor: 'sentinel-1-rtc',
    collection: 'sentinel-1-rtc',
    sceneId: String(o.scene.tileItem.id),
    datetime: o.scene.date,
    bands: [o.pol],
    expression: `10*log10(${o.pol.toLowerCase()})`,
    rescale: [rescale],
    stretch: 'p2-p98',
    colormap: SAR_COLORMAP,
    units: 'dB',
  }
  return {
    id: o.id,
    name: `Sentinel-1 ${o.pol} backscatter, dB (${o.scene.date})`,
    type: 'raster',
    tileUrl: sarTileUrl(o.scene, o.pol, rescale, SAR_COLORMAP),
    bounds: o.bbox,
    aoiMask: true,
    raster,
    provenance: o.provenance,
    confidence: o.confidence,
    ...(o.visible === false ? { defaultVisible: false } : {}),
  }
}
