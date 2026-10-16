import { describe, expect, it } from 'vitest'

import { periodDrift, periodMismatch, statedPeriod, usedDates } from '../period'

const NOW = Date.parse('2026-10-15T00:00:00Z')
const iso = (t: number | undefined) => (t == null ? null : new Date(t).toISOString().slice(0, 10))
const span = (q: string) => { const p = statedPeriod(q, NOW); return p ? [iso(p.start), iso(p.end)] : null }

describe('statedPeriod', () => {
  it('reads a bare year as the whole year and several years as their hull', () => {
    expect(span('the 2024 monsoon')).toEqual(['2024-01-01', '2024-12-31'])
    expect(span('between 2020 and 2023')).toEqual(['2020-01-01', '2023-12-31'])
  })

  it('reads a month and year as that month (the grain the live evaluation drifted at)', () => {
    expect(span('mean NDVI in February 2024')).toEqual(['2024-02-01', '2024-02-29'])
    expect(span('the August 2023 fire, before 1 Aug 2023, after 20 Aug 2023')).toEqual(['2023-08-01', '2023-08-31'])
    expect(span('Detect deforestation between January 2021 and December 2023')).toEqual(['2021-01-01', '2023-12-31'])
    expect(span('flooding on Oct 29, 2024')).toEqual(['2024-10-01', '2024-10-31'])
  })

  it('does not count the year of a month-year phrase twice, and ignores questions without a year', () => {
    expect(span('September 2023 versus 2022')).toEqual(['2022-01-01', '2023-09-30'])
    expect(span('Last September, how green was it?')).toBeNull()
  })
})

describe('periodMismatch with months', () => {
  it('refuses a step dated outside the stated month', () => {
    expect(periodMismatch('analyze_raster', { date: '2024-03-12' }, true, 'NDVI in February 2024', NOW)).toMatch(/does not overlap/)
    expect(periodMismatch('analyze_raster', { date: '2024-02-15' }, true, 'NDVI in February 2024', NOW)).toBeNull()
  })
})

describe('periodDrift: the data a tool really used', () => {
  it('names a scene picked weeks outside the stated month (veg02, fire01, chg04 of the live evaluation)', () => {
    expect(periodDrift('NDVI in February 2024', { scene_date: '2024-03-12' }, NOW)).toMatch(/scene_date 2024-03-12.*2024-02-01 to 2024-02-29/)
    expect(periodDrift('burn area, before 1 Aug 2023, after 20 Aug 2023', { date_before: '2023-07-29', date_after: '2023-09-17' }, NOW)).toMatch(/2023-07-29.*2023-09-17/)
    expect(periodDrift('deforestation between January 2021 and December 2023', { before_date: '2021-02-06', after_date: '2024-01-27' }, NOW)).toMatch(/after_date 2024-01-27/)
  })

  it('is silent when everything used is inside, when no period is stated, and for dates that are not data dates', () => {
    expect(periodDrift('NDVI in February 2024', { scene_date: '2024-02-12', window_start: '2024-02-01', window_end: '2024-02-29' }, NOW)).toBeNull()
    expect(periodDrift('How green is it now?', { scene_date: '2020-01-01' }, NOW)).toBeNull()
    expect(usedDates({ release: '2026-09-23', overture_release: '2026-09-23.1', mean: 0.4, scene_id: 'S2A_20230823' })).toEqual([])
  })
})
