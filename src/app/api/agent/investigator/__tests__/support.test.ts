import { describe, expect, it } from 'vitest'

import { classifyReports, corroborate, daysFromWindow, isoDate } from '../corroborate'
import { MAX_CELLS, rank, scanCells, scoreOf, splitCells } from '../discovery'
import { GeminiInvestigatorLlm, reportSearchQuery } from '../llm'
import { checkNarrative, citableIndex, templateNarrative } from '../narrative'
import { KASUR_AOI, WINDOW, failedGeo, geo, mockLlm } from './fixtures'

describe('corroboration', () => {
  const chunks = [{ uri: 'https://vertexaisearch.cloud.google.com/a', title: 'dawn.com', domain: 'dawn.com' }]
  const report = (over = {}) => ({ title: 'Floods hit Kasur', publisher: 'Dawn', published: '2025-09-02', url: 'https://www.dawn.com/news/1', ...over })

  it('measures a publication date against the window', () => {
    expect(daysFromWindow('2025-09-02', WINDOW)).toBe(0)
    expect(daysFromWindow('2025-07-30', WINDOW)).toBe(2)
    expect(daysFromWindow('2025-10-10', WINDOW)).toBe(10)
    expect(daysFromWindow('', WINDOW)).toBeNull()
    expect(daysFromWindow('last week', WINDOW)).toBeNull()
  })

  it('reads written dates and accepts a report whose link is the search result itself', () => {
    expect(isoDate('August 24, 2025')).toBe('2025-08-24')
    expect(isoDate('2025-09-02')).toBe('2025-09-02')
    expect(isoDate('last week')).toBeNull()
    const out = classifyReports({ reports: [report({ url: 'https://vertexaisearch.cloud.google.com/a', published: 'August 24, 2025' })], chunks, queries: [] }, WINDOW)
    expect(out.sources[0]).toMatchObject({ date: '2025-08-24', inWindow: true })
  })

  it('keeps a report only when the search returned a page from the same site', () => {
    const out = classifyReports({
      reports: [report(), report({ url: 'https://madeup.example/x', title: 'Invented' })],
      chunks, queries: [],
    }, WINDOW)
    expect(out.sources).toHaveLength(1)
    expect(out.sources[0]).toMatchObject({ publisher: 'Dawn', inWindow: true, days_from_window: 0 })
    expect(out.droppedUngrounded).toBe(1)
  })

  it('marks a report outside the window, and one with no date', () => {
    const out = classifyReports({ reports: [report({ published: '2025-12-01', title: 'Later' }), report({ published: '', title: 'Undated' })], chunks, queries: [] }, WINDOW)
    expect(out.sources[0]).toMatchObject({ inWindow: false, days_from_window: 62 })
    expect(out.sources[1]).toMatchObject({ date: '', inWindow: false, days_from_window: null })
  })

  it('deduplicates by site and title', () => {
    expect(classifyReports({ reports: [report(), report()], chunks, queries: [] }, WINDOW).sources).toHaveLength(1)
  })

  const input = { subject: 'Flood event', place: 'Kasur', bbox: [74.4, 30.95, 74.56, 31.08] as [number, number, number, number], window: WINDOW }

  it('says "grounded" with sources, labelled as context', async () => {
    const out = await corroborate(mockLlm({ searchReports: async () => ({ reports: [report()], chunks, queries: ['q'] }) }), input)
    expect(out).toMatchObject({ status: 'grounded', role: 'context' })
    expect(out.note).toMatch(/Context only/)
  })

  it('says so honestly when grounding fails', async () => {
    const thrown = await corroborate(mockLlm({ searchReports: async () => { throw new Error('tool not supported') } }), input)
    expect(thrown.status).toBe('failed')
    expect(thrown.sources).toEqual([])
    expect(thrown.note).toMatch(/could not run.*tool not supported/)
    const ungrounded = await corroborate(mockLlm({ searchReports: async () => ({ reports: [report()], chunks: [], queries: [] }) }), input)
    expect(ungrounded.status).toBe('failed')
    expect(ungrounded.note).toMatch(/failure to ground, not evidence that nothing was reported/)
  })

  it('says "no_sources" when the search ran and nothing matched, without treating it as evidence', async () => {
    const out = await corroborate(mockLlm({ searchReports: async () => ({ reports: [], chunks, queries: ['q'] }) }), input)
    expect(out.status).toBe('no_sources')
    expect(out.note).toMatch(/not evidence against/)
  })
})

describe('narrative check', () => {
  const index = citableIndex([{ result_id: 'r_00000000000000aa', item: 'x', op: 'map_flood', status: 'ok', measured: true, citable: { flood_pct_of_observed: 12.34, mean_delta: -0.31, orbit_match: 'orbit' } }])
  const id = 'r_00000000000000aa'

  it('keeps a numeric sentence whose numbers are the cited values (rounded, or as a fraction)', () => {
    const t = `About 12.3% was newly flooded [[${id}#flood_pct_of_observed]]. NDVI fell by 0.31 [[${id}#mean_delta]]. The fraction was 0.12 [[${id}#flood_pct_of_observed]].`
    const c = checkNarrative(t, index)
    expect(c.ok).toBe(true)
    expect(c.cleaned).toBe(t)
  })

  it('removes a sentence with a number and no citation', () => {
    const c = checkNarrative(`It was bad. Some 40 buildings were hit. ok`, index)
    expect(c.ok).toBe(false)
    expect(c.offending).toEqual(['Some 40 buildings were hit.'])
    expect(c.cleaned).not.toMatch(/40/)
    expect(c.cleaned).toMatch(/It was bad/)
  })

  it('removes a sentence whose number is not the cited value', () => {
    const c = checkNarrative(`About 55% was flooded [[${id}#flood_pct_of_observed]].`, index)
    expect(c.ok).toBe(false)
  })

  it('removes a citation of a result or field that was not recorded', () => {
    expect(checkNarrative(`Water was seen [[r_ffffffffffffffff#flood_pct_of_observed]].`, index).ok).toBe(false)
    expect(checkNarrative(`Water was seen [[${id}#made_up_field]].`, index).ok).toBe(false)
    expect(checkNarrative(`Water was seen [[not a citation]].`, index).ok).toBe(false)
  })

  it('lets dates and years through as non-measurements, and accepts a citation without numbers', () => {
    expect(checkNarrative(`The pass on 2025-09-02 was radar from 2025 [[${id}#orbit_match]].`, index).ok).toBe(true)
  })

  it('builds a template from the records alone', () => {
    const t = templateNarrative('Cannot determine.', [
      { result_id: id, item: 'Radar', op: 'map_flood', status: 'ok', measured: true, reading: `Radar: fraction was 0.1234 [[${id}#flood_pct_of_observed]].`, citable: {} },
      { result_id: 'r_00000000000000bb', item: 'Optical change', op: 'analyze_raster', status: 'failed', measured: false, reason: 'could not be read', citable: {} },
    ], ['A limit.'])
    expect(t).toContain('**Cannot determine.**')
    expect(t).toContain(`[[${id}#flood_pct_of_observed]]`)
    expect(t).toContain('Optical change could not be measured: could not be read.')
  })
})

describe('discovery', () => {
  it('splits an area into at most nine cells that lie inside it', () => {
    const cells = splitCells(KASUR_AOI)
    expect(cells.length).toBe(MAX_CELLS)
    expect(new Set(cells.map((c) => c.id)).size).toBe(cells.length)
    for (const c of cells) {
      expect(c.areaKm2).toBeGreaterThan(0)
      expect(c.bbox[0]).toBeGreaterThanOrEqual(74.4 - 1e-9)
      expect(c.bbox[2]).toBeLessThanOrEqual(74.56 + 1e-9)
    }
  })

  it('uses fewer cells for a small area', () => {
    const tiny = { type: 'Polygon' as const, coordinates: [[[74.4, 30.95], [74.41, 30.95], [74.41, 30.96], [74.4, 30.96], [74.4, 30.95]]] }
    const cells = splitCells(tiny)
    expect(cells.length).toBeGreaterThanOrEqual(1)
    expect(cells.length).toBeLessThan(9)
  })

  it('clips cells to a non-rectangular area and drops cells outside it', () => {
    const tri = { type: 'Polygon' as const, coordinates: [[[74.4, 30.95], [74.56, 30.95], [74.4, 31.08], [74.4, 30.95]]] }
    const cells = splitCells(tri)
    expect(cells.length).toBeLessThan(9)
    expect(cells.length).toBeGreaterThan(3)
  })

  it('scores a cell by the share of pixels that changed, and gives an unreadable cell no score', () => {
    expect(scoreOf(geo('analyze_raster', { increased_pct: 10, decreased_pct: 25, mean_delta: -0.1 }))).toEqual({ score: 0.35, meanDelta: -0.1 })
    const failed = scoreOf(failedGeo('analyze_raster'))
    expect(failed.score).toBeNull()
    expect(failed.reason).toMatch(/failed/)
    expect(scoreOf(geo('analyze_raster', undefined, { summary: 'Real data unavailable: cloud' })).score).toBeNull()
  })

  it('ranks scored cells best first and leaves unscored cells unranked', async () => {
    const cells = splitCells(KASUR_AOI).slice(0, 4)
    const scores = [0.1, 0.5, null, 0.3]
    const scored = await scanCells(cells, async (c) => {
      const s = scores[cells.indexOf(c)]
      return s === null ? failedGeo('analyze_raster') : geo('analyze_raster', { increased_pct: s * 100, decreased_pct: 0 })
    })
    const ranked = rank(scored)
    expect(ranked.map((c) => c.rank)).toEqual([3, 1, null, 2])
    expect(ranked[2].reason).toBeTruthy()
    expect(ranked[2].score).toBeNull()
  })

  it('records a thrown scan as a failure with its reason', async () => {
    const cells = splitCells(KASUR_AOI).slice(0, 2)
    const scored = await scanCells(cells, async () => { throw new Error('network') })
    expect(scored.every((c) => c.score === null && /scan failed: network/.test(c.reason!))).toBe(true)
  })
})

describe('Gemini transport', () => {
  const fake = (responses: Array<() => any>) => {
    const calls: any[] = []
    let i = 0
    return {
      calls,
      client: { models: { generateContent: async (p: any) => { calls.push(p); return responses[Math.min(i++, responses.length - 1)]() } } },
    }
  }
  const ok = (text: string, grounding?: any) => () => ({ text, candidates: [{ groundingMetadata: grounding }] })
  const apiErr = (status: number, message = 'x') => () => { throw Object.assign(new Error(message), { status }) }

  it('asks for structured JSON with a response schema and parses it', async () => {
    const f = fake([ok(JSON.stringify({ has_specific_event: true, family: 'fire', window_start: '2023-08-01', window_end: '2023-08-31', place: 'Lahaina', hypotheses: [{ id: 'fire_wildfire', prior: 0.5, why: 'a' }] }))])
    const llm = new GeminiInvestigatorLlm({ client: f.client, model: 'gemini-3.8-flash', apiKey: 'k' })
    const p = await llm.propose({ question: 'q', bbox: [0, 0, 1, 1], areaKm2: 5, today: '2026-10-13' })
    expect(p).toMatchObject({ family: 'fire', place: 'Lahaina', hasSpecificEvent: true })
    const cfg = f.calls[0].config
    expect(cfg.responseMimeType).toBe('application/json')
    expect(cfg.responseJsonSchema.properties.hypotheses.type).toBe('array')
    expect(JSON.stringify(cfg.responseJsonSchema)).not.toMatch(/additionalProperties|\$schema/)
    expect(f.calls[0].model).toBe('gemini-3.8-flash')
  })

  it('uses the per-phase thinking level: triage is the plan phase, the rest is synthesis, env overrides', async () => {
    const prior = { a: process.env.GEOAGENT_GEMINI_THINKING_PLAN, b: process.env.GEOAGENT_GEMINI_THINKING_SYNTHESIS, c: process.env.GEOAGENT_GEMINI_THINKING }
    try {
      delete process.env.GEOAGENT_GEMINI_THINKING; delete process.env.GEOAGENT_GEMINI_THINKING_SYNTHESIS
      process.env.GEOAGENT_GEMINI_THINKING_PLAN = 'high'
      const f = fake([ok(JSON.stringify({ has_specific_event: false, family: 'fire', window_start: '', window_end: '', place: '', hypotheses: [] })), ok('A sentence.')])
      const llm = new GeminiInvestigatorLlm({ client: f.client, model: 'gemini-3.8-flash' })
      await llm.propose({ bbox: [0, 0, 1, 1], areaKm2: 1, today: '2026-10-13' })
      await llm.explainStep({ family: { id: 'water' } as any, item: { title: 't', decides: 'd' } as any, leading: [], voiBits: 0.1, alternatives: [], skipped: [] })
      expect(f.calls[0].config.thinkingConfig.thinkingLevel).toBe('HIGH')
      expect(f.calls[1].config.thinkingConfig.thinkingLevel).toBe('LOW')
    } finally {
      for (const [k, v] of [['GEOAGENT_GEMINI_THINKING_PLAN', prior.a], ['GEOAGENT_GEMINI_THINKING_SYNTHESIS', prior.b], ['GEOAGENT_GEMINI_THINKING', prior.c]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v
      }
    }
  })

  it('rejects JSON that does not match the schema', async () => {
    const llm = new GeminiInvestigatorLlm({ client: fake([ok('{"family":1}')]).client, model: 'gemini-3.8-flash' })
    await expect(llm.propose({ bbox: [0, 0, 1, 1], areaKm2: 1, today: '2026-10-13' })).rejects.toThrow(/did not match the schema/)
    const llm2 = new GeminiInvestigatorLlm({ client: fake([ok('not json')]).client, model: 'gemini-3.8-flash' })
    await expect(llm2.propose({ bbox: [0, 0, 1, 1], areaKm2: 1, today: '2026-10-13' })).rejects.toThrow(/did not return JSON/)
  })

  it('retries a transient error, then falls to the next model, and does not retry a billing error', async () => {
    const retry = fake([apiErr(503), ok('A sentence.')])
    const llm = new GeminiInvestigatorLlm({ client: retry.client, model: 'gemini-3.8-flash', sleep: async () => {} })
    expect(await llm.explainStep({ family: { id: 'water' } as any, item: { title: 't', decides: 'd' } as any, leading: [], voiBits: 0.1, alternatives: [], skipped: [] })).toBe('A sentence.')
    expect(retry.calls).toHaveLength(2)

    const chain = fake([apiErr(503), apiErr(503), ok('From the fallback.')])
    const llm2 = new GeminiInvestigatorLlm({ client: chain.client, model: 'gemini-3.8-flash', sleep: async () => {} })
    await llm2.explainStep({ family: { id: 'water' } as any, item: { title: 't', decides: 'd' } as any, leading: [], voiBits: 0.1, alternatives: [], skipped: [] })
    expect(chain.calls.map((c) => c.model)[2]).not.toBe('gemini-3.8-flash')

    const billing = fake([apiErr(402, 'Your prepayment credits are depleted for key SECRET-KEY-1234567890')])
    const llm3 = new GeminiInvestigatorLlm({ client: billing.client, model: 'gemini-3.8-flash', apiKey: 'SECRET-KEY-1234567890', sleep: async () => {} })
    const err = await llm3.explainStep({ family: { id: 'water' } as any, item: { title: 't', decides: 'd' } as any, leading: [], voiBits: 0.1, alternatives: [], skipped: [] }).catch((e) => e)
    expect(billing.calls).toHaveLength(1)
    expect(String(err.message)).toMatch(/credits are depleted/)
    expect(String(err.message)).not.toContain('SECRET-KEY-1234567890')
  })

  it('searches with the googleSearch tool and returns the pages the search found', async () => {
    const grounding = { groundingChunks: [{ web: { uri: 'https://vertexaisearch.cloud.google.com/a', title: 'dawn.com' } }], webSearchQueries: ['kasur flood'] }
    const f = fake([ok('REPORT | T | Dawn | 2025-09-02 | https://dawn.com/x', grounding)])
    const llm = new GeminiInvestigatorLlm({ client: f.client, model: 'gemini-3.8-flash' })
    const out = await llm.searchReports({ subject: 's', place: 'p', bbox: [0, 0, 1, 1], window: WINDOW })
    expect(f.calls[0].config.tools).toEqual([{ googleSearch: {} }])
    expect(out.chunks).toEqual([{ uri: 'https://vertexaisearch.cloud.google.com/a', title: 'dawn.com', domain: 'dawn.com' }])
    expect(out.queries).toEqual(['kasur flood'])
    expect(out.reports).toHaveLength(1)
  })

  it('asks the search tool a short query (event, place, month), not a catalogue definition, and says it must search', async () => {
    const f = fake([ok('', { groundingChunks: [], webSearchQueries: [] })])
    const llm = new GeminiInvestigatorLlm({ client: f.client, model: 'gemini-3.8-flash' })
    await llm.searchReports({ subject: 'Wildfire or burn scar', place: 'Lahaina', bbox: [-156.69, 20.86, -156.66, 20.89], window: { start: '2023-08-01', end: '2023-08-31' } })
    expect(reportSearchQuery({ subject: 'Wildfire or burn scar', place: 'Lahaina', bbox: [0, 0, 1, 1], window: { start: '2023-08-01', end: '2023-08-31' } })).toBe('Wildfire or burn scar Lahaina August 2023')
    expect(reportSearchQuery({ subject: 'Flood', place: '', bbox: [74.4, 30.95, 74.56, 31.08], window: { start: '2025-08-01', end: '2025-09-30' } })).toBe('Flood 31.02, 74.48 August 2025 to September 2025')
    const text = f.calls[0].contents[0].parts[0].text as string
    expect(text).toContain('Use Google Search now, with the query: Wildfire or burn scar Lahaina August 2023')
    expect(text).toContain('do not answer from memory')
    expect(f.calls[0].config.maxOutputTokens).toBeLessThanOrEqual(1500)
  })

  it('classifies a picture into one of the catalogue categories only', async () => {
    const f = fake([ok(JSON.stringify({ category: 'no_visible_water', basis: 'dry fields' }))])
    const llm = new GeminiInvestigatorLlm({ client: f.client, model: 'gemini-3.8-flash' })
    const item: any = { title: 'v', args: { question: 'q' }, scale: { kind: 'categories', categories: [{ value: 'no_visible_water', why: 'a' }, { value: 'floodwater_over_land', why: 'b' }] } }
    expect(await llm.classifyImagery({ item, description: 'dry', imageBase64: 'AAAA' })).toBe('no_visible_water')
    expect(f.calls[0].config.responseJsonSchema.properties.category.enum).toEqual(['no_visible_water', 'floodwater_over_land'])
    expect(f.calls[0].contents[0].parts[1].inlineData).toMatchObject({ mimeType: 'image/png', data: 'AAAA' })
  })
})
