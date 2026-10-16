/** The browser's side of GET /api/scenes: read every page, and the small pure helpers the timeline
 *  uses (the area's bounding box, dates, the scene nearest a date, the tiles a frame will need). */

import type { SceneRecord, SceneRenderInfo, SceneRender, SceneSensor } from '@/app/api/agent/lib/scenes'

export type { SceneRecord, SceneRender, SceneSensor, SceneRenderInfo }

export const SENSOR_LABEL: Record<SceneSensor, string> = {
  'sentinel-2': 'Sentinel-2',
  landsat: 'Landsat',
  'sentinel-1': 'Sentinel-1',
}

export interface SceneQuery {
  bbox: [number, number, number, number]
  sensor: SceneSensor
  render: SceneRender
  from?: string
  to?: string
  /** 100 keeps every scene. */
  maxCloud: number
}

export interface SceneList {
  scenes: SceneRecord[]
  total: number
  first: string | null
  last: string | null
  truncated: boolean
  render: SceneRenderInfo
  provider: string
  label: string
}

const PAGE = 250

/** Every scene of the query, oldest first, read page by page. `onPage` sees the running count. */
export async function fetchSceneList(q: SceneQuery, opts: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void } = {}): Promise<SceneList> {
  const scenes: SceneRecord[] = []
  let cursor = '0'
  let meta: Omit<SceneList, 'scenes'> | null = null
  for (let guard = 0; guard < 40; guard++) {
    const p = new URLSearchParams({
      bbox: q.bbox.map((n) => Number(n.toFixed(6))).join(','),
      sensor: q.sensor,
      render: q.render,
      order: 'asc',
      group: 'day',
      limit: String(PAGE),
      cursor,
    })
    if (q.from) p.set('from', q.from)
    if (q.to) p.set('to', q.to)
    if (q.maxCloud < 100) p.set('maxCloud', String(q.maxCloud))
    const res = await fetch(`/api/scenes?${p}`, { signal: opts.signal })
    const body = await res.json().catch(() => null)
    if (!res.ok) throw new Error(body?.message ?? body?.issues?.map((i: { message: string }) => i.message).join('; ') ?? `HTTP ${res.status}`)
    scenes.push(...(body.scenes as SceneRecord[]))
    meta = { total: body.total, first: body.first, last: body.last, truncated: body.truncated, render: body.render, provider: body.provider, label: body.label }
    opts.onProgress?.(scenes.length, body.total)
    if (!body.next) break
    cursor = body.next
  }
  return { scenes, ...(meta as Omit<SceneList, 'scenes'>) }
}

/** The area's bounding box from a GeoJSON geometry. */
export function geometryBbox(g: GeoJSON.Geometry | null | undefined): [number, number, number, number] | null {
  if (!g || !('coordinates' in g)) return null
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      const [x, y] = c as number[]
      if (x < w) w = x
      if (x > e) e = x
      if (y < s) s = y
      if (y > n) n = y
    } else if (Array.isArray(c)) c.forEach(walk)
  }
  walk(g.coordinates)
  return Number.isFinite(w) && w < e && s < n ? [w, s, e, n] : null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `12 Mar 2019` from a YYYY-MM-DD (UTC, no timezone drift). */
export function dayLabel(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso
}

/** Index of the scene nearest a YYYY-MM-DD (the list is oldest first); -1 for an empty list. */
export function nearestSceneIndex(scenes: { date: string }[], date: string): number {
  if (scenes.length === 0) return -1
  const t = Date.parse(`${date}T00:00:00Z`)
  let best = 0
  let bestD = Infinity
  scenes.forEach((s, i) => {
    const d = Math.abs(Date.parse(`${s.date}T00:00:00Z`) - t)
    if (d < bestD) { best = i; bestD = d }
  })
  return best
}

/** Web-Mercator tiles covering `bounds` at `zoom`, capped, for warming the browser cache. */
export function tilesFor(bounds: { west: number; south: number; east: number; north: number }, zoom: number, cap = 12): [number, number, number][] {
  const z = Math.max(0, Math.min(18, Math.round(zoom)))
  const n = 2 ** z
  const x = (lng: number) => Math.floor(((lng + 180) / 360) * n)
  const y = (lat: number) => {
    const r = (lat * Math.PI) / 180
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)
  }
  const x0 = Math.max(0, x(bounds.west)), x1 = Math.min(n - 1, x(bounds.east))
  const y0 = Math.max(0, y(Math.min(bounds.north, 85.05))), y1 = Math.min(n - 1, y(Math.max(bounds.south, -85.05)))
  const out: [number, number, number][] = []
  for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) { if (out.length < cap) out.push([z, tx, ty]) }
  return out
}

/** Ask the browser for a frame's tiles now, so stepping to it shows them at once. */
export function prefetchTiles(tileUrl: string, tiles: [number, number, number][]): void {
  for (const [z, x, y] of tiles) {
    const img = new Image()
    img.decoding = 'async'
    img.src = tileUrl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
  }
}
