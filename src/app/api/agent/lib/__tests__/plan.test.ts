import { describe, it, expect } from 'vitest'
import { parseSubmitPlan, topoSort, hasCycle, unknownTools, type PlanStep } from '../plan'

const step = (tool: string, depends_on?: number[], parallel_group?: number): PlanStep => ({
  tool,
  args: {},
  reason: '',
  depends_on,
  parallel_group,
})

describe('parseSubmitPlan', () => {
  it('accepts a plan and fills defaults', () => {
    const r = parseSubmitPlan({ kind: 'plan', steps: [{ tool: 'fetch_dem' }] })
    expect(r).toEqual({
      ok: true,
      submitted: { kind: 'plan', plan: { steps: [{ tool: 'fetch_dem', args: {}, reason: '', depends_on: undefined, parallel_group: undefined }] } },
    })
  })

  it('keeps args, reason, depends_on and parallel_group', () => {
    const r = parseSubmitPlan({
      kind: 'replan',
      steps: [{ tool: 'fetch_precipitation_history', args_json: '{"months_back":12}', reason: 'rain', depends_on: [0], parallel_group: 2 }],
    })
    expect(r.ok && r.submitted.kind).toBe('replan')
    expect(r.ok && r.submitted.plan.steps[0]).toEqual({
      tool: 'fetch_precipitation_history', args: { months_back: 12 }, reason: 'rain', depends_on: [0], parallel_group: 2,
    })
  })

  it('decodes args_json and rejects what is not a JSON object, naming the step', () => {
    const bad = (args_json: string) => parseSubmitPlan({ kind: 'plan', steps: [{ tool: 'fetch_dem' }, { tool: 'fetch_ndvi', args_json }] })
    for (const args_json of ['{not json', '[1,2]', '"text"', '7']) {
      const r = bad(args_json)
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error).toMatch(/steps\.1\.args_json/)
    }
    const r = bad('  ')
    expect(r.ok && r.submitted.plan.steps[1].args).toEqual({})
  })

  it('rejects with a readable reason: no steps, missing tool, bad kind, wrong shape', () => {
    for (const bad of [
      { kind: 'plan', steps: [] },
      { kind: 'plan', steps: [{ args: {} }] },
      { kind: 'nope', steps: [{ tool: 'a' }] },
      { steps: [{ tool: 'a' }] },
      [{ tool: 'a' }],
      null,
    ]) {
      const r = parseSubmitPlan(bad)
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// topoSort
// ---------------------------------------------------------------------------

describe('topoSort', () => {
  it('puts fully independent steps in a single batch', () => {
    const steps = [step('a'), step('b'), step('c')]
    expect(topoSort(steps)).toEqual([[0, 1, 2]])
  })

  it('produces one batch per level for a linear chain', () => {
    const steps = [step('a'), step('b', [0]), step('c', [1])]
    expect(topoSort(steps)).toEqual([[0], [1], [2]])
  })

  it('handles a diamond dependency', () => {
    // 0 → {1,2} → 3
    const steps = [step('a'), step('b', [0]), step('c', [0]), step('d', [1, 2])]
    expect(topoSort(steps)).toEqual([[0], [1, 2], [3]])
  })

  it('ignores out-of-range dependency indices', () => {
    const steps = [step('a', [5]), step('b')]
    expect(topoSort(steps)).toEqual([[0, 1]])
  })

  it('throws on a 2-cycle', () => {
    const steps = [step('a', [1]), step('b', [0])]
    expect(() => topoSort(steps)).toThrow(/cycle/i)
  })

  it('throws on a self-dependency', () => {
    const steps = [step('a', [0])]
    expect(() => topoSort(steps)).toThrow(/cycle/i)
  })
})

describe('hasCycle', () => {
  it('is false for a DAG', () => {
    expect(hasCycle([step('a'), step('b', [0])])).toBe(false)
  })

  it('is true for a cycle', () => {
    expect(hasCycle([step('a', [1]), step('b', [0])])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// unknownTools
// ---------------------------------------------------------------------------

describe('unknownTools', () => {
  const valid = new Set(['fetch_dem', 'fetch_sar'])

  it('returns names not in the valid set', () => {
    const plan = { steps: [step('fetch_dem'), step('bogus_tool'), step('also_fake')] }
    expect(unknownTools(plan, valid).sort()).toEqual(['also_fake', 'bogus_tool'])
  })

  it('returns empty when all tools are valid', () => {
    const plan = { steps: [step('fetch_dem'), step('fetch_sar')] }
    expect(unknownTools(plan, valid)).toEqual([])
  })

  it('de-duplicates repeated unknown tools', () => {
    const plan = { steps: [step('x'), step('x')] }
    expect(unknownTools(plan, valid)).toEqual(['x'])
  })
})
