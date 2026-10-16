/**
 * Unit tests for C3 — reproducible, citable exports.
 *
 * Covers: bbox derivation, model-backend extraction, the export serializer
 * (provenance verbatim, deterministic ordering, round-trip JSON), and diffReproRun
 * (unchanged / changed "source updated" / added / removed / missing step).
 */

import { describe, it, expect } from 'vitest'
import {
  buildReproducibleExport,
  diffReproRun,
  bboxFromGeometry,
  extractModelBackends,
  REPRO_SCHEMA,
  REPRO_SCHEMA_VERSION,
  type ReproExportInput,
} from '../reproducible-export'
import type { CitableToolResult } from '../citations'

const POLY: GeoJSON.Geometry = {
  type: 'Polygon',
  coordinates: [[[36.80, -1.30], [36.82, -1.30], [36.82, -1.28], [36.80, -1.28], [36.80, -1.30]]],
}

const NDVI_RESULT: CitableToolResult = {
  tool: 'fetch_ndvi',
  resultId: 'fetch_ndvi-0',
  summaryData: { mean: 0.42, vegetation_pct: 64 },
  provenance: { source: 'Sentinel-2 L2A (AWS Element84)', date: '2026-05-24', method: 'titiler polygon stats', clip: 'polygon' },
  confidence: 'high',
}

const POP_RESULT: CitableToolResult = {
  tool: 'estimate_population',
  resultId: 'estimate_population-1',
  summaryData: { population: 12400 },
  provenance: { source: 'WorldPop GHS-POP 2020', method: 'raster sum', clip: 'polygon' },
  confidence: 'medium',
}

const VEG_RESULT: CitableToolResult = {
  tool: 'classify_vegetation',
  resultId: 'classify_vegetation-2',
  summaryData: { functional_type: 'closed-canopy forest' },
  provenance: { source: 'ESA WorldCover 2021 + huggingface:ibm-nasa-geospatial/Prithvi-EO-2.0', method: 'classify', clip: 'bbox' },
  confidence: 'medium',
}

function baseInput(overrides: Partial<ReproExportInput> = {}): ReproExportInput {
  return {
    aoi: { type: 'Polygon', geometry: POLY },
    toolResults: { [NDVI_RESULT.resultId]: NDVI_RESULT, [POP_RESULT.resultId]: POP_RESULT },
    layers: [{ id: 'l1', name: 'NDVI', type: 'raster', tool: 'fetch_ndvi', resultId: 'fetch_ndvi-0', provenance: NDVI_RESULT.provenance, confidence: 'high' }],
    messages: [{ role: 'user', content: 'how green is this?' }, { role: 'assistant', content: 'Mean NDVI 0.42.' }],
    now: () => 1_780_000_000_000,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// bboxFromGeometry
// ---------------------------------------------------------------------------

describe('bboxFromGeometry', () => {
  it('derives bbox from a Polygon', () => {
    expect(bboxFromGeometry(POLY)).toEqual([36.80, -1.30, 36.82, -1.28])
  })
  it('derives bbox from a Point', () => {
    expect(bboxFromGeometry({ type: 'Point', coordinates: [10, 20] })).toEqual([10, 20, 10, 20])
  })
  it('derives bbox from a MultiPolygon', () => {
    const mp: GeoJSON.Geometry = {
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [1, 0], [1, 1], [0, 0]]],
        [[[5, 5], [6, 5], [6, 6], [5, 5]]],
      ],
    }
    expect(bboxFromGeometry(mp)).toEqual([0, 0, 6, 6])
  })
  it('handles a GeometryCollection', () => {
    const gc: GeoJSON.Geometry = {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [1, 1] },
        { type: 'Point', coordinates: [3, 4] },
      ],
    }
    expect(bboxFromGeometry(gc)).toEqual([1, 1, 3, 4])
  })
  it('returns null for null/empty', () => {
    expect(bboxFromGeometry(null)).toBeNull()
    expect(bboxFromGeometry(undefined)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// extractModelBackends
// ---------------------------------------------------------------------------

describe('extractModelBackends', () => {
  it('finds a huggingface backend embedded in provenance.source', () => {
    expect(extractModelBackends({ a: VEG_RESULT })).toEqual(['huggingface:ibm-nasa-geospatial/Prithvi-EO-2.0'])
  })
  it('returns empty when no inference backend is present', () => {
    expect(extractModelBackends({ a: NDVI_RESULT, b: POP_RESULT })).toEqual([])
  })
  it('dedupes + sorts multiple backends', () => {
    const r1 = { ...VEG_RESULT, resultId: 'x' }
    const r2 = { ...VEG_RESULT, resultId: 'y', provenance: { source: 'replicate:meta/sam-2 mask', method: 'm', clip: 'polygon' } }
    const r3 = { ...VEG_RESULT, resultId: 'z' } // duplicate HF
    expect(extractModelBackends({ x: r1, y: r2, z: r3 })).toEqual([
      'huggingface:ibm-nasa-geospatial/Prithvi-EO-2.0',
      'replicate:meta/sam-2',
    ])
  })
})

// ---------------------------------------------------------------------------
// buildReproducibleExport
// ---------------------------------------------------------------------------

describe('buildReproducibleExport', () => {
  it('produces a schema-versioned export with derived bbox + ISO timestamp', () => {
    const ex = buildReproducibleExport(baseInput())
    expect(ex.schema).toBe(REPRO_SCHEMA)
    expect(ex.schemaVersion).toBe(REPRO_SCHEMA_VERSION)
    expect(ex.exportedAt).toBe(new Date(1_780_000_000_000).toISOString())
    expect(ex.aoi?.bbox).toEqual([36.80, -1.30, 36.82, -1.28])
  })

  it('carries provenance + confidence + figures verbatim per step', () => {
    const ex = buildReproducibleExport(baseInput())
    const ndvi = ex.steps.find((s) => s.resultId === 'fetch_ndvi-0')!
    expect(ndvi.source).toBe('Sentinel-2 L2A (AWS Element84)')
    expect(ndvi.method).toBe('titiler polygon stats')
    expect(ndvi.clip).toBe('polygon')
    expect(ndvi.date).toBe('2026-05-24')
    expect(ndvi.confidence).toBe('high')
    expect(ndvi.figures).toEqual({ mean: 0.42, vegetation_pct: 64 })
  })

  it('orders steps deterministically by resultId', () => {
    const ex = buildReproducibleExport(baseInput())
    expect(ex.steps.map((s) => s.resultId)).toEqual(['estimate_population-1', 'fetch_ndvi-0'])
  })

  it('lists model backends from provenance', () => {
    const ex = buildReproducibleExport(baseInput({
      toolResults: { [VEG_RESULT.resultId]: VEG_RESULT },
    }))
    expect(ex.modelBackends).toEqual(['huggingface:ibm-nasa-geospatial/Prithvi-EO-2.0'])
  })

  it('marks steps rerunnable when the tool is known + includes reproduce instructions', () => {
    const ex = buildReproducibleExport(baseInput())
    expect(ex.reproduce.aoiGeoJson).toEqual(POLY)
    expect(ex.reproduce.steps.every((s) => s.rerunnable)).toBe(true)
    expect(ex.reproduce.instructions).toContain('source updated')
  })

  it('handles a null AOI honestly (no fabricated geometry)', () => {
    const ex = buildReproducibleExport(baseInput({ aoi: null }))
    expect(ex.aoi).toBeNull()
    expect(ex.reproduce.aoiGeoJson).toBeNull()
  })

  it('labels a missing provenance as null (never fabricates a source)', () => {
    const noProv: CitableToolResult = { tool: 'query_osm', resultId: 'query_osm-3', summaryData: { count: 5 } }
    const ex = buildReproducibleExport(baseInput({ toolResults: { [noProv.resultId]: noProv } }))
    const step = ex.steps[0]
    expect(step.source).toBeNull()
    expect(step.method).toBeNull()
    expect(step.clip).toBeNull()
  })

  it('round-trips to JSON deep-equal (deterministic export)', () => {
    const a = buildReproducibleExport(baseInput())
    const b = JSON.parse(JSON.stringify(a))
    expect(b).toEqual(a)
  })

  it('includes the transcript (content-only) and skips empty messages', () => {
    const ex = buildReproducibleExport(baseInput({
      messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: '' }],
    }))
    expect(ex.transcript).toEqual([{ role: 'user', content: 'q' }])
  })
})

// ---------------------------------------------------------------------------
// diffReproRun
// ---------------------------------------------------------------------------

describe('diffReproRun', () => {
  it('reports reproduced=true when figures match exactly', () => {
    const ex = buildReproducibleExport(baseInput())
    const rerun = {
      'fetch_ndvi-0': { mean: 0.42, vegetation_pct: 64 },
      'estimate_population-1': { population: 12400 },
    }
    const report = diffReproRun(ex, rerun)
    expect(report.reproduced).toBe(true)
    expect(report.diffs.every((d) => d.status === 'unchanged')).toBe(true)
    expect(report.notes).toEqual([])
  })

  it('flags a changed figure as "source updated"', () => {
    const ex = buildReproducibleExport(baseInput())
    const rerun = {
      'fetch_ndvi-0': { mean: 0.51, vegetation_pct: 64 },  // NDVI drifted (new scene)
      'estimate_population-1': { population: 12400 },
    }
    const report = diffReproRun(ex, rerun)
    expect(report.reproduced).toBe(false)
    const changed = report.diffs.find((d) => d.resultId === 'fetch_ndvi-0' && d.key === 'mean')!
    expect(changed.status).toBe('changed')
    expect(changed.original).toBe(0.42)
    expect(changed.current).toBe(0.51)
    expect(report.notes.some((n) => n.includes('source updated'))).toBe(true)
  })

  it('tolerates float noise below 1e-9', () => {
    const ex = buildReproducibleExport(baseInput())
    const rerun = {
      'fetch_ndvi-0': { mean: 0.42 + 1e-12, vegetation_pct: 64 },
      'estimate_population-1': { population: 12400 },
    }
    expect(diffReproRun(ex, rerun).reproduced).toBe(true)
  })

  it('flags added + removed figures', () => {
    const ex = buildReproducibleExport(baseInput())
    const rerun = {
      'fetch_ndvi-0': { mean: 0.42, ndwi: 0.1 },  // vegetation_pct removed, ndwi added
      'estimate_population-1': { population: 12400 },
    }
    const report = diffReproRun(ex, rerun)
    const added = report.diffs.find((d) => d.key === 'ndwi')!
    const removed = report.diffs.find((d) => d.key === 'vegetation_pct')!
    expect(added.status).toBe('added')
    expect(removed.status).toBe('removed')
    expect(report.reproduced).toBe(false)
  })

  it('reports a missing re-run step honestly', () => {
    const ex = buildReproducibleExport(baseInput())
    const rerun = { 'fetch_ndvi-0': { mean: 0.42, vegetation_pct: 64 } }  // population step missing
    const report = diffReproRun(ex, rerun)
    expect(report.reproduced).toBe(false)
    expect(report.notes.some((n) => n.includes('not reproduced'))).toBe(true)
    expect(report.diffs.some((d) => d.resultId === 'estimate_population-1' && d.status === 'removed')).toBe(true)
  })

  it('compares string figures (functional_type) exactly', () => {
    const ex = buildReproducibleExport(baseInput({ toolResults: { [VEG_RESULT.resultId]: VEG_RESULT } }))
    const same = diffReproRun(ex, { 'classify_vegetation-2': { functional_type: 'closed-canopy forest' } })
    expect(same.reproduced).toBe(true)
    const diff = diffReproRun(ex, { 'classify_vegetation-2': { functional_type: 'open woodland' } })
    expect(diff.reproduced).toBe(false)
  })
})

describe('Q-47 — the evidence ledger in the export', () => {
  const ledger = [{
    runId: 'run1', createdAt: '2026-10-12T12:00:00.000Z', query: 'show NIR', aoi: POLY, focus: null,
    nodes: [{
      idx: 0, op: 'render_raster', version: '1.0.0', args: { bands: ['B08'] }, dependsOn: [], inputsHash: 'h', resultId: 'r_abc',
      status: 'ok' as const, cached: false, startedAt: '2026-10-12T12:00:00.000Z', ms: 900,
      provenance: { sources: ['S2'], items: ['S2A_1'], method: 'titiler' }, computedAt: '2026-10-12T12:00:01.000Z', stats: { mean: 0.4 },
    }],
  }]

  it('carries the plan graph, hashes and provenance items verbatim', () => {
    const out = buildReproducibleExport({ aoi: null, toolResults: {}, ledger })
    expect(out.ledger).toEqual(ledger)
    expect(JSON.parse(JSON.stringify(out)).ledger[0].nodes[0]).toMatchObject({ resultId: 'r_abc', inputsHash: 'h', provenance: { items: ['S2A_1'] } })
    expect(out.reproduce.instructions).toMatch(/\/api\/ledger\/<runId>\/rerun/)
  })

  it('is an empty ledger, not an invented one, when none was recorded', () => {
    expect(buildReproducibleExport({ aoi: null, toolResults: {} }).ledger).toEqual([])
  })
})
