/**
 * C3 — Reproducible, citable export (pure, framework-free).
 *
 * Produces a machine-readable record of an analysis that answers, per number,
 * *where it came from* (provenance: source + method + clip) and *how to reproduce
 * it* (the tool + AOI + the figures it produced). A re-run can be compared back to
 * the export with `diffReproRun` → unchanged | changed ("source updated") | added |
 * removed, so the export is genuinely re-runnable rather than a static snapshot.
 *
 * Kept free of React/Zustand/Prisma imports so it unit-tests in isolation and can
 * be reused by the ExportPanel, the report builder, or an API route.
 *
 * Honesty: every figure carries its original provenance/confidence verbatim — this
 * module never recomputes or fabricates. If a figure has no provenance, it is
 * labeled `provenance: null` rather than given a fake source.
 */

import type { CitableToolResult, CitationValue } from './citations'
import type { LedgerExport } from '@/app/api/agent/engine/ledger'
import { classifyDataTier, type DataTier } from './data-tiers'

export const REPRO_SCHEMA = 'geoagent.reproducible-analysis' as const
export const REPRO_SCHEMA_VERSION = 1 as const

/** Minimal AOI shape the export needs (matches the store's AOI). */
export interface ReproAoi {
  type: string
  geometry: GeoJSON.Geometry
  center?: { lng: number; lat: number }
  radiusKm?: number
}

/** Minimal layer shape the export needs. */
export interface ReproLayerInput {
  id: string
  name: string
  type: string
  tool?: string
  resultId?: string
  provenance?: { source: string; date?: string; method: string; clip: string }
  confidence?: 'high' | 'medium' | 'low'
}

export interface ReproExportInput {
  aoi: ReproAoi | null
  /** Optional precomputed bbox [w,s,e,n]; derived from geometry if omitted. */
  bbox?: [number, number, number, number] | null
  /** Optional precomputed area in km² (the store tracks this when the AOI is drawn). */
  areaKm2?: number | null
  /** The session's citable tool results, keyed by resultId. */
  toolResults: Record<string, CitableToolResult>
  /** Map layers (for source listing). */
  layers?: ReproLayerInput[]
  /** Q&A transcript (role + content only). */
  messages?: Array<{ role: string; content: string }>
  /** Optional data-tier label (C2). */
  dataTier?: string
  /** Q-47 — the evidence ledger of each request in the session (`GET /api/ledger/:runId`). */
  ledger?: LedgerExport[]
  /** Injectable clock for deterministic tests. */
  now?: () => number
}

/** One reproducible analysis step — a measured figure-set with its provenance. */
export interface ReproStep {
  resultId: string
  tool: string
  source: string | null
  method: string | null
  clip: string | null
  date?: string
  confidence?: 'high' | 'medium' | 'low'
  /** C2 — the data tier this figure came from (free-10m / commercial / user-upload). */
  tier: DataTier
  /** C2 — representative native resolution in m/pixel, or null when N/A. */
  resolutionM: number | null
  /** The cited figures this step produced (verbatim from summaryData). */
  figures: Record<string, CitationValue>
}

export interface ReproducibleExport {
  schema: typeof REPRO_SCHEMA
  schemaVersion: typeof REPRO_SCHEMA_VERSION
  exportedAt: string
  app: { name: 'Erdfeld AI' }
  aoi: {
    type: string
    geometry: GeoJSON.Geometry
    bbox: [number, number, number, number] | null
    areaKm2: number | null
    center?: { lng: number; lat: number }
    radiusKm?: number
  } | null
  dataTier?: string
  /** Distinct foundation-model backends used (Phase 2), parsed from provenance. */
  modelBackends: string[]
  steps: ReproStep[]
  layers: Array<{
    id: string
    name: string
    type: string
    tool?: string
    resultId?: string
    provenance?: { source: string; date?: string; method: string; clip: string }
    confidence?: 'high' | 'medium' | 'low'
  }>
  transcript: Array<{ role: string; content: string }>
  /** Q-47 — executed plan graphs: operation@version, arguments, `inputs_hash`, `result_id`,
   *  status, dependencies and the data items each result was built from. Empty when the server
   *  has no evidence store. */
  ledger: LedgerExport[]
  reproduce: {
    instructions: string
    aoiGeoJson: GeoJSON.Geometry | null
    steps: Array<{ tool: string; resultId: string; rerunnable: boolean }>
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive a [w,s,e,n] bbox from any GeoJSON geometry by scanning coordinates. */
export function bboxFromGeometry(geom: GeoJSON.Geometry | null | undefined): [number, number, number, number] | null {
  if (!geom) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const visit = (c: any): void => {
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      const [x, y] = c
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      return
    }
    if (Array.isArray(c)) for (const sub of c) visit(sub)
  }
  const anyGeom = geom as any
  if (anyGeom.type === 'GeometryCollection') {
    for (const g of anyGeom.geometries ?? []) {
      const b = bboxFromGeometry(g)
      if (b) {
        if (b[0] < minX) minX = b[0]
        if (b[1] < minY) minY = b[1]
        if (b[2] > maxX) maxX = b[2]
        if (b[3] > maxY) maxY = b[3]
      }
    }
  } else if (anyGeom.coordinates) {
    visit(anyGeom.coordinates)
  }
  if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null
  return [minX, minY, maxX, maxY]
}

/** Recognized inference-backend prefixes in a provenance.source string (Phase 2). */
const BACKEND_PREFIXES = ['huggingface:', 'replicate:', 'selfhosted:']

/** Extract distinct foundation-model backend identifiers from the tool results. */
export function extractModelBackends(toolResults: Record<string, CitableToolResult>): string[] {
  const found = new Set<string>()
  for (const r of Object.values(toolResults)) {
    const src = r.provenance?.source ?? ''
    for (const prefix of BACKEND_PREFIXES) {
      const idx = src.indexOf(prefix)
      if (idx >= 0) {
        // capture "provider:route" up to whitespace/comma/closeparen
        const tail = src.slice(idx)
        const token = tail.split(/[\s,)]/)[0]
        found.add(token)
      }
    }
  }
  return [...found].sort()
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildReproducibleExport(input: ReproExportInput): ReproducibleExport {
  const now = input.now ?? (() => Date.now())
  const exportedAt = new Date(now()).toISOString()

  const steps: ReproStep[] = Object.values(input.toolResults)
    // stable ordering by resultId so the export round-trips deterministically
    .sort((a, b) => a.resultId.localeCompare(b.resultId))
    .map((r) => {
      const tierInfo = classifyDataTier(r.provenance?.source)
      return {
        resultId: r.resultId,
        tool: r.tool,
        source: r.provenance?.source ?? null,
        method: r.provenance?.method ?? null,
        clip: r.provenance?.clip ?? null,
        ...(r.provenance?.date ? { date: r.provenance.date } : {}),
        ...(r.confidence ? { confidence: r.confidence } : {}),
        tier: tierInfo.tier,
        resolutionM: tierInfo.resolutionM,
        figures: { ...r.summaryData },
      }
    })

  const aoiBbox = input.bbox ?? bboxFromGeometry(input.aoi?.geometry)

  return {
    schema: REPRO_SCHEMA,
    schemaVersion: REPRO_SCHEMA_VERSION,
    exportedAt,
    app: { name: 'Erdfeld AI' },
    aoi: input.aoi
      ? {
          type: input.aoi.type,
          geometry: input.aoi.geometry,
          bbox: aoiBbox,
          areaKm2: input.areaKm2 ?? null,
          ...(input.aoi.center ? { center: input.aoi.center } : {}),
          ...(input.aoi.radiusKm != null ? { radiusKm: input.aoi.radiusKm } : {}),
        }
      : null,
    ...(input.dataTier ? { dataTier: input.dataTier } : {}),
    modelBackends: extractModelBackends(input.toolResults),
    steps,
    layers: (input.layers ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type,
      ...(l.tool ? { tool: l.tool } : {}),
      ...(l.resultId ? { resultId: l.resultId } : {}),
      ...(l.provenance ? { provenance: l.provenance } : {}),
      ...(l.confidence ? { confidence: l.confidence } : {}),
    })),
    transcript: (input.messages ?? [])
      .filter((m) => m.content)
      .map((m) => ({ role: m.role, content: m.content })),
    ledger: input.ledger ?? [],
    reproduce: {
      instructions:
        'Re-run each step by drawing the AOI below and asking Erdfeld AI to run the listed tool. ' +
        'Compare the new figures to this export with diffReproRun(): deterministic sources reproduce ' +
        'exactly; live upstreams (latest-scene STAC, near-real-time feeds) may report "source updated". ' +
        'For each ledger run, POST /api/ledger/<runId>/rerun on the server that produced it (same owner) ' +
        're-executes every node without the cache and reports whether each result_id reproduced.',
      aoiGeoJson: input.aoi?.geometry ?? null,
      steps: steps.map((s) => ({
        tool: s.tool,
        resultId: s.resultId,
        // A step is rerunnable when we know which tool produced it.
        rerunnable: !!s.tool,
      })),
    },
  }
}

// ---------------------------------------------------------------------------
// Diff a re-run against the original export
// ---------------------------------------------------------------------------

export interface ReproFigureDiff {
  resultId: string
  key: string
  original: CitationValue | undefined
  current: CitationValue | undefined
  status: 'unchanged' | 'changed' | 'added' | 'removed'
}

export interface ReproDiffReport {
  /** True when every shared figure is unchanged (deterministic reproduction). */
  reproduced: boolean
  diffs: ReproFigureDiff[]
  /** Human-readable per-figure notes for changed/added/removed entries. */
  notes: string[]
}

function valuesEqual(a: CitationValue | undefined, b: CitationValue | undefined): boolean {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') {
    // tolerate float noise but flag genuine drift
    return Math.abs(a - b) < 1e-9
  }
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Compare a fresh set of tool results (by resultId → figures) against an export.
 * Returns per-figure diffs + an honest "reproduced" flag. Changed deterministic
 * figures mean a real drift; changed live-source figures are the honest "source
 * updated" case the caller surfaces to the user.
 */
export function diffReproRun(
  original: ReproducibleExport,
  rerun: Record<string, Record<string, CitationValue>>,
): ReproDiffReport {
  const diffs: ReproFigureDiff[] = []
  const notes: string[] = []

  for (const step of original.steps) {
    const before = step.figures
    const after = rerun[step.resultId]
    if (!after) {
      // No matching re-run result — every original figure is "removed" from the rerun
      for (const key of Object.keys(before)) {
        diffs.push({ resultId: step.resultId, key, original: before[key], current: undefined, status: 'removed' })
      }
      notes.push(`${step.resultId}: no re-run result (step not reproduced)`)
      continue
    }
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const key of keys) {
      const o = before[key]
      const c = after[key]
      let status: ReproFigureDiff['status']
      if (o === undefined) status = 'added'
      else if (c === undefined) status = 'removed'
      else status = valuesEqual(o, c) ? 'unchanged' : 'changed'
      diffs.push({ resultId: step.resultId, key, original: o, current: c, status })
      if (status === 'changed') {
        notes.push(`${step.resultId}#${key}: ${JSON.stringify(o)} → ${JSON.stringify(c)} (source updated)`)
      } else if (status === 'added') {
        notes.push(`${step.resultId}#${key}: new figure ${JSON.stringify(c)}`)
      } else if (status === 'removed') {
        notes.push(`${step.resultId}#${key}: figure no longer produced`)
      }
    }
  }

  const reproduced = diffs.every((d) => d.status === 'unchanged')
  return { reproduced, diffs, notes }
}
