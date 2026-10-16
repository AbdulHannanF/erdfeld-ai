/** Access kinds GeoAgent cannot read in-app yet: the result states why and gives the route. */

import type { DatasetEntry } from '../types'
import { honest } from './common'
import { unavailableReason } from './routing'
import type { ReadOpts, ReaderAoi, ReadResult } from './types'

export async function readUnavailable(entry: DatasetEntry, _aoi: ReaderAoi, _opts: ReadOpts): Promise<ReadResult> {
  const kind = entry.access.kind
  const how =
    kind === 'stac-zarr' || kind === 'zarr'
      ? `Open it with xarray: \`xr.open_zarr("${entry.access.url}")\` (or its STAC assets) and select the AOI bounds.`
      : kind === 'openeo'
        ? `Run an openEO process graph against ${entry.access.url.replace(/\/collections\/.*/, '')} (free account, OIDC login).`
        : `Route: ${entry.access.url}`
  return honest(entry, 'unavailable', {
    headline: `"${entry.title}" cannot be read in-app yet`,
    body: [
      `${unavailableReason(entry)}. GeoAgent reads cloud-optimised GeoTIFF/STAC, Earth Engine, Overture GeoParquet and a few REST services; ${kind === 'openeo' ? 'openEO jobs' : 'chunked array stores'} need infrastructure that is not built yet.`,
      how,
      ...(entry.variables.length ? [`Variables: ${entry.variables.slice(0, 12).map((v) => (v.unit ? `${v.name} [${v.unit}]` : v.name)).join(', ')}.`] : []),
    ],
    needs: kind === 'openeo' ? 'openeo-account' : 'python-geo-service-Q-22',
  })
}
