import { describe, expect, it } from 'vitest'

import type { PlanStep } from '../../lib/plan'
import { effectiveDeps, referencedNodes, resolveFromNode, validatePlan, withImpliedDeps } from '../plan'

const AOI = { type: 'Polygon', coordinates: [[[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]]] }
const env = { aoi: AOI, now: Date.parse('2026-10-12T12:00:00Z') }
const step = (tool: string, args: Record<string, unknown> = {}, depends_on?: number[]): PlanStep => ({ tool, args, reason: '', depends_on })

describe('from_node references', () => {
  it('finds object and in-string references, nested anywhere', () => {
    expect(referencedNodes({ result_id: { from_node: 0 }, spec: '{"data":{"name":"${node:2}#features"}}', list: [{ from_node: 1 }] }).sort()).toEqual([0, 1, 2])
    expect(referencedNodes({ n: 3, text: 'plain' })).toEqual([])
  })

  it('replaces them with the result_id of the step they name', () => {
    const ids = ['r_aaaaaaaaaaaaaaaa', 'r_bbbbbbbbbbbbbbbb']
    const out = resolveFromNode({ result_id: { from_node: 1 }, spec: '{"name":"${node:0}#features"}', keep: 5 }, (n) => ids[n])
    expect(out).toEqual({ result_id: 'r_bbbbbbbbbbbbbbbb', spec: '{"name":"r_aaaaaaaaaaaaaaaa#features"}', keep: 5 })
  })

  it('makes a reference an implied dependency', () => {
    const s = step('style_layer', { result_id: { from_node: 0 } }, [])
    expect(effectiveDeps(s)).toEqual([0])
    expect(withImpliedDeps([step('a'), step('b', { x: { from_node: 0 } })])[1].depends_on).toEqual([0])
  })
})

describe('plan validation before anything runs', () => {
  it('accepts a valid plan with a backward reference', () => {
    const r = validatePlan([
      step('vectorize_raster', { index: 'NDWI' }),
      step('style_layer', { result_id: { from_node: 0 }, property: 'area_m2' }),
    ], env)
    expect(r).toEqual({ ok: true })
  })

  it('refuses an unknown tool, a forward reference and a forward dependency, with every reason', () => {
    const r = validatePlan([
      step('fetch_ndvi', {}, [1]),
      step('style_layer', { result_id: { from_node: 2 }, property: 'p' }),
      step('teleport'),
    ], env)
    expect(r.ok).toBe(false)
    const reasons = !r.ok ? r.reasons.join('\n') : ''
    expect(reasons).toMatch(/Step 0 \(fetch_ndvi\): depends_on 1 points forward/)
    expect(reasons).toMatch(/Step 1 \(style_layer\): from_node 2 points forward/)
    expect(reasons).toMatch(/Step 2 \(teleport\): unknown tool/)
  })

  it('refuses a reference to a step that does not exist', () => {
    const r = validatePlan([step('style_layer', { result_id: { from_node: 9 }, property: 'p' })], env)
    expect(!r.ok && r.reasons[0]).toMatch(/from_node 9 is not a step/)
  })

  it('refuses when a step fails its own static checks, naming the step', () => {
    const r = validatePlan([
      step('fetch_ndvi'),
      step('render_raster', { bands: ['B99'] }),
      step('map_flood', { before: '2025-08-01', after: '2025-07-01' }),
      step('fetch_temporal_stack', { months: '6' }),
    ], env)
    expect(r.ok).toBe(false)
    const reasons = !r.ok ? r.reasons : []
    expect(reasons.some((x) => /^Step 1 \(render_raster\): .*B99/.test(x))).toBe(true)
    expect(reasons.some((x) => /^Step 2 \(map_flood\): .*earlier than/.test(x))).toBe(true)
    expect(reasons.some((x) => /^Step 3 \(fetch_temporal_stack\)/.test(x))).toBe(true)
    expect(reasons.some((x) => x.startsWith('Step 0'))).toBe(false)
  })
})

describe('the period the question states', () => {
  const claim = 'Claim to check: "Over 20% of the tree cover in this area was lost between 2020 and 2023."'
  const reasonsOf = (steps: PlanStep[], question: string) => { const r = validatePlan(steps, { ...env, question }); return r.ok ? [] : r.reasons }

  it('refuses a time-bound step left on the latest imagery, and says why', () => {
    const r = reasonsOf([step('detect_deforestation')], claim)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatch(/^Step 0 \(detect_deforestation\): .*latest imagery.*2020-01-01 to 2023-12-31/)
  })

  it('refuses explicit dates outside the period but accepts dates inside it', () => {
    expect(reasonsOf([step('detect_deforestation', { before: '2025-02-01', after: '2026-02-01' })], claim)[0]).toMatch(/2025-02-01 to 2026-02-01.*does not overlap/)
    expect(reasonsOf([step('detect_deforestation', { before: '2020-06-01', after: '2023-06-01' })], claim)).toEqual([])
  })

  it('accepts a baseline just before the period (the window overlaps it)', () => {
    expect(reasonsOf([step('detect_change', { before: '2019-12-01', after: '2023-06-01' })], claim)).toEqual([])
  })

  it('ignores steps that are not time-bound, and questions that state no year', () => {
    expect(reasonsOf([step('fetch_built_surface')], claim)).toEqual([])
    expect(reasonsOf([step('detect_deforestation')], 'Did the forest shrink recently?')).toEqual([])
    expect(reasonsOf([step('detect_deforestation')], 'Is this area bigger than 2500 km2?')).toEqual([])
  })

  it('does not flag latest imagery when the question reaches the present', () => {
    expect(reasonsOf([step('detect_deforestation')], 'How much forest was lost from 2023 to 2026?')).toEqual([])
  })
})
