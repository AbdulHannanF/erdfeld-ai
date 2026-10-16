/** POST /api/quick-layer — run one quick layer through the engine, no LLM (Q-15).
 *
 *  Body `{ op: 'true_colour' | 'ndvi' | 'elevation', aoi: <GeoJSON Polygon/MultiPolygon or a
 *  Feature of one> }`. The operation and its arguments are fixed by `lib/quick-layers.ts`; the
 *  caller chooses neither. It runs through `runOperation`, the same executor an agent step uses,
 *  so the static checks (AOI size, date and sensor limits) and the dynamic checks apply, and the
 *  answer is the `GeoResult`: HTTP 200 with `status` ok / flagged / refused / failed. A malformed
 *  request is a 400 with the reasons; nothing is run for it.
 */

import { NextRequest } from 'next/server'

import { runOperation } from '../agent/engine/execute'
import { runWithCacheContext } from '../agent/lib/cache'
import { BODY_LIMITS, QuickLayerRequestSchema, parseBody } from '@/lib/api-schemas'
import { enforceRateLimit } from '@/lib/rate-limit'
import { QUICK_LAYERS } from '@/lib/quick-layers'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(req: NextRequest) {
  const limited = await enforceRateLimit(req, 'quickLayer')
  if (limited) return limited
  // A Feature / FeatureCollection AOI is unwrapped to its geometry by the schema.
  const parsed = await parseBody(req, QuickLayerRequestSchema, { max: BODY_LIMITS.quickLayer })
  if (!parsed.ok) return parsed.response

  const { operation, args } = QUICK_LAYERS[parsed.data.op]
  const result = await runWithCacheContext({ abortSignal: req.signal }, () =>
    runOperation(operation, { ...args }, { aoi: parsed.data.aoi }),
  )
  return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
