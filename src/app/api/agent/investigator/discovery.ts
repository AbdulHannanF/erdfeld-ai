/**
 * Discovery scan: when there is an area but no specific event, find where to look.
 *
 * The area is cut into at most nine cells; each is scored with one cheap registered measure
 * (`analyze_raster` change on NDVI between the window's two ends: the share of clear pixels that
 * moved by more than the threshold). Cells are ranked by that score and the top one is
 * investigated. A cell that could not be read has no score and is listed with the reason; a
 * failed read is never a score of zero. The ranking is a screen for where change is, not a
 * statement of what the change is.
 */

import { bboxPolygon, featureCollection, intersect } from '@turf/turf'

import type { GeoResult } from '@/lib/geo-result'

import { getAreaKm2, getBbox } from '../lib/geometry'
import type { Bbox, DiscoveryCell } from './events'

export const MAX_CELLS = 9
/** Cells smaller than this are merged away: the measures need a few hundred 10 m pixels. */
export const MIN_CELL_KM2 = 0.25
export const SCAN_THRESHOLD = 0.05
export const SCAN_CONCURRENCY = 3

export const SCAN_MEASURE = `share of clear pixels whose NDVI changed by more than ${SCAN_THRESHOLD} between the window's two dates`

export interface Cell {
  id: string
  aoi: any
  bbox: Bbox
  areaKm2: number
}

/** Up to nine cells covering the area (a grid over its bounding box, clipped to the shape). */
export function splitCells(aoi: any, maxCells = MAX_CELLS): Cell[] {
  const bbox = getBbox(aoi)
  const total = getAreaKm2(aoi)
  let n = Math.max(1, Math.floor(Math.sqrt(maxCells)))
  while (n > 1 && total / (n * n) < MIN_CELL_KM2) n--
  const [w, s, e, nn] = bbox
  const cells: Cell[] = []
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const box: Bbox = [w + ((e - w) * c) / n, s + ((nn - s) * r) / n, w + ((e - w) * (c + 1)) / n, s + ((nn - s) * (r + 1)) / n]
      let geometry: any = bboxPolygon(box).geometry
      if (n > 1 || aoi.type === 'Polygon' || aoi.type === 'MultiPolygon') {
        try {
          const clipped = intersect(featureCollection([{ type: 'Feature', properties: {}, geometry } as any, { type: 'Feature', properties: {}, geometry: aoi } as any]))
          if (!clipped) continue
          geometry = clipped.geometry
        } catch { continue }
      }
      const areaKm2 = getAreaKm2(geometry)
      if (areaKm2 <= 0) continue
      cells.push({ id: `${String.fromCharCode(65 + r)}${c + 1}`, aoi: geometry, bbox: getBbox(geometry), areaKm2 })
    }
  }
  return cells.slice(0, maxCells)
}

export interface ScoredCell extends Cell {
  score: number | null
  meanDelta: number | null
  resultId: string | null
  reason?: string
}

/** Score one cell from its change result. A result that did not measure has no score. */
export function scoreOf(result: GeoResult): { score: number | null; meanDelta: number | null; reason?: string } {
  if (result.status !== 'ok') return { score: null, meanDelta: null, reason: `${result.status}: ${result.summary.replace(/\*+/g, '').replace(/\s+/g, ' ').slice(0, 160)}` }
  const s = result.stats
  const inc = typeof s?.increased_pct === 'number' ? s.increased_pct : undefined
  const dec = typeof s?.decreased_pct === 'number' ? s.decreased_pct : undefined
  if (inc === undefined || dec === undefined) return { score: null, meanDelta: null, reason: result.summary.replace(/\*+/g, '').replace(/\s+/g, ' ').slice(0, 160) }
  return { score: Number(((inc + dec) / 100).toFixed(4)), meanDelta: typeof s?.mean_delta === 'number' ? s.mean_delta : null }
}

export async function scanCells(
  cells: Cell[],
  runCell: (cell: Cell) => Promise<GeoResult>,
  signal?: AbortSignal,
): Promise<ScoredCell[]> {
  const out: ScoredCell[] = new Array(cells.length)
  let next = 0
  const worker = async () => {
    while (next < cells.length && !signal?.aborted) {
      const i = next++
      const cell = cells[i]
      try {
        const result = await runCell(cell)
        out[i] = { ...cell, ...scoreOf(result), resultId: result.result_id }
      } catch (err: any) {
        out[i] = { ...cell, score: null, meanDelta: null, resultId: null, reason: `scan failed: ${String(err?.message ?? err).slice(0, 160)}` }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, cells.length) }, worker))
  return cells.map((c, i) => out[i] ?? { ...c, score: null, meanDelta: null, resultId: null, reason: 'not scanned (stopped early)' })
}

/** Best first; ties by area. Unscored cells are not ranked. */
export function rank(cells: ScoredCell[]): DiscoveryCell[] {
  const order = cells.filter((c) => c.score !== null).sort((a, b) => b.score! - a.score! || b.areaKm2 - a.areaKm2)
  return cells.map((c) => ({
    id: c.id, bbox: c.bbox, area_km2: Number(c.areaKm2.toFixed(2)), score: c.score, mean_ndvi_delta: c.meanDelta,
    result_id: c.resultId, ...(c.reason ? { reason: c.reason } : {}),
    rank: c.score === null ? null : order.indexOf(c) + 1,
  }))
}
