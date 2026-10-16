/** Raster → polygon vectorizer (pure TypeScript, no GDAL).
 *
 *  Pipeline: 4-connected component labelling → boundary tracing on the pixel-EDGE
 *  lattice → topology-preserving Douglas–Peucker → georeferencing → GeoJSON.
 *
 *  Why the edge lattice rather than per-component marching squares: every boundary
 *  edge between two pixels is a unit lattice segment owned by exactly one directed
 *  edge per side, so two adjacent components trace the SAME lattice vertices in
 *  opposite directions. Simplification then runs once per shared arc (arcs are cut
 *  at junction vertices where ≥3 labels meet) and both neighbours reuse the result,
 *  so shared boundaries stay coincident — no slivers, no overlaps.
 *
 *  Rings follow the "right-turn first" rule: with the component on the right-hand
 *  side, a vertex where two pixels of the same component touch only diagonally is
 *  resolved by splitting them (consistent with 4-connectivity). A hole that touches
 *  its shell at one vertex is split at the repeated vertex into shell + hole.
 *
 *  GEOREFERENCING. titiler's `/stac/feature.npy` returns the array over the BOUNDING
 *  BOX of the posted geometry, `width × height` cells (`lib/pixels.ts`, and
 *  `gridCoveragePct` in `lib/cloud.ts` derives the cell size the same way). Pixel
 *  corner (x, y) therefore sits at lon = minLng + x/width·ΔLng, lat = maxLat − y/height·ΔLat
 *  (row 0 = north).
 */

import { labelComponents } from './components'
import { douglasPeucker } from './simplify'

export { labelComponents } from './components'
export type { Components } from './components'
export { douglasPeucker } from './simplify'

export type BBox = [number, number, number, number]

export interface VectorizeOptions {
  /** Geographic extent the grid covers: [minLng, minLat, maxLng, maxLat]. */
  bbox: BBox
  /** Components smaller than this are dropped; holes smaller than this are filled. Default 0 (keep all). */
  minAreaM2?: number
  /** Douglas–Peucker tolerance in PIXELS. Default 0.7 (smooths the staircase, keeps corners). 0 = lossless. */
  simplifyTolerancePx?: number
  /** Raster value treated as background (not vectorized). Default 0. */
  background?: number
}

export interface VectorPolygon {
  /** Component id (1-based, in raster scan order). */
  id: number
  /** The raster value (class / label) of the component. */
  value: number
  /** Pixels in the component. */
  areaPx: number
  /** Area enclosed by the polygon (shell minus kept holes), m². */
  areaM2: number
  /** GeoJSON Polygon coordinates: [shell, ...holes], closed, shell CCW, holes CW. */
  coordinates: number[][][]
}

export interface VectorizeResult {
  polygons: VectorPolygon[]
  /** Working component-id grid (small components erased) — `VectorPolygon.id` indexes it,
   *  so callers can aggregate per-pixel values per polygon. */
  labels: Int32Array
  cellXm: number
  cellYm: number
  /** Components removed by the minimum-area filter. */
  droppedSmall: number
  droppedAreaM2: number
}

export interface Georef {
  cellXm: number
  cellYm: number
  pixelAreaM2: number
  /** Pixel-corner lattice coordinate → [lon, lat]. */
  toLonLat: (x: number, y: number) => [number, number]
}

/** Pixel-corner → lon/lat transform and cell size for a grid spanning `bbox`. */
export function makeGeoref(bbox: BBox, width: number, height: number): Georef {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const dLng = (maxLng - minLng) / width
  const dLat = (maxLat - minLat) / height
  const midLat = (minLat + maxLat) / 2
  const cellXm = dLng * 111_320 * Math.cos((midLat * Math.PI) / 180)
  const cellYm = dLat * 110_540
  const r = (v: number) => Math.round(v * 1e7) / 1e7
  return {
    cellXm,
    cellYm,
    pixelAreaM2: cellXm * cellYm,
    toLonLat: (x, y) => [r(minLng + x * dLng), r(maxLat - y * dLat)],
  }
}

// Directions in image space (y down), clockwise: E, S, W, N. Component on the RIGHT.
const DX = [1, 0, -1, 0]
const DY = [0, 1, 0, -1]

interface TracedRing { v: number[]; area: number }

export function vectorizeLabels(
  src: ArrayLike<number>,
  width: number,
  height: number,
  opts: VectorizeOptions,
): VectorizeResult {
  const geo = makeGeoref(opts.bbox, width, height)
  const comps = labelComponents(src, width, height, opts.background ?? 0)
  const tol = opts.simplifyTolerancePx ?? 0.7
  const minPx = opts.minAreaM2 && opts.minAreaM2 > 0 && geo.pixelAreaM2 > 0
    ? Math.ceil(opts.minAreaM2 / geo.pixelAreaM2)
    : 1

  // Drop small components by erasing them from the working label grid.
  let comp = comps.labels
  let droppedSmall = 0
  let droppedPx = 0
  if (minPx > 1) {
    const kill = new Uint8Array(comps.count + 1)
    for (let c = 1; c <= comps.count; c++) {
      if (comps.areas[c] < minPx) { kill[c] = 1; droppedSmall++; droppedPx += comps.areas[c] }
    }
    if (droppedSmall > 0) {
      comp = new Int32Array(comps.labels)
      for (let i = 0; i < comp.length; i++) if (kill[comp[i]]) comp[i] = 0
    }
  }

  const W1 = width + 1
  const nVerts = W1 * (height + 1)
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : comp[y * width + x])

  // 1 = boundary edge exists, 2 = consumed. Index = (vertex*4 + direction).
  const flags = new Uint8Array(nVerts * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const L = comp[y * width + x]
      if (L === 0) continue
      if (at(x, y - 1) !== L) flags[(y * W1 + x) * 4] = 1
      if (at(x + 1, y) !== L) flags[(y * W1 + x + 1) * 4 + 1] = 1
      if (at(x, y + 1) !== L) flags[((y + 1) * W1 + x + 1) * 4 + 2] = 1
      if (at(x - 1, y) !== L) flags[((y + 1) * W1 + x) * 4 + 3] = 1
    }
  }

  // Label on the right-hand side of the directed edge leaving (vx, vy) in direction d.
  const rightLabel = (vx: number, vy: number, d: number) =>
    d === 0 ? at(vx, vy) : d === 1 ? at(vx - 1, vy) : d === 2 ? at(vx - 1, vy - 1) : at(vx, vy - 1)

  const posOf = new Int32Array(nVerts).fill(-1)
  const ringsByLabel = new Map<number, TracedRing[]>()
  const vx = (id: number) => id % W1
  const vy = (id: number) => (id / W1) | 0
  const ringArea = (ring: number[]) => {
    let s = 0
    for (let i = 0, n = ring.length; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n]
      s += vx(a) * vy(b) - vx(b) * vy(a)
    }
    return s / 2
  }

  for (let idx = 0; idx < flags.length; idx++) {
    if (flags[idx] !== 1) continue
    const start = idx
    const L = rightLabel((idx >> 2) % W1, (((idx >> 2) / W1) | 0), idx & 3)
    const ring: number[] = []
    let cur = start
    let guard = 0
    do {
      flags[cur] = 2
      const d = cur & 3
      const v = cur >> 2
      const x = v % W1, y = (v / W1) | 0
      ring.push(v)
      const nx = x + DX[d], ny = y + DY[d]
      let nxt = -1
      for (const turn of [1, 0, 3]) {
        const nd = (d + turn) & 3
        const e = (ny * W1 + nx) * 4 + nd
        if ((flags[e] === 1 || e === start) && rightLabel(nx, ny, nd) === L) { nxt = e; break }
      }
      if (nxt < 0 || ++guard > nVerts * 4) {
        throw new Error('vectorize: boundary tracing failed to close a ring (corrupt label grid)')
      }
      cur = nxt
    } while (cur !== start)

    // Split at repeated vertices (a hole touching its shell at one corner).
    const stack: number[] = []
    const emit = (loop: number[]) => {
      if (loop.length < 4) return
      let list = ringsByLabel.get(L)
      if (!list) ringsByLabel.set(L, (list = []))
      list.push({ v: loop, area: ringArea(loop) })
    }
    for (const v of ring) {
      const p = posOf[v]
      if (p >= 0) {
        const loop = stack.splice(p)
        for (const u of loop) posOf[u] = -1
        emit(loop)
      }
      posOf[v] = stack.length
      stack.push(v)
    }
    for (const u of stack) posOf[u] = -1
    emit(stack)
  }

  // Junction vertices: ≥3 distinct labels around the vertex, or a diagonal pinch.
  const isNode = (id: number) => {
    const x = vx(id), y = vy(id)
    const a = at(x - 1, y - 1), b = at(x, y - 1), c = at(x - 1, y), d = at(x, y)
    if (a === d && b === c) return a !== b
    let distinct = 1
    if (b !== a) distinct++
    if (c !== a && c !== b) distinct++
    if (d !== a && d !== b && d !== c) distinct++
    return distinct >= 3
  }

  // Arc cache: a shared arc is simplified once, reused (reversed) by its neighbour.
  const arcCache = new Map<number, { kStart: number; ids: number[] }>()

  const simplifyArc = (arc: number[]): number[] => {
    const n = arc.length - 1
    const kStart = arc[0] * nVerts + arc[1]
    const kEnd = arc[n] * nVerts + arc[n - 1]
    const key = Math.min(kStart, kEnd)
    const hit = arcCache.get(key)
    if (hit) return hit.kStart === kStart ? hit.ids : hit.ids.slice().reverse()
    const xs = arc.map(vx), ys = arc.map(vy)
    const ids = douglasPeucker(xs, ys, tol).map((i) => arc[i])
    arcCache.set(key, { kStart, ids })
    return ids
  }

  /** Simplified closed ring (vertex ids, no repeated closing vertex). */
  const simplifyRing = (ringV: number[]): number[] => {
    let ring = ringV
    const nodePos: number[] = []
    for (let i = 0; i < ring.length; i++) if (isNode(ring[i])) nodePos.push(i)
    let startAt: number
    if (nodePos.length === 0) {
      // Canonical start so a ring and its mirror-image neighbour agree on the cut.
      startAt = 0
      for (let i = 1; i < ring.length; i++) if (ring[i] < ring[startAt]) startAt = i
    } else {
      startAt = nodePos[0]
    }
    if (startAt !== 0) ring = ring.slice(startAt).concat(ring.slice(0, startAt))
    const cuts = nodePos.length === 0 ? [0] : nodePos.map((p) => (p - startAt + ring.length) % ring.length).sort((a, b) => a - b)
    const out: number[] = []
    for (let j = 0; j < cuts.length; j++) {
      const from = cuts[j]
      const to = j + 1 < cuts.length ? cuts[j + 1] : ring.length
      const arc = ring.slice(from, to)
      arc.push(ring[to % ring.length])
      const s = simplifyArc(arc)
      for (let k = 0; k < s.length - 1; k++) out.push(s[k])
    }
    return out
  }

  const inRing = (ring: number[], px: number, py: number) => {
    let inside = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = vx(ring[i]), yi = vy(ring[i]), xj = vx(ring[j]), yj = vy(ring[j])
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }

  const polygons: VectorPolygon[] = []
  for (const [label, rings] of [...ringsByLabel.entries()].sort((a, b) => a[0] - b[0])) {
    const shells = rings.filter((r) => r.area > 0)
    const holes = rings.filter((r) => r.area < 0 && -r.area >= minPx)
    for (const shell of shells) {
      const myHoles = shells.length === 1
        ? holes
        : holes.filter((h) => inRing(shell.v, (vx(h.v[0]) + vx(h.v[1])) / 2, (vy(h.v[0]) + vy(h.v[1])) / 2))
      const coordRings: number[][][] = []
      let areaPx = shell.area
      const toCoords = (ids: number[]) => {
        const pts = ids.map((id) => geo.toLonLat(vx(id), vy(id)))
        pts.reverse() // image CW → lon/lat CCW for shells, CW for holes (RFC 7946)
        pts.push(pts[0])
        return pts
      }
      const simpShell = simplifyRing(shell.v)
      if (simpShell.length < 3 || Math.abs(ringArea(simpShell)) < 0.5) continue
      coordRings.push(toCoords(simpShell))
      for (const h of myHoles) {
        const sh = simplifyRing(h.v)
        if (sh.length < 3 || Math.abs(ringArea(sh)) < 0.5) continue
        coordRings.push(toCoords(sh))
        areaPx += h.area // h.area is negative
      }
      polygons.push({
        id: label,
        value: comps.values[label],
        areaPx: comps.areas[label],
        areaM2: areaPx * geo.pixelAreaM2,
        coordinates: coordRings,
      })
    }
  }

  return {
    polygons,
    labels: comp,
    cellXm: geo.cellXm,
    cellYm: geo.cellYm,
    droppedSmall,
    droppedAreaM2: droppedPx * geo.pixelAreaM2,
  }
}

/** Vectorize a binary mask (non-zero = feature). */
export function vectorizeMask(
  mask: ArrayLike<number>,
  width: number,
  height: number,
  opts: VectorizeOptions,
): VectorizeResult {
  const bin = new Uint8Array(width * height)
  for (let i = 0; i < bin.length; i++) bin[i] = mask[i] ? 1 : 0
  return vectorizeLabels(bin, width, height, { ...opts, background: 0 })
}

/** GeoJSON Feature for a polygon, with caller attributes merged over the defaults. */
export function polygonFeature(p: VectorPolygon, properties: Record<string, unknown> = {}) {
  return {
    type: 'Feature' as const,
    properties: { area_m2: Math.round(p.areaM2), ...properties },
    geometry: { type: 'Polygon' as const, coordinates: p.coordinates },
  }
}
