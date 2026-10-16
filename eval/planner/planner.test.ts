/** The planner evaluation's own tests: the case file is well formed, the scorer scores what it says,
 *  and replaying the committed recording with the current code regresses no case that passed in the
 *  baseline (offline: no key, no network). The synthetic outcomes below test the scorer's
 *  mechanics; they are hand-written, not model output, and appear in no score. */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { listOperations } from '../../src/app/api/agent/engine/registry'
import {
  PLANNER_DIR, loadAois, loadCases, loadRecording, matches, regressions, replayAll, scoreOutcome, summarize,
  type Baseline, type Outcome, type PlannerCase,
} from './lib'

const cases = loadCases()
const aois = loadAois()
const byId = (id: string) => cases.find((c) => c.id === id)!

const plan = (steps: Array<{ tool: string; args?: object }>): Outcome => ({
  text: '', finishReason: 'tool_calls',
  toolCalls: [{ id: 'p', name: 'submit_plan', args: { kind: 'plan', steps: steps.map((s) => ({ tool: s.tool, args_json: JSON.stringify(s.args ?? {}), reason: 'r' })) } }],
})
const direct = (name: string, args: object = {}): Outcome => ({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'd', name, args }] })
const say = (text: string): Outcome => ({ text, finishReason: 'stop', toolCalls: [] })
const score = (id: string, o: Outcome) => scoreOutcome(byId(id), o, aois[byId(id).aoi].geometry)

describe('case file', () => {
  it('has unique ids, known AOIs and real operations', () => {
    const ops = new Set(listOperations().map((o) => o.name))
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length)
    for (const c of cases) {
      expect(aois[c.aoi], c.id).toBeDefined()
      const named = [...(c.expect.must_use ?? []), ...(c.expect.must_use_any ?? []), ...(c.expect.must_not_use ?? []), ...(c.expect.or_use ?? []), ...Object.keys(c.expect.args ?? {})]
      for (const n of named) expect(ops.has(n), `${c.id}: ${n}`).toBe(true)
    }
  })

  it('covers the families the evaluation is about', () => {
    const families = new Set(cases.map((c) => c.family))
    for (const f of ['flood', 'indices', 'raw-bands', 'composites', 'claims', 'refusals', 'cannot-determine', 'osm', 'terrain', 'weather']) expect(families.has(f), f).toBe(true)
    expect(cases.length).toBeGreaterThanOrEqual(40)
  })
})

describe('scorer', () => {
  it('passes a right plan and fails a wrong operation', () => {
    expect(score('bd01', plan([{ tool: 'render_raster', args: { bands: ['B08'] } }])).passed).toBe(true)
    const wrong = score('bd01', plan([{ tool: 'fetch_ndvi' }]))
    expect(wrong.passed).toBe(false)
    expect(wrong.checks.filter((c) => !c.ok).map((c) => c.type)).toContain('op_choice')
  })

  it('checks arguments', () => {
    const r = score('bd02', plan([{ tool: 'render_raster', args: { bands: ['B04'] } }]))
    expect(r.checks.find((c) => c.type === 'args')?.ok).toBe(false)
  })

  it('fails a direct tool call even when the operation is right', () => {
    const r = score('ix01', direct('fetch_ndvi'))
    expect(r.behaviour).toBe('direct')
    expect(r.checks.find((c) => c.type === 'no_direct')?.ok).toBe(false)
    expect(r.passed).toBe(false)
  })

  it('counts a model decline, a validator refusal and an honest redirect as refusals, and a plan as a miss', () => {
    expect(score('rf01', say('There is no band B99; Sentinel-2 has B01-B12.')).passed).toBe(true)
    expect(score('rf01', plan([{ tool: 'render_raster', args: { bands: ['B99'] } }])).passed).toBe(true) // the validator refuses it
    expect(score('rf01', plan([{ tool: 'render_raster', args: { bands: ['B08'] } }])).passed).toBe(false)
    expect(score('cd03', plan([{ tool: 'classify_vegetation' }])).passed).toBe(true)
    expect(score('cd03', plan([{ tool: 'fetch_ndvi' }])).passed).toBe(false)
  })

  it('fails a decline of a question that has an answer', () => {
    const r = score('ix01', say('I cannot do that.'))
    expect(r.passed).toBe(false)
    expect(r.checks.find((c) => c.type === 'refusal')?.ok).toBe(false)
  })

  it('wants no tool call when the manifest holds the figure', () => {
    expect(score('ru01', say('Mean NDVI is 0.42 [[r_3fa9c2d41b7e08aa#mean]].')).passed).toBe(true)
    expect(score('ru01', plan([{ tool: 'fetch_ndvi' }])).passed).toBe(false)
  })

  it('keeps a provider error out of the rates', () => {
    const r = scoreOutcome(byId('ix01'), { text: '', toolCalls: [], finishReason: '', error: 'AI provider (gemini) error 429' }, aois.nairobi.geometry)
    expect(r.status).toBe('error')
    expect(summarize([r]).overall.n).toBe(0)
  })

  it('matches argument operators', () => {
    expect(matches('B08', { $any_of: ['B8', 'B08'] })).toBe(true)
    expect(matches(['B08', 'B04', 'B03'], { $len: 3 })).toBe(true)
    expect(matches('(B11-B08)/(B11+B08)', { $matches: 'B11.*B08' })).toBe(true)
    expect(matches(undefined, { $absent: true })).toBe(true)
  })
})

describe('replay of the committed recording', () => {
  const baselineFile = path.join(PLANNER_DIR, 'baseline.json')
  it.skipIf(!existsSync(baselineFile))('regresses no case that passed in the baseline', () => {
    const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')) as Baseline
    const rec = loadRecording(path.resolve(PLANNER_DIR, '../..', baseline.recording))
    expect(regressions(replayAll(rec), baseline)).toEqual([])
  })
})

export type { PlannerCase }
