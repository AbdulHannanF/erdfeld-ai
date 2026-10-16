import { beforeEach, describe, expect, it } from 'vitest'

import {
  TOOL_DURATION_BUCKETS,
  _resetMetrics,
  getToolMetrics,
  recordToolCall,
  renderPrometheus,
} from '../metrics'

beforeEach(() => {
  _resetMetrics()
})

describe('recordToolCall / getToolMetrics', () => {
  it('starts empty', () => {
    expect(getToolMetrics()).toEqual([])
  })

  it('counts calls by status', () => {
    recordToolCall('query_osm', 'success', 0.2)
    recordToolCall('query_osm', 'success', 0.3)
    recordToolCall('query_osm', 'error', 0.1)
    const m = getToolMetrics().find((x) => x.tool === 'query_osm')!
    expect(m.count).toBe(3)
    const calls = Object.fromEntries(m.calls.map((c) => [c.status, c.count]))
    expect(calls).toEqual({ success: 2, error: 1 })
  })

  it('accumulates the duration sum', () => {
    recordToolCall('fetch_dem', 'success', 1.5)
    recordToolCall('fetch_dem', 'success', 0.5)
    const m = getToolMetrics().find((x) => x.tool === 'fetch_dem')!
    expect(m.sum).toBeCloseTo(2.0, 6)
  })

  it('fills cumulative histogram buckets (a sample lands in every bucket >= its duration)', () => {
    // 0.3s → falls into le=0.5, 1, 2, 5, 10, 30 (and +Inf), NOT le=0.05,0.1,0.25
    recordToolCall('t', 'success', 0.3)
    const m = getToolMetrics().find((x) => x.tool === 't')!
    TOOL_DURATION_BUCKETS.forEach((le, i) => {
      expect(m.buckets[i]).toBe(le >= 0.3 ? 1 : 0)
    })
  })

  it('ignores negative/non-finite durations for the histogram but still counts the call', () => {
    recordToolCall('t', 'error', Number.NaN)
    const m = getToolMetrics().find((x) => x.tool === 't')!
    expect(m.count).toBe(1)
    expect(m.sum).toBe(0)
    expect(m.buckets.every((b) => b === 0)).toBe(true)
  })

  it('_resetMetrics clears everything', () => {
    recordToolCall('t', 'success', 1)
    _resetMetrics()
    expect(getToolMetrics()).toEqual([])
  })
})

describe('renderPrometheus', () => {
  it('emits valid counter + histogram + gauge families', () => {
    recordToolCall('query_osm', 'success', 0.3)
    const out = renderPrometheus(
      getToolMetrics(),
      { hits: { overpass: 4 }, misses: { overpass: 1, stac: 2 } },
      3,
    )

    // HELP/TYPE headers present
    expect(out).toContain('# TYPE geoagent_tool_calls_total counter')
    expect(out).toContain('# TYPE geoagent_tool_duration_seconds histogram')
    expect(out).toContain('# TYPE geoagent_cache_hits_total counter')
    expect(out).toContain('# TYPE geoagent_cache_misses_total counter')
    expect(out).toContain('# TYPE geoagent_inflight_requests gauge')

    // Samples
    expect(out).toContain('geoagent_tool_calls_total{tool="query_osm",status="success"} 1')
    expect(out).toContain('geoagent_tool_duration_seconds_bucket{tool="query_osm",le="+Inf"} 1')
    expect(out).toContain('geoagent_tool_duration_seconds_count{tool="query_osm"} 1')
    expect(out).toContain('geoagent_cache_hits_total{source="overpass"} 4')
    expect(out).toContain('geoagent_cache_misses_total{source="stac"} 2')
    expect(out).toContain('geoagent_inflight_requests 3')

    // Trailing newline (exposition format ends with LF)
    expect(out.endsWith('\n')).toBe(true)
  })

  it('the +Inf bucket equals the total count', () => {
    recordToolCall('t', 'success', 0.05)
    recordToolCall('t', 'success', 12)
    const out = renderPrometheus(getToolMetrics(), { hits: {}, misses: {} }, 0)
    expect(out).toContain('geoagent_tool_duration_seconds_bucket{tool="t",le="+Inf"} 2')
    expect(out).toContain('geoagent_tool_duration_seconds_count{tool="t"} 2')
  })

  it('escapes special characters in label values', () => {
    const out = renderPrometheus(
      [{ tool: 'we"ird', calls: [{ status: 'success', count: 1 }], buckets: TOOL_DURATION_BUCKETS.map(() => 1), sum: 1, count: 1 }],
      { hits: {}, misses: {} },
      0,
    )
    expect(out).toContain('tool="we\\"ird"')
  })

  it('renders an empty-but-valid body when nothing has been recorded', () => {
    const out = renderPrometheus([], { hits: {}, misses: {} }, 0)
    expect(out).toContain('# TYPE geoagent_inflight_requests gauge')
    expect(out).toContain('geoagent_inflight_requests 0')
  })
})
