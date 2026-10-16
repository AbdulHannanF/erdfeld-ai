/** GET /api/scenes: the dated scenes of one sensor over an area, oldest to newest, paged.
 *
 *    ?bbox=west,south,east,north        required, decimal degrees, at most 5,000 km2
 *    &sensor=sentinel-2|landsat|sentinel-1   default sentinel-2
 *    &from=YYYY-MM-DD&to=YYYY-MM-DD     default the sensor's whole archive up to today
 *    &maxCloud=0..100                   scene-wide cloud ceiling (ignored for radar), default 100
 *    &order=asc|desc                    default asc (oldest first)
 *    &group=day|scene                   one scene per acquisition day (default) or every STAC item
 *    &render=true_colour|ndvi           which tile URL each scene carries (radar: VV dB)
 *    &limit=1..250&cursor=N             a page, and the `next` of the previous one
 *
 *  → { sensor, label, provider, render, window, total, scenes: [{ id, datetime, date, sensor, platform,
 *      cloudPct, cloudBasis, coveragePct, thumbnail, tileUrl, itemIds }], next, first, last, truncated }
 *
 *  `cloudPct` is the whole scene's `eo:cloud_cover` (`cloudBasis: "scene"`), never a claim about the
 *  area; radar has none (`cloudBasis: "none"`). Cloud over the area itself is a pixel read, which the
 *  operations do for the scenes a person chooses. A catalogue that cannot be reached is a 502, never an
 *  empty list: an empty `scenes` array means the catalogue answered and holds none.
 *
 *  Cached: the STAC search by query for 15 minutes (a day once the window is over two weeks old), and
 *  the response for five. Rate limited like the other read routes.
 */

import { NextRequest } from 'next/server'

import { ScenesQuerySchema, queryObject, validate } from '@/lib/api-schemas'
import { enforceRateLimit } from '@/lib/rate-limit'

import { runWithCacheContext } from '../agent/lib/cache'
import { searchSceneCatalogue } from '../agent/lib/scenes'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const limited = await enforceRateLimit(req, 'scenes')
  if (limited) return limited
  const parsed = validate(ScenesQuerySchema, queryObject(req.nextUrl.searchParams))
  if (!parsed.ok) return parsed.response
  const q = parsed.data

  const found = await runWithCacheContext({ abortSignal: req.signal }, () =>
    searchSceneCatalogue({ sensor: q.sensor, bbox: q.bbox, from: q.from, to: q.to, maxCloud: q.maxCloud, order: q.order, group: q.group, render: q.render }),
  )
  if (!found.ok) {
    return Response.json({ error: 'catalogue_unavailable', message: found.message }, { status: 502, headers: { 'Cache-Control': 'no-store' } })
  }

  const total = found.scenes.length
  const page = found.scenes.slice(q.cursor, q.cursor + q.limit)
  const oldest = [...found.scenes].map((s) => s.datetime).sort()
  return Response.json(
    {
      sensor: found.sensor,
      label: found.label,
      provider: found.provider,
      render: found.render,
      window: found.window,
      total,
      first: oldest[0]?.slice(0, 10) ?? null,
      last: oldest[oldest.length - 1]?.slice(0, 10) ?? null,
      truncated: found.truncated,
      itemsRead: found.itemsRead,
      scenes: page,
      next: q.cursor + q.limit < total ? String(q.cursor + q.limit) : null,
    },
    { headers: { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600' } },
  )
}
