/** From an uploaded file's features to the plots of a claim batch (Q-28). Client-side, pure.
 *
 *  - A Polygon is a plot. A MultiPolygon of one polygon is unwrapped; of several it is skipped (it
 *    is not one plot). Lines are skipped.
 *  - A Point has no extent. It becomes a square plot only when the user states a half-side in
 *    metres; otherwise it is skipped, with the reason. Nothing is guessed.
 *  - A property named like a recipe parameter (e.g. `date`) is that plot's value of the parameter
 *    and overrides the shared one. The plot name is the first of `name`, `plot`, `plot_id`, `id`,
 *    `label`, `field` that is filled in. */

export const MAX_BATCH_PLOTS = 500

const NAME_KEYS = ['name', 'plot', 'plot_id', 'id', 'label', 'field']

export interface BatchPlot {
  name: string
  geometry: GeoJSON.Polygon
  params?: Record<string, string | number>
}

export interface PlotsFromFile {
  plots: BatchPlot[]
  skipped: Array<{ index: number; reason: string }>
  /** Recipe parameters some plot takes from the file. */
  paramColumns: string[]
  pointCount: number
  tooMany: boolean
}

/** A square of side 2 * halfM metres around a point (equirectangular; fine at plot scale). */
export function squareAround([lon, lat]: number[], halfM: number): GeoJSON.Polygon {
  const dLat = halfM / 111_320
  const dLon = halfM / (111_320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)))
  return { type: 'Polygon', coordinates: [[[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat], [lon - dLon, lat - dLat]]] }
}

export function plotsFromFeatures(fc: GeoJSON.FeatureCollection, paramNames: string[], opts: { halfSideM?: number } = {}): PlotsFromFile {
  const plots: BatchPlot[] = []
  const skipped: PlotsFromFile['skipped'] = []
  const used = new Set<string>()
  let pointCount = 0
  fc.features.forEach((f, i) => {
    const g = f.geometry
    let geometry: GeoJSON.Polygon | null = null
    if (!g) skipped.push({ index: i, reason: 'no geometry' })
    else if (g.type === 'Polygon') geometry = g
    else if (g.type === 'MultiPolygon') {
      if (g.coordinates.length === 1) geometry = { type: 'Polygon', coordinates: g.coordinates[0] }
      else skipped.push({ index: i, reason: 'a MultiPolygon of several parts is not one plot' })
    } else if (g.type === 'Point') {
      pointCount++
      if (opts.halfSideM && opts.halfSideM > 0) geometry = squareAround(g.coordinates, opts.halfSideM)
      else skipped.push({ index: i, reason: 'a point has no plot size (set the half-side to make it a square)' })
    } else skipped.push({ index: i, reason: `${g.type} is not a plot` })
    if (!geometry) return
    const props = (f.properties ?? {}) as Record<string, unknown>
    const params: Record<string, string | number> = {}
    for (const p of paramNames) {
      const v = props[p]
      if (typeof v === 'string' && v.trim() !== '') params[p] = v.trim()
      else if (typeof v === 'number' && Number.isFinite(v)) params[p] = v
      if (p in params) used.add(p)
    }
    const nameKey = NAME_KEYS.find((k) => props[k] != null && String(props[k]).trim() !== '')
    plots.push({
      name: (nameKey ? String(props[nameKey]).trim() : `Plot ${i + 1}`).slice(0, 120),
      geometry, ...(Object.keys(params).length ? { params } : {}),
    })
  })
  return { plots, skipped, paramColumns: [...used], pointCount, tooMany: plots.length > MAX_BATCH_PLOTS }
}
