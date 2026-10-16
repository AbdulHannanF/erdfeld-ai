/** Per-class model-confidence stats for the Detection tab.
 *
 *  Only layers produced by computer-vision detectors qualify. A `confidence` property
 *  on a polygon is not evidence of a detection: `delineate_fields` regions, for one,
 *  carry a segmentation-contrast `confidence` and a phenology `class`, and must never
 *  be summarised as "model detections".
 */

import type { MapLayer } from '@/store/useStore'

/** Tools whose layers hold CV detections. */
export const DETECTION_TOOLS: ReadonlySet<string> = new Set(['run_cv_detector', 'detect_objects', 'digitize_features'])

/** Layer-id prefixes the CV tools mint, for layers that arrive without a `tool` tag. */
const DETECTION_ID_PREFIXES = ['cv-', 'perception-']

export function isDetectionLayer(l: Pick<MapLayer, 'id' | 'tool'>): boolean {
  if (l.tool) return DETECTION_TOOLS.has(l.tool)
  return DETECTION_ID_PREFIXES.some((p) => l.id.startsWith(p))
}

export interface DetectionClassStat { label: string; count: number; confidence: number }

export function detectionStats(layers: ReadonlyArray<Pick<MapLayer, 'id' | 'tool' | 'geojson'>>): DetectionClassStat[] {
  const byClass = new Map<string, { sum: number; n: number }>()
  for (const l of layers) {
    if (!isDetectionLayer(l)) continue
    for (const f of l.geojson?.features ?? []) {
      const p = f.properties as Record<string, unknown> | null
      const label = typeof p?.label === 'string' ? p.label : typeof p?.class === 'string' ? p.class : null
      if (p && label && typeof p.confidence === 'number') {
        const e = byClass.get(label) ?? { sum: 0, n: 0 }
        e.sum += p.confidence
        e.n++
        byClass.set(label, e)
      }
    }
  }
  return Array.from(byClass, ([label, { sum, n }]) => ({ label, count: n, confidence: Math.round((sum / n) * 100) }))
}
