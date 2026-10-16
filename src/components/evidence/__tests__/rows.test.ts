import { describe, expect, it } from 'vitest'
import type { LedgerExport } from '@/app/api/agent/engine/ledger'
import type { CitableToolResult } from '@/lib/citations'
import type { ToolCallStatus } from '@/store/useStore'
import { buildEvidenceRows, dateInItem } from '../rows'

const ledger = {
  runId: 'run_1',
  createdAt: '2026-10-13T04:00:00.000Z',
  query: 'q',
  aoi: null,
  focus: null,
  nodes: [
    {
      idx: 0, op: 'fetch_ndvi', version: '1.0.0', args: {}, dependsOn: [], inputsHash: 'h', resultId: 'r_aaaaaaaaaaaaaaaa', status: 'ok', cached: false,
      startedAt: '2026-10-13T04:00:00.000Z', ms: 1200,
      provenance: { sources: ['Sentinel-2 L2A (Earth Search)'], items: ['S2B_MSIL2A_20260108T052229_N0510_R062_T43REQ', 'S2A_MSIL2A_20260123T052101_N0510_R062_T43REQ'], method: 'm', date: '2026-01-23' },
      computedAt: '2026-10-13T04:00:01.000Z',
      stats: { mean: 0.412, aoi_clear_pct: 94, scene_cloud_pct: 29.6, label: 'rice', series: [{ label: 'a', value: 1 }] },
    },
    {
      idx: 1, op: 'map_flood', version: '1.0.0', args: {}, dependsOn: [0], inputsHash: null, resultId: null, status: 'skipped', cached: false,
      startedAt: '2026-10-13T04:00:02.000Z', ms: 0, provenance: null, computedAt: null, stats: null,
    },
  ],
} as unknown as LedgerExport

const results: Record<string, CitableToolResult> = {
  r_aaaaaaaaaaaaaaaa: { tool: 'fetch_ndvi', resultId: 'r_aaaaaaaaaaaaaaaa', summaryData: { mean: 0.412 }, confidence: 'high' },
}

describe('dateInItem', () => {
  it('finds the acquisition date in scene ids and plain dates', () => {
    expect(dateInItem('S2B_MSIL2A_20260108T052229_N0510')).toBe('2026-01-08')
    expect(dateInItem('LC09_L2SP_150039_20250904_20250906_02_T1')).toBe('2025-09-04')
    expect(dateInItem('2026-01-08')).toBe('2026-01-08')
    expect(dateInItem('cop-dem-glo-30')).toBeNull()
    expect(dateInItem('r_5f0c2a91b7d3e480')).toBeNull()
  })
})

describe('buildEvidenceRows from the ledger', () => {
  const rows = buildEvidenceRows(ledger, results, [])
  it('lists every node, with its operation, source, items, dates and status', () => {
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      resultId: 'r_aaaaaaaaaaaaaaaa', n: 1, op: 'fetch_ndvi', version: '1.0.0', status: 'ok', confidence: 'high', fromLedger: true, ms: 1200,
      sources: ['Sentinel-2 L2A (Earth Search)'],
    })
    expect(rows[0].items).toHaveLength(2)
    expect(rows[0].dates).toEqual(['2026-01-08', '2026-01-23'])
  })
  it('reads clear and cloud percentages from the result figures, and keeps scalar figures only', () => {
    expect(rows[0].clearPct).toBe(94)
    expect(rows[0].cloudPct).toBe(29.6)
    expect(rows[0].figures.map((f) => f.key)).toEqual(['mean', 'aoi_clear_pct', 'scene_cloud_pct', 'label'])
  })
  it('keeps a skipped node as a row with no result id rather than dropping it', () => {
    expect(rows[1]).toMatchObject({ resultId: null, op: 'map_flood', status: 'skipped' })
  })
})

describe('buildEvidenceRows without a ledger', () => {
  const calls: ToolCallStatus[] = [
    { toolName: 'fetch_ndvi', label: 'NDVI', status: 'completed', resultId: 'r_aaaaaaaaaaaaaaaa', durationMs: 900 },
    { toolName: 'detect_water', label: 'Water', status: 'error', errorText: 'HTTP 503' },
  ]
  const rows = buildEvidenceRows(null, results, calls)
  it('rebuilds rows from the session and says they are not from the ledger', () => {
    expect(rows.map((r) => [r.op, r.status, r.fromLedger])).toEqual([['fetch_ndvi', 'ok', false], ['detect_water', 'failed', false]])
    expect(rows[1].note).toBe('HTTP 503')
  })
})
