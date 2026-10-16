/** Pixel-box → GeoJSON polygon, shared by the inference provider clients.
 *
 *  Extracted from `providers/huggingface.ts` when that client was deleted
 *  (ISS-104): there is nothing HuggingFace-specific about it — the Replicate
 *  client used it too, and any future provider returning corner boxes will.
 */

export interface PixelBox {
  xmin: number
  ymin: number
  xmax: number
  ymax: number
}

export interface TileBounds {
  west: number
  south: number
  east: number
  north: number
}

/**
 * Convert a pixel-space detection box to a GeoJSON polygon ring.
 * `tileBounds` gives the geo extent; `tilePx` is the tile's pixel dimension.
 *
 * The Y axis is flipped: pixel row 0 is the tile's north edge.
 */
export function boxToGeoPolygon(box: PixelBox, tileBounds: TileBounds, tilePx = 256): number[][][] {
  const lonScale = (tileBounds.east - tileBounds.west) / tilePx
  const latScale = (tileBounds.north - tileBounds.south) / tilePx
  const x1 = tileBounds.west + box.xmin * lonScale
  const x2 = tileBounds.west + box.xmax * lonScale
  const y1 = tileBounds.north - box.ymax * latScale
  const y2 = tileBounds.north - box.ymin * latScale
  return [[[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]]
}
