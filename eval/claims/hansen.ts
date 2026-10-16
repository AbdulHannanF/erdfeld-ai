/** Hansen Global Forest Change (GFC-2024-v1.12), the independent label source for the claim
 *  evaluation. Read through titiler's /cog/bbox from the public Google Cloud Storage bucket.
 *  The recipe under test never reads Hansen: it is only used here, to label plots.
 *
 *  Tiles are 10x10 degrees named by their north-west corner (e.g. 00N_060W covers lat -10..0,
 *  lon -60..-50) at 1/4000 degree (about 30 m).
 */

import { parseNpy } from '../../src/app/api/agent/lib/npy'

const BASE = 'https://storage.googleapis.com/earthenginepartners-hansen/GFC-2024-v1.12'
const TITILER = (process.env.TITILER_ENDPOINT || 'https://titiler.xyz').replace(/\/+$/, '')
export const PX_DEG = 1 / 4000

export function tileName(lat: number, lon: number): string {
  const top = Math.floor(lat / 10) * 10 + 10
  const left = Math.floor(lon / 10) * 10
  const ns = `${String(Math.abs(top)).padStart(2, '0')}${top >= 0 ? 'N' : 'S'}`
  const ew = `${String(Math.abs(left)).padStart(3, '0')}${left >= 0 ? 'E' : 'W'}`
  return `${ns}_${ew}`
}

const layerUrl = (layer: 'lossyear' | 'treecover2000', tile: string) => `${BASE}/Hansen_GFC-2024-v1.12_${layer}_${tile}.tif`

export interface HansenWindow {
  /** West and south edge, aligned to the 30 m pixel grid. */
  west: number
  south: number
  size: number
  lossyear: Uint8Array
  treecover: Uint8Array
}

async function readLayer(layer: 'lossyear' | 'treecover2000', tile: string, west: number, south: number, size: number): Promise<Uint8Array> {
  const bbox = [west, south, west + size * PX_DEG, south + size * PX_DEG].map((v) => v.toFixed(6)).join(',')
  const url = `${TITILER}/cog/bbox/${bbox}/${size}x${size}.npy?url=${encodeURIComponent(layerUrl(layer, tile))}`
  let lastErr = ''
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      if (res.ok) {
        const arr = parseNpy(Buffer.from(await res.arrayBuffer()))
        if (arr.data.length < size * size) throw new Error(`short array ${arr.shape.join('x')}`)
        return Uint8Array.from(arr.data.subarray(0, size * size))
      }
      lastErr = `HTTP ${res.status}`
    } catch (err) {
      lastErr = (err as Error).message
    }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
  }
  throw new Error(`Hansen ${layer} ${tile} ${bbox}: ${lastErr}`)
}

/** A `size` x `size` pixel window whose south-west corner is snapped to the pixel grid. The
 *  whole window must lie inside one tile (the caller keeps it away from 10-degree edges). */
export async function readWindow(lat: number, lon: number, size = 400): Promise<HansenWindow> {
  const west = Math.floor(lon / PX_DEG) * PX_DEG
  const south = Math.floor(lat / PX_DEG) * PX_DEG
  const tile = tileName(south + (size * PX_DEG) / 2, west + (size * PX_DEG) / 2)
  const [lossyear, treecover] = await Promise.all([
    readLayer('lossyear', tile, west, south, size),
    readLayer('treecover2000', tile, west, south, size),
  ])
  return { west, south, size, lossyear, treecover }
}
