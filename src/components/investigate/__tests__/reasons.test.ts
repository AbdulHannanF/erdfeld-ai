import { describe, expect, it } from 'vitest'
import { checkFinding, checkName, foldEvents, ruledOut, ruledOutReason, type StepEntry } from '../state'
import type { InvestigationEvent } from '@/lib/investigation-events'

/** A water question: the long-term water record read 0 % of years, which rules "flood" out. */
const EVENTS: InvestigationEvent[] = [
  { type: 'hypotheses', items: [
    { id: 'flood', label: 'Flood', family: 'Water', prior: 0.5 },
    { id: 'dry', label: 'Dry season', family: 'Water', prior: 0.5 },
  ] },
  { type: 'step', n: 1, op: 'fetch_surface_water', title: 'Long-term water occurrence (JRC, 1984-2021)', why: 'Tells a river from a flood.', voi: 0.4 },
  {
    type: 'evidence', n: 1, resultId: 'r_1', status: 'ok', features: { water_occurrence_pct: 0 },
    summary: 'Surface Water History — JRC Global Surface Water v1.4 · 217.9 km² (drawn polygon) Dataset: JRC/GSW1_4',
    measured: true,
    feature: { name: 'water_occurrence_pct', value: 0, unit: '% of years', field: 'stats.occ', derivation: 'mean', bin: '< 5 % of years' },
  },
  { type: 'belief', n: 1, posteriors: { flood: 0.02, dry: 0.98 } },
]

describe('plain-language reasons from structured events', () => {
  const s = foldEvents(EVENTS)

  it('builds the ruled-out line from the step title, the measured feature and the belief change', () => {
    const r = ruledOut(s)[0]
    const line = ruledOutReason(r)
    expect(line).toBe('Ruled out after long-term water occurrence (JRC, 1984-2021): read 0 % of years (50% → 2%).')
    // none of the result's prose leaks into the line
    expect(line).not.toMatch(/Dataset|Surface Water History|217\.9/)
  })

  it('says so when a hypothesis never rose, without inventing a cause', () => {
    const none = foldEvents(EVENTS.slice(0, 1))
    const r = { hypothesis: none.hypotheses[0], probability: 0.01, fromProbability: 0.5 }
    expect(ruledOutReason(r)).toBe('Never rose above 50%.')
  })

  it('states a check finding from the feature, and the reason when nothing was measured', () => {
    expect(checkFinding(s.steps[0])).toBe('Measured 0 % of years (< 5 % of years).')
    const failed: StepEntry = { n: 2, op: 'map_flood', why: '', voi: 0, evidence: { resultId: 'r_2', summary: 'raw', features: {}, status: 'failed', reason: 'the radar scenes could not be read' } }
    expect(checkFinding(failed)).toBe('Could not be measured: the radar scenes could not be read')
    expect(checkFinding({ n: 3, op: 'x', why: '', voi: 0 })).toBe('')
  })

  it('names a check by its title, else by its operation', () => {
    expect(checkName(s.steps[0])).toMatch(/^Long-term water occurrence/)
    expect(checkName({ op: 'map_flood' })).toBe('map flood')
  })
})
