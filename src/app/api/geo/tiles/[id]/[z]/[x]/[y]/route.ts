/** GET /api/geo/tiles/:id/:z/:x/:y — browser-reachable proxy for the geo service's composite
 *  tiles (the service runs server-side only and is never exposed).
 *
 *  Only what `GeoTileParamsSchema` / `GeoTileQuerySchema` (lib/api-schemas.ts) accept is
 *  forwarded; anything else is a 400 `invalid_request`, so this cannot be turned into an open proxy. Upstream
 *  statuses pass through (204 outside bounds, 404 evicted, 400), and an unreachable service is a
 *  502 `fetch_failed` — never an empty tile.
 */

import { NextRequest, NextResponse } from 'next/server'

import { GeoTileParamsSchema, GeoTileQuerySchema, queryObject, validate } from '@/lib/api-schemas'
import { geoAuthHeaders } from '@/app/api/agent/lib/geo-auth'
import { geoServiceUrl } from '@/app/api/agent/lib/geo-service'

export const dynamic = 'force-dynamic'

const TIMEOUT_MS = 30_000

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; z: string; x: string; y: string }> }) {
  const tile = validate(GeoTileParamsSchema, await params)
  if (!tile.ok) return tile.response
  const query = validate(GeoTileQuerySchema, queryObject(req.nextUrl.searchParams))
  if (!query.ok) return query.response
  const p = tile.data
  const { z, x, y } = p

  const out = new URLSearchParams()
  if (query.data.rescale != null) out.set('rescale', query.data.rescale)
  if (query.data.colormap_name != null) out.set('colormap_name', query.data.colormap_name)
  for (const b of query.data.bidx ?? []) out.append('bidx', b)

  const base = geoServiceUrl()
  if (!base) return NextResponse.json({ error: 'not_configured', detail: 'GEO_SERVICE_URL is not set' }, { status: 503 })

  const auth = await geoAuthHeaders()
  if (auth === null) return NextResponse.json({ error: 'fetch_failed', detail: 'could not get a Google ID token for the geo service' }, { status: 502 })

  let res: Response
  try {
    res = await fetch(`${base}/composite/${p.id}/tiles/${z}/${x}/${y}.png${out.size ? `?${out}` : ''}`, { headers: auth, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    return NextResponse.json({ error: 'fetch_failed', detail: `geo service unreachable: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 })
  }
  if (res.status === 204) return new NextResponse(null, { status: 204 })
  const body = await res.arrayBuffer()
  return new NextResponse(body, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': res.ok ? 'public, max-age=3600' : 'no-store',
    },
  })
}
