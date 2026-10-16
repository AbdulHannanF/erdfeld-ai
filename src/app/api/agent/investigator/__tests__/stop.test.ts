import { describe, expect, it } from 'vitest'

import { MIN_VOI_BITS } from '../select'
import { MAX_EVIDENCE_OPS, decide, shouldStop, timeBudgetMs, type StopInput } from '../stop'

const base = (over: Partial<StopInput> = {}): StopInput => ({
  posterior: { a: 0.4, b: 0.35, c: 0.25 },
  history: [{ id: 'a', p: 0.4 }],
  measured: 1, windowMeasured: 1, opsRun: 1, elapsedMs: 10_000, budgetMs: 180_000, bestVoi: 0.3, minVoi: MIN_VOI_BITS,
  ...over,
})

describe('stopping rule', () => {
  it('goes on when nothing says stop', () => {
    expect(shouldStop(base())).toBeNull()
  })

  it('stops when the top posterior is at least 0.85', () => {
    expect(shouldStop(base({ posterior: { a: 0.85, b: 0.1, c: 0.05 } }))).toBe('confident')
    expect(shouldStop(base({ posterior: { a: 0.849, b: 0.1, c: 0.051 } }))).toBeNull()
  })

  it('does not stop on priors alone: confidence needs a measurement', () => {
    expect(shouldStop(base({ measured: 0, windowMeasured: 0, posterior: { a: 0.92, b: 0.08 } }))).toBeNull()
  })

  it('does not stop confident on evidence that never observed the window (an archive baseline moved belief to 0.86)', () => {
    expect(shouldStop(base({ measured: 1, windowMeasured: 0, posterior: { a: 0.86, b: 0.14 } }))).toBeNull()
    expect(shouldStop(base({ measured: 2, windowMeasured: 1, posterior: { a: 0.86, b: 0.14 } }))).toBe('confident')
  })

  it('stops when the same hypothesis leads and moved under 0.03 over the last two steps', () => {
    const h = [{ id: 'a', p: 0.5 }, { id: 'a', p: 0.51 }, { id: 'a', p: 0.52 }]
    expect(shouldStop(base({ history: h }))).toBe('converged')
  })

  it('does not call it converged when the lead moved 0.03 or more, or changed hands', () => {
    expect(shouldStop(base({ history: [{ id: 'a', p: 0.5 }, { id: 'a', p: 0.52 }, { id: 'a', p: 0.54 }] }))).toBeNull()
    expect(shouldStop(base({ history: [{ id: 'b', p: 0.5 }, { id: 'a', p: 0.5 }, { id: 'a', p: 0.5 }] }))).toBeNull()
  })

  it('needs two steps after the priors; a step that measured nothing adds no history entry, so it cannot look like convergence', () => {
    // priors then one measured step: only two entries
    expect(shouldStop(base({ history: [{ id: 'a', p: 0.5 }, { id: 'a', p: 0.5 }] }))).toBeNull()
  })

  it('stops at six evidence operations', () => {
    expect(shouldStop(base({ opsRun: MAX_EVIDENCE_OPS - 1 }))).toBeNull()
    expect(shouldStop(base({ opsRun: MAX_EVIDENCE_OPS }))).toBe('op_budget')
  })

  it('stops when the time budget is spent', () => {
    expect(shouldStop(base({ elapsedMs: 180_000 }))).toBe('time_budget')
    expect(shouldStop(base({ elapsedMs: 179_999 }))).toBeNull()
  })

  it('stops when no item has positive value of information', () => {
    expect(shouldStop(base({ bestVoi: 0 }))).toBe('no_informative_evidence')
    expect(shouldStop(base({ bestVoi: MIN_VOI_BITS }))).toBeNull()
  })

  it('stops at once when the client has gone', () => {
    expect(shouldStop(base({ aborted: true }))).toBe('aborted')
  })

  it('reads the time budget from INVESTIGATOR_TIME_BUDGET_MS, default 180000', () => {
    expect(timeBudgetMs({})).toBe(180_000)
    expect(timeBudgetMs({ INVESTIGATOR_TIME_BUDGET_MS: '300000' })).toBe(300_000)
    expect(timeBudgetMs({ INVESTIGATOR_TIME_BUDGET_MS: 'soon' })).toBe(180_000)
    expect(timeBudgetMs({ INVESTIGATOR_TIME_BUDGET_MS: '10' })).toBe(180_000)
  })
})

describe('verdict', () => {
  it('names the top hypothesis at 0.6 or above', () => {
    expect(decide({ a: 0.6, b: 0.4 }, 2)).toEqual({ kind: 'hypothesis', id: 'a', posterior: 0.6 })
  })
  it('says "cannot determine" below 0.6', () => {
    expect(decide({ a: 0.59, b: 0.41 }, 2)).toMatchObject({ kind: 'cannot_determine', leading: { id: 'a' } })
  })
  it('says "cannot determine" when nothing inside the window was measured, however confident the belief', () => {
    expect(decide({ a: 0.86, b: 0.14 }, 0)).toMatchObject({ kind: 'cannot_determine', leading: { id: 'a' } })
  })
  it('says "cannot determine" when nothing was measured, whatever the priors', () => {
    expect(decide({ a: 0.92, b: 0.08 }, 0)).toMatchObject({ kind: 'cannot_determine' })
  })
})
