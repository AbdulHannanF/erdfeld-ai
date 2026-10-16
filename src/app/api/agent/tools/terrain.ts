/** Terrain tools: fetch_dem and fetch_elevation_derivatives.
 *  Stats + derivatives from opentopodata.org (Mapzen ~30m global by default);
 *  fetch_dem's map layer is real per-pixel Copernicus DEM 30m tiles via PC + titiler. */

import { cachedFetchJson, fetchWithRetry } from '../lib/cache'
import { debugLog } from '../lib/debug'
import { fetchFailureNote } from '../lib/fetch-failure'
import { getLogger } from '../lib/logger'
import { genId, pointInAoi } from '../lib/geometry'
import {
  aspectToRgb,
  elevToRgb,
  generateRasterPng,
  slopeToRgb,
} from '../lib/raster'
import {
  COMPASS_LABELS,
  aspectClass,
  computeAspect,
  computeContours,
  computeSlope,
  slopeDistribution,
} from '../lib/dem-derivatives'
import { locateCopDemTiles, readCopDemGrid, readCopDemStats, type CopDemTile, type DemRasterStats } from '../lib/dem-raster'
import { buildDemCogTileUrl, buildDemHillshadeTileUrl } from '../lib/titiler'
import { isGeePreferred, geeDem, getGeeLastError } from '../lib/gee'
import type {
  ClassesPalette,
  GradientPalette,
  Provenance,
  ResultLayer,
  SummaryDatum,
  ToolCtx,
  ToolOutput,
} from '../lib/types'

const log = getLogger('tools/terrain')

// ---------------------------------------------------------------------------
// DEM elevation palette
// ---------------------------------------------------------------------------

function demPalette(minElev: number, maxElev: number): GradientPalette {
  return {
    kind: 'gradient', label: 'Elevation', unit: 'm', min: minElev, max: maxElev,
    stops: [
      { value: minElev,                              color: 'rgb(49,54,149)',   label: 'low' },
      { value: minElev + 0.25 * (maxElev - minElev), color: 'rgb(116,173,209)', label: 'mid-low' },
      { value: minElev + 0.50 * (maxElev - minElev), color: 'rgb(254,224,144)', label: 'mid' },
      { value: minElev + 0.75 * (maxElev - minElev), color: 'rgb(244,109,67)',  label: 'mid-high' },
      { value: maxElev,                              color: 'rgb(165,0,38)',    label: 'high' },
    ],
  }
}

// ---------------------------------------------------------------------------
// DEM grid cache (shared between fetchDem and fetchElevationDerivatives)
// ---------------------------------------------------------------------------

export interface DemGridResult {
  elevGrid: number[][]
  usedSide: number
  minElev: number
  maxElev: number
  meanElev: number
  relief: number
  stddev: number
  bbox: [number, number, number, number]
  /** Meters per column step (east–west). */
  cellSizeX: number
  /** Meters per row step (north–south). */
  cellSizeY: number
  polygonFiltered: boolean
  elevations: number[]
  /** Where min / max / mean / relief / stddev come from. `raster` = every pixel of the Copernicus DEM inside the
   *  polygon; `sampled` = the point grid only (the raster could not be read), which is NOT an extremum. */
  statsSource: 'raster' | 'sampled'
  raster: DemRasterStats | null
  /** Copernicus DEM tiles meeting the AOI (for the map layers); null when the catalogue was unreachable. */
  tiles: CopDemTile[] | null
}

const _demGridCache = new Map<string, { data: DemGridResult; ts: number }>()
const DEM_GRID_TTL_MS = 10 * 60 * 1000

// Mapzen is opentopodata.org's best-available global merged DEM (SRTM, 3DEP 10m in
// the US, and other regional high-res sources) at ~30 m — finer than srtm90m at the
// same 100-point request cost. Override via OPEN_ELEVATION_ENDPOINT in .env.
const DEM_ENDPOINT = process.env.OPEN_ELEVATION_ENDPOINT || 'https://api.opentopodata.org/v1/mapzen'
export const DEM_DATASET_LABEL = /srtm90m/.test(DEM_ENDPOINT) ? 'SRTM 90m'
  : /srtm30m/.test(DEM_ENDPOINT) ? 'SRTM 30m'
  : /mapzen/.test(DEM_ENDPOINT) ? 'Mapzen ~30m (global merged)'
  : /aster/.test(DEM_ENDPOINT) ? 'ASTER 30m'
  : 'opentopodata DEM'

function buildGrid(bbox: [number, number, number, number], side: number) {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const locs: { latitude: number; longitude: number; row: number; col: number }[] = []
  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      locs.push({
        latitude:  minLat + (maxLat - minLat) * (row / (side - 1)),
        longitude: minLng + (maxLng - minLng) * (col / (side - 1)),
        row, col,
      })
    }
  }
  return locs
}

/** Fetch (or return cached) the elevation point-grid for `bbox` from opentopodata.org.
 *  Returns null on network error or ocean/polar coverage.
 *
 *  Grid is a single 10×10 = 100-point request (opentopodata.org hard limit is 100
 *  locations/request — a denser single request returns HTTP 400). This grid feeds
 *  the polygon-true headline stats (min/max/mean/relief/stddev), the W→E profile,
 *  and the slope/aspect/contour derivatives. The high-resolution *visualization*
 *  comes from real per-pixel Copernicus DEM 30m tiles via titiler (see fetchDem),
 *  so this grid no longer needs to be dense for a sharp picture.
 *
 *  ISS-129 — exported so `classify_land_cover` can reuse this exact signal as an
 *  independent land check when ESA WorldCover is unavailable: a `null` return
 *  here means opentopodata.org found no usable elevation anywhere in the AOI
 *  (network failure OR the all-null "ocean/polar" response `fetchDem` already
 *  handles below) — either way, that is "did not confirm land," not "confirmed
 *  ocean," so the caller should treat it as inconclusive, not as proof of water. */
export async function getDemGrid(aoi: any, bbox: [number, number, number, number]): Promise<DemGridResult | null> {
  const out = await getDemGridOutcome(aoi, bbox)
  return out.ok ? out.data : null
}

/** `getDemGrid` that tells a failed request apart from a request that returned no elevation. */
export type DemGridOutcome =
  | { ok: true; data: DemGridResult }
  | { ok: false; kind: 'fetch-failed'; error: unknown }
  | { ok: false; kind: 'no-elevation' }

export async function getDemGridOutcome(aoi: any, bbox: [number, number, number, number]): Promise<DemGridOutcome> {
  const key = bbox.map(v => v.toFixed(5)).join(',')
  const cached = _demGridCache.get(key)
  if (cached && Date.now() - cached.ts < DEM_GRID_TTL_MS) return { ok: true, data: cached.data }

  const [minLng, minLat, maxLng, maxLat] = bbox

  // 10×10 = 100 points — the maximum opentopodata.org accepts in a single request.
  const usedSide = 10
  const denseGrid = buildGrid(bbox, usedSide)

  const locStr = denseGrid
    .map(l => `${l.latitude.toFixed(6)},${l.longitude.toFixed(6)}`)
    .join('|')

  // The raster statistics do not depend on the point grid, so the two run together.
  const rasterRead = (async () => {
    const tiles = await locateCopDemTiles(bbox)
    return { tiles, raster: tiles ? await readCopDemStats(aoi, tiles) : null }
  })()

  let demJson: any
  try {
    demJson = await cachedFetchJson(`dem:${locStr}`, { source: 'dem', persist: true }, async () => {
      const res = await fetchWithRetry(DEM_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations: locStr }),
        signal: AbortSignal.timeout(25000),
      })
      if (!res.ok) {
        const errTxt = await res.text().catch(() => '')
        throw new Error(`opentopodata.org HTTP ${res.status}: ${errTxt.slice(0, 120)}`)
      }
      return res.json()
    })
  } catch (error) {
    return { ok: false, kind: 'fetch-failed', error }
  }

  const demResults: any[] = demJson.results || []

  const inPolygonIdx: number[] = []
  for (let i = 0; i < denseGrid.length; i++) {
    const e = demResults[i]?.elevation
    if (e == null || isNaN(e)) continue
    const { longitude, latitude } = denseGrid[i]
    if (pointInAoi(longitude, latitude, aoi)) inPolygonIdx.push(i)
  }

  let sampleIdx = inPolygonIdx
  let polygonFiltered = true
  if (sampleIdx.length < 4) {
    sampleIdx = demResults
      .map((r, i) => (r?.elevation != null && !isNaN(r.elevation) ? i : -1))
      .filter(i => i >= 0)
    polygonFiltered = false
  }

  if (sampleIdx.length === 0) return { ok: false, kind: 'no-elevation' }

  const elevations = sampleIdx.map(i => demResults[i].elevation as number)
  const { tiles, raster } = await rasterRead
  const sampledMean = elevations.reduce((a, b) => a + b, 0) / elevations.length
  // Area statistics come from the raster when it was read. The point grid (100 samples) misses summits and
  // pits between its points, so its extremes are only ever offered as "sampled".
  const minElev    = raster ? raster.minM : Math.min(...elevations)
  const maxElev    = raster ? raster.maxM : Math.max(...elevations)
  const meanElev   = raster ? raster.meanM : sampledMean
  const relief     = maxElev - minElev
  const stddev     = raster ? raster.stdM : Math.sqrt(
    elevations.map(e => (e - sampledMean) ** 2).reduce((a, b) => a + b, 0) / elevations.length
  )

  // Build 2D elevation grid: row 0 = north (max latitude)
  const elevGrid: number[][] = []
  for (let r = 0; r < usedSide; r++) {
    elevGrid.push([])
    for (let c = 0; c < usedSide; c++) {
      const origRow = usedSide - 1 - r
      const idx = origRow * usedSide + c
      elevGrid[r].push(demResults[idx]?.elevation ?? sampledMean)
    }
  }

  const centerLat = (minLat + maxLat) / 2
  const cellSizeY = (maxLat - minLat) / (usedSide - 1) * 111320
  const cellSizeX = (maxLng - minLng) / (usedSide - 1) * 111320 * Math.cos(centerLat * Math.PI / 180)

  const data: DemGridResult = {
    elevGrid, usedSide, minElev, maxElev, meanElev, relief, stddev,
    bbox, cellSizeX, cellSizeY, polygonFiltered, elevations,
    statsSource: raster ? 'raster' : 'sampled', raster, tiles,
  }
  _demGridCache.set(key, { data, ts: Date.now() })
  return { ok: true, data }
}

// ---------------------------------------------------------------------------
// Copernicus DEM 30m — real per-pixel raster tiles via PC STAC + titiler
// ---------------------------------------------------------------------------

/** The map's elevation layers: one colour-relief layer and one hillshade layer PER Copernicus DEM tile that meets
 *  the AOI, each bounded to the part of the AOI inside its tile. One tile's URL for the whole AOI (the earlier
 *  design) answers "outside bounds" for the part across a 1-degree cell edge and leaves a hole in the map.
 *
 *  The tile URLs are NOT probed first (a blocking HEAD cost ~1.7 s, 45% of the call): the map loads the tiles
 *  lazily and flags the layer when they fail (MapPanel's `map.on('error')` -> the layer's `expired` flag). */
function copDemLayers(
  tiles: CopDemTile[],
  aoiBbox: [number, number, number, number],
  minElev: number,
  maxElev: number,
  terrainClass: string,
  provenance: { colour: Provenance; shade: Provenance },
  palette: GradientPalette,
): { colour: ResultLayer[]; shade: ResultLayer[] } {
  const colour: ResultLayer[] = []
  const shade: ResultLayer[] = []
  tiles.forEach((tile, i) => {
    const bounds: [number, number, number, number] = [
      Math.max(aoiBbox[0], tile.bbox[0]), Math.max(aoiBbox[1], tile.bbox[1]),
      Math.min(aoiBbox[2], tile.bbox[2]), Math.min(aoiBbox[3], tile.bbox[3]),
    ]
    if (!(bounds[2] > bounds[0] && bounds[3] > bounds[1])) return // the AOI only touches this tile's edge
    const first = colour.length === 0
    const part = first ? '' : ` (tile ${colour.length + 1})`
    colour.push({
      id: first ? 'dem-active' : `dem-active-${i}`,
      name: `DEM: ${terrainClass} (${minElev.toFixed(0)}–${maxElev.toFixed(0)} m)${part}`,
      type: 'raster' as const,
      tileUrl: buildDemCogTileUrl(tile.href, minElev, maxElev),
      bounds,
      palette,
      provenance: provenance.colour,
      confidence: 'high',
    })
    shade.push({
      id: first ? 'dem-hillshade-active' : `dem-hillshade-active-${i}`,
      name: `Hillshade (shaded relief, 30 m)${part}`,
      type: 'raster' as const,
      tileUrl: buildDemHillshadeTileUrl(tile.href),
      bounds,
      provenance: provenance.shade,
      confidence: 'high',
    })
  })
  return { colour, shade }
}

// ---------------------------------------------------------------------------
// fetch_dem
// ---------------------------------------------------------------------------

export async function fetchDem(ctx: ToolCtx): Promise<ToolOutput> {
  const { aoi, bbox, centroid, areaKm2 } = ctx
  const [minLng, minLat, maxLng, maxLat] = bbox

  const outcome = await getDemGridOutcome(aoi, bbox)

  if (!outcome.ok) {
    return {
      summary: outcome.kind === 'fetch-failed'
        ? fetchFailureNote(`the elevation API (opentopodata.org ${DEM_DATASET_LABEL})`, outcome.error)
        : `The elevation API (opentopodata.org ${DEM_DATASET_LABEL}) answered but returned no elevation for this area (all null — it may be ocean or polar, outside the dataset's coverage).\n\nDraw a land AOI.`,
    }
  }
  const dem = outcome.data

  const { elevGrid, usedSide, minElev, maxElev, meanElev, relief, stddev, polygonFiltered, elevations } = dem

  const terrainClass =
    relief < 20   ? 'Flat plains / coastal lowland' :
    relief < 100  ? 'Gently rolling terrain' :
    relief < 300 && stddev < 80 ? 'Hilly terrain' :
    relief < 1000 ? 'Mountainous' :
    'High mountain / alpine'

  const fromRaster = dem.statsSource === 'raster' && dem.raster != null
  const gsdM = dem.raster ? Number(dem.raster.gsdM.toFixed(1)) : null
  // Raster statistics are the area's true lowest / highest pixel. The 100-point grid cannot give an extremum
  // (it missed the Matterhorn by 370 m and Everest by 250 m), so without the raster its extremes are keyed
  // and worded as what they are: the lowest and highest SAMPLED point.
  const demSd: Record<string, SummaryDatum> = fromRaster
    ? {
        min_elevation_m: Math.round(minElev),
        max_elevation_m: Math.round(maxElev),
        mean_elevation_m: Math.round(meanElev),
        relief_m: Math.round(relief),
        stddev_m: Number(stddev.toFixed(1)),
        terrain_class: terrainClass,
        area_km2: Number(areaKm2.toFixed(1)),
        elevation_stats_source: 'Copernicus DEM GLO-30 raster, every pixel inside the polygon',
        dem_pixels: dem.raster!.pixels,
        dem_gsd_m: gsdM!,
      }
    : {
        sampled_lowest_elevation_m: Math.round(minElev),
        sampled_highest_elevation_m: Math.round(maxElev),
        sampled_mean_elevation_m: Math.round(meanElev),
        sampled_points: elevations.length,
        terrain_class: terrainClass,
        area_km2: Number(areaKm2.toFixed(1)),
        elevation_stats_source: `${DEM_DATASET_LABEL} point grid; the Copernicus DEM raster could not be read`,
      }

  // W→E profile: mid-row cross-section (sampled points)
  const profilePts = Array.from({ length: usedSide }, (_, col) => ({
    dist: parseFloat(((maxLng - minLng) * 111 * col / (usedSide - 1)).toFixed(2)),
    elev: dem.elevGrid[Math.floor(usedSide / 2)][col] ?? Math.round(meanElev),
  }))
  const profileStr = profilePts.map(p => `${p.dist}km:${p.elev}m`).join(' → ')
  // Expose the REAL cross-section to the client as a chartable series (the
  // Spatial Charts elevation tab previously synthesized a sine-wave profile).
  demSd.elevation_profile = profilePts.map((p) => ({ label: `${p.dist}`, value: Math.round(p.elev) }))
  demSd.elevation_profile_points = usedSide

  const clipNote = polygonFiltered
    ? `${elevations.length} in-polygon samples (clipped to drawn AOI)`
    : `${elevations.length} samples across AOI bbox — polygon smaller than ${DEM_DATASET_LABEL} grid spacing`

  /** The statistics block of the summary, worded for where the numbers came from. */
  const statsText = fromRaster
    ? `**Elevation statistics (${dem.raster!.source}):**\n- Lowest pixel: **${minElev.toFixed(0)} m**\n- Highest pixel: **${maxElev.toFixed(0)} m**\n- Mean: **${Math.round(meanElev)} m**\n- Relief: **${relief.toFixed(0)} m**\n- Std deviation: **${stddev.toFixed(1)} m**\n\n_A 30 m cell averages a narrow summit or pit, so in steep terrain the true highest point can be higher (and the lowest lower) than these pixel values by up to a few hundred metres._`
    : `**Elevation SAMPLED at ${elevations.length} points (${DEM_DATASET_LABEL} via opentopodata.org; the Copernicus DEM raster could not be read):**\n- Lowest sampled point: **${minElev.toFixed(0)} m**\n- Highest sampled point: **${maxElev.toFixed(0)} m**\n- Mean of the samples: **${Math.round(meanElev)} m**\n\n_These are the extremes of ${elevations.length} sample points, **not the area's minimum or maximum**: a summit or pit between the points is missed, so do not state them as the highest or lowest elevation._`

  const terrainWord = fromRaster ? terrainClass : `${terrainClass} (from the sampled points)`

  const demBounds: [number, number, number, number] = [minLng, minLat, maxLng, maxLat]

  // ── Optional accelerator (GEE_PREFERRED=1): colour relief + hillshade (server-rendered)
  if (isGeePreferred()) {
    ctx.emit?.('token', { type: 'token', content: 'Rendering Copernicus DEM 30 m colour relief + hillshade (Google Earth Engine)...\n' })
    const g = await geeDem(aoi)
    if (g) {
      const extra: ResultLayer[] = []
      if (g.hillshadeUrl) {
        extra.push({
          id: 'dem-hillshade-active',
          name: 'Hillshade (shaded relief, GEE)',
          type: 'raster' as const,
          tileUrl: g.hillshadeUrl,
          bounds: demBounds,
          provenance: { source: 'Copernicus DEM GLO-30 (Google Earth Engine)', method: 'ee.Terrain.hillshade, server-rendered', clip: 'polygon' },
          confidence: 'high',
        })
      }
      const gMean = g.mean != null ? Math.round(g.mean) : Math.round(meanElev)
      return {
        summary: `Digital Elevation Model for ${areaKm2.toFixed(1)} km² at ${centroid.lat.toFixed(4)}°N, ${centroid.lng.toFixed(4)}°E.\n\n**Real elevation statistics (Copernicus DEM GLO-30 via Google Earth Engine):**\n- Min: **${g.min} m**\n- Max: **${g.max} m**\n- Mean: **${gMean} m**\n- Relief: **${g.max - g.min} m**\n\n**Terrain class:** ${terrainClass}\n\n**Map layers:** GEE-rendered **colour relief** + a greyscale **hillshade** (real per-pixel 30 m, polygon-clipped). Toggle 3D terrain for the full relief view.`,
        summary_data: { ...demSd, min_elevation_m: g.min, max_elevation_m: g.max, mean_elevation_m: gMean, relief_m: g.max - g.min },
        layer: {
          id: 'dem-active',
          name: `DEM: ${terrainClass} (${g.min}–${g.max} m, GEE)`,
          type: 'raster' as const,
          tileUrl: g.colorUrl,
          bounds: demBounds,
          palette: demPalette(g.min, g.max),
          provenance: { source: 'Copernicus DEM GLO-30 (Google Earth Engine)', method: 'GEE server-rendered 30 m colour relief · polygon reduceRegion stats', clip: 'polygon' },
          confidence: 'high',
        },
        layers: extra.length > 0 ? extra : undefined,
      }
    }
    ctx.emit?.('token', { type: 'token', content: `GEE unavailable (${getGeeLastError() ?? 'unknown'}) — falling back to Planetary Computer + titiler...\n` })
  }

  // ── Fallback: real per-pixel Copernicus DEM 30m tiles (PC + titiler) ────────
  const demTiles = dem.tiles ?? []
  if (demTiles.length > 0) {
    debugLog(`[DEM] real per-pixel cop-dem-30 tiles x${demTiles.length} (${minElev.toFixed(0)}–${maxElev.toFixed(0)} m)`)
    const { colour, shade } = copDemLayers(
      demTiles, demBounds, minElev, maxElev, terrainClass,
      {
        colour: {
          source: fromRaster
            ? 'Copernicus DEM 30m (PC STAC) + titiler: the colour ramp and the statistics are the same raster'
            : `Map imagery: Copernicus DEM 30m (PC STAC) + titiler · Statistics: ${DEM_DATASET_LABEL} via opentopodata.org (sampled points)`,
          method: fromRaster ? 'real per-pixel 30 m COG tiles, one layer per DEM tile the AOI meets' : `map layer: real per-pixel 30 m COG tiles · statistics: ${DEM_DATASET_LABEL} point-sampled grid`,
          clip: 'bbox',
        },
        shade: {
          source: 'Copernicus DEM 30m (PC STAC) + titiler hillshade algorithm',
          method: 'real per-pixel 30 m shaded relief',
          clip: 'bbox',
        },
      },
      demPalette(minElev, maxElev),
    )
    if (colour.length > 0) {
      return {
        summary: `Digital Elevation Model for ${areaKm2.toFixed(1)} km² at ${centroid.lat.toFixed(4)}°N, ${centroid.lng.toFixed(4)}°E.\n\n${statsText}\n\n**Terrain class:** ${terrainWord}\n\n**W→E elevation cross-section (${usedSide} sampled points, mid-row):**\n${profileStr}\n\n**Map layers:** real per-pixel **Copernicus DEM 30 m** colour relief + greyscale **hillshade** via titiler${colour.length > 1 ? ` (${colour.length} DEM tiles, because the area crosses a 1-degree tile edge)` : ''}. Toggle on 3D terrain for the full relief view.`,
        summary_data: demSd,
        layer: colour[0],
        layers: [...colour.slice(1), ...shade],
      }
    }
  }

  // ── Fallback: point-interpolated sharp PNG (no cop-dem / titiler) ───────────
  const elevRange = Math.max(1, maxElev - minElev)
  const normGrid  = elevGrid.map(row => row.map(e => (e - minElev) / elevRange))

  let imageBase64: string | undefined
  try {
    imageBase64 = await generateRasterPng(normGrid, elevToRgb, 200, 200, {
      polygon: aoi,
      bounds: [minLng, minLat, maxLng, maxLat],
    })
    debugLog(`[DEM] fallback 200×200 PNG from ${usedSide}×${usedSide} grid (clip=${polygonFiltered ? 'polygon' : 'bbox'})`)
  } catch (err: any) {
    log.error({ tool: 'dem', err: err.message }, 'PNG generation failed')
  }

  if (!imageBase64) {
    const terrainColor =
      relief > 1000 ? '#7c3aed' : relief > 300 ? '#2563eb' : relief > 50 ? '#0891b2' : '#0d9488'
    return {
      summary: `Digital Elevation Model (${DEM_DATASET_LABEL}) for ${areaKm2.toFixed(1)} km².\n\n${statsText}\n\nTerrain: ${terrainWord}\n\nData: ${DEM_DATASET_LABEL} via opentopodata.org (${clipNote}).`,
      summary_data: demSd,
      layer: {
        id: 'dem-active',
        name: `Terrain: ${terrainClass}`,
        type: 'geojson' as const,
        geojson: {
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            properties: { mean_elevation: Math.round(meanElev), relief: Math.round(relief), terrain: terrainClass, color: terrainColor, fill: terrainColor },
            geometry: { type: 'Polygon', coordinates: [[[minLng, minLat], [maxLng, minLat], [maxLng, maxLat], [minLng, maxLat], [minLng, minLat]]] },
          }],
        },
        palette: demPalette(minElev, maxElev),
      },
    }
  }

  return {
    summary: `Digital Elevation Model (${DEM_DATASET_LABEL}) for ${areaKm2.toFixed(1)} km² at ${centroid.lat.toFixed(4)}°N, ${centroid.lng.toFixed(4)}°E.\n\n${statsText}\n\n**Terrain class:** ${terrainWord}\n\n**W→E elevation cross-section (bbox-wide, mid-row):**\n${profileStr}\n\n**Color ramp:** low(blue) → mid(tan) → high(dark red)\nData: ${DEM_DATASET_LABEL} via opentopodata.org · ${clipNote} · bilinearly interpolated PNG (alpha-clipped to AOI polygon). _Copernicus DEM tile layer unavailable — showing interpolated fallback._`,
    summary_data: demSd,
    layer: {
      id: 'dem-active',
      name: `DEM: ${terrainClass} (${minElev.toFixed(0)}–${maxElev.toFixed(0)} m)`,
      type: 'raster' as const,
      imageBase64,
      bounds: [minLng, minLat, maxLng, maxLat],
      palette: demPalette(minElev, maxElev),
      provenance: {
        source: `${DEM_DATASET_LABEL} via opentopodata.org`,
        method: 'bilinear interpolation · polygon alpha-clip',
        clip: polygonFiltered ? 'polygon' : 'bbox',
      },
      confidence: polygonFiltered ? 'high' : 'medium',
    },
  }
}

// ---------------------------------------------------------------------------
// fetch_elevation_derivatives
// ---------------------------------------------------------------------------

const ASPECT_PALETTE: ClassesPalette = {
  kind: 'classes',
  label: 'Aspect',
  unit: '°',
  classes: [
    { color: 'rgb(65,105,225)',  label: 'N  (0°)'   },
    { color: 'rgb(0,190,150)',   label: 'NE (45°)'  },
    { color: 'rgb(50,200,50)',   label: 'E  (90°)'  },
    { color: 'rgb(180,215,45)', label: 'SE (135°)'  },
    { color: 'rgb(255,215,0)',   label: 'S  (180°)'  },
    { color: 'rgb(255,130,0)',   label: 'SW (225°)'  },
    { color: 'rgb(210,45,45)',   label: 'W  (270°)'  },
    { color: 'rgb(170,70,210)',  label: 'NW (315°)'  },
  ],
}

export async function fetchElevationDerivatives(
  ctx: ToolCtx,
  args: Record<string, any>,
): Promise<ToolOutput> {
  const { aoi, bbox, areaKm2 } = ctx
  const [minLng, minLat, maxLng, maxLat] = bbox

  const kind = (['slope', 'aspect', 'contours', 'all'].includes(args.kind as string)
    ? args.kind as string
    : 'all')

  ctx.emit?.('token', {
    type: 'token',
    content: `Computing ${kind === 'all' ? 'slope, aspect, and contours' : kind} from ${DEM_DATASET_LABEL}...\n`,
  })

  const outcome = await getDemGridOutcome(aoi, bbox)
  if (!outcome.ok) {
    return {
      summary: outcome.kind === 'fetch-failed'
        ? fetchFailureNote(`the elevation API (opentopodata.org ${DEM_DATASET_LABEL})`, outcome.error)
        : `The elevation API (opentopodata.org ${DEM_DATASET_LABEL}) answered but returned no elevation for this area. ` +
          'Verify coverage by running `fetch_dem` first, or reduce the AOI size.',
    }
  }
  const dem = outcome.data

  // Slope, aspect and contours from the Copernicus DEM raster (up to 150 px on the long edge) when it can be
  // read: a 10 x 10 point grid is ~1 km between points and smooths a canyon's slopes away.
  const fine = dem.tiles && dem.tiles.length > 0 ? await readCopDemGrid(aoi, dem.tiles, 150) : null
  let elevGrid = dem.elevGrid
  let usedSide = dem.usedSide
  let cellSizeX = dem.cellSizeX
  let cellSizeY = dem.cellSizeY
  let gridNote = `${dem.usedSide}×${dem.usedSide} ${DEM_DATASET_LABEL} point grid`
  if (fine) {
    let sum = 0
    let n = 0
    for (const v of fine.values) if (v === v) { sum += v; n++ }
    const fill = n > 0 ? sum / n : 0 // outside the polygon: the mean, as for the point grid (the layer is alpha-clipped)
    elevGrid = Array.from({ length: fine.height }, (_, r) => Array.from({ length: fine.width }, (_, c) => {
      const v = fine.values[r * fine.width + c]
      return v === v ? v : fill
    }))
    usedSide = Math.max(fine.width, fine.height)
    const centerLat = (minLat + maxLat) / 2
    cellSizeX = ((maxLng - minLng) / fine.width) * 111320 * Math.cos((centerLat * Math.PI) / 180)
    cellSizeY = ((maxLat - minLat) / fine.height) * 110540
    gridNote = `${fine.width}×${fine.height} Copernicus DEM pixels at ~${Math.round(Math.max(cellSizeX, cellSizeY))} m`
  }
  const { minElev, maxElev, relief } = dem
  const pngSize = usedSide >= 20 ? 300 : 200

  // Auto-select a sensible contour interval if not specified
  const requestedInterval = Number(args.contour_interval)
  const autoInterval =
    relief < 50   ?   5 :
    relief < 200  ?  10 :
    relief < 500  ?  25 :
    relief < 1000 ?  50 : 100
  const contourInterval = isFinite(requestedInterval) && requestedInterval >= 5
    ? Math.round(requestedInterval)
    : autoInterval

  const doSlope    = kind === 'slope'    || kind === 'all'
  const doAspect   = kind === 'aspect'   || kind === 'all'
  const doContours = kind === 'contours' || kind === 'all'

  const provSource = fine ? 'Copernicus DEM GLO-30 (Planetary Computer)' : `${DEM_DATASET_LABEL} via opentopodata.org (point grid)`
  const provMethod = 'Horn (1981) finite-difference'

  // P4.2 — accumulate citable figures across whichever derivatives were computed.
  const derivSd: Record<string, SummaryDatum> = {
    ...(dem.statsSource === 'raster'
      ? { min_elevation_m: Math.round(minElev), max_elevation_m: Math.round(maxElev), relief_m: Math.round(relief) }
      : { sampled_lowest_elevation_m: Math.round(minElev), sampled_highest_elevation_m: Math.round(maxElev) }),
    area_km2: Number(areaKm2.toFixed(1)),
    derivative_grid: gridNote,
  }

  // ---- slope -----------------------------------------------------------------
  let slopeLayer: ResultLayer | undefined
  let slopeSummary = ''

  if (doSlope) {
    const slopeGrid = computeSlope(elevGrid, cellSizeX, cellSizeY)
    const maxSlope  = slopeGrid.max || 1
    const meanSlope = slopeGrid.values.flat().reduce((a, b) => a + b, 0) /
                      (slopeGrid.rows * slopeGrid.cols)
    const dist      = slopeDistribution(slopeGrid.values.flat())

    const normGrid = slopeGrid.values.map(row => row.map(s => s / maxSlope))

    let slopeImg: string | undefined
    try {
      slopeImg = await generateRasterPng(normGrid, slopeToRgb, pngSize, pngSize, {
        polygon: aoi,
        bounds: [minLng, minLat, maxLng, maxLat],
      })
    } catch (err: any) {
      log.error({ tool: 'elevation_derivatives', err: err.message }, 'slope PNG failed')
    }

    const slopePalette: GradientPalette = {
      kind: 'gradient', label: 'Slope', unit: '%',
      min: 0, max: Math.round(maxSlope),
      stops: [
        { value: 0,                        color: 'rgb(255,255,200)', label: 'flat' },
        { value: Math.round(maxSlope * 0.25), color: 'rgb(255,200,50)',  label: 'gentle' },
        { value: Math.round(maxSlope * 0.5),  color: 'rgb(255,130,15)',  label: 'moderate' },
        { value: Math.round(maxSlope * 0.75), color: 'rgb(190,30,10)',   label: 'steep' },
        { value: Math.round(maxSlope),     color: 'rgb(110,0,0)',     label: 'extreme' },
      ],
    }

    slopeLayer = {
      id: `slope-raster-${genId()}`,
      name: `Slope (max ${Math.round(maxSlope)}%, ${DEM_DATASET_LABEL})`,
      type: slopeImg ? 'raster' : 'geojson',
      ...(slopeImg
        ? { imageBase64: slopeImg, bounds: [minLng, minLat, maxLng, maxLat] }
        : {
            geojson: {
              type: 'FeatureCollection',
              features: [{
                type: 'Feature',
                properties: { color: '#f97316', fill: '#f97316' },
                geometry: { type: 'Polygon', coordinates: [[[minLng, minLat], [maxLng, minLat], [maxLng, maxLat], [minLng, maxLat], [minLng, minLat]]] },
              }],
            },
          }),
      palette: slopePalette,
      provenance: { source: provSource, method: `${provMethod} slope`, clip: dem.polygonFiltered ? 'polygon' : 'bbox' },
      confidence: 'high',
    }

    slopeSummary =
      `**Slope (${DEM_DATASET_LABEL}, Horn 1981):**\n` +
      `- Mean slope: **${meanSlope.toFixed(1)}%** | Max: **${Math.round(maxSlope)}%**\n` +
      `- Distribution: flat (<5%) ${dist.flat}% · gentle (5–15%) ${dist.gentle}% · ` +
      `moderate (15–30%) ${dist.moderate}% · steep (30–60%) ${dist.steep}% · ` +
      `very steep (>60%) ${dist.verysteep}%`

    derivSd.mean_slope_pct = Number(meanSlope.toFixed(1))
    derivSd.max_slope_pct = Math.round(maxSlope)
    derivSd.slope_distribution = [
      { label: 'flat', value: dist.flat },
      { label: 'gentle', value: dist.gentle },
      { label: 'moderate', value: dist.moderate },
      { label: 'steep', value: dist.steep },
      { label: 'v.steep', value: dist.verysteep },
    ]
  }

  // ---- aspect ----------------------------------------------------------------
  let aspectLayer: ResultLayer | undefined
  let aspectSummary = ''

  if (doAspect) {
    const aspectGrid = computeAspect(elevGrid, cellSizeX, cellSizeY)
    const flatVals   = aspectGrid.values.flat()

    // Count cells per compass octant
    const octantCounts = new Array(8).fill(0)
    for (const deg of flatVals) octantCounts[aspectClass(deg)]++
    const total = flatVals.length || 1
    const dominantOctant = octantCounts.indexOf(Math.max(...octantCounts))
    const dominantPct    = Math.round((octantCounts[dominantOctant] / total) * 100)

    const normAspect = aspectGrid.values.map(row => row.map(a => a / 360))

    let aspectImg: string | undefined
    try {
      aspectImg = await generateRasterPng(normAspect, aspectToRgb, pngSize, pngSize, {
        polygon: aoi,
        bounds: [minLng, minLat, maxLng, maxLat],
      })
    } catch (err: any) {
      log.error({ tool: 'elevation_derivatives', err: err.message }, 'aspect PNG failed')
    }

    aspectLayer = {
      id: `aspect-raster-${genId()}`,
      name: `Aspect (dominant: ${COMPASS_LABELS[dominantOctant]})`,
      type: aspectImg ? 'raster' : 'geojson',
      ...(aspectImg
        ? { imageBase64: aspectImg, bounds: [minLng, minLat, maxLng, maxLat] }
        : {
            geojson: {
              type: 'FeatureCollection',
              features: [{
                type: 'Feature',
                properties: { color: '#6366f1', fill: '#6366f1' },
                geometry: { type: 'Polygon', coordinates: [[[minLng, minLat], [maxLng, minLat], [maxLng, maxLat], [minLng, maxLat], [minLng, minLat]]] },
              }],
            },
          }),
      palette: ASPECT_PALETTE,
      provenance: { source: provSource, method: `${provMethod} aspect`, clip: dem.polygonFiltered ? 'polygon' : 'bbox' },
      confidence: 'high',
    }

    const octantStr = octantCounts
      .map((n, i) => `${COMPASS_LABELS[i]}: ${Math.round((n / total) * 100)}%`)
      .join(' · ')
    aspectSummary =
      `**Aspect (${DEM_DATASET_LABEL}, Horn 1981):**\n` +
      `- Dominant facing: **${COMPASS_LABELS[dominantOctant]}** (${dominantPct}% of AOI)\n` +
      `- Octant distribution: ${octantStr}`

    derivSd.dominant_aspect = COMPASS_LABELS[dominantOctant]
    derivSd.dominant_aspect_pct = dominantPct
  }

  // ---- contours --------------------------------------------------------------
  let contoursLayer: ResultLayer | undefined
  let contourSummary = ''

  if (doContours) {
    const result = computeContours(elevGrid, contourInterval, [minLng, minLat, maxLng, maxLat])

    if (result.levels.length > 0) {
      // Color each contour feature by elevation (dark-olive for all — consistent line style)
      const featuresWithColor = result.featureCollection.features.map(f => ({
        ...f,
        properties: { ...f.properties, color: '#5c3d1e', stroke: '#5c3d1e', 'stroke-width': 1 },
      }))

      contoursLayer = {
        id: `contours-${genId()}`,
        name: `Contours (${contourInterval} m interval, ${minElev.toFixed(0)}–${maxElev.toFixed(0)} m)`,
        type: 'geojson',
        geojson: { ...result.featureCollection, features: featuresWithColor },
        provenance: {
          source: provSource,
          method: `marching-squares contours at ${contourInterval} m interval · computed from ${gridNote}`,
          clip: dem.polygonFiltered ? 'polygon' : 'bbox',
        },
        confidence: 'high',
        palette: {
          kind: 'gradient',
          label: 'Elevation',
          unit: 'm',
          min: Math.round(result.minElev),
          max: Math.round(result.maxElev),
          stops: [
            { value: Math.round(result.minElev), color: 'rgb(49,54,149)',   label: 'low' },
            { value: Math.round(result.minElev + 0.5 * relief), color: 'rgb(254,224,144)', label: 'mid' },
            { value: Math.round(result.maxElev), color: 'rgb(165,0,38)',   label: 'high' },
          ],
        } satisfies GradientPalette,
      }

      contourSummary =
        `**Contours (marching squares, ${contourInterval} m interval):**\n` +
        `- ${result.levels.length} contour levels · ${result.totalLines} continuous lines (joined from ${result.totalSegments} cell crossings)\n` +
        `- Elevation range covered: ${result.minElev.toFixed(0)}–${result.maxElev.toFixed(0)} m`

      derivSd.contour_levels = result.levels.length
      derivSd.contour_lines = result.totalLines
      derivSd.contour_segments = result.totalSegments
      derivSd.contour_interval_m = contourInterval
    } else {
      contourSummary =
        `**Contours:** No contour lines generated at ${contourInterval} m interval ` +
        `(relief = ${relief.toFixed(0)} m — try a smaller interval).`
    }
  }

  // ---- assemble result -------------------------------------------------------
  const clipNote = dem.polygonFiltered
    ? `Polygon-clipped (${dem.elevations.length} ${DEM_DATASET_LABEL} samples)`
    : `Bbox-clipped (polygon smaller than ${DEM_DATASET_LABEL} spacing)`

  const sections = [slopeSummary, aspectSummary, contourSummary].filter(Boolean)
  const summary =
    `**Elevation Derivatives for ${areaKm2.toFixed(1)} km² AOI** ` +
    `(elevation ${minElev.toFixed(0)}–${maxElev.toFixed(0)} m, relief ${dem.relief.toFixed(0)} m)\n\n` +
    sections.join('\n\n') +
    `\n\n_Source: ${DEM_DATASET_LABEL} via opentopodata.org · ${clipNote} · Horn (1981) finite-difference · marching-squares contours._`

  // Primary layer = slope (or aspect or contours depending on kind)
  const primary = doSlope ? slopeLayer : doAspect ? aspectLayer : contoursLayer
  const extras: ResultLayer[] = []
  if (doSlope && slopeLayer && primary !== slopeLayer) extras.push(slopeLayer)
  if (doAspect && aspectLayer && primary !== aspectLayer) extras.push(aspectLayer)
  if (doContours && contoursLayer && primary !== contoursLayer) extras.push(contoursLayer)

  return {
    summary,
    summary_data: derivSd,
    layer: primary,
    layers: extras.length > 0 ? extras : undefined,
  }
}
