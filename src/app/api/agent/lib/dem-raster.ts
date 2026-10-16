/** Elevation from the Copernicus DEM 30 m raster itself (Planetary Computer `cop-dem-glo-30`).
 *
 *  A 10 x 10 grid of point samples cannot find a summit: the Matterhorn box read 4105 m (true summit
 *  4478 m) and the Everest box 8599 m (true 8849 m). Here every pixel of the polygon is read through
 *  titiler. The DEM is cut into 1-degree tiles, so an AOI across a tile edge needs several files: the
 *  same polygon and pixel budget are requested from each tile (titiler returns the same grid, valid only
 *  where that tile has data) and the grids are merged. */

import { chooseMaxSize } from './digitize/scene-grid'
import { getLogger } from './logger'
import { fetchCogFeatureGrid, toGeometry } from './pixels'
import { searchPCStac, signPCAsset } from './stac'

const log = getLogger('agent/dem-raster')

export const COP_DEM_COLLECTION = 'cop-dem-glo-30'
const NATIVE_GSD_M = 30
/** Longest edge of a read: 1000 px is 30 m for an AOI up to 30 km across, coarser beyond it (and reported). */
const MAX_GRID = 1000
const MAX_TILES = 9
const NODATA_BELOW = -500 // Copernicus uses -32767/-32768 for nodata; the lowest land, the Dead Sea shore, is -430 m

export interface CopDemTile {
  id: string
  /** SAS-signed COG href. */
  href: string
  bbox: [number, number, number, number]
}

export interface DemRasterStats {
  minM: number
  maxM: number
  meanM: number
  stdM: number
  /** Pixels read inside the polygon. */
  pixels: number
  /** Ground sample distance of the read (30 m when the AOI is up to 30 km across). */
  gsdM: number
  tiles: number
  source: string
}

/** Merged elevation grid over the polygon's bounding box; NaN outside the polygon or without data. Row 0 = north. */
export interface DemGrid {
  values: Float32Array
  width: number
  height: number
  gsdM: number
  tiles: number
}

/** Every Copernicus DEM tile that meets `bbox`, signed. Null when the catalogue could not be reached (a
 *  failure, which is different from no tile: the ocean has none). */
export async function locateCopDemTiles(bbox: [number, number, number, number]): Promise<CopDemTile[] | null> {
  try {
    const { features } = await searchPCStac(bbox, COP_DEM_COLLECTION, MAX_TILES)
    const tiles: CopDemTile[] = []
    for (const f of features ?? []) {
      const href = f?.assets?.data?.href
      if (!href || !Array.isArray(f.bbox)) continue
      tiles.push({ id: String(f.id), href: await signPCAsset(href), bbox: [f.bbox[0], f.bbox[1], f.bbox[2], f.bbox[3]] })
    }
    return tiles
  } catch (err: any) {
    log.warn({ err: err?.message }, 'cop-dem tile search failed')
    return null
  }
}

/** The merged DEM grid over the polygon, at most `maxSize` pixels on the longest edge (default: native 30 m).
 *  Null when a tile could not be read: a missing tile would bias the extremes, so no partial answer is given. */
export async function readCopDemGrid(aoi: any, tiles: CopDemTile[], maxSize?: number): Promise<DemGrid | null> {
  const geom = toGeometry(aoi)
  if (!geom || tiles.length === 0) return null
  const sizing = chooseMaxSize(geom, NATIVE_GSD_M, MAX_GRID)
  if (!sizing) return null
  const size = Math.max(16, Math.min(maxSize ?? sizing.maxSize, sizing.maxSize))

  let out: Float32Array | null = null
  let width = 0
  let height = 0
  let contributing = 0
  for (const tile of tiles) {
    let g
    try {
      g = await fetchCogFeatureGrid({ cogUrl: tile.href, geom, maxSize: size, cacheTag: 'copdem' })
    } catch (err: any) {
      // 404: the polygon does not reach into this tile (it only touches its edge): nothing to merge.
      if (/HTTP 404/.test(String(err?.message))) continue
      log.warn({ tile: tile.id, err: err?.message }, 'cop-dem tile read failed')
      return null
    }
    if (!out) {
      width = g.width
      height = g.height
      out = new Float32Array(width * height).fill(NaN)
    } else if (g.width !== width || g.height !== height) {
      log.warn({ tile: tile.id }, 'cop-dem tiles returned different grids')
      return null
    }
    let used = 0
    for (let i = 0; i < out.length; i++) {
      const v = g.values[i]
      if (out[i] === out[i] || !(g.mask[i] > 0) || !Number.isFinite(v) || v < NODATA_BELOW) continue
      out[i] = v
      used++
    }
    if (used > 0) contributing++
  }
  if (!out || contributing === 0) return null
  return { values: out, width, height, gsdM: (sizing.gsdM * sizing.maxSize) / size, tiles: contributing }
}

/** Min, max, mean and standard deviation of the DEM over the polygon, or null when it could not be read. */
export async function readCopDemStats(aoi: any, tiles: CopDemTile[]): Promise<DemRasterStats | null> {
  const grid = await readCopDemGrid(aoi, tiles)
  if (!grid) return null
  let n = 0
  let sum = 0
  let sumSq = 0
  let min = Infinity
  let max = -Infinity
  for (const v of grid.values) {
    if (v !== v) continue
    n++; sum += v; sumSq += v * v
    if (v < min) min = v
    if (v > max) max = v
  }
  if (n === 0) return null
  const mean = sum / n
  return {
    minM: min,
    maxM: max,
    meanM: mean,
    stdM: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
    pixels: n,
    gsdM: grid.gsdM,
    tiles: grid.tiles,
    source: `Copernicus DEM GLO-30 raster (Planetary Computer), ${n.toLocaleString('en-US')} pixels at ~${Math.round(grid.gsdM)} m`,
  }
}
