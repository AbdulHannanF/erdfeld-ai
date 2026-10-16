import type { MapLayer } from '@/store/useStore'
import { resolveVectorStyle } from '@/lib/vector-style'

export interface ClassRow {
  /** The value the map filters on. */
  value: string | number
  label: string
  color: string
  /** Features of the layer in this class. */
  count: number
  /** Hectares in this class, summed from each feature's area_ha; null when any feature lacks it. */
  areaHa: number | null
}

/** The classes of a layer coloured by a categorical property, with how many features fall in each.
 *  Null for any other layer: a graduated ramp has no discrete classes to switch off. */
export function classRows(layer: MapLayer): ClassRow[] | null {
  if (layer.type !== 'geojson' || layer.vectorStyle?.kind !== 'categorical' || !layer.geojson) return null
  const r = resolveVectorStyle(layer.vectorStyle, layer.geojson)
  if (!r.ok || r.value.classes.length === 0) return null
  const property = r.value.property
  const counts = new Map<string, number>()
  const area = new Map<string, number>()
  let hasArea = true
  for (const f of layer.geojson.features) {
    const v = f.properties?.[property]
    if (v === undefined || v === null) continue
    const k = String(v)
    counts.set(k, (counts.get(k) ?? 0) + 1)
    const ha = f.properties?.area_ha
    if (typeof ha === 'number' && Number.isFinite(ha)) area.set(k, (area.get(k) ?? 0) + ha)
    else hasArea = false
  }
  return r.value.classes.map((c) => ({
    value: c.value,
    label: c.label,
    color: c.color,
    count: counts.get(String(c.value)) ?? 0,
    areaHa: hasArea ? area.get(String(c.value)) ?? 0 : null,
  }))
}

/** The filter after one class is clicked. No filter means every class shows; the first click
 *  narrows to that class, later clicks add or drop classes, and selecting them all clears it. */
export function toggleClass(current: Array<string | number> | undefined, value: string | number, all: Array<string | number>): Array<string | number> | null {
  const key = String(value)
  const set = new Set((current ?? []).map(String))
  if (!current) {
    return [value]
  }
  if (set.has(key)) set.delete(key)
  else set.add(key)
  if (set.size === 0 || set.size === all.length) return null
  return all.filter((v) => set.has(String(v)))
}
