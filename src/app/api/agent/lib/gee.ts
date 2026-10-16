/** Google Earth Engine integration (optional, preferred rendering backend).
 *
 *  When a service-account key is configured (GEE_SERVICE_ACCOUNT_KEY = the JSON
 *  string, or GEE_KEY_FILE = a path to it), the satellite/terrain tools render
 *  real per-pixel tiles from GEE instead of the public titiler.xyz instance.
 *
 *  Why GEE: Google renders the tiles server-side from cloud-masked **median
 *  composites** over a date window, so (a) the visualization is GEE-quality, (b)
 *  large multi-scene AOIs are mosaicked automatically (no single-110 km-scene
 *  limit), and (c) the reported mean is a real polygon-clipped reduceRegion.
 *
 *  Everything here is best-effort: any auth/compute failure resolves to null so
 *  the caller transparently falls back to the titiler path. No fabricated data.
 *
 *  Setup (operator): see `ccdoc/GEE_SETUP.md`.
 */

import * as fs from 'fs'
import { getLogger } from './logger'

const log = getLogger('lib/gee')

// ---------------------------------------------------------------------------
// Config + lazy auth/init (cached for the process)
// ---------------------------------------------------------------------------

let _key: any | null | undefined // undefined = not yet read; null = absent
function getServiceAccountKey(): any | null {
  if (_key !== undefined) return _key
  try {
    const raw = process.env.GEE_SERVICE_ACCOUNT_KEY
    if (raw && raw.trim()) {
      _key = JSON.parse(raw)
      return _key
    }
    const path = process.env.GEE_KEY_FILE
    if (path && fs.existsSync(path)) {
      _key = JSON.parse(fs.readFileSync(path, 'utf8'))
      return _key
    }
  } catch (err: any) {
    log.error({ err: err?.message }, 'GEE key parse failed — check GEE_SERVICE_ACCOUNT_KEY / GEE_KEY_FILE')
  }
  _key = null
  return _key
}

/** True when a GEE service-account key is configured. Cheap; no network. */
export function isGeeConfigured(): boolean {
  return getServiceAccountKey() != null
}

/** True only when GEE is configured AND explicitly opted in as the preferred raster
 *  backend (`GEE_PREFERRED=1|true|yes`). Default is **off**: the self-hosted/public TiTiler
 *  path (TITILER_ENDPOINT) is the fast, reliable default. GEE compute is high-quality but
 *  slow and is best used as an opt-in accelerator, not in the interactive hot path — so a
 *  failing/slow GEE config never silently taxes every query. This is the gate the raster
 *  tools check before attempting GEE. */
export function isGeePreferred(): boolean {
  if (!isGeeConfigured()) return false
  const v = (process.env.GEE_PREFERRED || '').toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

/** Human-readable reason GEE last failed to init/compute (for UI + logs). */
let _lastError: string | null = null
export function getGeeLastError(): string | null {
  return _lastError
}
function setGeeError(stage: string, err: any): void {
  const msg = typeof err === 'string' ? err : (err?.message ?? JSON.stringify(err)?.slice(0, 300) ?? 'unknown')
  _lastError = `${stage}: ${msg}`
  log.error({ stage, err: msg }, 'GEE error')
}

let _eeReady: Promise<boolean> | null = null

/** Authenticate + initialize the EE client once per process. Resolves false
 *  (never throws) if unconfigured or auth fails — caller falls back to titiler. */
function ensureEe(): Promise<boolean> {
  if (_eeReady) return _eeReady
  _eeReady = new Promise<boolean>((resolve) => {
    const key = getServiceAccountKey()
    if (!key) { setGeeError('config', 'no service-account key found (GEE_KEY_FILE / GEE_SERVICE_ACCOUNT_KEY)'); return resolve(false) }
    let ee: any
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ee = require('@google/earthengine')
    } catch (err: any) {
      setGeeError('load', err)
      return resolve(false)
    }
    const timeout = setTimeout(() => {
      setGeeError('init', 'auth/init timed out after 20s')
      resolve(false)
    }, 20_000)
    // Modern Earth Engine requires the Cloud project to be specified. Take it from
    // the key (or GEE_PROJECT override) and pass it to ee.initialize's opt_project.
    const project = process.env.GEE_PROJECT || key.project_id || undefined
    try {
      ee.data.authenticateViaPrivateKey(
        key,
        () => {
          ee.initialize(
            null,
            null,
            () => { clearTimeout(timeout); _lastError = null; log.info({ project }, 'GEE initialized'); resolve(true) },
            (err: any) => { clearTimeout(timeout); setGeeError('initialize', err); resolve(false) },
            null,
            project,
          )
        },
        (err: any) => { clearTimeout(timeout); setGeeError('authenticate', err); resolve(false) },
      )
    } catch (err: any) {
      clearTimeout(timeout)
      setGeeError('authenticate-threw', err)
      resolve(false)
    }
  })
  return _eeReady
}

function ee(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@google/earthengine')
}

// ---------------------------------------------------------------------------
// Promise wrappers around EE's callback API
// ---------------------------------------------------------------------------

/** image.getMap(visParams) → XYZ tile-URL template, or null. */
function getMapUrl(image: any, visParams: any, timeoutMs = 25_000): Promise<string | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => { setGeeError('getMap', 'timed out after 25s'); resolve(null) }, timeoutMs)
    try {
      image.getMap(visParams, (map: any, err: any) => {
        clearTimeout(t)
        if (err) setGeeError('getMap', err)
        if (err || !map) return resolve(null)
        // Newer client returns { urlFormat }; older returns { mapid, token }.
        if (map.urlFormat) return resolve(map.urlFormat as string)
        if (map.mapid) {
          const tok = map.token ? `?token=${map.token}` : ''
          return resolve(
            `https://earthengine.googleapis.com/v1/${map.mapid}/tiles/{z}/{x}/{y}${tok}`,
          )
        }
        resolve(null)
      })
    } catch {
      clearTimeout(t)
      resolve(null)
    }
  })
}

/** computeObject.evaluate() → plain JS value, or null. */
function evaluate<T = any>(obj: any, timeoutMs = 25_000): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs)
    try {
      obj.evaluate((val: any, err: any) => {
        clearTimeout(t)
        resolve(err ? null : (val as T))
      })
    } catch {
      clearTimeout(t)
      resolve(null)
    }
  })
}

// ---------------------------------------------------------------------------
// Palettes (match the existing LayerLegend conventions)
// ---------------------------------------------------------------------------

const NDVI_PALETTE = [
  '#a50026', '#d73027', '#f46d43', '#fdae61', '#fee08b',
  '#ffffbf', '#d9ef8b', '#a6d96a', '#66bd63', '#1a9850', '#006837',
]
const DEM_PALETTE = ['#313695', '#74add1', '#fee090', '#f46d43', '#a50026']
const LST_PALETTE = [
  '#000080', '#0000ff', '#00ffff', '#00ff00', '#ffff00', '#ff8000', '#ff0000',
]

// ---------------------------------------------------------------------------
// NDVI — cloud-masked Sentinel-2 median composite
// ---------------------------------------------------------------------------

export interface GeeNdviResult {
  tileUrl: string
  meanNdvi: number | null
  startDate: string
  endDate: string
  composite: 'median'
}

/** Real NDVI tiles from a cloud-masked Sentinel-2 SR median composite over the
 *  last `months`, clipped to the AOI. Returns null if GEE is unconfigured/fails. */
export async function geeNdvi(aoiGeoJson: any, months = 3): Promise<GeeNdviResult | null> {
  if (!(await ensureEe())) return null
  try {
    const E = ee()
    const geom = E.Geometry(aoiGeoJson)
    const end = new Date()
    const start = new Date(Date.now() - months * 30 * 86400_000)
    const startStr = start.toISOString().slice(0, 10)
    const endStr = end.toISOString().slice(0, 10)

    // QA60-based cloud mask (bits 10=cloud, 11=cirrus).
    const coll = E.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(geom)
      .filterDate(startStr, endStr)
      .filter(E.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 40))
      .map((img: any) => {
        const qa = img.select('QA60')
        const mask = qa.bitwiseAnd(1 << 10).eq(0).and(qa.bitwiseAnd(1 << 11).eq(0))
        return img.updateMask(mask).divide(10000)
      })

    const composite = coll.median()
    const ndvi = composite.normalizedDifference(['B8', 'B4']).rename('NDVI').clip(geom)

    const [tileUrl, meanObj] = await Promise.all([
      getMapUrl(ndvi, { min: -0.2, max: 0.8, palette: NDVI_PALETTE }),
      evaluate<{ NDVI?: number }>(
        ndvi.reduceRegion({
          reducer: E.Reducer.mean(),
          geometry: geom,
          scale: 10,
          maxPixels: 1e9,
          bestEffort: true,
        }),
      ),
    ])
    if (!tileUrl) return null
    return {
      tileUrl,
      meanNdvi: meanObj?.NDVI != null ? Number(meanObj.NDVI) : null,
      startDate: startStr,
      endDate: endStr,
      composite: 'median',
    }
  } catch (err: any) {
    log.error({ err: err?.message }, 'geeNdvi failed')
    return null
  }
}

// ---------------------------------------------------------------------------
// Spectral indices (NDWI/NDBI/EVI/NBR/SAVI) — same composite, different math
// ---------------------------------------------------------------------------

const SPECTRAL_BANDS: Record<string, { a: string; b: string; kind: 'nd' | 'evi' | 'savi' }> = {
  NDVI: { a: 'B8', b: 'B4', kind: 'nd' },
  NDWI: { a: 'B3', b: 'B8', kind: 'nd' },
  NDBI: { a: 'B11', b: 'B8', kind: 'nd' },
  NBR:  { a: 'B8', b: 'B12', kind: 'nd' },
  EVI:  { a: 'B8', b: 'B4', kind: 'evi' },
  SAVI: { a: 'B8', b: 'B4', kind: 'savi' },
}

export async function geeSpectralIndex(aoiGeoJson: any, index: string, months = 3): Promise<GeeNdviResult | null> {
  const cfg = SPECTRAL_BANDS[index.toUpperCase()]
  if (!cfg) return null
  if (!(await ensureEe())) return null
  try {
    const E = ee()
    const geom = E.Geometry(aoiGeoJson)
    const end = new Date()
    const start = new Date(Date.now() - months * 30 * 86400_000)
    const startStr = start.toISOString().slice(0, 10)
    const endStr = end.toISOString().slice(0, 10)

    const coll = E.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(geom).filterDate(startStr, endStr)
      .filter(E.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 40))
      .map((img: any) => {
        const qa = img.select('QA60')
        const mask = qa.bitwiseAnd(1 << 10).eq(0).and(qa.bitwiseAnd(1 << 11).eq(0))
        return img.updateMask(mask).divide(10000)
      })
    const c = coll.median()

    let img: any
    if (cfg.kind === 'nd') {
      img = c.normalizedDifference([cfg.a, cfg.b]).rename('IDX')
    } else if (cfg.kind === 'evi') {
      img = c.expression('2.5*((NIR-RED)/(NIR+6*RED-7.5*BLUE+1))', {
        NIR: c.select('B8'), RED: c.select('B4'), BLUE: c.select('B2'),
      }).rename('IDX')
    } else {
      img = c.expression('1.5*((NIR-RED)/(NIR+RED+0.5))', {
        NIR: c.select('B8'), RED: c.select('B4'),
      }).rename('IDX')
    }
    img = img.clip(geom)

    const [tileUrl, meanObj] = await Promise.all([
      getMapUrl(img, { min: -0.5, max: 0.8, palette: NDVI_PALETTE }),
      evaluate<{ IDX?: number }>(img.reduceRegion({
        reducer: E.Reducer.mean(), geometry: geom, scale: 10, maxPixels: 1e9, bestEffort: true,
      })),
    ])
    if (!tileUrl) return null
    return { tileUrl, meanNdvi: meanObj?.IDX != null ? Number(meanObj.IDX) : null, startDate: startStr, endDate: endStr, composite: 'median' }
  } catch (err: any) {
    log.error({ err: err?.message, index }, 'geeSpectralIndex failed')
    return null
  }
}

// ---------------------------------------------------------------------------
// DEM — Copernicus GLO-30 colour relief + hillshade, real stats
// ---------------------------------------------------------------------------

export interface GeeDemResult {
  colorUrl: string
  hillshadeUrl: string | null
  min: number
  max: number
  mean: number | null
}

export async function geeDem(aoiGeoJson: any): Promise<GeeDemResult | null> {
  if (!(await ensureEe())) return null
  try {
    const E = ee()
    const geom = E.Geometry(aoiGeoJson)
    // Copernicus GLO-30 is an ImageCollection of tiles; mosaic + select DEM band.
    const dem = E.ImageCollection('COPERNICUS/DEM/GLO30').select('DEM').mosaic().clip(geom)

    // Real min/max/mean over the polygon (drives the colour rescale + the stat).
    const stats = await evaluate<{ DEM_min?: number; DEM_max?: number; DEM_mean?: number }>(
      dem.reduceRegion({
        reducer: E.Reducer.minMax().combine({ reducer2: E.Reducer.mean(), sharedInputs: true }),
        geometry: geom, scale: 30, maxPixels: 1e9, bestEffort: true,
      }),
    )
    const min = stats?.DEM_min != null ? Math.floor(stats.DEM_min) : 0
    const max = stats?.DEM_max != null ? Math.ceil(stats.DEM_max) : min + 1
    const mean = stats?.DEM_mean != null ? Number(stats.DEM_mean) : null

    const hillshade = E.Terrain.hillshade(dem)
    const [colorUrl, hillshadeUrl] = await Promise.all([
      getMapUrl(dem, { min, max: Math.max(min + 1, max), palette: DEM_PALETTE }),
      getMapUrl(hillshade, { min: 0, max: 255 }),
    ])
    if (!colorUrl) return null
    return { colorUrl, hillshadeUrl, min, max, mean }
  } catch (err: any) {
    log.error({ err: err?.message }, 'geeDem failed')
    return null
  }
}

// ---------------------------------------------------------------------------
// Land Surface Temperature — MODIS MOD11A1 daily (global, simple, reliable)
// ---------------------------------------------------------------------------

export interface GeeLstResult {
  tileUrl: string
  meanCelsius: number | null
  startDate: string
  endDate: string
}

export async function geeLst(aoiGeoJson: any, days = 30): Promise<GeeLstResult | null> {
  if (!(await ensureEe())) return null
  try {
    const E = ee()
    const geom = E.Geometry(aoiGeoJson)
    const end = new Date()
    const start = new Date(Date.now() - days * 86400_000)
    const startStr = start.toISOString().slice(0, 10)
    const endStr = end.toISOString().slice(0, 10)

    // MOD11A1 LST_Day_1km is in Kelvin × 0.02. Convert to °C.
    const coll = E.ImageCollection('MODIS/061/MOD11A1')
      .filterDate(startStr, endStr).select('LST_Day_1km')
    const celsius = coll.mean().multiply(0.02).subtract(273.15).rename('LST_C').clip(geom)

    const [tileUrl, meanObj] = await Promise.all([
      getMapUrl(celsius, { min: 0, max: 45, palette: LST_PALETTE }),
      evaluate<{ LST_C?: number }>(celsius.reduceRegion({
        reducer: E.Reducer.mean(), geometry: geom, scale: 1000, maxPixels: 1e9, bestEffort: true,
      })),
    ])
    if (!tileUrl) return null
    return { tileUrl, meanCelsius: meanObj?.LST_C != null ? Number(meanObj.LST_C) : null, startDate: startStr, endDate: endStr }
  } catch (err: any) {
    log.error({ err: err?.message }, 'geeLst failed')
    return null
  }
}

// ---------------------------------------------------------------------------
// Any catalog asset: used by the dataset registry's Earth Engine reader
// ---------------------------------------------------------------------------

export interface GeeAssetRead {
  assetType: 'IMAGE' | 'IMAGE_COLLECTION'
  band: string
  bands: string[]
  /** Reducer outputs over the polygon, in the band's own units. */
  stats: { mean: number | null; min: number | null; max: number | null; std: number | null; p2: number | null; p98: number | null }
  /** XYZ template, null when tile creation failed. */
  tileUrl: string | null
  window?: { start: string; end: string }
  scaleM: number
}

function getAssetInfo(assetId: string, timeoutMs = 25_000): Promise<any | { __error: string }> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ __error: 'getAsset timed out after 25s' }), timeoutMs)
    try {
      ee().data.getAsset(assetId, (val: any, err: any) => {
        clearTimeout(t)
        resolve(err || !val ? { __error: typeof err === 'string' ? err : (err?.message ?? 'asset not found or not accessible') } : val)
      })
    } catch (err: any) {
      clearTimeout(t)
      resolve({ __error: err?.message ?? 'getAsset threw' })
    }
  })
}

/** Read any Earth Engine image / image collection over a polygon: reduceRegion statistics for one
 *  band (median composite over the window for collections) plus an XYZ tile URL stretched to the
 *  polygon's own p2-p98. Resolves `{ error }` (never throws, never invents numbers). */
export async function geeReadAsset(
  aoiGeoJson: any,
  o: { assetId: string; band?: string; start?: string; end?: string; scaleM?: number; palette?: string[] },
): Promise<GeeAssetRead | { error: string }> {
  if (!(await ensureEe())) return { error: getGeeLastError() ?? 'Earth Engine failed to initialise' }
  try {
    const E = ee()
    const info = await getAssetInfo(o.assetId)
    if (info?.__error) return { error: `Earth Engine could not open "${o.assetId}": ${info.__error}` }
    const type = String(info?.type ?? '')
    if (type !== 'IMAGE' && type !== 'IMAGE_COLLECTION') {
      return { error: `"${o.assetId}" is an Earth Engine ${type || 'unknown'} asset, not a raster (image or image collection).` }
    }
    const bands: string[] = (info.bands ?? []).map((b: any) => String(b.id))
    const band = o.band && bands.includes(o.band) ? o.band : o.band ? '' : bands[0]
    if (!band) return { error: `Band "${o.band}" does not exist on "${o.assetId}". Bands: ${bands.slice(0, 30).join(', ') || 'none listed'}.` }

    const geom = E.Geometry(aoiGeoJson)
    let image: any
    if (type === 'IMAGE_COLLECTION') {
      let coll = E.ImageCollection(o.assetId).filterBounds(geom)
      if (o.start && o.end) coll = coll.filterDate(o.start, o.end)
      image = coll.select(band).median()
    } else {
      image = E.Image(o.assetId).select(band)
    }
    image = image.clip(geom)
    const scaleM = o.scaleM && o.scaleM > 0 ? o.scaleM : 30

    const reducer = E.Reducer.mean()
      .combine({ reducer2: E.Reducer.minMax(), sharedInputs: true })
      .combine({ reducer2: E.Reducer.stdDev(), sharedInputs: true })
      .combine({ reducer2: E.Reducer.percentile([2, 98]), sharedInputs: true })
    const res = await evaluate<Record<string, number>>(
      image.reduceRegion({ reducer, geometry: geom, scale: scaleM, maxPixels: 1e9, bestEffort: true }),
      60_000,
    )
    const pick = (suffix: string) => { const v = res?.[`${band}_${suffix}`]; return typeof v === 'number' && Number.isFinite(v) ? v : null }
    const stats = { mean: pick('mean'), min: pick('min'), max: pick('max'), std: pick('stdDev'), p2: pick('p2'), p98: pick('p98') }
    if (stats.mean === null) {
      return { error: `Earth Engine returned no valid pixels for "${o.assetId}" band ${band} over this polygon (no coverage, or all masked).` }
    }
    const lo = stats.p2 ?? stats.min ?? 0
    const hi = stats.p98 ?? stats.max ?? lo + 1
    const tileUrl = await getMapUrl(image, { min: lo, max: hi > lo ? hi : lo + 1, ...(o.palette ? { palette: o.palette } : {}) })
    return {
      assetType: type, band, bands, stats, tileUrl, scaleM,
      ...(type === 'IMAGE_COLLECTION' && o.start && o.end ? { window: { start: o.start, end: o.end } } : {}),
    }
  } catch (err: any) {
    setGeeError('geeReadAsset', err)
    return { error: `Earth Engine read failed: ${err?.message ?? 'unknown error'}` }
  }
}

/** GEE palettes exported so tools can build a matching LayerLegend. */
export const GEE_PALETTES = { NDVI_PALETTE, DEM_PALETTE, LST_PALETTE }
