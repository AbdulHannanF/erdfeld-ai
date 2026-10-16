/** Flood impact: which buildings and how much road lie inside flood polygons (pure geometry).
 *
 *  A building counts as affected when the centroid of its footprint lies inside a flood
 *  polygon (holes respected). That is a deliberate, stated choice: a footprint that only
 *  grazes the flood edge is not counted, one that is mostly inside always is.
 *  A uniform grid index over polygon bounding boxes keeps the test O(1) per point, so
 *  50 000 buildings against thousands of polygons stays fast.
 */

export type Ring = number[][]
/** GeoJSON Polygon coordinates: [shell, ...holes]. */
export type PolyCoords = Ring[]

function inRing(ring: Ring, x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Point in polygon with holes (even-odd per ring). */
export function pointInPolygon(coords: PolyCoords, x: number, y: number): boolean {
  if (!coords.length || !inRing(coords[0], x, y)) return false
  for (let h = 1; h < coords.length; h++) if (inRing(coords[h], x, y)) return false
  return true
}

export interface PolygonIndex {
  /** Index of the first polygon containing the point, or -1. */
  find(x: number, y: number): number
  bbox: [number, number, number, number] | null
}

export function buildPolygonIndex(polys: PolyCoords[]): PolygonIndex {
  if (polys.length === 0) return { find: () => -1, bbox: null }
  const boxes = polys.map((p) => {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity
    for (const [x, y] of p[0] ?? []) {
      if (x < a) a = x
      if (x > c) c = x
      if (y < b) b = y
      if (y > d) d = y
    }
    return [a, b, c, d] as [number, number, number, number]
  })
  const minX = Math.min(...boxes.map((b) => b[0]))
  const minY = Math.min(...boxes.map((b) => b[1]))
  const maxX = Math.max(...boxes.map((b) => b[2]))
  const maxY = Math.max(...boxes.map((b) => b[3]))
  const n = Math.max(4, Math.min(256, Math.ceil(Math.sqrt(polys.length) * 2)))
  const sx = (maxX - minX) / n || 1
  const sy = (maxY - minY) / n || 1
  const cell = (v: number, lo: number, s: number) => Math.max(0, Math.min(n - 1, Math.floor((v - lo) / s)))
  const cells: number[][] = Array.from({ length: n * n }, () => [])
  boxes.forEach((b, k) => {
    for (let cy = cell(b[1], minY, sy); cy <= cell(b[3], minY, sy); cy++) {
      for (let cx = cell(b[0], minX, sx); cx <= cell(b[2], minX, sx); cx++) cells[cy * n + cx].push(k)
    }
  })
  return {
    bbox: [minX, minY, maxX, maxY],
    find(x, y) {
      if (x < minX || x > maxX || y < minY || y > maxY) return -1
      for (const k of cells[cell(y, minY, sy) * n + cell(x, minX, sx)]) {
        const b = boxes[k]
        if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && pointInPolygon(polys[k], x, y)) return k
      }
      return -1
    },
  }
}

/** Area-weighted centroid of a ring; falls back to the vertex mean for a degenerate ring.
 *  Computed relative to the first vertex: with absolute lon/lat (~74, ~31) the cross products of a 20 m footprint
 *  cancel catastrophically in double precision and the centroid drifts by hundreds of metres. */
export function ringCentroid(ring: Ring): [number, number] {
  const ox = ring[0]?.[0] ?? 0
  const oy = ring[0]?.[1] ?? 0
  let a = 0, cx = 0, cy = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xj = ring[j][0] - ox, yj = ring[j][1] - oy, xi = ring[i][0] - ox, yi = ring[i][1] - oy
    const f = xj * yi - xi * yj
    a += f
    cx += (xj + xi) * f
    cy += (yj + yi) * f
  }
  if (Math.abs(a) < 1e-18) {
    const n = ring.length || 1
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n]
  }
  return [ox + cx / (3 * a), oy + cy / (3 * a)]
}

/** Footprint centroid of a Polygon / MultiPolygon (largest outer ring for a multi-part building), or null. */
export function footprintCentroid(geom: any): [number, number] | null {
  let ring: Ring | undefined
  if (geom?.type === 'Polygon') ring = geom.coordinates?.[0]
  else if (geom?.type === 'MultiPolygon') {
    let best = -1
    for (const poly of geom.coordinates ?? []) {
      const r: Ring | undefined = poly?.[0]
      if (!r) continue
      const span = Math.abs(ringAreaDeg(r))
      if (span > best) { best = span; ring = r }
    }
  } else if (geom?.type === 'Point') return geom.coordinates as [number, number]
  if (!ring || ring.length < 3) return null
  const c = ringCentroid(ring)
  return Number.isFinite(c[0]) && Number.isFinite(c[1]) ? c : null
}

function ringAreaDeg(r: Ring): number {
  let a = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]
  return a / 2
}

export interface BuildingRow { id?: string; geometry: any; bbox?: any }

export interface AffectedBuilding {
  id: string
  centroid: [number, number]
  geometry: any
  /** Index into the flood polygon list that contains the centroid. */
  polygon: number
}

/** Buildings whose footprint centroid lies inside a flood polygon. */
export function buildingsInFlood(rows: BuildingRow[], index: PolygonIndex): AffectedBuilding[] {
  const out: AffectedBuilding[] = []
  for (const row of rows) {
    const c = footprintCentroid(row.geometry)
    if (!c) continue
    const k = index.find(c[0], c[1])
    if (k >= 0) out.push({ id: String(row.id ?? ''), centroid: c, geometry: row.geometry, polygon: k })
  }
  return out
}

export interface RoadImpact { floodedKm: number; totalKm: number; segmentsTouched: number; segmentsRead: number }

/**
 * Length of road inside flood polygons: each segment is walked in `stepM` pieces and a
 * piece counts, at its own length, when its midpoint is inside a flood polygon. Accurate
 * to about `stepM` per polygon crossing; not exact clipping.
 */
export function floodedRoadLength(rows: Array<{ geometry: any }>, index: PolygonIndex, stepM = 10): RoadImpact {
  let floodedKm = 0
  let totalKm = 0
  let touched = 0
  const bb = index.bbox
  for (const row of rows) {
    const g = row.geometry
    const lines: number[][][] = g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : []
    let hit = false
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        const [x0, y0] = line[i - 1], [x1, y1] = line[i]
        const kx = 111_320 * Math.cos((((y0 + y1) / 2) * Math.PI) / 180)
        const lenM = Math.hypot((x1 - x0) * kx, (y1 - y0) * 110_540)
        totalKm += lenM / 1000
        if (!bb || (Math.max(x0, x1) < bb[0] || Math.min(x0, x1) > bb[2] || Math.max(y0, y1) < bb[1] || Math.min(y0, y1) > bb[3])) continue
        const pieces = Math.max(1, Math.ceil(lenM / stepM))
        for (let p = 0; p < pieces; p++) {
          const t = (p + 0.5) / pieces
          if (index.find(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t) >= 0) { floodedKm += lenM / pieces / 1000; hit = true }
        }
      }
    }
    if (hit) touched++
  }
  return { floodedKm, totalKm, segmentsTouched: touched, segmentsRead: rows.length }
}
