// Pure, framework-free geometry helpers for the client: great-circle distance,
// spherical-shoelace polygon area and the vertex-average centroid. No DOM and no
// third-party imports. The client deliberately uses these hand-rolled formulas
// rather than the `@turf/*` packages (which are server-side only) to keep the
// client bundle lean.

const EARTH_RADIUS_M = 6371000

export type Ring = number[][] // [ [lng, lat], ... ]

export interface LngLat {
  lng: number
  lat: number
}

/** Haversine great-circle distance in meters between two lng/lat points. */
export function haversineM(
  lng1: number,
  lat1: number,
  lng2: number,
  lat2: number,
): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function ringOf(poly: GeoJSON.Polygon): Ring {
  return poly.coordinates[0] ?? []
}

/** Spherical-shoelace area in m². Expects a closed ring (last vertex == first). */
export function ringAreaM2(coords: Ring): number {
  const R = EARTH_RADIUS_M
  let area = 0
  for (let i = 0; i < coords.length - 1; i++) {
    const [x1, y1] = coords[i]
    const [x2, y2] = coords[i + 1]
    const latRad1 = y1 * (Math.PI / 180)
    const latRad2 = y2 * (Math.PI / 180)
    const x1m = x1 * (Math.PI / 180) * R * Math.cos(latRad1)
    const y1m = y1 * (Math.PI / 180) * R
    const x2m = x2 * (Math.PI / 180) * R * Math.cos(latRad2)
    const y2m = y2 * (Math.PI / 180) * R
    area += x1m * y2m - x2m * y1m
  }
  return Math.abs(area) / 2
}

/** Average-of-vertices centroid. */
export function polygonCentroid(poly: GeoJSON.Polygon): LngLat {
  const coords = ringOf(poly)
  const n = coords.length || 1
  const sumLng = coords.reduce((s, c) => s + c[0], 0)
  const sumLat = coords.reduce((s, c) => s + c[1], 0)
  return { lng: sumLng / n, lat: sumLat / n }
}
