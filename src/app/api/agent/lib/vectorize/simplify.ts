/** Douglas–Peucker simplification of an open polyline in pixel space. */

/** Indices of the vertices to keep (endpoints always kept). Iterative, so a
 *  100k-vertex boundary cannot blow the call stack. Tolerance 0 still drops
 *  exactly-collinear vertices. */
export function douglasPeucker(xs: ArrayLike<number>, ys: ArrayLike<number>, tolerance: number): number[] {
  const n = xs.length
  if (n <= 2) return Array.from({ length: n }, (_, i) => i)
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack: number[] = [0, n - 1]
  const tol = Math.max(0, tolerance)
  while (stack.length) {
    const b = stack.pop()!
    const a = stack.pop()!
    if (b <= a + 1) continue
    const ax = xs[a], ay = ys[a], bx = xs[b], by = ys[b]
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    let maxD = -1
    let maxI = -1
    for (let i = a + 1; i < b; i++) {
      let d: number
      if (len2 === 0) {
        // Closed arc (start == end): distance to the point.
        d = Math.hypot(xs[i] - ax, ys[i] - ay)
      } else {
        const t = Math.max(0, Math.min(1, ((xs[i] - ax) * dx + (ys[i] - ay) * dy) / len2))
        d = Math.hypot(xs[i] - (ax + t * dx), ys[i] - (ay + t * dy))
      }
      if (d > maxD) { maxD = d; maxI = i }
    }
    if (maxD > tol) {
      keep[maxI] = 1
      stack.push(a, maxI, maxI, b)
    }
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i)
  return out
}
