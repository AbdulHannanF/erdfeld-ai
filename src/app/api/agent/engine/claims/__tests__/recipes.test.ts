import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { validatePlan } from '../../plan'
import { compareSemver, loadRecipes, parseRecipe } from '../loader'
import { instantiatePlan, resolveParams } from '../params'
import { recipeKey } from '../schema'

const catalog = loadRecipes(path.join(__dirname, '../../../../../../../recipes'))
const plot: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[-55, -7], [-54.997, -7], [-54.997, -7.003], [-55, -7.003], [-55, -7]]] }

const minimal = (over: Record<string, unknown> = {}) => {
  const base = `
id: demo
version: 1.0.0
title: Demo
claim: "Demo claim {date}."
params: { date: { type: date, required: true } }
plan:
  - { tool: fetch_ndvi, args: {} }
decision:
  rules:
    - { id: yes, when: { gte: [{ stat: "0.mean" }, 0.5] }, verdict: supported, reason: "ok", confidence: { base: 0.6 } }
    - { id: no, when: { lt: [{ stat: "0.mean" }, 0.5] }, verdict: contradicted, reason: "no", confidence: { base: 0.6 } }
  otherwise: { reason: "unclear" }
`
  return Object.entries(over).reduce(
    (text, [k, v]) => (new RegExp(`^${k}:`, 'm').test(text) ? text.replace(new RegExp(`^${k}:.*$`, 'm'), `${k}: ${JSON.stringify(v)}`) : `${text}${k}: ${JSON.stringify(v)}\n`),
    base,
  )
}

describe('recipe schema', () => {
  it('accepts a minimal recipe', () => {
    expect(parseRecipe(minimal(), 'demo@1.0.0.yaml')).toMatchObject({ id: 'demo', version: '1.0.0' })
  })

  it('rejects a non-semver version, a wrong file name, an unknown field and a rule with no confidence', () => {
    expect(() => parseRecipe(minimal({ version: 'v1' }))).toThrow(/semver/)
    expect(() => parseRecipe(minimal(), 'demo@1.0.1.yaml')).toThrow(/file name must be demo@1\.0\.0\.yaml/)
    expect(() => parseRecipe(minimal({ surprise: 1 }))).toThrow(/surprise|Unrecognized/)
    expect(() => parseRecipe(minimal().replace(', confidence: { base: 0.6 } }\n    - { id: no', ' }\n    - { id: no'))).toThrow(/needs a confidence/)
  })

  it('rejects a Cannot determine rule without a kind, a stat that is not node.key, and a missing verdict side', () => {
    expect(() => parseRecipe(minimal().replace('verdict: supported, reason: "ok", confidence: { base: 0.6 }', 'verdict: cannot_determine, reason: "ok"'))).toThrow(/needs a kind|supported and one contradicted/)
    expect(() => parseRecipe(minimal().replace('"0.mean"', '"mean"'))).toThrow(/stat is/)
  })

  it('rejects a template or reference to a name the recipe does not define', () => {
    expect(() => parseRecipe(minimal().replace('reason: "ok"', 'reason: "{nope}"'))).toThrow(/\{nope\}/)
    expect(() => parseRecipe(minimal().replace('{ stat: "0.mean" }, 0.5] }, verdict: supported', '{ param: ghost }, 0.5] }, verdict: supported'))).toThrow()
  })

  it('rejects requires or depends_on that point outside the plan', () => {
    expect(() => parseRecipe(minimal().replace('rules:', 'requires: [3]\n  rules:'))).toThrow(/not a plan step/)
  })
})

describe('recipe loader and versioning', () => {
  it('loads the shipped recipes, latest by default and an exact version on request', () => {
    const ids = catalog.list().map(recipeKey)
    expect(ids).toEqual(expect.arrayContaining(['flooded_on@1.0.0', 'not_cleared_since@1.0.0']))
    expect(catalog.get('flooded_on')?.version).toBe('1.0.0')
    expect(catalog.get('flooded_on@1.0.0')?.id).toBe('flooded_on')
    expect(catalog.get('flooded_on@9.9.9')).toBeUndefined()
    expect(catalog.get('nope')).toBeUndefined()
  })

  it('picks the highest semver as latest (numerically, not as text) and keeps old versions addressable', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'recipes-'))
    for (const v of ['1.2.0', '1.10.0', '1.9.3']) writeFileSync(path.join(dir, `demo@${v}.yaml`), minimal({ version: v }))
    const c = loadRecipes(dir)
    expect(c.get('demo')?.version).toBe('1.10.0')
    expect(c.get('demo@1.9.3')?.version).toBe('1.9.3')
    expect(c.list().map((r) => r.version)).toEqual(['1.10.0', '1.9.3', '1.2.0'])
    expect(compareSemver('1.10.0', '1.9.9')).toBeGreaterThan(0)
  })

  it('refuses a file whose name and content disagree, and an empty directory has no recipes', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'recipes-'))
    writeFileSync(path.join(dir, 'demo@2.0.0.yaml'), minimal())
    expect(() => loadRecipes(dir)).toThrow(/file name must be/)
    expect(loadRecipes(path.join(dir, 'missing')).list()).toEqual([])
  })
})

describe('shipped recipes against the engine', () => {
  it.each(['not_cleared_since', 'flooded_on'])('%s: its plan validates against the operation registry', (id) => {
    const recipe = catalog.get(id)!
    const raw = id === 'flooded_on' ? { date: '2025-09-04' } : { date: '2020-07-31', as_of: '2024-12-31' }
    const p = resolveParams(recipe, raw, plot, '2026-10-13')
    expect(p.ok).toBe(true)
    if (!p.ok) return
    const steps = instantiatePlan(recipe, p.params)
    expect(validatePlan(steps, { aoi: plot, now: Date.parse('2026-10-13') })).toEqual({ ok: true })
  })

  it('every shipped decision reason, rule and abstention is reachable by id and unique', () => {
    for (const r of catalog.list()) {
      const ids = r.decision.rules.map((x) => x.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(r.decision.rules.some((x) => x.verdict === 'cannot_determine')).toBe(true)
    }
  })
})

describe('parameters', () => {
  const nc = catalog.get('not_cleared_since')!
  const fl = catalog.get('flooded_on')!

  it('derives the same-season compare date and the plot area; stores today when as_of is left out', () => {
    const p = resolveParams(nc, { date: '2020-07-31', as_of: '2024-12-31' }, plot, '2026-10-13')
    expect(p).toMatchObject({ ok: true, params: { date: '2020-07-31', as_of: '2024-12-31', compare_date: '2024-07-31' } })
    const q = resolveParams(nc, { date: '2020-07-31' }, plot, '2026-10-13')
    expect(q.ok && q.params).toMatchObject({ as_of: '2026-10-13', compare_date: '2026-07-31' })
    if (p.ok) expect(p.params.plot_area_ha).toBeGreaterThan(8)
  })

  it('applies defaults and bounds, and says every problem', () => {
    const p = resolveParams(fl, { date: '2025-09-04' }, plot, '2026-10-13')
    expect(p.ok && p.params).toMatchObject({ tolerance_days: 7, min_flooded_pct: 30, reference_date: '2025-08-05' })
    expect(resolveParams(fl, { date: '2025-09-04', tolerance_days: 40, bogus: 1 }, plot, '2026-10-13')).toEqual({
      ok: false, errors: expect.arrayContaining(['bogus is not a parameter of flooded_on', 'tolerance_days must be at most 15']),
    })
    expect(resolveParams(fl, {}, plot, '2026-10-13')).toEqual({ ok: false, errors: ['date is required'] })
    expect(resolveParams(fl, { date: '2025-02-30' }, plot, '2026-10-13')).toEqual({ ok: false, errors: ['date must be a calendar date, YYYY-MM-DD'] })
  })

  it('writes parameters into the plan and leaves from_node references for the executor', () => {
    const recipe = parseRecipe(minimal().replace('{ tool: fetch_ndvi, args: {} }', '{ tool: fetch_ndvi, args: { product: { param: date }, up: { from_node: 0 } } }'))
    expect(instantiatePlan(recipe, { date: '2024-01-01' })[0].args).toEqual({ product: '2024-01-01', up: { from_node: 0 } })
  })
})
