/** Landsat surface-temperature display: one scale/offset, one unit, one stretch.
 *
 *  Collection 2 Level 2 ST_B10 is a uint16 digital number. The physical value is
 *  `K = 0.00341802 * DN + 149.0` (see `titiler.ts`), so anything that colours or reports the band
 *  must apply that first. The statistics, the tile URL, the polygon-clipped PNG and the legend all
 *  take their numbers from here, in degrees Celsius, so they cannot disagree.
 */

import type { RasterDescriptor } from '@/lib/raster-style'
import { stretchFromSummary } from './raster-render'
import { dnToCelsius } from './titiler'

/** Shown only when the AOI has no clear pixel to take a stretch from; the descriptor says `fixed`. */
export const LST_FALLBACK_RANGE_C: [number, number] = [0, 50]

/** Statistics of the clear pixels in raw ST_B10 digital numbers. */
export interface LstDnStats {
  min: number
  max: number
  p2: number
  p98: number
  mean: number
  count: number
}

/** Display range in degrees Celsius: the AOI's own p2-p98 when there are clear pixels, else the
 *  fixed fallback. A uniform AOI is widened so the colormap has something to span. */
export function lstStretchC(stats: LstDnStats | null): { rescale: [number, number]; stretch: 'p2-p98' | 'fixed' } {
  if (!stats || !(stats.count > 0)) return { rescale: LST_FALLBACK_RANGE_C, stretch: 'fixed' }
  const c = (dn: number) => dnToCelsius(dn)
  // Never narrower than 1 °C: a flat scene would otherwise exaggerate sensor noise into colour.
  const [lo, hi] = stretchFromSummary({ n: stats.count, min: c(stats.min), max: c(stats.max), p2: c(stats.p2), p98: c(stats.p98), mean: c(stats.mean) })
  if (hi - lo >= 1) return { rescale: [lo, hi], stretch: 'p2-p98' }
  const mid = (lo + hi) / 2
  return { rescale: [Number((mid - 0.5).toFixed(2)), Number((mid + 0.5).toFixed(2))], stretch: 'p2-p98' }
}

/** The generic raster descriptor (legend + restyle controls) for a Landsat LST layer. */
export function lstDescriptor(o: { sceneId?: string; datetime?: string; rescale: [number, number]; stretch: 'p2-p98' | 'fixed' }): RasterDescriptor {
  return {
    kind: 'continuous',
    sensor: 'landsat-c2-l2',
    collection: 'landsat-c2-l2',
    sceneId: o.sceneId,
    datetime: o.datetime,
    bands: ['lwir11'],
    expression: 'ST_B10 * 0.00341802 + 149.0 - 273.15',
    rescale: [o.rescale],
    stretch: o.stretch,
    colormap: 'plasma',
    units: '°C',
  }
}
