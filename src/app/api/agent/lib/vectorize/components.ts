/** Connected-component labelling of a raster (4-connectivity, same source value).
 *
 *  Two-pass union-find over a flat row-major grid. 4-connectivity is deliberate:
 *  pixels that touch only at a corner are separate features, which is what lets
 *  `trace.ts` give every component a ring set that bounds exactly its own pixels.
 */

export interface Components {
  /** Per-pixel component id, 1..count; 0 = background / non-finite. */
  labels: Int32Array
  count: number
  /** Pixel count per component id (`areas[0]` is 0). */
  areas: Int32Array
  /** Source raster value of each component (`values[0]` is `background`). */
  values: Float64Array
}

export function labelComponents(
  src: ArrayLike<number>,
  width: number,
  height: number,
  background = 0,
): Components {
  const n = width * height
  const lab = new Int32Array(n)
  // 4-connectivity bounds provisional labels at ceil(n/2) (a checkerboard).
  const parent = new Int32Array(Math.ceil(n / 2) + 2)
  let next = 1

  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]]
      a = parent[a]
    }
    return a
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const v = src[i]
      if (v === background || v !== v) continue
      const left = x > 0 && src[i - 1] === v ? lab[i - 1] : 0
      const up = y > 0 && src[i - width] === v ? lab[i - width] : 0
      if (left === 0 && up === 0) {
        parent[next] = next
        lab[i] = next++
      } else if (left !== 0 && up !== 0) {
        const a = find(left)
        const b = find(up)
        if (a !== b) {
          if (a < b) parent[b] = a
          else parent[a] = b
        }
        lab[i] = Math.min(a, b)
      } else {
        lab[i] = left || up
      }
    }
  }

  // Second pass: compact the roots to 1..count.
  const remap = new Int32Array(next)
  let count = 0
  for (let p = 1; p < next; p++) if (find(p) === p) remap[p] = ++count
  const areas = new Int32Array(count + 1)
  const values = new Float64Array(count + 1)
  values[0] = background
  for (let i = 0; i < n; i++) {
    if (lab[i] === 0) continue
    const id = remap[find(lab[i])]
    lab[i] = id
    areas[id]++
    values[id] = src[i]
  }
  return { labels: lab, count, areas, values }
}
