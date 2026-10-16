import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { byBiome, summarize, wilson, ece, type Row } from '../../../../../../../eval/claims/metrics'
import { loadRecipes } from '../loader'
import { resolveParams } from '../params'
import { decide, type NodeRecord } from '../rule'

const root = path.join(__dirname, '../../../../../../..')
const fixture = JSON.parse(readFileSync(path.join(root, 'eval/claims/fixtures/subset20.json'), 'utf8'))
const recipe = loadRecipes(path.join(root, 'recipes')).get(fixture.recipe)!

/** The cached 20-plot subset of the claim evaluation (Q-25): live Sentinel-2 figures recorded
 *  once; CI re-evaluates the recipe's decision rule on them with no network. A recipe or engine
 *  change that alters a verdict on real recorded data fails here and must be re-measured. */
describe('claim evaluation, cached 20-plot subset', () => {
  const evaluated = fixture.plots.map((p: any) => {
    const params = resolveParams(recipe, fixture.claim, p.geometry, '2026-10-13')
    if (!params.ok) throw new Error(params.errors.join())
    return { p, d: decide(recipe.decision, { params: params.params, nodes: p.nodes as NodeRecord[] }) }
  })

  it('has 20 plots across 5 biomes, half loss and half stable', () => {
    expect(fixture.plots).toHaveLength(20)
    expect(new Set(fixture.plots.map((p: any) => p.biome)).size).toBe(5)
    expect(fixture.plots.filter((p: any) => p.label === 'loss')).toHaveLength(10)
  })

  const cases: Array<[string, any]> = fixture.plots.map((p: any) => [p.id, p])
  it.each(cases)('%s: the recipe reproduces the recorded verdict, confidence and rule', (_id: string, p: any) => {
    const { d } = evaluated.find((e: any) => e.p.id === p.id)
    expect({ verdict: d.verdict, confidence: d.confidence, rule: d.rule }).toEqual({ verdict: p.recorded.verdict, confidence: p.recorded.confidence, rule: p.recorded.rule })
  })

  it('scores the subset: accuracy on answered, abstention, coverage, calibration', () => {
    const rows: Row[] = evaluated.map(({ p, d }: any) => ({ id: p.id, biome: p.biome, label: p.label, split: 'test', verdict: d.verdict, confidence: d.confidence, kind: d.kind }))
    const s = summarize(rows)
    expect(s.n).toBe(20)
    expect(s.answered + s.abstained).toBe(20)
    expect(s.coverage).toBeCloseTo(s.answered / 20)
    expect(s.accuracy).not.toBeNull()
    expect(s.accuracy!).toBeGreaterThanOrEqual(0.7)
    expect(s.ece).not.toBeNull()
    expect(Object.keys(byBiome(rows))).toHaveLength(5)
  })
})

describe('evaluation metrics', () => {
  const r = (label: Row['label'], verdict: string, confidence: number | null, biome = 'a'): Row => ({ id: `${label}${verdict}${confidence}`, biome, label, split: 'test', verdict, confidence })

  it('counts abstentions as neither right nor wrong, and errors apart from both', () => {
    const s = summarize([r('loss', 'contradicted', 0.9), r('loss', 'supported', 0.8), r('stable', 'supported', 0.7), r('stable', 'cannot_determine', null), r('stable', 'error', null)])
    expect(s).toMatchObject({ n: 5, answered: 3, correct: 2, abstained: 1, errors: 1, loss_recall: 0.5, stable_recall: 1 })
    expect(s.accuracy).toBeCloseTo(2 / 3)
    expect(s.coverage).toBeCloseTo(3 / 5)
  })

  it('has no accuracy when nothing was answered', () => {
    expect(summarize([r('loss', 'cannot_determine', null)])).toMatchObject({ accuracy: null, accuracy_ci95: null, ece: null, coverage: 0 })
  })

  it('computes ECE as the weighted gap between confidence and accuracy', () => {
    expect(ece([{ confidence: 0.9, correct: true }, { confidence: 0.9, correct: true }])).toBeCloseTo(0.1)
    expect(ece([{ confidence: 0.95, correct: true }, { confidence: 0.95, correct: false }])).toBeCloseTo(0.45)
    expect(ece([])).toBeNull()
  })

  it('gives a Wilson interval that contains the estimate', () => {
    const [lo, hi] = wilson(40, 50)!
    expect(lo).toBeLessThan(0.8)
    expect(hi).toBeGreaterThan(0.8)
    expect(wilson(0, 0)).toBeNull()
  })
})
