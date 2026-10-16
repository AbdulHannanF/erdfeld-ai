import { describe, expect, it } from 'vitest'
import { toRfc3339Interval } from '../stac'

describe('toRfc3339Interval', () => {
  it('pads a bare date-only interval to RFC3339 (start of day / end of day)', () => {
    // Element84 rejects "2026-03-03/2026-06-01" with HTTP 400 — this is the regression fix.
    expect(toRfc3339Interval('2026-03-03/2026-06-01')).toBe(
      '2026-03-03T00:00:00Z/2026-06-01T23:59:59Z',
    )
  })

  it('leaves an already-RFC3339 interval untouched (idempotent)', () => {
    const full = '2026-03-03T00:00:00Z/2026-06-01T23:59:59Z'
    expect(toRfc3339Interval(full)).toBe(full)
  })

  it('is idempotent when applied twice', () => {
    const once = toRfc3339Interval('2026-03-03/2026-06-01')
    expect(toRfc3339Interval(once)).toBe(once)
  })

  it('pads only the bare side of a mixed interval', () => {
    expect(toRfc3339Interval('2026-03-03/2026-06-01T12:30:00Z')).toBe(
      '2026-03-03T00:00:00Z/2026-06-01T12:30:00Z',
    )
  })

  it('pads a single instant (no slash) to start of day', () => {
    expect(toRfc3339Interval('2026-03-03')).toBe('2026-03-03T00:00:00Z')
  })

  it('preserves open-ended interval sentinels', () => {
    expect(toRfc3339Interval('2026-03-03/..')).toBe('2026-03-03T00:00:00Z/..')
    expect(toRfc3339Interval('../2026-06-01')).toBe('../2026-06-01T23:59:59Z')
  })
})
