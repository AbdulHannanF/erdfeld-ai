import { describe, expect, it, vi } from 'vitest'
import { fetchOsmQuadtree } from '../tools/osm'

const CAP = 5000
const ROOT: [number, number, number, number] = [0, 0, 4, 4]

/** A cap-saturating quadrant payload (length triggers a split; identical refs
 *  keep it cheap and let the dedupe collapse it). */
const saturated = () => new Array(CAP).fill({ type: 'way', id: 'x' })
/** Unique small payload so merged counts stay meaningful. */
const small = (ids: number[]) => ids.map((id) => ({ type: 'way', id }))

describe('fetchOsmQuadtree', () => {
  it('makes a single request when the root fits under the cap', async () => {
    const fetcher = vi.fn(async () => small([1, 2, 3]))
    const r = await fetchOsmQuadtree(ROOT, [], 'Polygon', undefined, fetcher)
    expect(r.totalRequests).toBe(1)
    expect(r.leafQuadrants).toBe(1)
    expect(r.maxDepth).toBe(0)
    expect(r.truncated).toBe(false)
    expect(r.elements).toHaveLength(3)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('splits a saturated root into four quadrants that fit', async () => {
    let n = 0
    const fetcher = vi.fn(async (b: [number, number, number, number]) => {
      // Root is the only cell equal to ROOT; children are smaller.
      if (b[2] - b[0] === 4) return saturated()
      return small([n++, n++])
    })
    const r = await fetchOsmQuadtree(ROOT, [], 'Polygon', undefined, fetcher)
    expect(r.totalRequests).toBe(5) // 1 root + 4 children
    expect(r.leafQuadrants).toBe(4)
    expect(r.maxDepth).toBe(1)
    expect(r.truncated).toBe(false)
  })

  it('bounds recursion at MAX_QUADTREE_DEPTH and flags truncation when still saturated', async () => {
    const fetcher = vi.fn(async () => saturated())
    const r = await fetchOsmQuadtree(ROOT, [], 'Polygon', undefined, fetcher)
    expect(r.maxDepth).toBe(4)
    expect(r.truncated).toBe(true)
    // collected leaves only exist at the depth ceiling
    expect(r.leafQuadrants).toBe(4 ** 4)
  })

  it('emits one progress token per sub-root wave (depth > 0)', async () => {
    const emit = vi.fn()
    const fetcher = vi.fn(async (b: [number, number, number, number]) =>
      b[2] - b[0] === 4 ? saturated() : small([1]),
    )
    await fetchOsmQuadtree(ROOT, [], 'Polygon', emit, fetcher)
    const tokenCalls = emit.mock.calls.filter((c) => c[0] === 'token')
    expect(tokenCalls).toHaveLength(1) // depth-0 wave does not emit; one depth-1 wave does
  })

  it('dedupes features that straddle quadrant boundaries', async () => {
    const fetcher = vi.fn(async (b: [number, number, number, number]) => {
      if (b[2] - b[0] === 4) return saturated()
      return small([100, 200]) // every child returns the same shared ids
    })
    const r = await fetchOsmQuadtree(ROOT, [], 'Polygon', undefined, fetcher)
    expect(r.elements.map((e) => e.id).sort()).toEqual([100, 200])
  })

  it('throws when the root quadrant fails (caller shows the friendly message)', async () => {
    const fetcher = vi.fn(async () => { throw new Error('all mirrors down') })
    await expect(fetchOsmQuadtree(ROOT, [], 'Polygon', undefined, fetcher)).rejects.toThrow('all mirrors down')
  })

  it('tolerates a deep-quadrant failure as partial coverage', async () => {
    const fetcher = vi.fn(async (b: [number, number, number, number]) => {
      if (b[2] - b[0] === 4) return saturated() // root splits
      if (b[1] >= 2) throw new Error('quadrant timeout') // northern children fail
      return small([1, 2])
    })
    const r = await fetchOsmQuadtree(ROOT, [], 'Polygon', undefined, fetcher)
    expect(r.failedQuadrants).toBe(2) // NW + NE
    expect(r.leafQuadrants).toBe(2) // SW + SE survived
    expect(r.totalRequests).toBe(5)
  })
})
