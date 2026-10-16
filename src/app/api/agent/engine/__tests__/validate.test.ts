import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { ToolOutput } from '../../lib/types'
import { defineOperation, type AnyOperation, type StaticCtx } from '../operation'
import {
  checkAoiArea,
  checkDates,
  checkRasterBands,
  checkResolution,
  genericDynamicChecks,
  runStaticChecks,
  validateParams,
} from '../validate'

const op = (over: Partial<Parameters<typeof defineOperation>[0]> = {}): AnyOperation =>
  defineOperation({
    name: 'test_op',
    label: 'Testing...',
    version: '1.0.0',
    description: 'test',
    params: z.object({ n: z.number(), date: z.string().optional(), start: z.string().optional(), end: z.string().optional(), before: z.string().optional(), after: z.string().optional() }),
    output: 'raster',
    cost: { typicalSeconds: 1 },
    limitations: ['none'],
    confidence: 'test',
    run: async () => ({ summary: 'ran' }),
    ...over,
  } as any)

const ctx = (areaKm2: number): StaticCtx => ({
  aoi: {}, bbox: [0, 0, 1, 1], centroid: { lat: 0, lng: 0 }, areaKm2,
})
const NOW = Date.parse('2026-10-12T12:00:00Z')

describe('static: params', () => {
  it('refuses a missing or mistyped argument with the field name, and drops nulls', () => {
    const missing = validateParams(op(), {})
    expect(missing.ok).toBe(false)
    expect(!missing.ok && missing.check).toMatchObject({ id: 'params', phase: 'static', status: 'fail' })
    expect(!missing.ok && missing.check.message).toMatch(/n:/)
    const wrongType = validateParams(op(), { n: '5' })
    expect(wrongType.ok).toBe(false)
    const withNull = validateParams(op(), { n: 5, date: null })
    expect(withNull).toEqual({ ok: true, args: { n: 5 } })
  })
})

describe('static: AOI area against the operation limits', () => {
  it('fails above max and below min, passes inside', () => {
    const limited = op({ limits: { maxAreaKm2: 100, minAreaKm2: 1 } })
    expect(checkAoiArea(limited, ctx(150))).toMatchObject({ id: 'aoi_area', status: 'fail' })
    expect(checkAoiArea(limited, ctx(150)).message).toMatch(/Draw a smaller area/)
    expect(checkAoiArea(limited, ctx(0.5))).toMatchObject({ status: 'fail' })
    expect(checkAoiArea(limited, ctx(50))).toMatchObject({ status: 'pass' })
  })

  it('defaults to the app-wide ceiling and refuses an unmeasurable AOI', () => {
    expect(checkAoiArea(op(), ctx(5001)).status).toBe('fail')
    expect(checkAoiArea(op(), ctx(4000)).status).toBe('pass')
    expect(checkAoiArea(op(), ctx(0)).status).toBe('fail')
    expect(checkAoiArea(op(), ctx(NaN)).status).toBe('fail')
  })
})

describe('static: dates', () => {
  const o = op({ limits: { earliest: '2015-06-23' } })

  it('refuses an impossible calendar date', () => {
    expect(checkDates(o, { date: '2026-02-31' }, NOW)[0]).toMatchObject({ id: 'dates_valid', status: 'fail' })
    expect(checkDates(o, { date: 'yesterday' }, NOW)[0].status).toBe('fail')
  })

  it('refuses a date in the future', () => {
    const c = checkDates(o, { end: '2026-10-13' }, NOW)
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ id: 'dates_not_future', status: 'fail' })
    expect(checkDates(o, { end: '2026-10-12' }, NOW)[0].status).toBe('pass')
  })

  it('refuses a date before the data begins', () => {
    expect(checkDates(o, { start: '2010-01-01' }, NOW)[0]).toMatchObject({ id: 'dates_after_earliest', status: 'fail' })
  })

  it('refuses out-of-order pairs; before/after must differ, start/end may be the same day', () => {
    expect(checkDates(o, { start: '2026-09-30', end: '2026-09-01' }, NOW)[0]).toMatchObject({ id: 'dates_ordered', status: 'fail' })
    expect(checkDates(o, { start: '2026-09-01', end: '2026-09-01' }, NOW)[0].status).toBe('pass')
    expect(checkDates(o, { before: '2026-09-01', after: '2026-09-01' }, NOW)[0]).toMatchObject({ id: 'dates_ordered', status: 'fail' })
    expect(checkDates(o, { before: '2026-08-01', after: '2026-09-01' }, NOW)[0].status).toBe('pass')
  })

  it('emits nothing when the operation was given no dates', () => {
    expect(checkDates(o, {}, NOW)).toEqual([])
  })
})

describe('static: bands exist for the sensor', () => {
  it('refuses a band the sensor does not have, naming the valid ones', () => {
    const c = checkRasterBands('sentinel-2-l2a', { bands: ['B99'] })
    expect(c).toMatchObject({ id: 'bands_exist', status: 'fail' })
    expect(c.message).toMatch(/B99/)
  })

  it('refuses a Sentinel-2 band on Landsat and an unknown name inside an expression', () => {
    expect(checkRasterBands('landsat-c2-l2', { bands: ['B8A'] }).status).toBe('fail')
    expect(checkRasterBands('sentinel-2-l2a', { expression: '(B08-Bxx)/(B08+B04)' }).status).toBe('fail')
  })

  it('passes real bands, a composite and an expression', () => {
    expect(checkRasterBands('sentinel-2-l2a', { bands: ['B08'] }).status).toBe('pass')
    expect(checkRasterBands('sentinel-2-l2a', { bands: ['B08', 'B04', 'B03'] }).status).toBe('pass')
    expect(checkRasterBands('landsat-c2-l2', { expression: '(nir08-red)/(nir08+red)' }).status).toBe('pass')
  })
})

describe('static: data resolution against the target', () => {
  it('refuses a target the data cannot resolve, with the honest note', () => {
    const o = op({ resolution_m: 10, target: () => 'vehicles' })
    const c = checkResolution(o, { n: 1 })!
    expect(c).toMatchObject({ id: 'resolution_vs_target', status: 'fail' })
    expect(c.message).toMatch(/sub-meter/i)
  })

  it('passes a target the data resolves, and is silent without a target', () => {
    expect(checkResolution(op({ resolution_m: 10, target: () => 'functional_type' }), { n: 1 })!.status).toBe('pass')
    expect(checkResolution(op({ resolution_m: 10 }), { n: 1 })).toBeNull()
  })
})

describe('static: the operation\'s own checks run too', () => {
  it('collects them with the generic ones', () => {
    const o = op({ staticChecks: () => [{ id: 'custom', phase: 'static', status: 'fail', message: 'nope' }] })
    const checks = runStaticChecks(o, ctx(10), { n: 1 }, NOW)
    expect(checks.map((c) => c.id)).toEqual(['aoi_area', 'custom'])
  })
})

// ---------------------------------------------------------------------------
// Dynamic
// ---------------------------------------------------------------------------

const layer = (over: Record<string, any> = {}) => ({ id: 'l', name: 'L', type: 'raster' as const, ...over })
const find = (checks: ReturnType<typeof genericDynamicChecks>, id: string) => checks.find((c) => c.id === id)
const run = (output: ToolOutput, sources: string[] = ['Sentinel-2']) =>
  genericDynamicChecks(output, [...(output.layer ? [output.layer] : []), ...(output.layers ?? [])], sources)

describe('dynamic: finite raster ranges and statistics', () => {
  it('fails a stretch that is not finite or not increasing', () => {
    const bad = run({ summary: 's', layer: layer({ raster: { kind: 'continuous', stretch: 'fixed', rescale: [[Number.NaN, 1]] } }) })
    expect(find(bad, 'raster_finite')).toMatchObject({ phase: 'dynamic', status: 'fail' })
    const flat = run({ summary: 's', layer: layer({ raster: { kind: 'continuous', stretch: 'fixed', rescale: [[0.3, 0.3]] } }) })
    expect(find(flat, 'raster_finite')!.status).toBe('fail')
    const ok = run({ summary: 's', layer: layer({ raster: { kind: 'continuous', stretch: 'fixed', rescale: [[0, 1]] } }) })
    expect(find(ok, 'raster_finite')!.status).toBe('pass')
  })

  it('fails a gradient palette with an infinite bound', () => {
    const bad = run({ summary: 's', layer: layer({ palette: { kind: 'gradient', stops: [], min: 0, max: Infinity } }) })
    expect(find(bad, 'raster_finite')!.status).toBe('fail')
  })

  it('fails NaN and Infinity statistics, including inside series', () => {
    expect(find(run({ summary: 's', summary_data: { mean: Number.NaN } }), 'stats_finite')!.status).toBe('fail')
    expect(find(run({ summary: 's', summary_data: { series: [{ label: 'a', value: Infinity }] } }), 'stats_finite')!.status).toBe('fail')
    expect(find(run({ summary: 's', summary_data: { mean: 0.4 } }), 'stats_finite')!.status).toBe('pass')
  })
})

describe('dynamic: physical plausibility', () => {
  const ndvi = (stats: Record<string, number>) =>
    run({ summary: 's', summary_data: stats, layer: layer({ raster: { kind: 'continuous', stretch: 'p2-p98', rescale: [[0, 1]], index: 'NDVI' } }) })

  it('fails an NDVI outside [-1, 1] and passes one inside', () => {
    const bad = find(ndvi({ mean: 1.4, p98: 0.9 }), 'index_range')!
    expect(bad.status).toBe('fail')
    expect(bad.message).toMatch(/mean=1.4/)
    expect(find(ndvi({ mean: 0.42, p2: -0.1 }), 'index_range')!.status).toBe('pass')
  })

  it('does not range-check EVI, which has no hard bound', () => {
    const evi = run({ summary: 's', summary_data: { mean: 3.2 }, layer: layer({ raster: { kind: 'continuous', stretch: 'fixed', rescale: [[0, 1]], index: 'EVI' } }) })
    expect(find(evi, 'index_range')).toBeUndefined()
  })

  const refl = (stats: Record<string, number>) =>
    run({ summary: 's', summary_data: stats, layer: layer({ raster: { kind: 'continuous', stretch: 'p2-p98', rescale: [[0, 1]], units: 'reflectance' } }) })

  it('fails reflectance below the sensor offset, warns on slightly negative, passes non-negative', () => {
    expect(find(refl({ min: -0.5 }), 'reflectance_range')!.status).toBe('fail')
    expect(find(refl({ min: -0.01 }), 'reflectance_range')!.status).toBe('warn')
    expect(find(refl({ min: 0.02, max: 0.4 }), 'reflectance_range')!.status).toBe('pass')
  })
})

describe('dynamic: valid pixels and cloud', () => {
  it('fails under the usable floor, warns when partly masked, passes when clear', () => {
    expect(find(run({ summary: 's', summary_data: { valid_pixel_pct: 12 } }), 'valid_pixels')!.status).toBe('fail')
    expect(find(run({ summary: 's', summary_data: { valid_pixel_pct: 55 } }), 'valid_pixels')!.status).toBe('warn')
    expect(find(run({ summary: 's', summary_data: { valid_pixel_pct: 95 } }), 'valid_pixels')!.status).toBe('pass')
  })

  it('warns on a cloudy scene and says nothing without the figure', () => {
    expect(find(run({ summary: 's', summary_data: { cloud_pct: 85 } }), 'cloud_cover')!.status).toBe('warn')
    expect(find(run({ summary: 's', summary_data: { cloud_pct: 10 } }), 'cloud_cover')!.status).toBe('pass')
    expect(find(run({ summary: 's', summary_data: { mean: 1 } }), 'cloud_cover')).toBeUndefined()
  })
})

describe('dynamic: a measurement must name its data', () => {
  it('flags layers or figures with no provenance source (the Q-03 fabrication case)', () => {
    const noSource = run({ summary: 'Land cover: 60% forest', summary_data: { forest_pct: 60 } }, [])
    expect(find(noSource, 'provenance_sources')).toMatchObject({ status: 'fail', phase: 'dynamic' })
    const layerOnly = run({ summary: 's', layer: layer() }, [])
    expect(find(layerOnly, 'provenance_sources')!.status).toBe('fail')
  })

  it('passes with a source, and does not apply to an output with neither layers nor figures', () => {
    expect(find(run({ summary: 's', summary_data: { forest_pct: 60 } }, ['ESA WorldCover 2021']), 'provenance_sources')!.status).toBe('pass')
    expect(find(run({ summary: 'nothing found' }, []), 'provenance_sources')).toBeUndefined()
  })

  it('does not judge an output that is already a failure to read', () => {
    expect(find(run({ summary: 'x', summary_data: { area_km2: 3 }, failed: true }, []), 'provenance_sources')).toBeUndefined()
  })
})
