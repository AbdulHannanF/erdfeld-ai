import { beforeEach, describe, expect, it } from 'vitest'

import { _resetMetrics, getStageMetrics, recordStage, renderPrometheus } from '../metrics'
import { mark, span, withTimings } from '../timings'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
beforeEach(() => { _resetMetrics() })

describe('timing spans', () => {
  it('are free pass-throughs outside a scope', async () => {
    expect(await span('stats', async () => 7)).toBe(7)
    mark('first_layer')
  })

  it('record each stage in ms, sum repeats, and only list stages that ran', async () => {
    const { value, timings } = await withTimings(async () => {
      await span('stac_search', () => sleep(30))
      await Promise.all([span('stats', () => sleep(40)), span('stats', () => sleep(40))])
      mark('first_layer')
      return 'v'
    })
    expect(value).toBe('v')
    expect(timings.stac_search).toBeGreaterThanOrEqual(25)
    expect(timings.stats).toBeGreaterThanOrEqual(70) // two 40 ms spans add up, they do not take the max
    expect(timings.first_layer).toBeGreaterThanOrEqual(25)
    expect(timings).not.toHaveProperty('render')
  })

  it('count a span that throws, and keep concurrent scopes apart', async () => {
    const [a, b] = await Promise.all([
      withTimings(async () => { await span('render', async () => { await sleep(20); throw new Error('x') }).catch(() => {}) }),
      withTimings(async () => { await span('stats', () => sleep(10)) }),
    ])
    expect(a.timings.render).toBeGreaterThanOrEqual(15)
    expect(a.timings).not.toHaveProperty('stats')
    expect(b.timings).not.toHaveProperty('render')
  })
})

describe('stage histogram', () => {
  it('exposes geoagent_stage_duration_seconds with cumulative buckets per tool and stage', () => {
    recordStage('fetch_ndvi', 'stats', 0.3)
    recordStage('fetch_ndvi', 'stats', 1.5)
    recordStage('_request', 'llm_plan', 0.04)
    recordStage('fetch_ndvi', 'stats', -1) // ignored
    const stats = getStageMetrics().find((m) => m.tool === 'fetch_ndvi' && m.stage === 'stats')!
    expect(stats.count).toBe(2)
    expect(stats.sum).toBeCloseTo(1.8, 6)
    const text = renderPrometheus([], { hits: {}, misses: {} }, 0, getStageMetrics())
    expect(text).toContain('# TYPE geoagent_stage_duration_seconds histogram')
    expect(text).toContain('geoagent_stage_duration_seconds_bucket{tool="fetch_ndvi",stage="stats",le="0.5"} 1')
    expect(text).toContain('geoagent_stage_duration_seconds_bucket{tool="fetch_ndvi",stage="stats",le="2"} 2')
    expect(text).toContain('geoagent_stage_duration_seconds_count{tool="_request",stage="llm_plan"} 1')
  })
})
