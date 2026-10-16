/** The operation shortlist: it must keep every operation the planner evaluation expects, and be much smaller than the full set. */

import fs from 'node:fs'
import path from 'node:path'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { getToolDefinitions } from '../registry'
import { shortlistOperations } from '../shortlist'
import { addUsage, emptyUsage, tokenTotals } from '../../lib/token-usage'
import { buildPrompt } from '../../prompt'

beforeAll(() => {
  // composite is registered only while a geo service is configured, as in a full deployment
  vi.stubEnv('GEO_SERVICE_URL', 'http://127.0.0.1:1')
})

const cases = fs.readFileSync(path.resolve(__dirname, '../../../../../../eval/planner/cases.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

describe('shortlistOperations', () => {
  it('keeps every operation the planner evaluation expects for its question', () => {
    const missing: string[] = []
    for (const c of cases) {
      const names = shortlistOperations(c.query).names
      for (const op of c.expect.must_use ?? []) if (!names.includes(op)) missing.push(`${c.id}: ${op}`)
      const any: string[] = c.expect.must_use_any ?? []
      if (any.length && !any.some((o) => names.includes(o))) missing.push(`${c.id}: one of ${any.join('/')}`)
    }
    expect(missing).toEqual([])
  })

  it('offers far fewer declarations than the full set', () => {
    const full = JSON.stringify(getToolDefinitions()).length
    const sizes = cases.map((c) => {
      const names = shortlistOperations(c.query).names
      return JSON.stringify(getToolDefinitions().filter((t: any) => t.function.name === 'submit_plan' || names.includes(t.function.name))).length
    })
    const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length
    expect(mean).toBeLessThan(full * 0.4)
  })

  it('puts the obvious operation first and falls back to everything when nothing matches', () => {
    expect(shortlistOperations('Map the flood from last June').names[0]).toBe('map_flood')
    expect(shortlistOperations('Rainfall in July 2024?').names).toContain('fetch_weather_history')
    const all = shortlistOperations('zzz qqq')
    expect(all.names.length).toBeGreaterThan(20)
  })
})

describe('the prompt follows the shortlist and keeps a stable prefix', () => {
  const aoi = (x: number) => ({ type: 'Polygon', coordinates: [[[x, 1], [x + 0.1, 1], [x + 0.1, 1.1], [x, 1.1], [x, 1]]] })

  it('drops the rules and tool rows of operations that are not offered', () => {
    const full = buildPrompt(aoi(10), 'en')
    const flood = buildPrompt(aoi(10), 'en', undefined, undefined, undefined, ['map_flood'])
    expect(flood).toContain('### Rule 12')
    expect(flood).not.toContain('### Rule 15')
    expect(flood).not.toContain('| fetch_dem |')
    expect(flood.length).toBeLessThan(full.length * 0.7)
    // the rules everything depends on stay
    for (const r of ['Rule 1 ', 'Rule 2 ', 'Rule 3 ', 'Rule 5 ', 'Rule 21 ']) expect(flood).toContain(`### ${r}`)
  })

  it('puts everything that changes per request after everything that does not (implicit prefix caching)', () => {
    const a = buildPrompt(aoi(10), 'en', undefined, undefined, new Date('2026-10-15T00:00:00Z'), ['map_flood'])
    const b = buildPrompt(aoi(77), 'fr', undefined, undefined, new Date('2026-11-01T00:00:00Z'), ['map_flood'])
    const cut = (p: string) => p.slice(0, p.indexOf('## Request context'))
    expect(cut(a)).toBe(cut(b))
    expect(cut(a).length).toBeGreaterThan(3000)
    expect(a).toContain('## Request context')
  })

  it('tells the model to decline an off-topic question briefly and say what it can do', () => {
    const p = buildPrompt(aoi(10), 'en')
    expect(p).toMatch(/## Scope/)
    expect(p).toMatch(/unrelated question .* call no tool/)
  })
})

describe('token totals', () => {
  it('sum the phases and separate the cached prompt tokens from the billed ones', () => {
    const plan = emptyUsage()
    const synthesis = emptyUsage()
    addUsage(plan, { promptTokens: 3000, outputTokens: 200, thoughtTokens: 100, cachedTokens: 0 })
    addUsage(synthesis, { promptTokens: 4000, outputTokens: 600, thoughtTokens: 50, cachedTokens: 2500 })
    const t = tokenTotals({ plan, synthesis })
    expect(t.total).toMatchObject({ calls: 2, promptTokens: 7000, cachedTokens: 2500, billedInput: 4500, billedOutput: 950 })
  })
})
