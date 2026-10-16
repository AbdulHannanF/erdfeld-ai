/** OSM building height + cartographic color helpers. */

/** Parse building height from OSM tags. Priority: explicit height → building:levels×3.5m → type defaults. */
export function parseBuildingHeight(tags: Record<string, string>): { height: number; source: 'explicit' | 'levels' | 'type_default' } {
  if (tags.height) {
    const raw = String(tags.height).replace(/\s/g, '')
    const ftMatch = raw.match(/^([\d.]+)ft$/)
    if (ftMatch) return { height: parseFloat(ftMatch[1]) * 0.3048, source: 'explicit' }
    const m = parseFloat(raw)
    if (!isNaN(m) && m > 0) return { height: m, source: 'explicit' }
  }
  if (tags['building:levels']) {
    const lvl = parseFloat(tags['building:levels'])
    if (!isNaN(lvl) && lvl > 0) return { height: lvl * 3.5, source: 'levels' }
  }
  const t = (tags.building || '').toLowerCase()
  if (['tower', 'skyscraper'].includes(t)) return { height: 30, source: 'type_default' }
  if (['cathedral', 'church', 'mosque', 'synagogue', 'temple', 'chapel'].includes(t)) return { height: 20, source: 'type_default' }
  if (['apartments', 'flat', 'flats', 'residential', 'dormitory'].includes(t)) return { height: 12, source: 'type_default' }
  if (['commercial', 'office', 'retail', 'supermarket', 'mall'].includes(t)) return { height: 10, source: 'type_default' }
  if (['industrial', 'warehouse', 'factory', 'storage', 'barn', 'garage'].includes(t)) return { height: 8, source: 'type_default' }
  if (['hospital', 'school', 'university', 'college'].includes(t)) return { height: 10, source: 'type_default' }
  if (['house', 'detached', 'semidetached_house', 'bungalow'].includes(t)) return { height: 6, source: 'type_default' }
  if (['hut', 'shed', 'cabin'].includes(t)) return { height: 3, source: 'type_default' }
  return { height: 8, source: 'type_default' }
}

/** Map OSM building type → display color for the layer legend. */
export function buildingTypeColor(tags: Record<string, string>): string {
  const t = (tags.building || '').toLowerCase()
  if (['office', 'commercial', 'retail', 'supermarket', 'mall', 'shop'].some(k => t.includes(k))) return '#f59e0b'
  if (['apartments', 'residential', 'house', 'detached', 'flat', 'flats', 'dormitory'].some(k => t.includes(k))) return '#60a5fa'
  if (['industrial', 'warehouse', 'factory', 'storage', 'barn'].some(k => t.includes(k))) return '#9ca3af'
  if (['cathedral', 'church', 'mosque', 'synagogue', 'temple', 'chapel'].some(k => t.includes(k))) return '#a78bfa'
  if (['hospital', 'clinic'].some(k => t.includes(k))) return '#f87171'
  if (['school', 'university', 'college', 'kindergarten'].some(k => t.includes(k))) return '#34d399'
  if (['tower', 'skyscraper'].some(k => t.includes(k))) return '#fbbf24'
  return '#94a3b8'
}
