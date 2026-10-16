import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createTestDb, describeDb, type TestDb } from '@/test/db'
import { afterAll, beforeAll } from 'vitest'

import { createCaseStore, type CaseDb } from '../case-store'
import { loadRecipes } from '../loader'
import { resolveParams } from '../params'
import { decide } from '../rule'

const catalog = loadRecipes(path.join(__dirname, '../../../../../../../recipes'))
const plot: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[74.5, 31], [74.503, 31], [74.503, 30.997], [74.5, 30.997], [74.5, 31]]] }

describe('flooded_on decision rule', () => {
  const recipe = catalog.get('flooded_on')!
  const p = resolveParams(recipe, { date: '2025-09-04' }, plot, '2026-10-13')
  if (!p.ok) throw new Error('params')
  const flood = {
    flood_pct_of_observed: 80, valid_pixel_pct: 99, after_date: '2025-09-03', before_water_pct: 2, after_water_pct: 75, orbit_match: 'orbit',
    flood_area_km2: 0.07, observed_km2: 0.09,
  }
  const run = (over: Record<string, any> = {}, params = p.params, status: 'ok' | 'failed' = 'ok') =>
    decide(recipe.decision, { params, nodes: [{ idx: 0, op: 'map_flood', status, stats: status === 'ok' ? { ...flood, ...over } : null }] })

  it('Supported when the new flood covers the plot on a pass inside the tolerance', () => {
    const d = run()
    expect(d).toMatchObject({ verdict: 'supported', rule: 'flooded' })
    expect(d.confidence).toBeGreaterThan(0.8)
    expect(d.confidence).toBeLessThanOrEqual(0.9)
  })
  it('Contradicted (capped confidence) when almost none of the plot is new water', () => {
    const d = run({ flood_pct_of_observed: 0, after_water_pct: 1 })
    expect(d).toMatchObject({ verdict: 'contradicted', rule: 'dry' })
    expect(d.confidence).toBeLessThanOrEqual(0.7)
  })
  it('Cannot determine when the nearest pass is outside the tolerance window', () => {
    expect(run({ after_date: '2025-09-20' })).toMatchObject({ verdict: 'cannot_determine', kind: 'data_unavailable', rule: 'pass_outside_tolerance' })
    expect(run({ after_date: '2025-09-18' }, { ...p.params, tolerance_days: 15 })).toMatchObject({ verdict: 'supported' })
  })
  it('Cannot determine with no pair, thin coverage, mixed orbit geometry, a plot already wet, or a partial flood', () => {
    expect(run({ after_date: undefined, flood_pct_of_observed: undefined })).toMatchObject({ rule: 'no_pair', kind: 'data_unavailable' })
    expect(run({ valid_pixel_pct: 60 })).toMatchObject({ rule: 'low_coverage' })
    expect(run({ orbit_match: 'any' })).toMatchObject({ rule: 'orbit_geometry_differs' })
    expect(run({ before_water_pct: 90 })).toMatchObject({ rule: 'already_wet', kind: 'inconclusive' })
    expect(run({ flood_pct_of_observed: 15 })).toMatchObject({ rule: 'otherwise', kind: 'inconclusive' })
  })
  it('Cannot determine, as a fetch failure, when the radar could not be read', () => {
    expect(run({}, p.params, 'failed')).toMatchObject({ verdict: 'cannot_determine', kind: 'fetch_failed' })
  })
  it('a plot under 0.5 ha is out of scope', () => {
    expect(run({}, { ...p.params, plot_area_ha: 0.3 })).toMatchObject({ rule: 'plot_below_10m', kind: 'out_of_scope' })
  })
})

describe('not_cleared_since decision rule', () => {
  const recipe = catalog.get('not_cleared_since')!
  const p = resolveParams(recipe, { date: '2020-07-31', as_of: '2024-07-31' }, plot, '2026-10-13')
  if (!p.ok) throw new Error('params')
  const base = { median: 0.85, clear_pixels: 780, in_polygon_pixels: 784 }
  const chg = { date_before: '2020-07-30', date_after: '2024-07-28', sensor_resolution_m: 10, median_delta: -0.01, decreased_pct: 0, pixels_clear_both: 770 }
  const run = (b: Record<string, any> = {}, c: Record<string, any> = {}, params = p.params) =>
    decide(recipe.decision, { params, nodes: [{ idx: 0, op: 'a', status: 'ok', stats: { ...base, ...b } }, { idx: 1, op: 'a', status: 'ok', stats: { ...chg, ...c } }] })

  it('answers Supported, Contradicted and the three abstentions the task names', () => {
    expect(run()).toMatchObject({ verdict: 'supported', rule: 'intact' })
    expect(run({}, { decreased_pct: 60, median_delta: -0.35 })).toMatchObject({ verdict: 'contradicted', rule: 'cleared' })
    expect(run({ clear_pixels: 200 })).toMatchObject({ rule: 'baseline_cloudy', kind: 'insufficient_quality' })
    expect(run({}, { pixels_clear_both: 100 })).toMatchObject({ rule: 'pair_cloudy' })
    expect(run({}, {}, { ...p.params, plot_area_ha: 0.2 })).toMatchObject({ rule: 'plot_below_10m', kind: 'out_of_scope' })
    expect(run({}, { sensor_resolution_m: 30 }, { ...p.params, plot_area_ha: 3 })).toMatchObject({ rule: 'plot_below_sensor' })
    expect(run({ median: 0.2 })).toMatchObject({ rule: 'not_vegetated_at_start', kind: 'out_of_scope' })
    expect(run({}, { date_after: '2024-01-10' })).toMatchObject({ rule: 'season_mismatch' })
    expect(run({}, { decreased_pct: 12, median_delta: -0.06 })).toMatchObject({ rule: 'otherwise', kind: 'inconclusive' })
    expect(run({ median: undefined })).toMatchObject({ rule: 'no_baseline', kind: 'data_unavailable' })
  })
})

describeDb('case store on PostgreSQL', () => {
  let t: TestDb
  beforeAll(async () => { t = await createTestDb() })
  afterAll(async () => { await t?.drop() })

  it('round-trips a case and finds it by its ledger run', async () => {
    const store = createCaseStore(t.prisma as unknown as CaseDb)
    const made = await store.create({
      ownerToken: 'alice', claimType: 'flooded_on', recipe: 'flooded_on@1.0.0', geometry: plot, params: { date: '2025-09-04', tolerance_days: 7 },
      verdict: 'supported', confidence: 0.82, decision: { rule: 'flooded', reason: 'r', inputs: { flood_pct: 80, orbit: null } }, runId: 'run_1',
    })
    expect(await store.get(made.id)).toMatchObject({ ownerToken: 'alice', verdict: 'supported', confidence: 0.82, decision: { inputs: { flood_pct: 80, orbit: null } }, params: { tolerance_days: 7 } })
    expect((await store.byRun('run_1'))?.id).toBe(made.id)
    expect(await store.get('missing')).toBeNull()
  })
})
