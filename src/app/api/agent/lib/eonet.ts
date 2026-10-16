/** NASA EONET wildfire events — the key-free fallback for `fetch_active_fires`.
 *
 *  ## Why this exists
 *
 *  `fetch_active_fires` is backed by NASA FIRMS, which requires a free `MAP_KEY`. When
 *  the key is absent the tool was honest but empty: it named the missing key and
 *  returned nothing. That is correct behaviour and still better than inventing
 *  hotspots, but it means a default deployment answers "are there fires here?" with
 *  setup instructions rather than an answer.
 *
 *  EONET (Earth Observatory Natural Event Tracker) is NASA's curated event feed. It
 *  needs no key, no registration and no token, and it carries real wildfire events with
 *  a position, a date, a size and a named upstream source.
 *
 *  ## What this is NOT
 *
 *  EONET events are **not** FIRMS hotspots, and the difference is not cosmetic:
 *
 *  | | FIRMS | EONET |
 *  |---|---|---|
 *  | Unit | one thermal-anomaly pixel | one curated incident |
 *  | Resolution | 375 m (VIIRS) / 1 km (MODIS) | a single representative point |
 *  | Latency | near-real-time, hours | curated, can lag by a day or more |
 *  | Coverage | every detection, everywhere | incidents a reporting agency filed |
 *  | Count means | number of burning pixels | number of named incidents |
 *
 *  A count of EONET events is therefore not comparable to a count of FIRMS detections,
 *  and EONET's coverage is much thinner outside regions with active reporting agencies
 *  (its richest source is the US IRWIN feed). Absence of EONET events is emphatically
 *  not evidence of absence of fire. Every caller must say so — see
 *  `EONET_COVERAGE_CAVEAT`.
 */

import { cachedFetchJson } from './cache'
import { getLogger } from './logger'

const log = getLogger('agent/eonet')

const EONET_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events'

/** The sentence any answer built on EONET has to carry. */
export const EONET_COVERAGE_CAVEAT =
  'EONET lists curated fire *incidents* reported by agencies, not satellite thermal ' +
  'hotspots. Coverage is uneven outside regions with active reporting agencies, so ' +
  'zero events here means "none were reported", not "nothing is burning". For ' +
  'per-pixel detections set FIRMS_MAP_KEY.'

export interface EonetFire {
  id: string
  title: string
  /** ISO date of the most recent observation inside the requested window. */
  date: string
  lng: number
  lat: number
  /** Reported size, already normalised to acres where a unit was given. */
  acres: number | null
  /** Raw magnitude as reported, for provenance. */
  magnitudeValue: number | null
  magnitudeUnit: string | null
  /** Upstream reporting source ids (e.g. IRWIN, InciWeb). */
  sources: string[]
  /** True when the incident is still open. */
  open: boolean
}

/** Hectares → acres. EONET mixes units between sources on the same feed. */
function toAcres(value: number | null, unit: string | null): number | null {
  if (value == null || !Number.isFinite(value)) return null
  const u = (unit ?? '').toLowerCase()
  if (u.startsWith('acre')) return value
  if (u.startsWith('hectare') || u === 'ha') return value * 2.47105
  if (u.startsWith('km')) return value * 247.105
  return null
}

/**
 * Fetch wildfire events intersecting `bbox` within the last `days`.
 *
 * `bbox` is [minLng, minLat, maxLng, maxLat]; EONET wants west,north,east,south, which
 * is why the order is rearranged rather than passed through.
 *
 * Returns an empty array both when there are genuinely no events and when the feed is
 * unreachable — the two are distinguished by the `ok` flag so a caller never reports an
 * outage as "no fires".
 */
export async function fetchEonetWildfires(
  bbox: [number, number, number, number],
  days: number,
): Promise<{ ok: true; fires: EonetFire[] } | { ok: false; reason: string }> {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const windowDays = Math.min(Math.max(Math.round(days), 1), 120)
  const params = new URLSearchParams({
    category: 'wildfires',
    bbox: `${minLng.toFixed(4)},${maxLat.toFixed(4)},${maxLng.toFixed(4)},${minLat.toFixed(4)}`,
    days: String(windowDays),
    status: 'all',
  })
  const url = `${EONET_URL}?${params}`

  let json: any
  try {
    json = await cachedFetchJson(`eonet:${params}`, 15 * 60 * 1000, async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
      if (!res.ok) throw new Error(`EONET HTTP ${res.status}`)
      return res.json()
    })
  } catch (err: any) {
    log.warn({ err: err?.message }, 'EONET wildfire query failed')
    return { ok: false, reason: `NASA EONET did not respond (${err?.message ?? 'unknown error'})` }
  }

  const cutoff = Date.now() - windowDays * 86_400_000
  const fires: EonetFire[] = []

  for (const ev of (json?.events ?? []) as any[]) {
    const geoms = Array.isArray(ev?.geometry) ? ev.geometry : []
    // An event carries a track: one geometry entry per observation. Take the most
    // recent point inside the window, so a long-running incident is dated by when it
    // was last seen rather than when it started.
    let best: any = null
    for (const g of geoms) {
      if (g?.type !== 'Point' || !Array.isArray(g?.coordinates)) continue
      const t = Date.parse(g?.date ?? '')
      if (!Number.isFinite(t) || t < cutoff) continue
      if (!best || t > Date.parse(best.date)) best = g
    }
    if (!best) continue

    const [lng, lat] = best.coordinates
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue

    const magnitudeValue = Number.isFinite(best.magnitudeValue) ? Number(best.magnitudeValue) : null
    const magnitudeUnit = typeof best.magnitudeUnit === 'string' ? best.magnitudeUnit : null

    fires.push({
      id: String(ev?.id ?? ''),
      title: String(ev?.title ?? 'Wildfire'),
      date: String(best.date ?? '').slice(0, 10),
      lng: Number(lng),
      lat: Number(lat),
      acres: toAcres(magnitudeValue, magnitudeUnit),
      magnitudeValue,
      magnitudeUnit,
      sources: (ev?.sources ?? []).map((s: any) => String(s?.id ?? '')).filter(Boolean),
      open: ev?.closed == null,
    })
  }

  fires.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  return { ok: true, fires }
}

/** Point-in-polygon narrowing, so a bbox query is reported against the drawn AOI.
 *  Uses the ray-casting test; callers pass a Polygon or MultiPolygon. */
export function firesInPolygon(fires: EonetFire[], aoi: any): EonetFire[] {
  const geom = aoi?.type === 'Feature' ? aoi.geometry : aoi
  const rings: number[][][] =
    geom?.type === 'Polygon'
      ? geom.coordinates
      : geom?.type === 'MultiPolygon'
        ? geom.coordinates.flat()
        : []
  if (rings.length === 0) return fires

  const inside = (lng: number, lat: number) => {
    let within = false
    for (const ring of rings) {
      let hit = false
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]
        const [xj, yj] = ring[j]
        if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit
      }
      // Rings after the first are holes; an odd number of containments wins.
      if (hit) within = !within
    }
    return within
  }

  return fires.filter((f) => inside(f.lng, f.lat))
}
