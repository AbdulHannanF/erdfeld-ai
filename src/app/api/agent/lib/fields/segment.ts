/** Multi-temporal field segmentation: marker-controlled watershed over a per-pixel
 *  NDVI time series, followed by region-adjacency merging.
 *
 *  A single NDVI image cannot separate two adjacent fields that happen to look alike
 *  on that day; a season of them can, because fields are managed as units and so
 *  share a phenology. The pipeline therefore works on the whole stack:
 *
 *   1. Boundary strength G = mean-over-dates Sobel magnitude of NDVI
 *                          + ½ · max over the 4 neighbours of the temporal-profile
 *                            dissimilarity (mean |ΔNDVI| across the dates both pixels
 *                            were observed). Cloud gaps are gaps, never zeros.
 *   2. Seeds = 4-connected, once-eroded cores of low-G pixels (G below a noise-adaptive
 *      threshold taken from the scene's own median G).
 *   3. Priority-flood watershed from the seeds over G (bucket queue, O(N)). Every
 *      observed pixel gets a label; boundaries are the ridge lines.
 *   4. Region-adjacency merging on mean temporal profiles: neighbours closer than
 *      `mergeDistance` are the same field over-split by noise; regions smaller than
 *      `minAreaPx` are absorbed by their most similar neighbour.
 *
 *  Adjacent fields with the same phenology and no visible boundary are merged by
 *  design — that is a resolution limit of the data, not a bug to hide.
 */

import { labelComponents } from '../vectorize/components'

export interface StackInput {
  width: number
  height: number
  /** One NDVI grid per date (NaN = cloud / gap), row-major, row 0 = north. */
  layers: Float32Array[]
  /** 1 = inside the polygon and observed. */
  inside: Uint8Array
  /** NDBI per date on the same grid and mask as `layers`. Used only to label regions
   *  (built-up vs. bare soil), never to place boundaries. */
  ndbi?: Float32Array[]
}

export interface SegmentOptions {
  /** Regions smaller than this are merged into their most similar neighbour. */
  minAreaPx: number
  /** Mean |ΔNDVI| between neighbouring region profiles below which they are one field. Default 0.05. */
  mergeDistance?: number
  /** A pixel needs this many clear dates to take part. Default max(2, ⌈0.4·dates⌉). */
  minValidDates?: number
}

export interface RegionStat {
  id: number
  pixels: number
  /** Mean NDVI per date (NaN where the region was not observed enough). */
  profile: number[]
  /** RMS deviation of member pixels from the region profile (interior heterogeneity). */
  sd: number
  /** Mean NDBI per date (NaN where unobserved); empty when the stack carries no NDBI. */
  ndbiProfile: number[]
  /** Border-weighted mean profile distance to neighbouring regions; null when it has none. */
  contrast: number | null
  /** Share of dates with a usable regional mean. */
  validDateFrac: number
}

export interface SegmentResult {
  /** 0 = unobserved / outside; otherwise 1..regions.length (index = id − 1). */
  labels: Int32Array
  regions: RegionStat[]
  seedCount: number
  initialRegions: number
  mergedSimilar: number
  mergedSmall: number
  boundaryThreshold: number
}

const LEVELS = 512
const G_MAX = 0.6

/** Min-heap on `cost`. */
class Heap {
  private cost: number[] = []
  private a: number[] = []
  private b: number[] = []
  private va: number[] = []
  private vb: number[] = []
  get size() { return this.cost.length }
  push(cost: number, a: number, b: number, va: number, vb: number) {
    let i = this.cost.length
    this.cost.push(cost); this.a.push(a); this.b.push(b); this.va.push(va); this.vb.push(vb)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.cost[p] <= this.cost[i]) break
      this.swap(i, p)
      i = p
    }
  }
  pop() {
    const top = { cost: this.cost[0], a: this.a[0], b: this.b[0], va: this.va[0], vb: this.vb[0] }
    const last = this.cost.length - 1
    this.swap(0, last)
    this.cost.pop(); this.a.pop(); this.b.pop(); this.va.pop(); this.vb.pop()
    let i = 0
    const n = this.cost.length
    for (;;) {
      const l = 2 * i + 1, r = l + 1
      let m = i
      if (l < n && this.cost[l] < this.cost[m]) m = l
      if (r < n && this.cost[r] < this.cost[m]) m = r
      if (m === i) break
      this.swap(i, m)
      i = m
    }
    return top
  }
  peekCost() { return this.cost[0] }
  private swap(i: number, j: number) {
    if (i === j) return
    ;[this.cost[i], this.cost[j]] = [this.cost[j], this.cost[i]]
    ;[this.a[i], this.a[j]] = [this.a[j], this.a[i]]
    ;[this.b[i], this.b[j]] = [this.b[j], this.b[i]]
    ;[this.va[i], this.va[j]] = [this.va[j], this.va[i]]
    ;[this.vb[i], this.vb[j]] = [this.vb[j], this.vb[i]]
  }
}

/** Per-pixel boundary strength. NaN where the pixel takes no part. */
export function boundaryStrength(stack: StackInput, usable: Uint8Array): Float32Array {
  const { width: w, height: h, layers } = stack
  const n = w * h
  const D = layers.length
  const gsum = new Float32Array(n)
  const gcnt = new Uint8Array(n)

  // Sobel magnitude per date. A missing neighbour is replaced by the centre value, so a
  // cloud edge contributes no false gradient.
  for (let d = 0; d < D; d++) {
    const L = layers[d]
    for (let y = 0; y < h; y++) {
      const ym = y > 0 ? y - 1 : y, yp = y < h - 1 ? y + 1 : y
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        const c = L[i]
        if (c !== c || !usable[i]) continue
        const xm = x > 0 ? x - 1 : x, xp = x < w - 1 ? x + 1 : x
        const s = (j: number) => { const v = L[j]; return v !== v ? c : v }
        const a = s(ym * w + xm), b = s(ym * w + x), cc = s(ym * w + xp)
        const dd = s(y * w + xm), ff = s(y * w + xp)
        const g = s(yp * w + xm), hh = s(yp * w + x), ii = s(yp * w + xp)
        const gx = (cc + 2 * ff + ii) - (a + 2 * dd + g)
        const gy = (g + 2 * hh + ii) - (a + 2 * b + cc)
        gsum[i] += Math.sqrt(gx * gx + gy * gy) / 8
        gcnt[i]++
      }
    }
  }

  // Temporal-profile dissimilarity across each pixel edge (to the right, and down).
  const dh = new Float32Array(n).fill(-1)
  const dv = new Float32Array(n).fill(-1)
  const pair = (i: number, j: number): number => {
    let s = 0, k = 0
    for (let d = 0; d < D; d++) {
      const p = layers[d][i], q = layers[d][j]
      if (p === p && q === q) { s += Math.abs(p - q); k++ }
    }
    return k > 0 ? s / k : -1
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!usable[i]) continue
      if (x < w - 1 && usable[i + 1]) dh[i] = pair(i, i + 1)
      if (y < h - 1 && usable[i + w]) dv[i] = pair(i, i + w)
    }
  }

  const G = new Float32Array(n).fill(NaN)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!usable[i] || gcnt[i] === 0) continue
      let p = 0
      if (dh[i] > p) p = dh[i]
      if (dv[i] > p) p = dv[i]
      if (x > 0 && dh[i - 1] > p) p = dh[i - 1]
      if (y > 0 && dv[i - w] > p) p = dv[i - w]
      G[i] = gsum[i] / gcnt[i] + 0.5 * p
    }
  }
  return G
}

export function segmentFields(stack: StackInput, opts: SegmentOptions): SegmentResult {
  const { width: w, height: h, layers, inside } = stack
  const n = w * h
  const D = layers.length
  const minValid = opts.minValidDates ?? Math.max(2, Math.ceil(D * 0.4))
  const mergeDistance = opts.mergeDistance ?? 0.05
  const minAreaPx = Math.max(1, Math.round(opts.minAreaPx))

  // ---- usable pixels ------------------------------------------------------
  const usable = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (!inside[i]) continue
    let k = 0
    for (let d = 0; d < D; d++) if (layers[d][i] === layers[d][i]) k++
    if (k >= minValid) usable[i] = 1
  }

  // ---- 1. boundary strength ----------------------------------------------
  const G = boundaryStrength(stack, usable)

  // Noise-adaptive seed threshold: the scene's own median G is its interior noise level.
  const hist = new Uint32Array(1024)
  let nUsable = 0
  for (let i = 0; i < n; i++) {
    if (!usable[i] || G[i] !== G[i]) continue
    hist[Math.min(1023, Math.floor((G[i] / 1.0) * 1024))]++
    nUsable++
  }
  let median = 0
  for (let acc = 0, b = 0; b < 1024; b++) {
    acc += hist[b]
    if (acc >= nUsable / 2) { median = (b + 0.5) / 1024; break }
  }
  const threshold = Math.min(0.15, Math.max(0.04, 1.8 * median))

  // ---- 2. seeds: low-G, once-eroded, 4-connected -------------------------
  const low = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (usable[i] && G[i] < threshold) low[i] = 1
  const core = new Uint8Array(n)
  const okNb = (x: number, y: number) => x < 0 || y < 0 || x >= w || y >= h || !usable[y * w + x] || low[y * w + x] === 1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (low[i] && okNb(x - 1, y) && okNb(x + 1, y) && okNb(x, y - 1) && okNb(x, y + 1)) core[i] = 1
    }
  }
  const seeds = labelComponents(core, w, h, 0)
  const minSeedPx = 4
  const lab = new Int32Array(n)
  const seedRemap = new Int32Array(seeds.count + 1)
  let nSeeds = 0
  for (let c = 1; c <= seeds.count; c++) if (seeds.areas[c] >= minSeedPx) seedRemap[c] = ++nSeeds
  for (let i = 0; i < n; i++) if (seeds.labels[i]) lab[i] = seedRemap[seeds.labels[i]]

  // ---- 3. priority-flood watershed (bucket queue) -------------------------
  const level = (i: number) => Math.min(LEVELS - 1, Math.max(0, Math.floor((G[i] / G_MAX) * LEVELS)))
  const head = new Int32Array(LEVELS).fill(-1)
  const tail = new Int32Array(LEVELS)
  const next = new Int32Array(n)
  const push = (i: number, lv: number) => {
    next[i] = -1
    if (head[lv] < 0) { head[lv] = tail[lv] = i } else { next[tail[lv]] = i; tail[lv] = i }
  }
  const visit = (p: number, q: number, lv: number) => {
    if (usable[q] && lab[q] === 0) { lab[q] = lab[p]; push(q, Math.max(level(q), lv)) }
  }
  // Snapshot the seeds first: labelling neighbours while scanning would let a seed's
  // label run along the scan direction at level 0, ignoring the boundary strength.
  const seedPx: number[] = []
  for (let i = 0; i < n; i++) if (lab[i]) seedPx.push(i)
  for (const p of seedPx) {
    const x = p % w, y = (p / w) | 0
    if (x > 0) visit(p, p - 1, 0)
    if (x < w - 1) visit(p, p + 1, 0)
    if (y > 0) visit(p, p - w, 0)
    if (y < h - 1) visit(p, p + w, 0)
  }
  for (let lv = 0; lv < LEVELS; lv++) {
    while (head[lv] >= 0) {
      const p = head[lv]
      head[lv] = next[p]
      const x = p % w, y = (p / w) | 0
      if (x > 0) visit(p, p - 1, lv)
      if (x < w - 1) visit(p, p + 1, lv)
      if (y > 0) visit(p, p - w, lv)
      if (y < h - 1) visit(p, p + w, lv)
    }
  }

  // Observed pixels no seed could reach (an isolated patch with no low-G core).
  let R = nSeeds
  const leftover = new Uint8Array(n)
  let anyLeft = false
  for (let i = 0; i < n; i++) if (usable[i] && lab[i] === 0) { leftover[i] = 1; anyLeft = true }
  if (anyLeft) {
    const lo = labelComponents(leftover, w, h, 0)
    for (let i = 0; i < n; i++) if (lo.labels[i]) lab[i] = R + lo.labels[i]
    R += lo.count
  }
  const initialRegions = R

  // ---- 4. region adjacency + merging -------------------------------------
  const sums = new Float64Array((R + 1) * D)
  const cnts = new Int32Array((R + 1) * D)
  const pix = new Int32Array(R + 1)
  for (let i = 0; i < n; i++) {
    const r = lab[i]
    if (!r) continue
    pix[r]++
    for (let d = 0; d < D; d++) {
      const v = layers[d][i]
      if (v === v) { sums[r * D + d] += v; cnts[r * D + d]++ }
    }
  }
  const adj: Array<Map<number, number>> = Array.from({ length: R + 1 }, () => new Map())
  const link = (a: number, b: number) => {
    if (!a || !b || a === b) return
    adj[a].set(b, (adj[a].get(b) ?? 0) + 1)
    adj[b].set(a, (adj[b].get(a) ?? 0) + 1)
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (x < w - 1) link(lab[i], lab[i + 1])
      if (y < h - 1) link(lab[i], lab[i + w])
    }
  }

  const alive = new Uint8Array(R + 1).fill(1)
  const ver = new Int32Array(R + 1)
  const dist = (a: number, b: number): number => {
    let s = 0, k = 0
    for (let d = 0; d < D; d++) {
      const ca = cnts[a * D + d], cb = cnts[b * D + d]
      if (ca > 0 && cb > 0) { s += Math.abs(sums[a * D + d] / ca - sums[b * D + d] / cb); k++ }
    }
    return k > 0 ? s / k : Infinity
  }
  const heap = new Heap()
  const pushEdge = (a: number, b: number) => {
    const c = dist(a, b)
    if (c < Infinity) heap.push(c, a, b, ver[a], ver[b])
  }
  const merge = (keep: number, drop: number) => {
    for (let d = 0; d < D; d++) {
      sums[keep * D + d] += sums[drop * D + d]
      cnts[keep * D + d] += cnts[drop * D + d]
    }
    pix[keep] += pix[drop]
    alive[drop] = 0
    adj[keep].delete(drop)
    for (const [nb, len] of adj[drop]) {
      adj[nb].delete(drop)
      if (nb === keep) continue
      adj[keep].set(nb, (adj[keep].get(nb) ?? 0) + len)
      adj[nb].set(keep, (adj[nb].get(keep) ?? 0) + len)
    }
    adj[drop].clear()
    ver[keep]++
    for (const nb of adj[keep].keys()) pushEdge(keep, nb)
  }
  // `parent` follows merges so pixel labels can be remapped at the end.
  const parent = new Int32Array(R + 1)
  for (let r = 0; r <= R; r++) parent[r] = r
  const doMerge = (a: number, b: number) => {
    const keep = pix[a] >= pix[b] ? a : b
    const drop = keep === a ? b : a
    merge(keep, drop)
    parent[drop] = keep
  }

  for (let a = 1; a <= R; a++) for (const b of adj[a].keys()) if (a < b) pushEdge(a, b)
  let mergedSimilar = 0
  while (heap.size > 0 && heap.peekCost() <= mergeDistance) {
    const e = heap.pop()
    if (!alive[e.a] || !alive[e.b] || ver[e.a] !== e.va || ver[e.b] !== e.vb) continue
    doMerge(e.a, e.b)
    mergedSimilar++
  }

  let mergedSmall = 0
  for (let changed = true; changed; ) {
    changed = false
    const small: number[] = []
    for (let r = 1; r <= R; r++) if (alive[r] && pix[r] < minAreaPx && adj[r].size > 0) small.push(r)
    small.sort((x, y) => pix[x] - pix[y])
    for (const r of small) {
      if (!alive[r] || pix[r] >= minAreaPx || adj[r].size === 0) continue
      let best = -1, bestD = Infinity, bestLen = -1
      for (const [nb, len] of adj[r]) {
        const dd = dist(r, nb)
        if (dd < bestD || (dd === bestD && len > bestLen)) { best = nb; bestD = dd; bestLen = len }
      }
      if (best < 0) continue
      // The small region always yields, whichever is larger.
      merge(best, r)
      parent[r] = best
      mergedSmall++
      changed = true
    }
  }

  // ---- final labels + statistics ------------------------------------------
  const root = (r: number) => { while (parent[r] !== r) r = parent[r]; return r }
  const finalId = new Int32Array(R + 1)
  let K = 0
  for (let r = 1; r <= R; r++) if (alive[r]) finalId[r] = ++K
  const labels = new Int32Array(n)
  const rootCache = new Int32Array(R + 1)
  for (let r = 1; r <= R; r++) rootCache[r] = root(r)
  for (let i = 0; i < n; i++) if (lab[i]) labels[i] = finalId[rootCache[lab[i]]]

  const mean = new Float64Array((K + 1) * D).fill(NaN)
  const px = new Int32Array(K + 1)
  for (let r = 1; r <= R; r++) {
    if (!alive[r]) continue
    const id = finalId[r]
    px[id] = pix[r]
    for (let d = 0; d < D; d++) {
      const c = cnts[r * D + d]
      // A regional mean needs real support on that date, not a single clear pixel.
      if (c >= Math.max(3, 0.2 * pix[r]) || (pix[r] < 15 && c >= 1)) mean[id * D + d] = sums[r * D + d] / c
    }
  }
  const dev = new Float64Array(K + 1)
  const devN = new Int32Array(K + 1)
  for (let i = 0; i < n; i++) {
    const id = labels[i]
    if (!id) continue
    for (let d = 0; d < D; d++) {
      const v = layers[d][i], m = mean[id * D + d]
      if (v === v && m === m) { dev[id] += (v - m) * (v - m); devN[id]++ }
    }
  }
  const finalDist = (a: number, b: number) => {
    let s = 0, k = 0
    for (let d = 0; d < D; d++) {
      const p = mean[a * D + d], q = mean[b * D + d]
      if (p === p && q === q) { s += Math.abs(p - q); k++ }
    }
    return k > 0 ? s / k : NaN
  }
  const cSum = new Float64Array(K + 1)
  const cLen = new Float64Array(K + 1)
  const cache = new Map<number, number>()
  const edge = (a: number, b: number) => {
    if (!a || !b || a === b) return
    const key = a < b ? a * (K + 1) + b : b * (K + 1) + a
    let dd = cache.get(key)
    if (dd === undefined) { dd = finalDist(a, b); cache.set(key, dd) }
    if (dd !== dd) return
    cSum[a] += dd; cLen[a]++
    cSum[b] += dd; cLen[b]++
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (x < w - 1) edge(labels[i], labels[i + 1])
      if (y < h - 1) edge(labels[i], labels[i + w])
    }
  }

  // Regional NDBI profile: same supported-mean rule as the NDVI profile.
  const nd = stack.ndbi
  const ndSum = new Float64Array(nd ? (K + 1) * D : 0)
  const ndCnt = new Int32Array(nd ? (K + 1) * D : 0)
  if (nd) {
    for (let i = 0; i < n; i++) {
      const id = labels[i]
      if (!id) continue
      for (let d = 0; d < D; d++) {
        const v = nd[d][i]
        if (v === v) { ndSum[id * D + d] += v; ndCnt[id * D + d]++ }
      }
    }
  }

  const regions: RegionStat[] = []
  for (let id = 1; id <= K; id++) {
    const profile: number[] = []
    let finite = 0
    for (let d = 0; d < D; d++) {
      const m = mean[id * D + d]
      profile.push(m)
      if (m === m) finite++
    }
    const ndbiProfile: number[] = []
    if (nd) {
      for (let d = 0; d < D; d++) {
        const c = ndCnt[id * D + d]
        ndbiProfile.push(c >= Math.max(3, 0.2 * px[id]) || (px[id] < 15 && c >= 1) ? ndSum[id * D + d] / c : NaN)
      }
    }
    regions.push({
      id,
      pixels: px[id],
      profile,
      ndbiProfile,
      sd: devN[id] > 0 ? Math.sqrt(dev[id] / devN[id]) : 0,
      contrast: cLen[id] >= 3 ? cSum[id] / cLen[id] : null,
      validDateFrac: finite / D,
    })
  }

  return { labels, regions, seedCount: nSeeds, initialRegions, mergedSimilar, mergedSmall, boundaryThreshold: threshold }
}
