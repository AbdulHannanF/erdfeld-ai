import { describe, expect, it } from 'vitest'
import { parseInvestigationEvent } from '@/lib/investigation-events'
import { FIXTURE_RESOLVED, FIXTURE_UNDETERMINED } from '../fixtures'
import { chosenCell, currentBelief, foldEvents, INITIAL_INVESTIGATION, leading, reduceInvestigation, ruledOut } from '../state'

describe('investigation state', () => {
  it('folds a full stream into a finished run', () => {
    const s = foldEvents(FIXTURE_RESOLVED)
    expect(s.status).toBe('done')
    expect(s.steps.map((x) => x.n)).toEqual([1, 2, 3, 4])
    expect(s.steps.every((x) => x.evidence)).toBe(true)
    expect(s.verdict?.kind).toBe('hypothesis')
    expect(s.dossier?.runId).toBe('fixture-run-1')
    expect(chosenCell(s)).toEqual([74.02, 31.1, 74.06, 31.14])
  })

  it('uses the priors until the first belief update', () => {
    const s = foldEvents(FIXTURE_RESOLVED.slice(0, 2))
    expect(currentBelief(s).harvest).toBeCloseTo(0.3)
    const after = foldEvents(FIXTURE_RESOLVED)
    expect(currentBelief(after).harvest).toBeCloseTo(0.78)
  })

  it('ranks the hypotheses still in play and lists the ruled-out ones with their cause', () => {
    const s = foldEvents(FIXTURE_RESOLVED)
    expect(leading(s)[0].hypothesis.id).toBe('harvest')
    const out = ruledOut(s)
    expect(out.map((r) => r.hypothesis.id).sort()).toEqual(['artefact', 'flood'])
    const flood = out.find((r) => r.hypothesis.id === 'flood')!
    // the biggest single drop for "flood" is the radar step, and the reason comes from that evidence
    expect(flood.step?.op).toBe('detect_water')
    expect(flood.step?.evidence?.summary).toMatch(/open water/i)
  })

  it('keeps evidence whose step event never arrived, and does not duplicate a repeated step', () => {
    let s = reduceInvestigation(INITIAL_INVESTIGATION, {
      type: 'evidence', n: 7, resultId: 'r_x', summary: 'late', features: {}, status: 'ok',
    })
    expect(s.steps).toHaveLength(1)
    expect(s.steps[0].evidence?.summary).toBe('late')
    s = reduceInvestigation(s, { type: 'step', n: 7, op: 'fetch_dem', why: 'w', voi: 0.1 })
    s = reduceInvestigation(s, { type: 'step', n: 7, op: 'fetch_dem', why: 'w', voi: 0.1 })
    expect(s.steps.filter((x) => x.n === 7)).toHaveLength(1)
  })

  it('an undetermined run ends in cannot_determine and shows the failed fetch as failed', () => {
    const s = foldEvents(FIXTURE_UNDETERMINED)
    expect(s.verdict?.kind).toBe('cannot_determine')
    expect(s.steps[1].evidence?.status).toBe('failed')
    expect(ruledOut(s)).toEqual([])
  })

  it('an error event ends the run with its message', () => {
    const s = reduceInvestigation(INITIAL_INVESTIGATION, { type: 'error', message: 'boom' })
    expect(s.status).toBe('error')
    expect(s.error).toBe('boom')
  })
})

describe('parseInvestigationEvent', () => {
  it('takes the type from the SSE event name, even when the payload omits it', () => {
    const e = parseInvestigationEvent('step', JSON.stringify({ n: 2, op: 'fetch_dem', why: 'x', voi: 0.2 }))
    expect(e).toMatchObject({ type: 'step', n: 2, op: 'fetch_dem' })
  })

  it('rejects malformed JSON, unknown events and events missing required fields', () => {
    expect(parseInvestigationEvent('step', '{oops')).toBeNull()
    expect(parseInvestigationEvent('mystery', '{}')).toBeNull()
    expect(parseInvestigationEvent('belief', JSON.stringify({ n: 1 }))).toBeNull()
    expect(parseInvestigationEvent('verdict', JSON.stringify({ kind: 'hypothesis', label: 'x' }))).toBeNull()
  })
})
