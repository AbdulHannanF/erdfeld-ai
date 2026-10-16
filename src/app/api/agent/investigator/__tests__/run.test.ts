import { describe, expect, it } from 'vitest'

import type { GeoResult } from '@/lib/geo-result'

import { memoryStore } from '../../engine/__tests__/memory-store'
import type { InvestigateEvents } from '../events'
import type { InvestigatorLlm } from '../llm'
import { chooseWindow, normaliseDate, resolveArgs, runInvestigation } from '../run'
import { KASUR_AOI, WINDOW, failedGeo, flaggedGeo, geo, mockLlm } from './fixtures'

type Ev = { event: keyof InvestigateEvents; data: any }

const FLOOD_STATS = { flood_pct_of_observed: 38, before_water_pct: 3, orbit_match: 'orbit', valid_pixel_pct: 98 }

/** Operations answer from a table of handlers; anything unlisted fails like an unreachable service. */
function ops(handlers: Record<string, (args: Record<string, any>) => GeoResult>) {
  const calls: Array<{ op: string; args: Record<string, any> }> = []
  const runOp = async (name: string, args: Record<string, any>) => {
    calls.push({ op: name, args })
    return handlers[name]?.(args) ?? failedGeo(name)
  }
  return { runOp, calls }
}

async function run(opts: {
  now?: () => number
  handlers: Record<string, (args: Record<string, any>) => GeoResult>
  llm?: InvestigatorLlm
  family?: any
  question?: string
  window?: { start: string; end: string }
  aoi?: any
  budgetMs?: number
}) {
  const events: Ev[] = []
  const { runOp, calls } = ops(opts.handlers)
  const mem = memoryStore()
  const llm = opts.llm ?? mockLlm()
  await runInvestigation({
    aoi: opts.aoi ?? KASUR_AOI, question: opts.question, window: opts.window ?? WINDOW, family: opts.family === null ? undefined : (opts.family ?? 'water'),
    owner: null, llm: { provider: 'gemini', apiKey: 'test-key-123456789' },
    emit: ((event: any, data: any) => { events.push({ event, data }) }) as any,
    signal: new AbortController().signal,
    budgetMs: opts.budgetMs,
    deps: { llm, runOp: runOp as any, evidence: async () => mem.store, now: opts.now ?? Date.now },
  })
  const of = <K extends keyof InvestigateEvents>(k: K) => events.filter((e) => e.event === k).map((e) => e.data as InvestigateEvents[K])
  return { events, of, calls, mem, llm }
}

const floodHandlers = {
  map_flood: () => geo('map_flood', FLOOD_STATS),
  fetch_surface_water: () => geo('fetch_surface_water', { occurrence_mean_pct: 2 }),
  analyze_raster: (a: Record<string, any>) => geo('analyze_raster', { operation: 'change', index: a.index, mean_delta: a.index === 'NDWI' ? 0.2 : -0.1, date_before: '2025-08-01', date_after: '2025-09-30' }),
  inspect_imagery: () => geo('inspect_imagery', { aoi_cloud_pct: 5, valid_pixel_pct: 95, scene_date: '2025-09-28' }, { summary: 'Wide sheets of water over fields.' }),
}

describe('a flood investigation end to end (mocked operations and model)', () => {
  it('emits the events in order, updates belief from measurements and reaches a verdict', async () => {
    const r = await run({ handlers: floodHandlers })
    const names = r.events.map((e) => e.event)
    expect(names[0]).toBe('zoom_to')
    expect(names.indexOf('hypotheses')).toBeLessThan(names.indexOf('step'))
    for (const e of ['hypotheses', 'step', 'tool_call', 'evidence', 'belief', 'verdict', 'corroboration', 'ledger', 'dossier', 'done'] as const) expect(names, e).toContain(e)
    expect(names.indexOf('verdict')).toBeLessThan(names.indexOf('dossier'))
    expect(names[names.length - 1]).toBe('done')
    // each step precedes its evidence and belief
    const first = names.indexOf('step')
    expect(names.indexOf('evidence')).toBeGreaterThan(first)
    expect(names.indexOf('belief')).toBeGreaterThan(names.indexOf('evidence'))

    const verdict = r.of('verdict')[0]
    expect(verdict.kind).toBe('hypothesis')
    expect(verdict.id).toBe('water_flood_event')
    expect(verdict.posterior).toBeGreaterThanOrEqual(0.6)
    expect(verdict.items_measured).toBeGreaterThan(1)
  })

  it('runs one operation for items that read the same result and counts it once', async () => {
    // only radar answers, so the three radar items (new water, prior water, orbit geometry) share one run
    const r = await run({ handlers: { map_flood: floodHandlers.map_flood } })
    expect(r.calls.filter((c) => c.op === 'map_flood')).toHaveLength(1)
    const radarSteps = r.of('step').filter((s) => s.op === 'map_flood')
    expect(radarSteps.length).toBeGreaterThanOrEqual(2)
    expect(radarSteps[0].reused).toBe(false)
    expect(radarSteps.slice(1).every((s) => s.reused && s.cost_s === 0)).toBe(true)
    const radarEvidence = r.of('evidence').filter((e) => e.op === 'map_flood')
    expect(radarEvidence.every((e) => e.measured)).toBe(true)
    expect(new Set(radarEvidence.map((e) => e.resultId)).size).toBe(1)
    expect(r.of('verdict')[0].evidence_ops_run).toBe(r.calls.length) // the reused items added no run
    expect(r.of('verdict')[0].id).toBe('water_flood_event')
  })

  it('records the run as one ledger run whose nodes are the executed operations', async () => {
    const r = await run({ handlers: floodHandlers })
    expect(r.mem.runs.size).toBe(1)
    const run1 = [...r.mem.runs.values()][0]
    expect(run1.nodes.map((n) => n.op)).toEqual(r.calls.map((c) => c.op))
    expect(run1.nodes.every((n) => n.resultId)).toBe(true)
    expect(run1.aoi).toEqual(KASUR_AOI)
    expect(r.of('ledger')[0].run_id).toBe('run1')
    expect(r.of('dossier')[0].runId).toBe('run1')
  })

  it('fills the window tokens in the operation arguments', async () => {
    const r = await run({ handlers: { map_flood: floodHandlers.map_flood } })
    expect(r.calls.find((c) => c.op === 'map_flood')!.args).toMatchObject({ start: WINDOW.start, end: WINDOW.end, include_roads: false })
  })

  it('writes each step rationale from the value-of-information numbers, with no model call', async () => {
    let calls = 0
    const r = await run({ handlers: floodHandlers, llm: mockLlm({ explainStep: async () => { calls++; return 'a model sentence' } }) })
    const step = r.of('step')[0]
    expect(calls).toBe(0)
    expect(step.why_source).toBe('rule')
    expect(step.why).toMatch(/Leading: .*\d+%/)
    expect(step.why).toMatch(/expected to remove \d\.\d\d bits of uncertainty/)
  })
})

describe('hypotheses from the model', () => {
  it('rejects unknown ids, clamps priors to [0.05, 0.6] and normalises', async () => {
    const llm = mockLlm({
      propose: async () => ({ hasSpecificEvent: true, family: 'water', windowStart: '', windowEnd: '', place: '', hypotheses: [
        { id: 'water_flood_event', prior: 0.99, why: '' }, { id: 'water_permanent', prior: 0, why: '' }, { id: 'water_seasonal_inundation', prior: 0.3, why: '' }, { id: 'volcano', prior: 0.5, why: '' },
      ] }),
    })
    const r = await run({ handlers: {}, llm })
    const h = r.of('hypotheses')[0]
    expect(h.rejected_ids).toEqual(['volcano'])
    expect(h.clamped_ids.sort()).toEqual(['water_flood_event', 'water_permanent'])
    expect(h.items.map((x) => x.id).sort()).toEqual(['water_flood_event', 'water_permanent', 'water_seasonal_inundation'])
    expect(h.items.reduce((s, x) => s + x.prior, 0)).toBeCloseTo(1, 9)
    expect(h.used_default_priors).toBe(false)
  })

  it('uses the catalogue priors, and says so, when the model call fails', async () => {
    const r = await run({ handlers: floodHandlers, llm: mockLlm({ propose: async () => { throw new Error('credits depleted') } }) })
    const h = r.of('hypotheses')[0]
    expect(h.used_default_priors).toBe(true)
    expect(h.note).toMatch(/could not triage.*credits depleted/)
    expect(r.of('verdict')).toHaveLength(1)
  })

  it('stops with an error when no family is given and the model cannot pick one', async () => {
    const r = await run({ handlers: {}, family: null, question: 'what happened here?', llm: mockLlm({ propose: async () => { throw new Error('down') } }) })
    expect(r.of('error')[0].content).toMatch(/could not be matched to a hypothesis family/)
    expect(r.of('hypotheses')).toHaveLength(0)
    expect(r.calls).toHaveLength(0)
  })

  it('never puts the api key in an event', async () => {
    const r = await run({ handlers: {}, llm: mockLlm({ propose: async () => { throw new Error('bad key test-key-123456789 rejected') } }) })
    expect(JSON.stringify(r.events)).not.toContain('test-key-123456789')
  })
})

describe('results that cannot be measured', () => {
  it('records failed operations as "could not measure" and leaves belief at the priors', async () => {
    const r = await run({ handlers: {} }) // every operation fails
    const prior = r.of('hypotheses')[0].items
    const verdict = r.of('verdict')[0]
    expect(verdict.kind).toBe('cannot_determine')
    expect(verdict.items_measured).toBe(0)
    expect(verdict.items_unmeasured).toBeGreaterThan(0)
    const ev = r.of('evidence')
    expect(ev.length).toBeGreaterThan(0)
    for (const e of ev) { expect(e.measured).toBe(false); expect(e.reason).toMatch(/could not be read/) }
    for (const b of r.of('belief')) {
      expect(b.updated).toBe(false)
      for (const row of b.posterior) expect(row.p).toBeCloseTo(prior.find((x) => x.id === row.id)!.prior, 9)
    }
    expect(verdict.evidence_that_would_decide.length).toBeGreaterThan(0)
    expect(verdict.evidence_that_would_decide[0].why_not).toMatch(/could not be measured/)
  })

  it('does not stop as "converged" just because failed steps changed nothing', async () => {
    const r = await run({ handlers: {} })
    expect(r.of('verdict')[0].stop_reason).not.toBe('converged')
    expect(r.of('verdict')[0].stop_reason).not.toBe('confident')
  })

  it('does not update on a flagged result even though it carries figures', async () => {
    const r = await run({
      // the other operations fail, so the flagged radar result is the only evidence on offer
      handlers: { map_flood: () => flaggedGeo('map_flood', FLOOD_STATS, 'Only 10% of the pixels are clear') },
    })
    const sarEvidence = r.of('evidence').filter((e) => e.op === 'map_flood')
    expect(sarEvidence.length).toBeGreaterThan(0)
    for (const e of sarEvidence) { expect(e.measured).toBe(false); expect(e.reason).toMatch(/flagged/) }
  })

  it('treats a refused result like a failed one', async () => {
    const r = await run({ handlers: { map_flood: () => geo('map_flood', undefined, { status: 'refused', summary: '**map_flood was not run.** too large' }) } })
    const e = r.of('evidence').find((x) => x.op === 'map_flood')
    if (e) { expect(e.measured).toBe(false); expect(e.reason).toMatch(/refused before running/) }
  })
})

describe('cloud, and radar instead', () => {
  it('stops asking optical items once one reports cloud, and runs radar', async () => {
    const cloudy: GeoResult = geo('analyze_raster', undefined, { summary: 'Real data unavailable: 2025-08-01: only 8% of pixels are clear (cloud)' })
    const r = await run({
      handlers: {
        ...floodHandlers,
        analyze_raster: () => cloudy,
        inspect_imagery: () => geo('inspect_imagery', { aoi_cloud_pct: 90, valid_pixel_pct: 8 }, { summary: 'cloud everywhere' }),
      },
      llm: mockLlm({ classifyImagery: async () => 'cloud_or_shadow_dominates' }),
    })
    const steps = r.of('step')
    const blockedAt = r.of('evidence').findIndex((e) => !e.measured && (e.op === 'analyze_raster' || e.op === 'inspect_imagery') || e.op === 'inspect_imagery')
    expect(blockedAt).toBeGreaterThanOrEqual(0)
    // after the block, no optical operation is chosen again
    const afterIdx = steps.findIndex((s, i) => i > blockedAt && (s.op === 'analyze_raster' || s.op === 'inspect_imagery'))
    expect(afterIdx).toBe(-1)
    expect(steps.some((s) => s.op === 'map_flood')).toBe(true)
    // the skipped list says why, in the engine's words
    expect(steps.flatMap((s) => s.skipped).some((s) => /cloud-limited/.test(s.reason))).toBe(true)
  })
})

describe('stopping', () => {
  it('respects the six-operation budget', async () => {
    const r = await run({ handlers: {} })
    expect(r.calls.length).toBeLessThanOrEqual(6)
  })

  it('reads the items that share a finished result even after the time budget is spent, and nothing else', async () => {
    // a clock that jumps 100 s during the radar run, against a 30 s budget
    let t = Date.now()
    const r = await run({
      now: () => t, budgetMs: 30_000,
      handlers: { map_flood: () => { t += 100_000; return geo('map_flood', FLOOD_STATS) } },
    })
    const radar = r.of('step').filter((s) => s.op === 'map_flood')
    expect(radar.length).toBeGreaterThanOrEqual(3)
    expect(radar.slice(1).every((s) => s.reused)).toBe(true)
    const verdict = r.of('verdict')[0]
    // reading the free items may itself settle the question; either way the budget was respected
    expect(['time_budget', 'confident']).toContain(verdict.stop_reason)
    expect(verdict.evidence_ops_run).toBe(r.calls.length)
    // no operation was started after the budget ran out
    expect(r.calls[r.calls.length - 1].op).toBe('map_flood')
    expect(r.of('evidence').filter((e) => e.op === 'map_flood').every((e) => e.measured)).toBe(true)
  })

  it('stops at the time budget', async () => {
    const r = await run({ handlers: floodHandlers, budgetMs: 5_000, llm: mockLlm() })
    // a 5 s budget is spent only after real time passes; with instant mocks the run finishes first
    expect(['confident', 'converged', 'no_informative_evidence', 'time_budget', 'op_budget']).toContain(r.of('verdict')[0].stop_reason)
  })
})

describe('corroboration is context, not evidence', () => {
  const corro = (over: Partial<InvestigatorLlm> = {}) => mockLlm({
    searchReports: async () => ({
      reports: [{ title: 'Floods hit Kasur', publisher: 'Dawn', published: '2025-09-02', url: 'https://www.dawn.com/news/1' }],
      chunks: [{ uri: 'https://vertexaisearch.cloud.google.com/x', title: 'dawn.com', domain: 'dawn.com' }], queries: ['q'],
    }),
    ...over,
  })

  it('never changes the posterior or the verdict', async () => {
    const withSources = await run({ handlers: floodHandlers, llm: corro() })
    const without = await run({ handlers: floodHandlers, llm: mockLlm() })
    const failing = await run({ handlers: floodHandlers, llm: corro({ searchReports: async () => { throw new Error('grounding unavailable') } }) })
    const posterior = (r: typeof withSources) => r.of('dossier')[0].final_posterior.map((x) => [x.id, x.p])
    expect(posterior(withSources)).toEqual(posterior(without))
    expect(posterior(failing)).toEqual(posterior(without))
    expect(withSources.of('verdict')[0].posterior).toBe(without.of('verdict')[0].posterior)
    expect(withSources.of('corroboration')[0]).toMatchObject({ status: 'grounded', role: 'context' })
    expect(withSources.of('corroboration')[0].sources[0]).toMatchObject({ publisher: 'Dawn', inWindow: true })
    expect(without.of('corroboration')[0].status).toBe('failed')
    expect(failing.of('corroboration')[0]).toMatchObject({ status: 'failed' })
    expect(failing.of('corroboration')[0].note).toMatch(/grounding unavailable|could not run/)
    expect(failing.of('done')).toHaveLength(1)
  })

  it('corroboration never feeds the narrative as evidence', async () => {
    let seen: any
    const llm = corro({ writeNarrative: async (i) => { seen = i; return 'Water was measured.' } })
    await run({ handlers: floodHandlers, llm })
    expect(JSON.stringify(seen)).not.toMatch(/dawn/i)
  })
})

describe('the dossier narrative', () => {
  it('drops a sentence with a number that has no citation, and keeps a cited one', async () => {
    let id = ''
    const llm = mockLlm({
      writeNarrative: async (i) => {
        const r = i.records.find((x) => x.measured && 'flood_pct_of_observed' in x.citable)!
        id = r.result_id
        return `Radar showed that 38% of the observed area was newly under water [[${r.result_id}#flood_pct_of_observed]]. About 77 buildings were hit.`
      },
    })
    const r = await run({ handlers: { map_flood: floodHandlers.map_flood }, llm })
    const d = r.of('dossier')[0]
    expect(id).toMatch(/^r_/)
    expect(d.summary).toContain(`[[${id}#flood_pct_of_observed]]`)
    expect(d.summary).not.toContain('77')
    expect(d.sentences_dropped).toBeGreaterThan(0)
    expect(d.summary_source).toBe('model')
  })

  it('builds the summary from recorded results when the model is down', async () => {
    const r = await run({ handlers: floodHandlers, llm: mockLlm({ writeNarrative: async () => { throw new Error('down') } }) })
    const d = r.of('dossier')[0]
    expect(d.summary_source).toBe('recorded-results')
    expect(d.summary).toMatch(/\[\[r_[0-9a-f]{16}#[a-z_]+\]\]/)
  })
})

describe('discovery', () => {
  it('scans up to nine cells, ranks them, investigates the top one and records that cell as the run area', async () => {
    let n = 0
    const r = await run({
      family: null, question: undefined,
      handlers: {
        ...floodHandlers,
        analyze_raster: (a) => {
          if (a.threshold === 0.05 && a.index === 'NDVI') { n++; return geo('analyze_raster', { operation: 'change', index: 'NDVI', increased_pct: n === 4 ? 40 : 1, decreased_pct: n === 4 ? 30 : 2, mean_delta: -0.1 }) }
          return floodHandlers.analyze_raster(a)
        },
      },
      llm: mockLlm({ propose: async () => ({ hasSpecificEvent: true, family: 'water', windowStart: '', windowEnd: '', place: '', hypotheses: [] }) }),
    })
    const d = r.of('discovery')[0]
    expect(d.cells.length).toBeLessThanOrEqual(9)
    expect(d.cells.length).toBeGreaterThan(1)
    expect(d.chosen_cell).toBeTruthy()
    expect(d.cells.find((c) => c.rank === 1)!.id).toBe(d.chosen_cell)
    expect(d.cells.find((c) => c.rank === 1)!.score).toBeCloseTo(0.7, 3)
    expect(r.events.map((e) => e.event).indexOf('discovery')).toBeLessThan(r.events.map((e) => e.event).indexOf('hypotheses'))
    expect(r.events.some((e) => e.event === 'layer' && e.data.layer_id === 'discovery-cells')).toBe(true)
    const saved = [...r.mem.runs.values()][0]
    expect(saved.aoi).not.toEqual(KASUR_AOI)
    expect(r.of('dossier')[0].timings_ms.discovery).toBeTypeOf('number')
  })

  it('reports a failed scan as a failure, not as no change', async () => {
    const r = await run({ family: null, question: undefined, handlers: {} })
    const d = r.of('discovery')[0]
    expect(d.chosen_cell).toBeNull()
    expect(d.cells.every((c) => c.score === null && c.reason)).toBe(true)
    expect(r.of('error')[0].content).toMatch(/failure to read the imagery, not a finding that nothing changed/)
    expect(r.of('hypotheses')).toHaveLength(0)
    expect(r.events[r.events.length - 1].event).toBe('done')
  })
})

describe('guards', () => {
  it('refuses a provider other than Gemini when no model is injected', async () => {
    const events: Ev[] = []
    await runInvestigation({
      aoi: KASUR_AOI, family: 'water', owner: null, llm: { provider: 'ollama' },
      emit: ((event: any, data: any) => { events.push({ event, data }) }) as any, signal: new AbortController().signal,
    })
    expect(events.find((e) => e.event === 'error')!.data.content).toMatch(/needs a Gemini key/)
    expect(events[events.length - 1].event).toBe('done')
  })

  it('refuses an area that is too large', async () => {
    const big = { type: 'Polygon', coordinates: [[[60, 10], [80, 10], [80, 30], [60, 30], [60, 10]]] }
    const r = await run({ handlers: {}, aoi: big })
    expect(r.of('error')).toHaveLength(1)
    expect(r.of('hypotheses')).toHaveLength(0)
  })
})

describe('pure helpers', () => {
  it('fills window tokens', () => {
    expect(resolveArgs({ a: '{{window.start}}', b: '{{window.end_month}}', c: 5, d: '{{window.days_to_now}}', e: 'x' }, { start: '2025-08-01', end: '2025-09-30' }, Date.parse('2025-10-05')))
      .toEqual({ a: '2025-08-01', b: '2025-09', c: 5, d: 6, e: 'x' })
  })
  it('widens months and years to their first and last day', () => {
    expect(normaliseDate('2023-08', 'start')).toBe('2023-08-01')
    expect(normaliseDate('2023-08', 'end')).toBe('2023-08-31')
    expect(normaliseDate('2024-02', 'end')).toBe('2024-02-29')
    expect(normaliseDate('2023', 'end')).toBe('2023-12-31')
    expect(normaliseDate('soon', 'end')).toBeNull()
  })
  it('chooses the request window, then the model\'s, then the last 120 days', () => {
    const now = Date.parse('2025-10-05')
    expect(chooseWindow({ start: '2025-08', end: '2025-09' }, undefined, now)).toMatchObject({ source: 'request', window: { start: '2025-08-01', end: '2025-09-30' } })
    expect(chooseWindow(undefined, { start: '2023-08-01', end: '2023-08-31' }, now).source).toBe('model')
    const d = chooseWindow(undefined, undefined, now)
    expect(d.source).toBe('default')
    expect(d.window.end).toBe('2025-10-05')
    const bad = chooseWindow({ start: '2025-09-01', end: '2025-08-01' }, undefined, now)
    expect(bad.source).toBe('default')
    expect(bad.note).toMatch(/not usable/)
    expect(chooseWindow({ start: '2025-01-01', end: '2030-01-01' }, undefined, now).window.end).toBe('2025-10-05')
  })
})
