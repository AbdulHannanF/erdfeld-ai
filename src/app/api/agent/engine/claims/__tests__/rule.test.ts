import { describe, expect, it } from 'vitest'

import { anniversaryBefore, dayOfYearGap, decide, evalOperand, type NodeRecord } from '../rule'
import { DecisionSchema, type Decision } from '../schema'

const decision: Decision = DecisionSchema.parse({
  requires: [0],
  inputs: {
    ha: { param: 'plot_area_ha' },
    drop: { stat: '0.drop_pct' },
    clear: { stat: '0.clear_frac' },
    gap: { fn: 'abs_days', args: [{ stat: '0.pass' }, { param: 'date' }] },
  },
  rules: [
    { id: 'tiny', when: { lt: [{ ref: 'ha' }, 0.5] }, verdict: 'cannot_determine', kind: 'out_of_scope', reason: 'Plot is {ha} ha.' },
    { id: 'no_data', when: { missing: { ref: 'drop' } }, verdict: 'cannot_determine', kind: 'data_unavailable', reason: 'No figure.' },
    { id: 'cloudy', when: { lt: [{ ref: 'clear' }, 0.5] }, verdict: 'cannot_determine', kind: 'insufficient_quality', reason: 'Only {clear} clear.' },
    { id: 'late', when: { gt: [{ ref: 'gap' }, 7] }, verdict: 'cannot_determine', kind: 'data_unavailable', reason: 'Pass {gap} days away.' },
    {
      id: 'cleared', when: { gte: [{ ref: 'drop' }, 25] }, verdict: 'contradicted', reason: '{drop}% dropped.',
      confidence: { base: 0.5, terms: [{ weight: 0.4, value: { ref: 'drop' }, from: 25, to: 75 }], cap: 0.9 },
    },
    {
      id: 'intact', when: { lte: [{ ref: 'drop' }, 5] }, verdict: 'supported', reason: 'Only {drop}% dropped.',
      confidence: { base: 0.6, terms: [{ weight: 0.3, value: { ref: 'clear' }, from: 0.5, to: 1 }], cap: 0.95 },
    },
  ],
  otherwise: { kind: 'inconclusive', reason: 'Mixed: {drop}%.' },
})

const node = (stats: NodeRecord['stats'], status: NodeRecord['status'] = 'ok', extra: Partial<NodeRecord> = {}): NodeRecord => ({ idx: 0, op: 'op', status, stats, ...extra })
const params = { plot_area_ha: 4, date: '2024-05-10' }
const ok = { drop_pct: 2, clear_frac: 0.9, pass: '2024-05-12' }
const run = (stats: NodeRecord['stats'], p: Record<string, string | number> = params, nodeExtra?: { status?: NodeRecord['status']; flags?: string[]; summary?: string }) =>
  decide(decision, { params: p, nodes: [node(stats, nodeExtra?.status ?? 'ok', nodeExtra)] })

describe('decide: every verdict path', () => {
  it('Supported, with a confidence from its terms', () => {
    const d = run(ok)
    expect(d).toMatchObject({ verdict: 'supported', rule: 'intact', reason: 'Only 2% dropped.' })
    expect(d.confidence).toBeCloseTo(0.6 + 0.3 * 0.8, 3)
    expect(d.inputs).toMatchObject({ ha: 4, drop: 2, clear: 0.9, gap: 2 })
  })

  it('Contradicted, with confidence capped', () => {
    expect(run({ ...ok, drop_pct: 40 })).toMatchObject({ verdict: 'contradicted', rule: 'cleared', confidence: 0.5 + 0.4 * 0.3 })
    expect(run({ ...ok, drop_pct: 100 }).confidence).toBe(0.9)
  })

  it('abstains on a plot below the resolution, and carries no confidence', () => {
    const d = run(ok, { ...params, plot_area_ha: 0.2 })
    expect(d).toMatchObject({ verdict: 'cannot_determine', kind: 'out_of_scope', rule: 'tiny', confidence: null })
    expect(d.reason).toBe('Plot is 0.2 ha.')
  })

  it('abstains when a figure is missing (no data), not as zero', () => {
    expect(run({ clear_frac: 0.9, pass: '2024-05-12' })).toMatchObject({ verdict: 'cannot_determine', kind: 'data_unavailable', rule: 'no_data' })
  })

  it('abstains on too little clear data', () => {
    expect(run({ ...ok, clear_frac: 0.3 })).toMatchObject({ verdict: 'cannot_determine', kind: 'insufficient_quality', rule: 'cloudy' })
  })

  it('abstains when the pass is outside the tolerance (date arithmetic)', () => {
    const d = run({ ...ok, pass: '2024-05-30' })
    expect(d).toMatchObject({ rule: 'late', kind: 'data_unavailable' })
    expect(d.reason).toBe('Pass 20 days away.')
  })

  it('is inconclusive, never a guess, between the two thresholds', () => {
    expect(run({ ...ok, drop_pct: 12 })).toMatchObject({ verdict: 'cannot_determine', kind: 'inconclusive', rule: 'otherwise', reason: 'Mixed: 12%.' })
  })

  it('first matching rule wins (abstentions placed before verdicts)', () => {
    expect(run({ ...ok, drop_pct: 60, clear_frac: 0.2 }).rule).toBe('cloudy')
  })
})

describe('decide: nodes that did not give figures', () => {
  it('a failed node is a fetch failure, in those words', () => {
    const d = run(null, params, { status: 'failed', summary: '**op failed:** timeout. This is a failure, not an absence of data.' })
    expect(d).toMatchObject({ verdict: 'cannot_determine', kind: 'fetch_failed', rule: 'node_0_failed' })
    expect(d.reason).toContain('could not be read (a failure, not an absence of data)')
  })

  it('a refused node is out of scope and carries the refusal', () => {
    const d = run(null, params, { status: 'refused', flags: ['date is before Sentinel-2 began'] })
    expect(d).toMatchObject({ kind: 'out_of_scope', rule: 'node_0_refused' })
    expect(d.reason).toContain('date is before Sentinel-2 began')
  })

  it('a flagged node is not trusted', () => {
    expect(run(ok, params, { status: 'flagged', flags: ['NDVI outside [-1,1]'] })).toMatchObject({ kind: 'insufficient_quality', rule: 'node_0_flagged' })
  })

  it('a skipped or absent required node cannot be decided on', () => {
    expect(run(null, params, { status: 'skipped' })).toMatchObject({ kind: 'fetch_failed' })
    expect(decide(decision, { params, nodes: [] })).toMatchObject({ kind: 'fetch_failed', rule: 'node_0_missing' })
  })
})

describe('operands', () => {
  const scope = { params: { d: '2024-01-31' } as Record<string, string | number>, nodes: [node({ x: 4, s: 'abc' })], inputs: {}, plotAreaHa: 9 }
  it('does arithmetic and propagates missing values', () => {
    expect(evalOperand({ fn: 'div', args: [{ stat: '0.x' }, 2] }, scope)).toBe(2)
    expect(evalOperand({ fn: 'div', args: [{ stat: '0.x' }, 0] }, scope)).toBeUndefined()
    expect(evalOperand({ fn: 'sub', args: [{ stat: '0.nope' }, 1] }, scope)).toBeUndefined()
    expect(evalOperand({ stat: '0.s' }, scope)).toBe('abc')
    expect(evalOperand({ fn: 'plot_area_ha', args: [] }, scope)).toBe(9)
  })
  it('adds days across a month end', () => {
    expect(evalOperand({ fn: 'add_days', args: [{ param: 'd' }, -45] }, scope)).toBe('2023-12-17')
    expect(evalOperand({ fn: 'add_days', args: ['2024-02-27', 3] }, scope)).toBe('2024-03-01')
  })
})

describe('season helpers', () => {
  it('finds the same-season anniversary at least a year on', () => {
    expect(anniversaryBefore('2020-07-31', '2024-12-31')).toBe('2024-07-31')
    expect(anniversaryBefore('2020-07-31', '2024-07-31')).toBe('2024-07-31')
    expect(anniversaryBefore('2020-07-31', '2024-07-30')).toBe('2023-07-31')
    expect(anniversaryBefore('2020-02-29', '2023-03-15')).toBe('2023-02-28')
  })
  it('falls back to as_of when less than a year has passed, and rejects a reversed span', () => {
    expect(anniversaryBefore('2025-07-31', '2026-03-01')).toBe('2026-03-01')
    expect(anniversaryBefore('2025-07-31', '2025-01-01')).toBeUndefined()
  })
  it('measures how far apart two dates are in the year, circularly', () => {
    expect(dayOfYearGap('2021-01-02', '2023-12-30')).toBe(3)
    expect(dayOfYearGap('2021-07-01', '2024-07-31')).toBe(30)
  })
})
