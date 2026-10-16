/** Pure helpers for NASA FIRMS CSV parsing and fire hotspot analysis. Server-only; no client bundle impact. */

import { pointInAoi } from './geometry'
import type { ClassesPalette } from './types'

export interface FireFeatureProperties {
  frp: number
  confidence: 'high' | 'medium' | 'low'
  acq_date: string
  acq_time: string
  satellite: string
  daynight: string
  type: number
  brightness: number
  source: string
  color: string
}

export interface FireFeature {
  type: 'Feature'
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: FireFeatureProperties
}

/** Map fire radiative power (MW) to a display color. */
export function frpToColor(frp: number): string {
  if (frp > 200) return '#8b0000' // extreme
  if (frp > 50) return '#ff4500'  // high
  if (frp > 10) return '#ff8c00'  // moderate
  return '#ffd700'                 // low
}

/** Normalize VIIRS text confidence ('h'/'high'/'n'/'nominal'/'l'/'low') or
 *  MODIS numeric confidence (0–100) to a 3-tier string. */
export function normalizeConfidence(raw: string, isViirs: boolean): 'high' | 'medium' | 'low' {
  const s = raw.trim().toLowerCase()
  if (isViirs) {
    if (s === 'h' || s === 'high') return 'high'
    if (s === 'l' || s === 'low') return 'low'
    return 'medium' // 'n', 'nominal', or unrecognized
  }
  const n = parseInt(s, 10)
  if (isNaN(n)) return 'medium'
  if (n >= 80) return 'high'
  if (n >= 50) return 'medium'
  return 'low'
}

/** Parse a FIRMS area CSV response (VIIRS or MODIS format) into GeoJSON point features.
 *  Returns an empty array for header-only or empty responses. */
export function parseFirmsCsv(csv: string, source: string): FireFeature[] {
  const lines = csv.trim().split('\n')
  if (lines.length < 2) return []

  const isViirs = source.startsWith('VIIRS')
  const headers = lines[0].split(',').map(h => h.trim())

  const idx = (name: string) => headers.indexOf(name)
  const latIdx = idx('latitude')
  const lonIdx = idx('longitude')
  const frpIdx = idx('frp')
  const confIdx = idx('confidence')
  const dateIdx = idx('acq_date')
  const timeIdx = idx('acq_time')
  const satIdx = idx('satellite')
  const dnIdx = idx('daynight')
  const typeIdx = idx('type')
  // VIIRS uses bright_ti4 (I-band 4 brightness temp); MODIS uses brightness (band 21/22)
  const brightIdx = isViirs ? idx('bright_ti4') : idx('brightness')

  if (latIdx < 0 || lonIdx < 0) return []

  const features: FireFeature[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const vals = line.split(',')
    if (vals.length <= Math.max(latIdx, lonIdx)) continue

    const lat = parseFloat(vals[latIdx])
    const lon = parseFloat(vals[lonIdx])
    if (isNaN(lat) || isNaN(lon)) continue

    const frp = Math.max(0, parseFloat(vals[frpIdx] ?? '') || 0)
    const rawConf = (vals[confIdx] ?? '').trim()

    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        frp,
        confidence: normalizeConfidence(rawConf, isViirs),
        acq_date: (vals[dateIdx] ?? '').trim(),
        acq_time: (vals[timeIdx] ?? '').trim(),
        satellite: (vals[satIdx] ?? '').trim(),
        daynight: (vals[dnIdx] ?? 'D').trim() || 'D',
        type: parseInt(vals[typeIdx] ?? '') || 0,
        brightness: brightIdx >= 0 ? (parseFloat(vals[brightIdx] ?? '') || 0) : 0,
        source,
        color: frpToColor(frp),
      },
    })
  }
  return features
}

/** Merge VIIRS (primary, 375 m) and MODIS (supplementary, 1 km) detections.
 *  Drops MODIS points that fall within 0.01° (~1 km) of a same-date VIIRS point to avoid
 *  double-counting the same fire pixel detected by both sensors. */
export function mergeAndDedup(viirs: FireFeature[], modis: FireFeature[]): FireFeature[] {
  if (modis.length === 0) return viirs

  const viirsKeys = new Set(viirs.map(f => {
    const [lon, lat] = f.geometry.coordinates
    return `${f.properties.acq_date}:${Math.round(lon * 100)}:${Math.round(lat * 100)}`
  }))

  const newModis = modis.filter(f => {
    const [lon, lat] = f.geometry.coordinates
    const key = `${f.properties.acq_date}:${Math.round(lon * 100)}:${Math.round(lat * 100)}`
    return !viirsKeys.has(key)
  })

  return [...viirs, ...newModis]
}

/** Filter fire features to those whose centroid falls inside the AOI polygon. */
export function filterFiresInAoi(features: FireFeature[], aoi: any): FireFeature[] {
  return features.filter(f => {
    const [lon, lat] = f.geometry.coordinates
    return pointInAoi(lon, lat, aoi)
  })
}

export interface FireStats {
  count: number
  meanFrp: number
  maxFrp: number
  highConf: number
  medConf: number
  lowConf: number
  dayCount: number
  nightCount: number
  dates: string[]
  frpTiers: { extreme: number; high: number; moderate: number; low: number }
}

export function computeFireStats(features: FireFeature[]): FireStats {
  if (features.length === 0) {
    return {
      count: 0, meanFrp: 0, maxFrp: 0,
      highConf: 0, medConf: 0, lowConf: 0,
      dayCount: 0, nightCount: 0, dates: [],
      frpTiers: { extreme: 0, high: 0, moderate: 0, low: 0 },
    }
  }
  const frps = features.map(f => f.properties.frp)
  const sum = frps.reduce((a, b) => a + b, 0)
  return {
    count: features.length,
    meanFrp: sum / frps.length,
    maxFrp: Math.max(...frps),
    highConf: features.filter(f => f.properties.confidence === 'high').length,
    medConf: features.filter(f => f.properties.confidence === 'medium').length,
    lowConf: features.filter(f => f.properties.confidence === 'low').length,
    dayCount: features.filter(f => f.properties.daynight === 'D').length,
    nightCount: features.filter(f => f.properties.daynight === 'N').length,
    dates: [...new Set(features.map(f => f.properties.acq_date))].sort(),
    frpTiers: {
      extreme: features.filter(f => f.properties.frp > 200).length,
      high: features.filter(f => f.properties.frp > 50 && f.properties.frp <= 200).length,
      moderate: features.filter(f => f.properties.frp > 10 && f.properties.frp <= 50).length,
      low: features.filter(f => f.properties.frp <= 10).length,
    },
  }
}

/** Class palette for FIRE_PALETTE — drives the LayerLegend colorbar. */
export const FIRE_PALETTE: ClassesPalette = {
  kind: 'classes',
  label: 'Fire Radiative Power',
  unit: 'MW',
  classes: [
    { value: 'extreme', color: '#8b0000', label: '>200 MW' },
    { value: 'high',    color: '#ff4500', label: '50–200 MW' },
    { value: 'moderate',color: '#ff8c00', label: '10–50 MW' },
    { value: 'low',     color: '#ffd700', label: '<10 MW' },
  ],
}
