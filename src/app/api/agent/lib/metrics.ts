/** P7.2 — in-process metrics for the agent surface.
 *
 *  Process-local counters (reset on restart; no persistence, no PII in labels).
 *  Read by `/api/metrics` and formatted as Prometheus text exposition. Tool latency
 *  is a real Prometheus histogram (cumulative `_bucket` + `_sum` + `_count`).
 *
 *  Cache hit/miss + inflight counters live in `cache.ts` (the source of truth) and are
 *  surfaced by the metrics route directly via `getCacheStatsBySource()` /
 *  `getInflightCount()` — they are NOT duplicated here.
 */

/** Upper bounds (seconds) for the tool-duration histogram. `+Inf` is implicit. */
export const TOOL_DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30] as const

interface ToolStat {
  /** Calls by terminal status: `success` | `error`. */
  calls: Map<string, number>
  /** Cumulative-per-bucket observation counts, aligned to TOOL_DURATION_BUCKETS. */
  buckets: number[]
  /** Sum of all observed durations (seconds). */
  sum: number
  /** Total observations (== sum of `calls` values). */
  count: number
}

const toolStats = new Map<string, ToolStat>()

function statFor(tool: string): ToolStat {
  let s = toolStats.get(tool)
  if (!s) {
    s = { calls: new Map(), buckets: new Array(TOOL_DURATION_BUCKETS.length).fill(0), sum: 0, count: 0 }
    toolStats.set(tool, s)
  }
  return s
}

/** Record one completed tool execution. `durationSec` is wall-clock seconds. */
export function recordToolCall(tool: string, status: 'success' | 'error', durationSec: number): void {
  const s = statFor(tool)
  s.calls.set(status, (s.calls.get(status) ?? 0) + 1)
  s.count += 1
  if (Number.isFinite(durationSec) && durationSec >= 0) {
    s.sum += durationSec
    // Cumulative histogram: a sample falls into every bucket whose `le` >= duration.
    for (let i = 0; i < TOOL_DURATION_BUCKETS.length; i++) {
      if (durationSec <= TOOL_DURATION_BUCKETS[i]) s.buckets[i] += 1
    }
  }
}

// --- Per-stage durations (Q-15) ----------------------------------------------
// One histogram per (tool, stage): stac_search, scene_scoring, stats, render, first_layer, total
// for tools; llm_plan / llm_synthesis under the pseudo-tool `_request`. Stages overlap, so a
// tool's stages do not sum to its `total`.

const stageStats = new Map<string, ToolStat & { tool: string; stage: string }>()

/** Record one stage duration in seconds. */
export function recordStage(tool: string, stage: string, durationSec: number): void {
  if (!Number.isFinite(durationSec) || durationSec < 0) return
  const key = `${tool}\u0000${stage}`
  let s = stageStats.get(key)
  if (!s) {
    s = { tool, stage, calls: new Map(), buckets: new Array(TOOL_DURATION_BUCKETS.length).fill(0), sum: 0, count: 0 }
    stageStats.set(key, s)
  }
  s.count += 1
  s.sum += durationSec
  for (let i = 0; i < TOOL_DURATION_BUCKETS.length; i++) {
    if (durationSec <= TOOL_DURATION_BUCKETS[i]) s.buckets[i] += 1
  }
}

export interface StageMetricsSnapshot {
  tool: string
  stage: string
  buckets: number[]
  sum: number
  count: number
}

export function getStageMetrics(): StageMetricsSnapshot[] {
  return [...stageStats.values()].map(({ tool, stage, buckets, sum, count }) => ({ tool, stage, buckets: [...buckets], sum, count }))
}

export interface ToolMetricsSnapshot {
  tool: string
  calls: Array<{ status: string; count: number }>
  buckets: number[]
  sum: number
  count: number
}

/** Immutable snapshot for the metrics exposition route. */
export function getToolMetrics(): ToolMetricsSnapshot[] {
  const out: ToolMetricsSnapshot[] = []
  for (const [tool, s] of toolStats) {
    out.push({
      tool,
      calls: [...s.calls.entries()].map(([status, count]) => ({ status, count })),
      buckets: [...s.buckets],
      sum: s.sum,
      count: s.count,
    })
  }
  return out
}

/** Test helper — clear all tool counters. */
export function _resetMetrics(): void {
  toolStats.clear()
  stageStats.clear()
}

// --- Prometheus text exposition ---------------------------------------------

/** Escape a Prometheus label value (backslash, double-quote, newline). */
function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

/** Format a float without locale separators; integers stay integers. */
function num(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)))
}

export interface CacheSourceCounts {
  hits: Record<string, number>
  misses: Record<string, number>
}

/** Render the full `/api/metrics` body as Prometheus text exposition. Pure — all
 *  inputs are passed in (cache + inflight come from `cache.ts`) so it's unit-testable. */
export function renderPrometheus(
  toolMetrics: ToolMetricsSnapshot[],
  cache: CacheSourceCounts,
  inflight: number,
  stages: StageMetricsSnapshot[] = [],
): string {
  const lines: string[] = []

  // geoagent_tool_calls_total{tool,status}
  lines.push('# HELP geoagent_tool_calls_total Total tool executions by tool and terminal status.')
  lines.push('# TYPE geoagent_tool_calls_total counter')
  for (const m of toolMetrics) {
    for (const { status, count } of m.calls) {
      lines.push(`geoagent_tool_calls_total{tool="${escapeLabel(m.tool)}",status="${escapeLabel(status)}"} ${num(count)}`)
    }
  }

  // geoagent_tool_duration_seconds histogram
  lines.push('# HELP geoagent_tool_duration_seconds Tool execution wall-clock duration in seconds.')
  lines.push('# TYPE geoagent_tool_duration_seconds histogram')
  for (const m of toolMetrics) {
    const tool = escapeLabel(m.tool)
    for (let i = 0; i < TOOL_DURATION_BUCKETS.length; i++) {
      lines.push(`geoagent_tool_duration_seconds_bucket{tool="${tool}",le="${num(TOOL_DURATION_BUCKETS[i])}"} ${num(m.buckets[i] ?? 0)}`)
    }
    // The +Inf bucket holds every observation.
    lines.push(`geoagent_tool_duration_seconds_bucket{tool="${tool}",le="+Inf"} ${num(m.count)}`)
    lines.push(`geoagent_tool_duration_seconds_sum{tool="${tool}"} ${num(m.sum)}`)
    lines.push(`geoagent_tool_duration_seconds_count{tool="${tool}"} ${num(m.count)}`)
  }

  // geoagent_stage_duration_seconds histogram
  lines.push('# HELP geoagent_stage_duration_seconds Per-stage wall-clock duration of a tool call (stages overlap) and of the LLM turns.')
  lines.push('# TYPE geoagent_stage_duration_seconds histogram')
  for (const m of stages) {
    const labels = `tool="${escapeLabel(m.tool)}",stage="${escapeLabel(m.stage)}"`
    for (let i = 0; i < TOOL_DURATION_BUCKETS.length; i++) {
      lines.push(`geoagent_stage_duration_seconds_bucket{${labels},le="${num(TOOL_DURATION_BUCKETS[i])}"} ${num(m.buckets[i] ?? 0)}`)
    }
    lines.push(`geoagent_stage_duration_seconds_bucket{${labels},le="+Inf"} ${num(m.count)}`)
    lines.push(`geoagent_stage_duration_seconds_sum{${labels}} ${num(m.sum)}`)
    lines.push(`geoagent_stage_duration_seconds_count{${labels}} ${num(m.count)}`)
  }

  // geoagent_cache_hits_total{source} / geoagent_cache_misses_total{source}
  lines.push('# HELP geoagent_cache_hits_total External-fetch cache hits by data source.')
  lines.push('# TYPE geoagent_cache_hits_total counter')
  for (const [source, count] of Object.entries(cache.hits)) {
    lines.push(`geoagent_cache_hits_total{source="${escapeLabel(source)}"} ${num(count)}`)
  }
  lines.push('# HELP geoagent_cache_misses_total External-fetch cache misses by data source.')
  lines.push('# TYPE geoagent_cache_misses_total counter')
  for (const [source, count] of Object.entries(cache.misses)) {
    lines.push(`geoagent_cache_misses_total{source="${escapeLabel(source)}"} ${num(count)}`)
  }

  // geoagent_inflight_requests gauge
  lines.push('# HELP geoagent_inflight_requests Distinct external fetches currently in flight (de-duped).')
  lines.push('# TYPE geoagent_inflight_requests gauge')
  lines.push(`geoagent_inflight_requests ${num(inflight)}`)

  return lines.join('\n') + '\n'
}
