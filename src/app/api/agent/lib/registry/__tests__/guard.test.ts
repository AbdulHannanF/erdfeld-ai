import { describe, expect, it } from 'vitest'
import { checkSnapshotShrink, checkSnapshotSize, diffSnapshots, renderDiffMd } from '../guard'

describe('checkSnapshotShrink', () => {
  it('allows the first run (no previous snapshot)', () => {
    expect(checkSnapshotShrink(null, 10).ok).toBe(true)
    expect(checkSnapshotShrink(0, 10).ok).toBe(true)
  })
  it('allows growth and small shrinkage', () => {
    expect(checkSnapshotShrink(1000, 1200).ok).toBe(true)
    expect(checkSnapshotShrink(1000, 900).ok).toBe(true)
    expect(checkSnapshotShrink(1000, 0).ok).toBe(false)
  })
  it('refuses a drop below 90% of the previous total', () => {
    const r = checkSnapshotShrink(1000, 899)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('89.9%')
  })
  it('respects a custom minimum ratio', () => {
    expect(checkSnapshotShrink(1000, 500, 0.5).ok).toBe(true)
    expect(checkSnapshotShrink(1000, 499, 0.5).ok).toBe(false)
  })
})

describe('checkSnapshotSize', () => {
  it('accepts a snapshot within budget and refuses one over it', () => {
    expect(checkSnapshotSize(8.2).ok).toBe(true)
    expect(checkSnapshotSize(10.5).ok).toBe(false)
  })
})

describe('diffSnapshots / renderDiffMd', () => {
  it('lists added and removed ids, sorted, and caps long lists', () => {
    const prev = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]
    const next = [{ id: 'c', title: 'C' }, { id: 'b', title: 'B' }, { id: 'aa', title: 'AA' }]
    const d = diffSnapshots(prev, next)
    expect(d.added.map((e) => e.id)).toEqual(['aa', 'c'])
    expect(d.removed.map((e) => e.id)).toEqual(['a'])
    const md = renderDiffMd(d, 2, 3, 1)
    expect(md).toContain('2 → 3 datasets. Added 2, removed 1')
    expect(md).toContain('… and 1 more')
  })
})
