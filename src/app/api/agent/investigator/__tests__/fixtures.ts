import { GEO_RESULT_SCHEMA, type GeoResult } from '@/lib/geo-result'

import type { InvestigatorLlm } from '../llm'

let n = 0

/** A well-formed GeoResult with a distinct result id. */
export function geo(op: string, stats: GeoResult['stats'] | undefined, over: Partial<GeoResult> = {}): GeoResult {
  n++
  return {
    schema: GEO_RESULT_SCHEMA,
    result_id: `r_${n.toString(16).padStart(16, '0')}`,
    op: { name: op, version: '1.0.0' },
    status: 'ok',
    summary: `${op} result`,
    layers: [],
    ...(stats ? { stats } : {}),
    provenance: { sources: ['test'], items: [], method: `${op}@1.0.0`, inputs_hash: 'h'.repeat(8) },
    validation: [],
    ...over,
  }
}

export const failedGeo = (op: string, summary = '**x failed:** boom. This is a failure, not an absence of data.') => geo(op, undefined, { status: 'failed', summary })
export const refusedGeo = (op: string, summary = 'x was not run.') => geo(op, undefined, { status: 'refused', summary })
export const flaggedGeo = (op: string, stats: GeoResult['stats'], message = 'Only 10% of pixels are clear') =>
  geo(op, stats, { status: 'flagged', validation: [{ id: 'valid_pixels', phase: 'dynamic', status: 'fail', message }] })

export const WINDOW = { start: '2025-08-01', end: '2025-09-30' }

/** An AOI of about 15 km by 14 km near Kasur. */
export const KASUR_AOI = {
  type: 'Polygon' as const,
  coordinates: [[[74.4, 30.95], [74.56, 30.95], [74.56, 31.08], [74.4, 31.08], [74.4, 30.95]]],
}

export function mockLlm(over: Partial<InvestigatorLlm> = {}): InvestigatorLlm & { calls: Record<string, number> } {
  const calls: Record<string, number> = {}
  const count = <T extends (...a: any[]) => any>(name: string, fn: T): T => ((...a: any[]) => { calls[name] = (calls[name] ?? 0) + 1; return fn(...a) }) as T
  return {
    calls,
    propose: count('propose', async () => ({ hasSpecificEvent: true, family: 'water' as const, windowStart: '', windowEnd: '', place: 'Kasur', hypotheses: [] })),
    explainStep: count('explainStep', async () => 'Because it is the most informative next measurement.'),
    classifyImagery: count('classifyImagery', async () => 'floodwater_over_land'),
    writeNarrative: count('writeNarrative', async () => 'The radar pass showed new water.'),
    searchReports: count('searchReports', async () => ({ reports: [], chunks: [], queries: [] })),
    ...over,
  } as any
}
