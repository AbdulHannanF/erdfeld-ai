/**
 * The Processing toolbox's data: the operation registry as `GET /api/operations` serves it (the
 * exact set the planner may use), grouped into domains for browsing. The grouping is only a
 * browsing aid; an operation the table below does not know still shows, under "Other", so a new
 * registry entry appears in the toolbox without a code change.
 */

export interface OperationInfo {
  name: string
  version: string
  description: string
  /** JSON Schema of the arguments (the same one the planner sees). */
  params: { properties: Record<string, SchemaProp>; required: string[] }
  output: string
  sensors: string[]
  resolution_m: number | null
  limits: { maxAreaKm2: number; minAreaKm2: number | null; earliest: string | null; needsDates: boolean }
  /** Set when the operation works on an existing result: a queued run needs `result_id` (the toolbox offers a picker). */
  input_result?: { description: string } | null
  cost: { typicalSeconds: number; [k: string]: unknown }
  limitations: string[]
  confidence: string
}

export interface SchemaProp {
  type?: string
  description?: string
  enum?: Array<string | number>
  items?: { type?: string; enum?: Array<string | number> }
  minimum?: number
  maximum?: number
}

export interface Domain {
  id: string
  label: string
  ops: string[]
}

export const DOMAINS: Domain[] = [
  { id: 'optical', label: 'Optical imagery and indices', ops: ['fetch_ndvi', 'compute_spectral_index', 'fetch_temporal_stack', 'render_raster', 'composite', 'inspect_imagery', 'analyze_raster', 'fetch_thermal'] },
  { id: 'radar', label: 'Radar, water and floods', ops: ['fetch_sar', 'fetch_surface_water', 'map_flood'] },
  { id: 'terrain', label: 'Terrain and elevation', ops: ['fetch_dem', 'fetch_elevation_derivatives'] },
  { id: 'change', label: 'Land cover and change', ops: ['classify_land_cover', 'classify_vegetation', 'detect_change', 'detect_deforestation', 'detect_anomaly', 'forecast_index'] },
  { id: 'vector', label: 'Features and vectors', ops: ['query_osm', 'fetch_built_surface', 'vectorize_raster', 'delineate_fields', 'digitize_features', 'detect_objects', 'run_cv_detector', 'segment_feature', 'query_3d_tiles'] },
  { id: 'climate', label: 'Weather, climate and fire', ops: ['fetch_weather_history', 'fetch_precipitation_history', 'fetch_active_fires'] },
  { id: 'discovery', label: 'Data discovery', ops: ['find_dataset', 'use_dataset'] },
  { id: 'viz', label: 'Charts and styling', ops: ['make_chart', 'style_layer', 'render_to_map'] },
]

export interface DomainGroup {
  id: string
  label: string
  ops: OperationInfo[]
}

/** Registry operations in their domains, filtered by a search over name, description and sensors. */
export function groupOperations(ops: OperationInfo[], query: string): DomainGroup[] {
  const q = query.trim().toLowerCase()
  const match = (o: OperationInfo) =>
    !q || humanName(o.name).toLowerCase().includes(q) || o.name.includes(q) || o.description.toLowerCase().includes(q) || o.sensors.some((s) => s.toLowerCase().includes(q)) || o.output.includes(q)
  const byName = new Map(ops.map((o) => [o.name, o]))
  const placed = new Set<string>()
  const groups: DomainGroup[] = DOMAINS.map((d) => ({
    id: d.id,
    label: d.label,
    ops: d.ops.flatMap((n) => {
      const o = byName.get(n)
      if (o) placed.add(n)
      return o && match(o) ? [o] : []
    }),
  }))
  const other = ops.filter((o) => !placed.has(o.name) && match(o))
  if (other.length) groups.push({ id: 'other', label: 'Other', ops: other })
  return groups.filter((g) => g.ops.length > 0)
}

/** `compute_spectral_index` -> "Compute spectral index". */
export function humanName(name: string): string {
  const s = name.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** First sentence of an operation's description, trimmed for a one-line row. */
export function oneLine(description: string, max = 92): string {
  const first = description.split(/(?<=[.!?])\s/)[0] ?? description
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first
}

let cache: Promise<OperationInfo[]> | null = null

/** The registry, fetched once per page load. A failed fetch is not cached, so Retry works. */
export function loadOperations(): Promise<OperationInfo[]> {
  if (!cache) {
    cache = fetch('/api/operations', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`The operation registry answered HTTP ${r.status}`)
        const body = (await r.json()) as { operations: OperationInfo[] }
        return body.operations
      })
      .catch((e) => {
        cache = null
        throw e
      })
  }
  return cache
}
