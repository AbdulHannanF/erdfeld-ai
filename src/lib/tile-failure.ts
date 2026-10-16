/** When does a failing raster source count as a broken layer?
 *
 *  Tile URLs are not probed before a layer is sent (a blocking probe cost 1.7 s on fetch_dem), so
 *  the map is where a bad URL shows. A 4xx (bad, expired or unauthorised URL) is final: flag at
 *  once. A 5xx or a network error (no status) may be a blip on a shared tile server, so a source
 *  must fail `TRANSIENT_FAILURES_BEFORE_FLAG` times before it is flagged. Pure: the caller keeps
 *  the per-source counter map.
 */

export const TRANSIENT_FAILURES_BEFORE_FLAG = 3

/** Records one tile error for `sourceId`; true when the layer should now be flagged. */
export function decideTileFailure(counts: Map<string, number>, sourceId: string, status: number | undefined): boolean {
  if (typeof status === 'number' && status >= 400 && status < 500) return true
  const n = (counts.get(sourceId) ?? 0) + 1
  counts.set(sourceId, n)
  return n >= TRANSIENT_FAILURES_BEFORE_FLAG
}
