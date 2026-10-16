/**
 * C7 — Tool integration tests (VCR-style).
 *
 * These run the REAL tool code path end-to-end through `executeTool` — URL building
 * → fetch → response parsing → ToolOutput — against recorded *real-shape* upstream
 * fixtures (replayed via a mocked global fetch routed by host). This is the layer the
 * 2026-06-01 live run proved was missing: the mocked pure-helper tests stub the parsed
 * value, so they could not catch the STAC-001 / CLIMATE-001 upstream-shape drift bugs.
 * These tests exercise the actual request URLs + the actual parsing, so:
 *   - a broken URL builder fails the "request contract" assertions, and
 *   - a broken response parser fails the "result" assertions.
 *
 * All fixtures are inline (no network). Default suite — always runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeTool } from '../tools/index'
import { _resetCache } from '../lib/cache'

// A small Nairobi AOI polygon (raw GeoJSON geometry — what executeTool expects).
const AOI: GeoJSON.Geometry = {
  type: 'Polygon',
  coordinates: [[[36.80, -1.30], [36.82, -1.30], [36.82, -1.28], [36.80, -1.28], [36.80, -1.30]]],
}

// ---------------------------------------------------------------------------
// Real-shape fixtures (trimmed to the fields the tools read)
// ---------------------------------------------------------------------------

// One year of daily archive data (CLIMATE-001 shape: daily=, NOT monthly=).
const ARCHIVE_FIXTURE = (() => {
  const time: string[] = []
  const temp: number[] = []
  const precip: number[] = []
  const start = new Date('2025-06-01')
  for (let d = 0; d < 365; d++) {
    const dt = new Date(start.getTime() + d * 86400_000)
    time.push(dt.toISOString().slice(0, 10))
    temp.push(20 + (d % 10))
    precip.push(d % 30 === 0 ? 12 : 1)
  }
  return { daily: { time, temperature_2m_mean: temp, precipitation_sum: precip } }
})()

// ---------------------------------------------------------------------------
// Fetch router — replays fixtures by host; records calls for contract asserts
// ---------------------------------------------------------------------------

let fetchCalls: string[] = []

function jsonResponse(body: unknown) {
  return {
    ok: true, status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as any
}

function installFetchRouter() {
  fetchCalls = []
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    const u = String(url)
    fetchCalls.push(u)
    // Match exact endpoint paths (the trailing `?` guards against a typo'd builder
    // like `/forecastXX?` slipping through — that's the whole point of C7).
    if (u.includes('archive-api.open-meteo.com/v1/archive?')) return jsonResponse(ARCHIVE_FIXTURE)
    // Unknown host → surface clearly so a misrouted request fails loudly.
    throw new Error(`unexpected fetch in test: ${u.slice(0, 80)}`)
  }))
}

beforeEach(() => {
  _resetCache()
  installFetchRouter()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// fetch_weather_history (CLIMATE-001 regression guard)
// ---------------------------------------------------------------------------

describe('integration: fetch_weather_history (Open-Meteo archive, daily→monthly)', () => {
  it('requests daily= (NOT monthly=) and rolls up to 12 months', async () => {
    const result = await executeTool('fetch_weather_history', AOI, {})
    const archiveCall = fetchCalls.find((u) => u.includes('archive-api.open-meteo.com'))
    expect(archiveCall, 'archive URL not requested').toBeTruthy()
    // CLIMATE-001: the archive API rejects monthly= — assert we never send it
    expect(archiveCall).toContain('daily=')
    expect(archiveCall).not.toContain('monthly=')
    // Roll-up produced real annual totals
    expect(result.stats!.annual_precip_mm).toBeGreaterThan(0)
    expect(Array.isArray(result.stats!.monthly_precip_mm)).toBe(true)
    expect((result.stats!.monthly_precip_mm as any[]).length).toBeGreaterThanOrEqual(12)
  })
})

// ---------------------------------------------------------------------------
// Honest degrade: upstream failure → no fabrication
// ---------------------------------------------------------------------------

describe('integration: honest degrade on upstream failure', () => {
  it('fetch_weather_history reports an upstream outage as a failure, not as an empty year', async () => {
    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 503, json: async () => ({}), text: async () => 'down',
      headers: { get: () => null },
    } as any)))
    const result = await executeTool('fetch_weather_history', AOI, {})
    expect(result.stats).toBeUndefined()
    expect(result.status).toBe('failed')
  })

  it('unknown tool returns an honest message (no throw)', async () => {
    const result = await executeTool('not_a_real_tool', AOI, {})
    expect(result.summary).toContain('Unknown tool')
    expect(result.status).toBe('refused')
  })
})
