import { describe, it, expect } from 'vitest'
import {
  PRECIP_GRADIENT_PALETTE,
  MONTH_NAMES,
  aggregateDailyToMonthly,
  buildClimatology,
  computeAnomalies,
  identifyRainySeason,
  computeAnomalyHeadline,
  type MonthClimate,
  type PrecipAnomaly,
} from '../precipitation'

// ---------------------------------------------------------------------------
// aggregateDailyToMonthly — roll Open-Meteo daily series up to months
// ---------------------------------------------------------------------------

describe('aggregateDailyToMonthly', () => {
  it('sums daily precipitation into per-month totals (YYYY-MM-01 timestamps)', () => {
    const time = ['2020-01-01', '2020-01-15', '2020-02-10', '2020-02-20']
    const r = aggregateDailyToMonthly(time, [2, 3, 5, 1], 'sum')
    expect(r.time).toEqual(['2020-01-01', '2020-02-01'])
    expect(r.values).toEqual([5, 6])
  })

  it('averages daily values for mode "mean" (temperature)', () => {
    const r = aggregateDailyToMonthly(['2020-01-01', '2020-01-02'], [10, 20], 'mean')
    expect(r.values).toEqual([15])
  })

  it('skips null/NaN days but keeps the month', () => {
    const r = aggregateDailyToMonthly(['2020-03-01', '2020-03-02', '2020-03-03'], [4, null, 6], 'sum')
    expect(r.values).toEqual([10])
  })

  it('yields null for a month whose days are all missing', () => {
    const r = aggregateDailyToMonthly(['2020-04-01', '2020-04-02'], [null, null], 'sum')
    expect(r.time).toEqual(['2020-04-01'])
    expect(r.values).toEqual([null])
  })

  it('preserves chronological month order across a year boundary', () => {
    const r = aggregateDailyToMonthly(['2019-12-31', '2020-01-01'], [1, 2], 'sum')
    expect(r.time).toEqual(['2019-12-01', '2020-01-01'])
  })

  it('produces month timestamps that buildClimatology can bucket', () => {
    // 2 years of a single January value each → climatology January mean is their average.
    const r = aggregateDailyToMonthly(['1991-01-10', '1992-01-10'], [100, 200], 'sum')
    const clim = buildClimatology(r.time, r.values)
    expect(clim[0].mean).toBe(150)
  })
})

// ---------------------------------------------------------------------------
// PRECIP_GRADIENT_PALETTE structure
// ---------------------------------------------------------------------------

describe('PRECIP_GRADIENT_PALETTE', () => {
  it('has kind gradient', () => {
    expect(PRECIP_GRADIENT_PALETTE.kind).toBe('gradient')
  })
  it('has unit mm/month', () => {
    expect(PRECIP_GRADIENT_PALETTE.unit).toBe('mm/month')
  })
  it('has min=0 and max=400', () => {
    expect(PRECIP_GRADIENT_PALETTE.min).toBe(0)
    expect(PRECIP_GRADIENT_PALETTE.max).toBe(400)
  })
  it('has at least 3 gradient stops', () => {
    expect(PRECIP_GRADIENT_PALETTE.stops.length).toBeGreaterThanOrEqual(3)
  })
  it('stops are ordered by value ascending', () => {
    const vals = PRECIP_GRADIENT_PALETTE.stops.map(s => s.value)
    for (let i = 1; i < vals.length; i++) {
      expect(vals[i]).toBeGreaterThan(vals[i - 1])
    }
  })
  it('each stop has a valid hex color', () => {
    for (const stop of PRECIP_GRADIENT_PALETTE.stops) {
      expect(stop.color).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })
})

// ---------------------------------------------------------------------------
// MONTH_NAMES
// ---------------------------------------------------------------------------

describe('MONTH_NAMES', () => {
  it('has 12 entries', () => {
    expect(MONTH_NAMES.length).toBe(12)
  })
  it('starts with Jan and ends with Dec', () => {
    expect(MONTH_NAMES[0]).toBe('Jan')
    expect(MONTH_NAMES[11]).toBe('Dec')
  })
})

// ---------------------------------------------------------------------------
// buildClimatology — pure function
// ---------------------------------------------------------------------------

describe('buildClimatology', () => {
  function makeTimeSeries(years: number): { time: string[]; precip: (number | null)[] } {
    const time: string[] = []
    const precip: (number | null)[] = []
    for (let y = 1991; y < 1991 + years; y++) {
      for (let m = 1; m <= 12; m++) {
        time.push(`${y}-${String(m).padStart(2, '0')}-01`)
        // Simulate a monsoon-like pattern: peak in Jul (100 mm), dry in Jan (5 mm)
        const base = [5, 8, 15, 30, 55, 80, 100, 90, 60, 35, 15, 6]
        precip.push(base[m - 1] + Math.random() * 5)
      }
    }
    return { time, precip }
  }

  it('returns 12 MonthClimate entries', () => {
    const { time, precip } = makeTimeSeries(5)
    const result = buildClimatology(time, precip)
    expect(result).toHaveLength(12)
  })

  it('month numbers are 1–12', () => {
    const { time, precip } = makeTimeSeries(5)
    const result = buildClimatology(time, precip)
    expect(result.map(m => m.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  it('month names match MONTH_NAMES', () => {
    const { time, precip } = makeTimeSeries(3)
    const result = buildClimatology(time, precip)
    result.forEach((m, i) => expect(m.name).toBe(MONTH_NAMES[i]))
  })

  it('July mean is highest in monsoon simulation', () => {
    const { time, precip } = makeTimeSeries(10)
    const result = buildClimatology(time, precip)
    const jul = result[6] // July = index 6
    const maxMean = Math.max(...result.map(m => m.mean))
    expect(jul.mean).toBe(maxMean)
  })

  it('p10 <= mean <= p90 for each month', () => {
    const { time, precip } = makeTimeSeries(10)
    const result = buildClimatology(time, precip)
    for (const m of result) {
      expect(m.p10).toBeLessThanOrEqual(m.mean)
      expect(m.p90).toBeGreaterThanOrEqual(m.mean)
    }
  })

  it('handles null precipitation values gracefully', () => {
    const time = ['1991-01-01', '1991-02-01', '1991-03-01']
    const precip: (number | null)[] = [100, null, 50]
    const result = buildClimatology(time, precip)
    // Jan gets 100, Feb gets nothing (skipped), Mar gets 50
    expect(result[0].mean).toBe(100)
    expect(result[1].mean).toBe(0) // no data → defaults to 0
    expect(result[2].mean).toBe(50)
  })

  it('returns zero means for empty input', () => {
    const result = buildClimatology([], [])
    expect(result).toHaveLength(12)
    result.forEach(m => expect(m.mean).toBe(0))
  })

  it('means are rounded to one decimal place', () => {
    const time = ['1991-01-01']
    const precip: (number | null)[] = [33.3333]
    const result = buildClimatology(time, precip)
    // Should be 33.3 (rounded to 1dp)
    expect(result[0].mean).toBe(33.3)
  })
})

// ---------------------------------------------------------------------------
// computeAnomalies — pure function
// ---------------------------------------------------------------------------

function makeClimatology(uniformMean = 100): MonthClimate[] {
  return Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    name: MONTH_NAMES[i],
    mean: uniformMean,
    p10: uniformMean * 0.6,
    p90: uniformMean * 1.4,
  }))
}

describe('computeAnomalies', () => {
  it('returns empty array for empty input', () => {
    const result = computeAnomalies([], [], makeClimatology())
    expect(result).toHaveLength(0)
  })

  it('length matches input time array length', () => {
    const clim = makeClimatology(100)
    const time = ['2024-01-01', '2024-02-01', '2024-03-01']
    const precip = [80, 120, 100]
    const result = computeAnomalies(time, precip, clim)
    expect(result).toHaveLength(3)
  })

  it('flags actual > 120% of mean as wet', () => {
    const clim = makeClimatology(100)
    const result = computeAnomalies(['2024-07-01'], [125], clim)
    expect(result[0].flag).toBe('wet')
    expect(result[0].pct).toBe(25)
  })

  it('flags actual < 80% of mean as dry', () => {
    const clim = makeClimatology(100)
    const result = computeAnomalies(['2024-07-01'], [75], clim)
    expect(result[0].flag).toBe('dry')
    expect(result[0].pct).toBe(-25)
  })

  it('flags actual within ±20% as normal', () => {
    const clim = makeClimatology(100)
    // +20% exactly → still normal (boundary is exclusive at >20 / <-20)
    const result = computeAnomalies(['2024-07-01'], [120], clim)
    expect(result[0].flag).toBe('normal')
  })

  it('exactly at wet boundary (pct = 21) → wet', () => {
    const clim = makeClimatology(100)
    const result = computeAnomalies(['2024-07-01'], [121], clim)
    expect(result[0].flag).toBe('wet')
  })

  it('delta is actual minus climatologyMean', () => {
    const clim = makeClimatology(80)
    const result = computeAnomalies(['2024-04-01'], [60], clim)
    expect(result[0].delta).toBe(-20)
    expect(result[0].climatologyMean).toBe(80)
  })

  it('pct is 0 when climatologyMean < 1 mm', () => {
    const clim = makeClimatology(0)
    const result = computeAnomalies(['2024-01-01'], [5], clim)
    expect(result[0].pct).toBe(0)
  })

  it('yearMonth is sliced to YYYY-MM', () => {
    const clim = makeClimatology(50)
    const result = computeAnomalies(['2023-06-01'], [55], clim)
    expect(result[0].yearMonth).toBe('2023-06')
  })

  it('actual values are rounded to 1 decimal', () => {
    const clim = makeClimatology(100)
    const result = computeAnomalies(['2024-05-01'], [123.456], clim)
    expect(result[0].actual).toBe(123.5)
  })
})

// ---------------------------------------------------------------------------
// identifyRainySeason — pure function
// ---------------------------------------------------------------------------

describe('identifyRainySeason', () => {
  it('returns no-clear-rainy-season string for uniform precipitation', () => {
    const clim = makeClimatology(100) // all months equal
    const result = identifyRainySeason(clim)
    expect(result).toMatch(/No clear rainy season/i)
  })

  it('identifies single peak rainy month', () => {
    const clim = makeClimatology(20)
    // July is very wet (200 mm vs monthly avg 20 mm)
    clim[6] = { ...clim[6], mean: 200 }
    const result = identifyRainySeason(clim)
    expect(result).toContain('Jul')
  })

  it('identifies multiple rainy months', () => {
    const clim = makeClimatology(10)
    clim[5] = { ...clim[5], mean: 150 } // Jun
    clim[6] = { ...clim[6], mean: 200 } // Jul
    clim[7] = { ...clim[7], mean: 120 } // Aug
    const result = identifyRainySeason(clim)
    // All three should be above 1.5× monthly avg ≈ (10×9+150+200+120)/12 ≈ ~48 → 1.5× = 72
    // Jun=150, Jul=200 should appear; Aug=120 depends on avg
    expect(result).toContain('Jul')
    expect(result).toContain('Jun')
  })

  it('returns no-rainy-season for arid region (all months near 0)', () => {
    const clim: MonthClimate[] = Array.from({ length: 12 }, (_, i) => ({
      month: i + 1, name: MONTH_NAMES[i], mean: 0.5, p10: 0, p90: 1,
    }))
    const result = identifyRainySeason(clim)
    expect(result).toMatch(/No clear rainy season/i)
  })

  it('result lists months in descending order of mean', () => {
    const clim = makeClimatology(5)
    clim[3] = { ...clim[3], mean: 300 } // Apr — wettest
    clim[4] = { ...clim[4], mean: 200 } // May — second
    const result = identifyRainySeason(clim)
    const aprIdx = result.indexOf('Apr')
    const mayIdx = result.indexOf('May')
    expect(aprIdx).toBeGreaterThanOrEqual(0)
    expect(aprIdx).toBeLessThan(mayIdx)
  })

  it('includes mean value in parentheses for rainy months', () => {
    const clim = makeClimatology(5)
    clim[0] = { ...clim[0], mean: 200 } // Jan
    const result = identifyRainySeason(clim)
    expect(result).toContain('(200 mm)')
  })
})

// ---------------------------------------------------------------------------
// computeAnomalyHeadline — pure function
// ---------------------------------------------------------------------------

describe('computeAnomalyHeadline', () => {
  it('returns no-data string for empty anomalies', () => {
    const result = computeAnomalyHeadline([])
    expect(result).toBe('No recent data available.')
  })

  function makeAnomalies(
    months: string[],
    actuals: number[],
    means: number[],
  ): PrecipAnomaly[] {
    return months.map((ym, i) => {
      const actual = actuals[i]
      const climatologyMean = means[i]
      const delta = actual - climatologyMean
      const pct = climatologyMean >= 1 ? Math.round((delta / climatologyMean) * 100) : 0
      const flag: 'wet' | 'dry' | 'normal' =
        pct > 20 ? 'wet' : pct < -20 ? 'dry' : 'normal'
      return { yearMonth: ym, actual, climatologyMean, delta, pct, flag }
    })
  }

  it('headline mentions "drier" for below-normal period', () => {
    const anomalies = makeAnomalies(
      ['2023-01', '2023-02'],
      [50, 50],
      [100, 100],
    )
    const result = computeAnomalyHeadline(anomalies)
    expect(result).toContain('drier')
  })

  it('headline mentions "wetter" for above-normal period', () => {
    const anomalies = makeAnomalies(
      ['2023-05', '2023-06'],
      [160, 170],
      [100, 100],
    )
    const result = computeAnomalyHeadline(anomalies)
    expect(result).toContain('wetter')
  })

  it('headline mentions "near the climatological average" for normal period', () => {
    const anomalies = makeAnomalies(
      ['2023-03', '2023-04'],
      [100, 105],
      [100, 100],
    )
    const result = computeAnomalyHeadline(anomalies)
    expect(result).toContain('near the climatological average')
  })

  it('includes the date range from first to last month', () => {
    const anomalies = makeAnomalies(
      ['2022-01', '2022-06', '2022-12'],
      [100, 100, 100],
      [100, 100, 100],
    )
    const result = computeAnomalyHeadline(anomalies)
    expect(result).toContain('2022-01')
    expect(result).toContain('2022-12')
  })

  it('includes count of anomalous months', () => {
    const anomalies = makeAnomalies(
      ['2023-01', '2023-02', '2023-03'],
      [50, 150, 100],
      [100, 100, 100],
    )
    const result = computeAnomalyHeadline(anomalies)
    expect(result).toMatch(/1 below-normal/)
    expect(result).toMatch(/1 above-normal/)
  })

  it('correctly handles single-month anomaly', () => {
    const anomalies = makeAnomalies(['2024-08'], [200], [100])
    const result = computeAnomalyHeadline(anomalies)
    expect(result).toContain('Last 1 months')
    expect(result).toContain('2024-08')
  })

  it('percentage is computed on total actual vs total climatology', () => {
    // 4 months, total actual=600 vs total clim=1000 → -40% → drier
    const anomalies = makeAnomalies(
      ['2023-01', '2023-02', '2023-03', '2023-04'],
      [150, 150, 150, 150],
      [250, 250, 250, 250],
    )
    const result = computeAnomalyHeadline(anomalies)
    expect(result).toContain('40%')
    expect(result).toContain('drier')
  })
})
