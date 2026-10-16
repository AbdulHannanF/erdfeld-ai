/**
 * Elevation derivatives: Horn (1981) slope & aspect, marching-squares contours.
 * Pure math — no I/O. Used by tools/terrain.ts for fetch_elevation_derivatives.
 *
 * Grid convention throughout: grid[r][c], row 0 = north (high latitude),
 * col 0 = west (low longitude). Same convention as the elevGrid in terrain.ts.
 */

export interface DerivativeGrid {
  values: number[][]
  rows: number
  cols: number
  min: number
  max: number
}

/** Horn (1981) finite-difference slope in percent.
 *  cellSizeX = meters per column (east–west); cellSizeY = meters per row (north–south). */
export function computeSlope(grid: number[][], cellSizeX: number, cellSizeY: number): DerivativeGrid {
  const rows = grid.length
  const cols = grid[0]?.length ?? 0
  if (rows < 2 || cols < 2) return { values: [[0]], rows: 1, cols: 1, min: 0, max: 0 }

  const g = (r: number, c: number) =>
    grid[Math.max(0, Math.min(rows - 1, r))][Math.max(0, Math.min(cols - 1, c))]

  const values: number[][] = []
  let min = Infinity, max = -Infinity

  for (let r = 0; r < rows; r++) {
    const row: number[] = []
    for (let c = 0; c < cols; c++) {
      // Horn's kernel for east–west gradient (positive = uphill going east)
      const dzdx =
        (g(r - 1, c + 1) + 2 * g(r, c + 1) + g(r + 1, c + 1) -
         g(r - 1, c - 1) - 2 * g(r, c - 1) - g(r + 1, c - 1)) /
        (8 * cellSizeX)
      // Horn's kernel in the grid's row direction (positive = uphill going south,
      // since row increases going south). Used in slope magnitude only.
      const dzdy =
        (g(r + 1, c - 1) + 2 * g(r + 1, c) + g(r + 1, c + 1) -
         g(r - 1, c - 1) - 2 * g(r - 1, c) - g(r - 1, c + 1)) /
        (8 * cellSizeY)
      const s = Math.sqrt(dzdx * dzdx + dzdy * dzdy) * 100
      row.push(s)
      if (s < min) min = s
      if (s > max) max = s
    }
    values.push(row)
  }
  return { values, rows, cols, min, max }
}

/** Horn (1981) aspect in degrees clockwise from north (0 = N, 90 = E, 180 = S, 270 = W).
 *  Flat cells (no gradient) return 0. */
export function computeAspect(grid: number[][], cellSizeX: number, cellSizeY: number): DerivativeGrid {
  const rows = grid.length
  const cols = grid[0]?.length ?? 0
  if (rows < 2 || cols < 2) return { values: [[0]], rows: 1, cols: 1, min: 0, max: 0 }

  const g = (r: number, c: number) =>
    grid[Math.max(0, Math.min(rows - 1, r))][Math.max(0, Math.min(cols - 1, c))]

  const values: number[][] = []

  for (let r = 0; r < rows; r++) {
    const row: number[] = []
    for (let c = 0; c < cols; c++) {
      const dzdx =
        (g(r - 1, c + 1) + 2 * g(r, c + 1) + g(r + 1, c + 1) -
         g(r - 1, c - 1) - 2 * g(r, c - 1) - g(r + 1, c - 1)) /
        (8 * cellSizeX)
      // dzdy_grid: positive = uphill going south (increasing row)
      // Northward gradient = −dzdy_grid
      const dzdy_grid =
        (g(r + 1, c - 1) + 2 * g(r + 1, c) + g(r + 1, c + 1) -
         g(r - 1, c - 1) - 2 * g(r - 1, c) - g(r - 1, c + 1)) /
        (8 * cellSizeY)
      // Aspect clockwise from N = atan2(east_gradient, north_gradient)
      let aspect = Math.atan2(dzdx, -dzdy_grid) * (180 / Math.PI)
      if (aspect < 0) aspect += 360
      row.push(aspect)
    }
    values.push(row)
  }
  return { values, rows, cols, min: 0, max: 360 }
}

// ---------------------------------------------------------------------------
// Marching-squares contours
// ---------------------------------------------------------------------------

/** Lookup table: case index → [[edgeA, edgeB], ...] line segment pairs.
 *  Edges: 0=top (tl→tr), 1=right (tr→br), 2=bottom (br→bl), 3=left (bl→tl).
 *  Case bit mask: bit3=tl, bit2=tr, bit1=br, bit0=bl; bit=1 means corner ≥ level. */
const MS_LOOKUP: Record<number, [number, number][]> = {
   1: [[3, 2]],           // bl above              → left–bottom
   2: [[2, 1]],           // br above              → bottom–right
   3: [[3, 1]],           // br,bl above           → left–right
   4: [[1, 0]],           // tr above              → right–top
   5: [[3, 0], [2, 1]],  // tr,bl above (saddle)  → left–top & bottom–right
   6: [[2, 0]],           // tr,br above           → bottom–top
   7: [[3, 0]],           // tr,br,bl above        → left–top
   8: [[0, 3]],           // tl above              → top–left
   9: [[0, 2]],           // tl,bl above           → top–bottom
  10: [[0, 1], [3, 2]],  // tl,br above (saddle)  → top–right & left–bottom
  11: [[0, 1]],           // tl,br,bl above        → top–right
  12: [[1, 3]],           // tl,tr above           → right–left
  13: [[1, 2]],           // tl,tr,bl above        → right–bottom
  14: [[2, 3]],           // tl,tr,br above        → bottom–left
}

export interface ContourResult {
  featureCollection: { type: 'FeatureCollection'; features: ContourFeature[] }
  levels: number[]
  minElev: number
  maxElev: number
  /** Raw marching-squares cell crossings, before joining. Diagnostic only. */
  totalSegments: number
  /** Continuous polylines after joining — what actually gets drawn, and the number
   *  worth reporting. A 10x10 grid at 4 levels can yield 261 crossings and 6 lines. */
  totalLines: number
}

export interface ContourFeature {
  type: 'Feature'
  geometry: { type: 'MultiLineString'; coordinates: [number, number][][] }
  properties: { elevation: number }
}

/** Join marching-squares crossings into continuous polylines.
 *
 *  Marching squares emits one short segment per cell edge pair, so a single contour
 *  ring comes out as dozens of disconnected two-point fragments. Handing those to the
 *  map as-is is what produced "261 contour segments from a 10x10 grid" — a true count
 *  of a useless geometry. Adjacent cells share an edge crossing computed by the same
 *  interpolation from the same two corner values, so the endpoints match exactly and
 *  can be chained.
 *
 *  Coordinates are keyed at 1e-9 degrees (~0.1 mm) rather than by raw float identity,
 *  so a last-bit difference cannot split a line that is geometrically continuous.
 */
export function stitchSegments(segs: [number, number][][]): [number, number][][] {
  const key = (p: [number, number]) => `${p[0].toFixed(9)},${p[1].toFixed(9)}`

  // Adjacency: point key -> indices of segments touching it.
  const touching = new Map<string, number[]>()
  segs.forEach((seg, i) => {
    for (const p of [seg[0], seg[seg.length - 1]]) {
      const k = key(p)
      const list = touching.get(k)
      if (list) list.push(i)
      else touching.set(k, [i])
    }
  })

  const used = new Array<boolean>(segs.length).fill(false)
  const lines: [number, number][][] = []

  /** Find an unused segment sharing `point`, and return its far end. */
  const step = (point: [number, number]): { idx: number; next: [number, number] } | null => {
    for (const idx of touching.get(key(point)) ?? []) {
      if (used[idx]) continue
      const seg = segs[idx]
      const a = seg[0]
      const b = seg[seg.length - 1]
      if (key(a) === key(point)) return { idx, next: b }
      if (key(b) === key(point)) return { idx, next: a }
    }
    return null
  }

  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    used[i] = true
    const line: [number, number][] = [...segs[i]]

    // Extend forward from the tail, then backward from the head. A closed ring
    // terminates naturally when the only remaining neighbour is already used.
    for (;;) {
      const hop = step(line[line.length - 1])
      if (!hop) break
      used[hop.idx] = true
      line.push(hop.next)
    }
    for (;;) {
      const hop = step(line[0])
      if (!hop) break
      used[hop.idx] = true
      line.unshift(hop.next)
    }

    lines.push(line)
  }

  return lines
}

/** Generate contour lines using marching squares.
 *  grid[r][c]: elevation (m), row 0 = north.
 *  interval: contour interval in meters (must be > 0).
 *  bounds: [minLng, minLat, maxLng, maxLat] of the grid corners. */
export function computeContours(
  grid: number[][],
  interval: number,
  bounds: [number, number, number, number],
): ContourResult {
  const rows = grid.length
  const cols = grid[0]?.length ?? 0
  const [minLng, minLat, maxLng, maxLat] = bounds

  let minElev = Infinity, maxElev = -Infinity
  for (const row of grid) for (const e of row) {
    if (e < minElev) minElev = e
    if (e > maxElev) maxElev = e
  }

  if (rows < 2 || cols < 2 || !isFinite(minElev)) {
    return { featureCollection: { type: 'FeatureCollection', features: [] }, levels: [], minElev: 0, maxElev: 0, totalSegments: 0, totalLines: 0 }
  }

  /** Convert fractional grid position to [lng, lat]. */
  const toLL = (fr: number, fc: number): [number, number] => [
    minLng + (fc / (cols - 1)) * (maxLng - minLng),
    maxLat - (fr / (rows - 1)) * (maxLat - minLat),
  ]

  /** Interpolated crossing point on an edge between two corners. */
  const cross = (
    e0: number, e1: number,
    r0: number, c0: number,
    r1: number, c1: number,
    level: number,
  ): [number, number] => {
    const t = (level - e0) / (e1 - e0)
    return toLL(r0 + t * (r1 - r0), c0 + t * (c1 - c0))
  }

  const firstLevel = Math.ceil(minElev / interval) * interval
  const levelList: number[] = []
  for (let lev = firstLevel; lev <= maxElev; lev += interval) levelList.push(lev)

  const features: ContourFeature[] = []
  const usedLevels: number[] = []
  let totalSegments = 0
  let totalLines = 0

  for (const level of levelList) {
    const segs: [number, number][][] = []

    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const tl = grid[r][c]
        const tr = grid[r][c + 1]
        const br = grid[r + 1][c + 1]
        const bl = grid[r + 1][c]

        const caseIdx =
          (tl >= level ? 8 : 0) |
          (tr >= level ? 4 : 0) |
          (br >= level ? 2 : 0) |
          (bl >= level ? 1 : 0)

        const pairs = MS_LOOKUP[caseIdx]
        if (!pairs) continue

        // Pre-compute crossing point for each active edge (null if edge doesn't cross)
        const edgePts: ([number, number] | null)[] = [
          (tl >= level) !== (tr >= level) ? cross(tl, tr, r, c,     r,     c + 1, level) : null, // top
          (tr >= level) !== (br >= level) ? cross(tr, br, r, c + 1, r + 1, c + 1, level) : null, // right
          (br >= level) !== (bl >= level) ? cross(br, bl, r + 1, c + 1, r + 1, c, level) : null, // bottom
          (bl >= level) !== (tl >= level) ? cross(bl, tl, r + 1, c, r,     c,    level) : null,  // left
        ]

        for (const [a, b] of pairs) {
          const pA = edgePts[a], pB = edgePts[b]
          if (pA && pB) segs.push([pA, pB])
        }
      }
    }

    if (segs.length > 0) {
      const lines = stitchSegments(segs)
      features.push({
        type: 'Feature',
        geometry: { type: 'MultiLineString', coordinates: lines },
        properties: { elevation: level },
      })
      usedLevels.push(level)
      totalSegments += segs.length
      totalLines += lines.length
    }
  }

  return {
    featureCollection: { type: 'FeatureCollection', features },
    levels: usedLevels,
    minElev,
    maxElev,
    totalSegments,
    totalLines,
  }
}

// ---------------------------------------------------------------------------
// Derived statistics helpers
// ---------------------------------------------------------------------------

/** Compass bearing class (0–7) from an aspect value in degrees. */
export function aspectClass(deg: number): number {
  const d = ((deg % 360) + 360) % 360
  return Math.round(d / 45) % 8
}

export const COMPASS_LABELS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const

/** Count what fraction of grid cells fall into each slope category. */
export function slopeDistribution(slopePct: number[]): {
  flat: number; gentle: number; moderate: number; steep: number; verysteep: number
} {
  const n = slopePct.length || 1
  let flat = 0, gentle = 0, moderate = 0, steep = 0, verysteep = 0
  for (const s of slopePct) {
    if (s < 5) flat++
    else if (s < 15) gentle++
    else if (s < 30) moderate++
    else if (s < 60) steep++
    else verysteep++
  }
  const pct = (v: number) => Math.round((v / n) * 100)
  return { flat: pct(flat), gentle: pct(gentle), moderate: pct(moderate), steep: pct(steep), verysteep: pct(verysteep) }
}
