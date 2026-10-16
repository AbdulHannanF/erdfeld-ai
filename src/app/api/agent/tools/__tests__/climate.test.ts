/** fetch_weather_history takes a past period; use_dataset passes the dates through; the precipitation result names its
 *  source even without the raster; the CHIRPS layer comes from the Climate Hazards Center. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _resetCache } from '../../lib/cache'
import { signCHIRPSRaster } from '../../lib/precipitation'
import { readRest } from '../../lib/registry/readers/rest'
import { executeTool } from '../index'
import { weatherVariablesFor } from '../climate'
import { AOI as FIXTURE_AOI, entry } from '../../lib/registry/readers/__tests__/fixtures'

const AOI = { type: 'Polygon', coordinates: [[[-112.08, 33.44], [-112.06, 33.44], [-112.06, 33.46], [-112.08, 33.46], [-112.08, 33.44]]] }

let urls: string[] = []
function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } } as any
}
/** A July in Phoenix: 31 days, daily max 38..46 C, rain on two days. */
function july(start: string, end: string) {
  const time: string[] = []
  for (let d = Date.parse(`${start}T00:00:00Z`); d <= Date.parse(`${end}T00:00:00Z`); d += 86_400_000) time.push(new Date(d).toISOString().slice(0, 10))
  return {
    daily: {
      time,
      temperature_2m_max: time.map((_, i) => 38 + (i % 9)), // 38..46
      temperature_2m_mean: time.map(() => 33),
      precipitation_sum: time.map((_, i) => (i === 3 ? 12.4 : i === 20 ? 2 : 0)),
    },
  }
}

beforeEach(() => {
  _resetCache()
  urls = []
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    const u = String(url)
    urls.push(u)
    const m = u.match(/start_date=([\d-]+)&end_date=([\d-]+)/)
    if (u.includes('archive-api.open-meteo.com') && m) return json(july(m[1], m[2]))
    throw new Error(`unexpected fetch ${u.slice(0, 90)}`)
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('fetch_weather_history over a past period', () => {
  it('sends the requested dates to the archive and returns that window, not the trailing year', async () => {
    const r = await executeTool('fetch_weather_history', AOI, { start: '2023-07-01', end: '2023-07-31', variables: ['temperature_2m_max'], threshold: 43 })
    expect(urls[0]).toContain('start_date=2023-07-01&end_date=2023-07-31')
    expect(urls[0]).toContain('daily=temperature_2m_max')
    expect(r.status).toBe('ok')
    expect(r.stats).toMatchObject({ window_start: '2023-07-01', window_end: '2023-07-31', days_in_window: 31, hottest_day_c: 46, threshold_value: 43 })
    // 38 + (i % 9) > 43 means i % 9 in {6,7,8}: days 6,7,8,15,16,17,24,25,26 = 9 of 31
    expect(r.stats!.days_above_threshold).toBe(9)
    expect(Array.isArray(r.stats!.daily_temperature_2m_max)).toBe(true)
    expect(r.summary).toContain('2023-07-01 to 2023-07-31')
  })

  it('names its data source on the result itself', async () => {
    const r = await executeTool('fetch_weather_history', AOI, { start: '2023-07-01', end: '2023-07-31' })
    expect(r.validation.find((c) => c.id === 'provenance_sources')?.status).toBe('pass')
    expect(r.stats!.total_precip_mm).toBeCloseTo(14.4, 1)
    expect(r.stats!.rain_days_ge_1mm).toBe(2)
  })

  it('rolls a long window up to months', async () => {
    const r = await executeTool('fetch_weather_history', AOI, { start: '2023-01-01', end: '2023-12-31' })
    expect(Array.isArray(r.stats!.monthly_precip_mm)).toBe(true)
    expect((r.stats!.monthly_precip_mm as unknown[]).length).toBe(12)
    expect(r.stats!.annual_precip_mm).toBeGreaterThan(0)
  })

  it('refuses malformed, reversed, future and over-long windows before any request', async () => {
    for (const args of [
      { start: '2023-07-31', end: '2023-07-01' },
      { start: '2023-13-01', end: '2023-14-01' },
      { start: '2031-03-01', end: '2031-03-31' },
      { start: '1930-01-01', end: '1930-02-01' },
      { start: '2000-01-01', end: '2023-01-01' },
    ]) {
      const r = await executeTool('fetch_weather_history', AOI, args)
      expect(r.status, JSON.stringify(args)).toBe('refused')
    }
    expect(urls).toHaveLength(0)
  })
})

describe('use_dataset on open-meteo:era5-archive honours its dates and variable', () => {
  const era5 = entry({ id: 'open-meteo:era5-archive', source: 'open-meteo', title: 'ERA5', access: { kind: 'rest', url: 'https://x', requires_auth: null, notes: '' } })
  const aoi = FIXTURE_AOI

  it('passes start, end and the variable to fetch_weather_history', async () => {
    const runTool = vi.fn(async () => ({ summary: 'ok' }))
    await readRest(era5, aoi, { runTool, start: '2023-07-01', end: '2023-07-31', variable: 'temperature_2m_max' })
    expect(runTool).toHaveBeenCalledWith('fetch_weather_history', { start: '2023-07-01', end: '2023-07-31', variables: ['temperature_2m_max'] })
  })

  it('answers a dated rainfall question from the daily archive, an undated one from the climatology', async () => {
    const runTool = vi.fn(async () => ({ summary: 'ok' }))
    await readRest(era5, aoi, { runTool, start: '2024-07-01', end: '2024-07-31', variable: 'precipitation' })
    expect(runTool).toHaveBeenLastCalledWith('fetch_weather_history', { start: '2024-07-01', end: '2024-07-31', variables: ['precipitation_sum'] })
    await readRest(era5, aoi, { runTool, variable: 'precipitation' })
    expect(runTool).toHaveBeenLastCalledWith('fetch_precipitation_history', {})
  })

  it('maps free-text variables', () => {
    expect(weatherVariablesFor('max temperature')).toEqual(['temperature_2m_max'])
    expect(weatherVariablesFor('rain')).toEqual(['precipitation_sum'])
    expect(weatherVariablesFor(undefined)).toBeUndefined()
  })
})

describe('CHIRPS rainfall layer', () => {
  it('uses the newest monthly COG the Climate Hazards Center serves', async () => {
    const probed: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      probed.push(`${init?.method} ${url}`)
      return { ok: /2026\.07\.cog/.test(String(url)) } as any
    }))
    const r = await signCHIRPSRaster([0, 0, 1, 1], new Date('2026-10-15T00:00:00Z'))
    expect(r?.date).toBe('2026-07')
    expect(probed.map((p) => p.split('/').pop())).toEqual(['chirps-v2.0.2026.09.cog', 'chirps-v2.0.2026.08.cog', 'chirps-v2.0.2026.07.cog'])
    expect(r?.tileUrl).toContain(encodeURIComponent('https://data.chc.ucsb.edu/products/CHIRPS-2.0/global_monthly/cogs/chirps-v2.0.2026.07.cog'))
  })

  it('is null, not a made-up layer, when no recent month is reachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as any))
    expect(await signCHIRPSRaster([0, 0, 1, 1], new Date('2026-10-16T00:00:00Z'))).toBeNull()
  })
})

describe('fetch_precipitation_history without the raster', () => {
  it('names its source on the result and passes validation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      const m = String(url).match(/start_date=([\d-]+)&end_date=([\d-]+)/)!
      const time: string[] = []
      for (let d = Date.parse(`${m[1]}T00:00:00Z`); d <= Date.parse(`${m[2]}T00:00:00Z`); d += 86_400_000) time.push(new Date(d).toISOString().slice(0, 10))
      return json({ daily: { time, precipitation_sum: time.map(() => 3) } })
    }))
    const r = await executeTool('fetch_precipitation_history', AOI, { include_raster: false })
    expect(r.status).toBe('ok')
    expect(r.validation.find((c) => c.id === 'provenance_sources')?.status).toBe('pass')
    expect(r.provenance.sources.join(' ')).toMatch(/Open-Meteo ERA5/)
  })
})
