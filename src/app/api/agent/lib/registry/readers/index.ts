/** Reader dispatch: one entry point for every registry access kind. */

import { getLogger } from '../../logger'
import type { DatasetEntry } from '../types'
import { coveragePrecheck, honest, noCoverageResult } from './common'
import { readEarthEngine } from './earthengine'
import { lidarOutsideCoverage, readLidarDerived, readPointCloud } from './lidar'
import { readOverture } from './overture'
import { readRest } from './rest'
import { routeFor } from './routing'
import { readStac } from './stac'
import { readUnavailable } from './unavailable'
import type { ReadOpts, ReaderAoi, ReadResult } from './types'

const log = getLogger('registry/readers')

/** Read a registry entry over the AOI: numbers and a layer, or the exact reason it cannot. */
export async function readDataset(entry: DatasetEntry, aoi: ReaderAoi, opts: ReadOpts = {}): Promise<ReadResult> {
  const route = routeFor(entry)

  // Coverage pre-check from the registry entry alone: refuse fast, no network.
  const pre = coveragePrecheck(entry, aoi, opts)
  if (pre) {
    return route === 'lidar-derived' || route === 'lidar-pointcloud'
      ? lidarOutsideCoverage(entry, aoi, pre.reason)
      : noCoverageResult(entry, aoi, pre.reason)
  }

  try {
    switch (route) {
      case 'stac': return await readStac(entry, aoi, opts)
      case 'lidar-derived': return await readLidarDerived(entry, aoi, opts)
      case 'lidar-pointcloud': return await readPointCloud(entry, aoi, opts)
      case 'earthengine': return await readEarthEngine(entry, aoi, opts)
      case 'geoparquet': return await readOverture(entry, aoi, opts)
      case 'rest-tool': case 'rest-other': return await readRest(entry, aoi, opts)
      default: return await readUnavailable(entry, aoi, opts)
    }
  } catch (err: any) {
    log.error({ id: entry.id, err: err?.message }, 'reader threw')
    return honest(entry, 'error', { headline: `Reading "${entry.title}" failed`, body: [err?.message ?? 'unexpected error'] })
  }
}

export { routeFor, readability } from './routing'
export type { ReadOpts, ReaderAoi, ReadResult, ReadStatus, ReadStats, CoverageInfo } from './types'
