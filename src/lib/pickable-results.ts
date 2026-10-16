/** Results the toolbox can hand to an operation that works on an existing result (`make_chart`,
 *  `style_layer`): the content-addressed results this session produced, newest first.
 *
 *  Only stored results qualify: the queued job loads its input from the evidence store by id, and
 *  those ids are `r_` + 16 hex. A result that is not on the map any more can still be charted by
 *  its figures; a restyle needs a vector layer that is on the map.
 */

import type { CitableToolResult } from '@/lib/citations'
import { humanName } from '@/lib/operations-client'

export interface PickableResult {
  resultId: string
  /** "Fetch ndvi · NDVI 2026-09-03" style label for the picker. */
  label: string
  /** Citable figure names, for `<result_id>#<key>` in a chart spec. */
  keys: string[]
  /** The result has a vector layer on the map (its features can be charted or restyled). */
  hasFeatures: boolean
}

const STORED_ID = /^r_[0-9a-f]{16}$/

interface LayerRef {
  resultId?: string
  name: string
  type: string
  geojson?: { features?: unknown[] }
}

export function pickableResults(
  toolResults: Record<string, CitableToolResult>,
  layers: LayerRef[],
  opts: { vectorOnly?: boolean } = {},
): PickableResult[] {
  const byId = new Map<string, PickableResult>()
  for (const [id, r] of Object.entries(toolResults)) {
    if (!STORED_ID.test(id)) continue
    byId.set(id, { resultId: id, label: humanName(r.tool), keys: Object.keys(r.summaryData ?? {}), hasFeatures: false })
  }
  for (const l of layers) {
    if (!l.resultId || !STORED_ID.test(l.resultId)) continue
    const vector = l.type === 'geojson' && (l.geojson?.features?.length ?? 0) > 0
    const cur = byId.get(l.resultId)
    if (cur) {
      if (vector && !cur.hasFeatures) { cur.hasFeatures = true; cur.label = `${cur.label} · ${l.name}` }
    } else {
      byId.set(l.resultId, { resultId: l.resultId, label: l.name, keys: [], hasFeatures: vector })
    }
  }
  const all = [...byId.values()].reverse()
  return all.filter((r) => (opts.vectorOnly ? r.hasFeatures : r.hasFeatures || r.keys.length > 0))
}

/** The data names a chart spec can use for a result: its figures, and its features when it has them. */
export function chartDataNames(r: PickableResult): string[] {
  return [...r.keys.map((k) => `${r.resultId}#${k}`), ...(r.hasFeatures ? [`${r.resultId}#features`] : [])]
}
