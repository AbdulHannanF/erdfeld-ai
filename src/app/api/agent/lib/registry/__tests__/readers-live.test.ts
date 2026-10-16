/** Live end-to-end: `use_dataset` over real datasets, real networks, physically checked numbers.
 *
 *  Skipped unless REGISTRY_LIVE=1. Run with
 *    REGISTRY_LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run src/app/api/agent/lib/registry/__tests__/readers-live.test.ts
 *  It rewrites the "Dataset readers — live" section of eval/RESULTS.md with what it measured.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lonLatToTile } from '../../geometry'
import { executeTool } from '../../../tools'
import type { ToolOutput } from '../../types'
import { getRegistryIndex } from '..'

const LIVE = process.env.REGISTRY_LIVE === '1'
const d = describe.skipIf(!LIVE)

const poly = (c: number[][]) => ({ type: 'Polygon', coordinates: [c] })
const LAHORE = poly([[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]])
const DC = poly([[-77.05, 38.88], [-77.03, 38.88], [-77.03, 38.9], [-77.05, 38.9], [-77.05, 38.88]])
const DENVER = poly([[-104.995, 39.735], [-104.975, 39.735], [-104.975, 39.75], [-104.995, 39.75], [-104.995, 39.735]])

interface Row { dataset: string; outcome: string; numbers: string; ms: number; tile: string }
const rows: Row[] = []

async function run(aoi: any, id: string, args: Record<string, any> = {}): Promise<{ res: ToolOutput; ms: number }> {
  const t = Date.now()
  const res = await executeTool('use_dataset', aoi, { dataset_id: id, ...args })
  return { res, ms: Date.now() - t }
}

/** One XYZ tile at the AOI centre must come back as a 200 PNG. */
async function tileCheck(layer: any, aoi: any): Promise<string> {
  if (layer?.imageBase64) {
    expect(Buffer.from(layer.imageBase64, 'base64').subarray(1, 4).toString('ascii')).toBe('PNG')
    return 'inline PNG'
  }
  if (!layer?.tileUrl) return 'n/a'
  const ring: number[][] = aoi.coordinates[0]
  const lon = (Math.min(...ring.map((p) => p[0])) + Math.max(...ring.map((p) => p[0]))) / 2
  const lat = (Math.min(...ring.map((p) => p[1])) + Math.max(...ring.map((p) => p[1]))) / 2
  const z = 12
  const { x, y } = lonLatToTile(lon, lat, z)
  const url = String(layer.tileUrl).replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
  let last = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    const buf = Buffer.from(await r.arrayBuffer())
    last = `HTTP ${r.status}`
    if (r.status === 200 && buf.subarray(1, 4).toString('ascii') === 'PNG') return '200 PNG'
  }
  throw new Error(`tile did not return a 200 PNG (${last}): ${url.slice(0, 200)}`)
}

function record(dataset: string, outcome: string, numbers: string, ms: number, tile = 'n/a') {
  rows.push({ dataset, outcome, numbers, ms, tile })
}

const num = (res: ToolOutput, k: string) => Number(res.summary_data?.[k])

d('use_dataset: live, Lahore farmland', () => {
  beforeAll(async () => { await getRegistryIndex() }, 180_000)

  it('Sentinel-1 RTC, VV in dB', async () => {
    const { res, ms } = await run(LAHORE, 'planetary-computer:sentinel-1-rtc', { variable: 'vv' })
    expect(res.summary_data?.read).toBe('ok')
    const mean = num(res, 'mean')
    expect(mean).toBeGreaterThan(-30); expect(mean).toBeLessThan(5)
    expect(res.summary_data?.unit).toBe('dB')
    expect(num(res, 'min')).toBeGreaterThan(-60)
    const tile = await tileCheck(res.layer, LAHORE)
    record('Sentinel-1 RTC (VV dB)', 'ok', `${res.summary_data?.date}: mean ${mean} dB, p95 ${res.summary_data?.p95}, ${res.summary_data?.pixel_count} px, ${res.summary_data?.aoi_valid_pct}% of AOI`, ms, tile)
  }, 240_000)

  it('ALOS PALSAR mosaic, HH in dB', async () => {
    const { res, ms } = await run(LAHORE, 'planetary-computer:alos-palsar-mosaic', { variable: 'HH' })
    expect(res.summary_data?.read).toBe('ok')
    const mean = num(res, 'mean')
    expect(mean).toBeGreaterThan(-30); expect(mean).toBeLessThan(5)
    const tile = await tileCheck(res.layer, LAHORE)
    record('ALOS PALSAR mosaic (HH dB)', 'ok', `${res.summary_data?.date}: mean ${mean} dB, ${res.summary_data?.pixel_count} px`, ms, tile)
  }, 240_000)

  it.each([
    ['NASADEM', 'planetary-computer:nasadem'],
    ['Copernicus DEM GLO-30', 'planetary-computer:cop-dem-glo-30'],
    ['ALOS World 3D-30m', 'planetary-computer:alos-dem'],
  ])('%s elevation in metres', async (name, id) => {
    const { res, ms } = await run(LAHORE, id, { hillshade: true })
    expect(res.summary_data?.read).toBe('ok')
    const mean = num(res, 'mean')
    expect(mean).toBeGreaterThan(150); expect(mean).toBeLessThan(300) // Lahore sits near 215 m
    expect(num(res, 'min')).toBeGreaterThan(100); expect(num(res, 'max')).toBeLessThan(400)
    expect(res.layers?.length).toBeGreaterThanOrEqual(1) // hillshade layer
    const tile = await tileCheck(res.layer, LAHORE)
    await tileCheck(res.layers![0], LAHORE)
    record(name, 'ok', `mean ${mean} m (${num(res, 'min')} to ${num(res, 'max')}), ${res.summary_data?.pixel_count} px`, ms, tile)
  }, 240_000)

  it('ESA WorldCover classes', async () => {
    const { res, ms } = await run(LAHORE, 'planetary-computer:esa-worldcover')
    expect(res.summary_data?.read).toBe('ok')
    const valid = new Set(['Tree cover', 'Shrubland', 'Grassland', 'Cropland', 'Built-up', 'Bare / sparse vegetation', 'Snow and ice', 'Permanent water bodies', 'Herbaceous wetland', 'Mangroves', 'Moss and lichen'])
    const cls = res.summary_data?.class_pct as Array<{ label: string; value: number }>
    expect(cls.length).toBeGreaterThan(0)
    for (const c of cls) expect(valid.has(c.label), `unexpected class ${c.label}`).toBe(true)
    expect(cls.reduce((s, c) => s + c.value, 0)).toBeGreaterThan(98)
    expect(res.layer?.raster?.kind).toBe('categorical')
    const tile = await tileCheck(res.layer, LAHORE)
    record('ESA WorldCover', 'ok', cls.slice(0, 3).map((c) => `${c.label} ${c.value}%`).join(', '), ms, tile)
  }, 240_000)

  it('JRC Global Surface Water, occurrence', async () => {
    const { res, ms } = await run(LAHORE, 'planetary-computer:jrc-gsw', { variable: 'occurrence' })
    expect(res.summary_data?.read).toBe('ok')
    expect(num(res, 'mean')).toBeGreaterThanOrEqual(0); expect(num(res, 'max')).toBeLessThanOrEqual(100)
    const tile = await tileCheck(res.layer, LAHORE)
    record('JRC Global Surface Water (occurrence)', 'ok', `mean ${num(res, 'mean')}%, max ${num(res, 'max')}%`, ms, tile)
  }, 240_000)

  it('MODIS vegetation index (NDVI, scaled)', async () => {
    const { res, ms } = await run(LAHORE, 'planetary-computer:modis-13A1-061', { variable: 'NDVI' })
    expect(res.summary_data?.read).toBe('ok')
    const mean = num(res, 'mean')
    expect(mean).toBeGreaterThan(-0.2); expect(mean).toBeLessThanOrEqual(1) // scale 0.0001 applied
    const tile = await tileCheck(res.layer, LAHORE)
    record('MODIS 13A1 (NDVI)', 'ok', `${res.summary_data?.date}: mean ${mean}, ${res.summary_data?.pixel_count} px`, ms, tile)
  }, 240_000)

  it('io-lulc annual 10 m', async () => {
    const { res, ms } = await run(LAHORE, 'planetary-computer:io-lulc-annual-v02')
    expect(res.summary_data?.read).toBe('ok')
    const cls = res.summary_data?.class_pct as Array<{ label: string; value: number }>
    expect(cls.length).toBeGreaterThan(0)
    expect(cls.every((c) => !/^class \d+$/.test(c.label))).toBe(true) // names come from file:values
    const tile = await tileCheck(res.layer, LAHORE)
    record('io-lulc annual v02', 'ok', `${res.summary_data?.date ?? ''} ${cls.slice(0, 3).map((c) => `${c.label} ${c.value}%`).join(', ')}`, ms, tile)
  }, 240_000)

  it('SoilGrids (REST, routed to fetch_soil)', async () => {
    const { res, ms } = await run(LAHORE, 'isric:soilgrids')
    expect(res.summary_data?.routed_to).toBe('fetch_soil')
    const real = /clay|sand|pH/i.test(res.summary)
    record('SoilGrids 2.0 (rest)', real ? 'ok' : 'service unavailable', real ? res.summary.match(/clay[^\n]{0,60}/i)?.[0] ?? 'soil properties returned' : res.summary.slice(0, 80).replace(/\n/g, ' '), ms)
    expect(res.summary.length).toBeGreaterThan(40)
  }, 240_000)

  it('Open-Meteo ERA5 (REST, routed to fetch_weather_history)', async () => {
    let { res, ms } = await run(LAHORE, 'open-meteo:era5-archive')
    if (/429|rate.?limit/i.test(res.summary)) { // the shared egress IP is throttled by Open-Meteo: wait once and retry
      await new Promise((r) => setTimeout(r, 30_000))
      ;({ res, ms } = await run(LAHORE, 'open-meteo:era5-archive'))
    }
    expect(res.summary_data?.routed_to).toBe('fetch_weather_history')
    const real = /°C/.test(res.summary)
    const body = res.summary.split('\n\n').slice(1).join(' ').replace(/\s+/g, ' ')
    record('Open-Meteo ERA5 (rest)', real ? 'ok' : 'upstream rate-limited (429), reported honestly', body.slice(0, 160), ms)
    expect(res.summary.length).toBeGreaterThan(40)
  }, 240_000)

  it('Overture buildings', async () => {
    const { res, ms } = await run(LAHORE, 'overture:buildings')
    expect(res.summary_data?.read).toBe('ok')
    expect(num(res, 'feature_count')).toBeGreaterThan(100)
    expect(res.layer?.type).toBe('geojson')
    expect(res.layer?.vectorStyle).toBeTruthy()
    expect(res.layer!.geojson.features.length).toBe(num(res, 'feature_count'))
    record('Overture buildings', 'ok', `${num(res, 'feature_count')} buildings, footprints ${num(res, 'footprint_share_pct')}% of AOI, ${res.summary_data?.buildings_with_height ?? 0} with height`, ms, 'geojson')
  }, 240_000)

  it('NASA CMR dataset: honest Earthdata message unless a token is set', async () => {
    const { res, ms } = await run(LAHORE, 'cmr:ASF/ALOS2_L1_PSR2_1')
    if (process.env.EARTHDATA_TOKEN) {
      expect(['unavailable', 'ok']).toContain(res.summary_data?.read)
    } else {
      expect(res.summary_data?.read).toBe('auth_required')
      expect(res.summary).toMatch(/EARTHDATA_TOKEN/)
      expect(res.layer).toBeUndefined()
      expect(res.summary_data?.mean).toBeUndefined()
    }
    record('NASA CMR ALOS-2 PALSAR-2', String(res.summary_data?.read), res.summary.match(/found \*\*([^*]+)\*\*/)?.[1] ?? 'metadata only', ms)
  }, 240_000)

  it('Earth Engine dataset: honest credentials message when GEE is not configured', async () => {
    const { res, ms } = await run(LAHORE, 'gee:CIESIN/GPWv411/GPW_Population_Density')
    if (!process.env.GEE_KEY_FILE && !process.env.GEE_SERVICE_ACCOUNT_KEY) {
      expect(res.summary_data?.read).toBe('auth_required')
      expect(res.summary).toMatch(/GEE_KEY_FILE/)
      expect(res.summary).toMatch(/GPW_Population_Density/)
    }
    record('Earth Engine GPWv4 population density', String(res.summary_data?.read), res.summary_data?.read === 'ok' ? `mean ${res.summary_data?.mean}` : 'credentials not configured (GEE_KEY_FILE)', ms)
  }, 120_000)

  it('Zarr dataset: honest not-readable-yet', async () => {
    const { res, ms } = await run(LAHORE, 'planetary-computer:cil-gdpcir-cc-by')
    expect(res.summary_data?.read).toBe('unavailable')
    expect(res.summary).toMatch(/Q-22/)
    expect(res.layer).toBeUndefined()
    record('CIL-GDPCIR climate (Zarr)', 'unavailable', 'needs the Python geo service (Q-22)', ms)
  }, 60_000)

  it('refuses US-only lidar over Lahore fast, and says what lidar exists there', async () => {
    const { res, ms } = await run(LAHORE, 'planetary-computer:3dep-lidar-hag')
    expect(res.summary_data?.read).toBe('no_coverage')
    expect(res.summary).toMatch(/United States/)
    expect(res.summary).toMatch(/OpenTopography/)
    record('3DEP HAG over Lahore (coverage refusal)', 'no_coverage', res.summary.match(/lists \*\*[^*]+\*\*|lists \*\*no[^*]+\*\*/)?.[0] ?? 'refused', ms)
  }, 120_000)
})

d('use_dataset: live, Denver (3DEP lidar)', () => {
  beforeAll(async () => { await getRegistryIndex() }, 180_000)

  it('3DEP height above ground (canopy / building height)', async () => {
    const { res, ms } = await run(DENVER, 'planetary-computer:3dep-lidar-hag', { variable: 'building height' })
    expect(res.summary_data?.read).toBe('ok')
    expect(num(res, 'mean_height_m')).toBeGreaterThanOrEqual(0)
    expect(num(res, 'p95_height_m')).toBeGreaterThanOrEqual(0)
    expect(num(res, 'min')).toBeGreaterThanOrEqual(0)
    const tile = await tileCheck(res.layer, DENVER)
    // The 2013 South Platte HAG raster contradicts its own DSM - DTM here (mean ~89 m vs ~7 m): the reader must say so.
    expect(num(res, 'mean_height_m')).toBeLessThan(40)
    const how = res.summary_data?.height_source === 'dsm_minus_dtm' ? `HAG raster rejected (reads ${num(res, 'hag_raster_mean_m')} m), height from DSM-DTM` : 'HAG raster'
    record('3DEP lidar height above ground (Denver)', 'ok', `${res.summary_data?.date}: mean ${num(res, 'mean_height_m')} m, p95 ${num(res, 'p95_height_m')} m, ${res.summary_data?.pixel_count} px; ${how}`, ms, tile)
  }, 240_000)

  it('3DEP height above ground where the HAG raster is consistent (Washington DC)', async () => {
    const { res, ms } = await run(DC, 'planetary-computer:3dep-lidar-hag')
    expect(res.summary_data?.read).toBe('ok')
    expect(num(res, 'min')).toBeGreaterThanOrEqual(0)
    expect(num(res, 'mean_height_m')).toBeGreaterThanOrEqual(0)
    expect(num(res, 'mean_height_m')).toBeLessThan(40)
    expect(res.summary_data?.hag_cross_check).toBe('consistent')
    const tile = await tileCheck(res.layer, DC)
    record('3DEP lidar height above ground (Washington DC)', 'ok', `${res.summary_data?.date}: mean ${num(res, 'mean_height_m')} m, p95 ${num(res, 'p95_height_m')} m, cross-check vs DSM-DTM ${res.summary_data?.hag_cross_check}`, ms, tile)
  }, 240_000)

  it('3DEP DSM and DTM elevations are plausible for Denver', async () => {
    const dsm = await run(DENVER, 'planetary-computer:3dep-lidar-dsm')
    const dtm = await run(DENVER, 'planetary-computer:3dep-lidar-dtm')
    for (const { res } of [dsm, dtm]) {
      expect(res.summary_data?.read).toBe('ok')
      expect(num(res, 'mean')).toBeGreaterThan(1500); expect(num(res, 'mean')).toBeLessThan(1800)
    }
    expect(num(dsm.res, 'mean')).toBeGreaterThanOrEqual(num(dtm.res, 'mean') - 0.5) // surface is never below bare earth on average
    const t1 = await tileCheck(dsm.res.layer, DENVER)
    const t2 = await tileCheck(dtm.res.layer, DENVER)
    record('3DEP lidar DSM', 'ok', `mean ${num(dsm.res, 'mean')} m (${num(dsm.res, 'min')} to ${num(dsm.res, 'max')})`, dsm.ms, t1)
    record('3DEP lidar DTM', 'ok', `mean ${num(dtm.res, 'mean')} m (${num(dtm.res, 'min')} to ${num(dtm.res, 'max')})`, dtm.ms, t2)
  }, 300_000)

  it('3DEP point-cloud metadata path (no points rendered)', async () => {
    const { res, ms } = await run(DENVER, 'planetary-computer:3dep-lidar-copc')
    expect(res.summary_data?.read).toBe('metadata')
    expect(num(res, 'copc_tiles')).toBeGreaterThan(0)
    expect(num(res, 'point_density_median_pts_m2')).toBeGreaterThan(0.1)
    expect(res.layer).toBeUndefined()
    expect(res.summary).toMatch(/3dep-lidar-hag/)
    record('3DEP lidar point cloud (COPC)', 'metadata', `${num(res, 'copc_tiles')} tiles, ${num(res, 'projects')} project(s), ${num(res, 'point_density_median_pts_m2')} pts/m2, acquired ${res.summary_data?.acquired_first}..${res.summary_data?.acquired_last}`, ms)
  }, 240_000)
})

afterAll(() => {
  if (!LIVE || rows.length === 0) return
  const file = path.resolve(process.cwd(), 'eval/RESULTS.md')
  const head = '## Dataset readers — live'
  const now = new Date().toISOString().slice(0, 10)
  // Merge with rows from earlier runs so a partial run never erases the table.
  const prior = new Map<string, string>()
  try {
    const old = readFileSync(file, 'utf8')
    const at0 = old.indexOf(head)
    if (at0 >= 0) {
      const end0 = old.indexOf('\n## ', at0 + head.length)
      for (const line of old.slice(at0, end0 >= 0 ? end0 : undefined).split('\n')) {
        const m = line.match(/^\| (.+?) \| /)
        if (m && !/^dataset$|^---/.test(m[1])) prior.set(m[1], line)
      }
    }
  } catch { /* no file yet */ }
  for (const r of rows) prior.set(r.dataset, `| ${r.dataset} | ${r.outcome} | ${r.numbers.replace(/\|/g, '/')} | ${(r.ms / 1000).toFixed(1)} s | ${r.tile} |`)
  const section = [
    head, '',
    `Measured ${now} with \`REGISTRY_LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run src/app/api/agent/lib/registry/__tests__/readers-live.test.ts\`.`,
    'Each row is a real \`use_dataset({dataset_id})\` call through the agent tool layer. Farmland AOI near Lahore',
    '(74.05-74.08 E, 31.12-31.15 N, ~10 km²) and a Denver AOI (-104.995..-104.975, 39.735..39.75). A passing row means the number',
    'was inside its physical range (DEM metres, SAR dB -30..+5, HAG >= 0, valid WorldCover classes) and one XYZ tile at the AOI centre',
    'came back as a 200 PNG. Latency is the whole tool call, cold cache, from this sandbox through its egress proxy.', '',
    '| dataset | outcome | key numbers | latency | tile at AOI centre |', '|---|---|---|---:|---|',
    ...prior.values(),
    '',
  ].join('\n')
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { /* new file */ }
  const at = text.indexOf(head)
  if (at >= 0) {
    const next = text.indexOf('\n## ', at + head.length)
    text = text.slice(0, at) + section + (next >= 0 ? text.slice(next + 1) : '')
  } else {
    text = `${text.replace(/\s+$/, '')}\n\n${section}`
  }
  writeFileSync(file, text)
})
