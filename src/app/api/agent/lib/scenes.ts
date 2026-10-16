/** The scene catalogue over an area: every dated scene of one sensor, oldest to newest, each with
 *  the tile URL that draws it clipped to the area (the map hides the rest).
 *
 *  Sources, all free and unauthenticated:
 *    - Sentinel-2 L2A: AWS Earth Search (Element84), from 2015
 *    - Landsat Collection 2 Level-2: Microsoft Planetary Computer, from 1982
 *    - Sentinel-1 RTC: Microsoft Planetary Computer
 *
 *  This module only reads catalogues and builds URLs. The pixel reads (statistics, cloud over the
 *  area) live in the operations; a catalogue listing never claims more than its metadata holds:
 *  `cloudPct` is the scene-wide `eo:cloud_cover`, labelled `cloudBasis: 'scene'`, and radar has none.
 */

import { cachedFetchJson, fetchWithRetry } from './cache'
import { PC_DATA, PC_STAC, sensorById } from './analysis/sensors'
import { groupScenes, sarTileUrl } from './flood/scenes'
import { fetchFailureNote } from './fetch-failure'
import { getLogger } from './logger'
import { buildRasterTileUrl, scaleExpression, trueColorRescale } from './raster-render'
import { resolveBandSetReflectance } from './reflectance'
import { S2_ASSET_KEYS, STAC_SEARCH_URL, getStacItemHref, pickAssetKey, toRfc3339Interval } from './stac'
import { TITILER_BASE } from './titiler'

const log = getLogger('agent/scenes')

export const SCENE_SENSORS = ['sentinel-2', 'landsat', 'sentinel-1'] as const
export type SceneSensor = (typeof SCENE_SENSORS)[number]
export const SCENE_RENDERS = ['true_colour', 'ndvi'] as const
export type SceneRender = (typeof SCENE_RENDERS)[number]

interface SensorInfo {
  label: string
  /** Short name for a badge on the map. */
  short: string
  collection: string
  searchUrl: string
  provider: string
  /** The operations' sensor id, when an operation can read this sensor. */
  opSensor: 'sentinel-2-l2a' | 'landsat-c2-l2' | null
  /** The date the catalogue search starts from when the caller gives none. */
  from: string
  hasCloud: boolean
  /** STAC asset keys the tile builders and the list need; everything else is dropped from the cache. */
  keepAssets: string[]
  /** STAC `fields` to ask for: the catalogue then sends a few hundred bytes per item, not the whole item. */
  fields: string[]
}

export const SCENE_SENSOR_INFO: Record<SceneSensor, SensorInfo> = {
  'sentinel-2': {
    label: 'Sentinel-2 L2A',
    short: 'Sentinel-2',
    collection: 'sentinel-2-l2a',
    searchUrl: STAC_SEARCH_URL,
    provider: 'AWS Element84 Earth Search',
    opSensor: 'sentinel-2-l2a',
    from: '2015-06-23',
    hasCloud: true,
    keepAssets: ['red', 'green', 'blue', 'nir', 'B02', 'B03', 'B04', 'B08', 'thumbnail', 'scl'],
    fields: ['id', 'bbox', 'collection', 'links', 'properties.datetime', 'properties.platform', 'properties.eo:cloud_cover', 'properties.s2:processing_baseline', 'assets.red', 'assets.green', 'assets.blue', 'assets.nir', 'assets.thumbnail', 'assets.scl'],
  },
  landsat: {
    label: 'Landsat Collection 2 Level-2',
    short: 'Landsat',
    collection: 'landsat-c2-l2',
    searchUrl: PC_STAC,
    provider: 'Microsoft Planetary Computer',
    opSensor: 'landsat-c2-l2',
    from: '1982-08-22',
    hasCloud: true,
    keepAssets: ['red', 'green', 'blue', 'nir08', 'rendered_preview', 'qa_pixel'],
    fields: ['id', 'bbox', 'collection', 'links', 'properties.datetime', 'properties.platform', 'properties.eo:cloud_cover', 'assets.red', 'assets.green', 'assets.blue', 'assets.nir08', 'assets.rendered_preview'],
  },
  'sentinel-1': {
    label: 'Sentinel-1 RTC',
    short: 'Sentinel-1',
    collection: 'sentinel-1-rtc',
    searchUrl: PC_STAC,
    provider: 'Microsoft Planetary Computer',
    opSensor: null,
    from: '2014-01-01',
    hasCloud: false,
    keepAssets: ['vv', 'vh', 'rendered_preview'],
    fields: ['id', 'bbox', 'collection', 'links', 'properties.datetime', 'properties.platform', 'properties.sat:orbit_state', 'properties.sat:relative_orbit', 'assets.vv', 'assets.vh', 'assets.rendered_preview'],
  },
}

/** What a render mode draws, stated with the scenes: the stretch is FIXED so frames compare. */
export interface SceneRenderInfo {
  mode: SceneRender | 'backscatter'
  label: string
  units: string
  /** Fixed display range; null for true colour (a reflectance window, not a value range). */
  rescale: [number, number] | null
  colormap: string | null
}

export const NDVI_RANGE: [number, number] = [-0.1, 0.9]
export const SAR_RANGE: [number, number] = [-25, 0]

export function renderInfo(sensor: SceneSensor, render: SceneRender): SceneRenderInfo {
  if (sensor === 'sentinel-1') return { mode: 'backscatter', label: 'VV backscatter (dB)', units: 'dB', rescale: SAR_RANGE, colormap: 'greys_r' }
  if (render === 'ndvi') return { mode: 'ndvi', label: 'NDVI (fixed range)', units: 'NDVI', rescale: NDVI_RANGE, colormap: 'rdylgn' }
  return { mode: 'true_colour', label: 'True colour', units: 'reflectance 0 to 0.3', rescale: null, colormap: null }
}

export interface SceneRecord {
  /** The STAC item id (for Sentinel-1, the item that draws the scene). */
  id: string
  /** ISO date-time of the acquisition. */
  datetime: string
  /** YYYY-MM-DD (UTC). */
  date: string
  sensor: SceneSensor
  platform: string
  collection: string
  /** Scene-wide `eo:cloud_cover` %, or null when the sensor has none (radar) or the item omits it. */
  cloudPct: number | null
  /** `scene`: the metadata value for the whole scene, not the drawn area. `none`: not applicable. */
  cloudBasis: 'scene' | 'none'
  /** Share of the area's bounding box inside this scene's footprint box, 0..100. */
  coveragePct: number
  thumbnail: string | null
  /** XYZ template drawing this scene in the chosen render; null when its assets are missing. */
  tileUrl: string | null
  /** Items of the same day folded into this one (group=day), the id of each. */
  itemIds: string[]
  orbit?: string
  relativeOrbit?: number | null
}

export interface SceneSearch {
  sensor: SceneSensor
  bbox: [number, number, number, number]
  from?: string
  to?: string
  /** Scene-wide cloud ceiling, 0..100; 100 keeps everything. Ignored for radar. */
  maxCloud?: number
  order?: 'asc' | 'desc'
  /** `day`: one scene per acquisition day (the best covering item); `scene`: every item. */
  group?: 'day' | 'scene'
  render?: SceneRender
}

export interface SceneSearchResult {
  ok: true
  sensor: SceneSensor
  label: string
  provider: string
  render: SceneRenderInfo
  window: { from: string; to: string }
  /** Every scene found, in `order`; the route pages through it. */
  scenes: SceneRecord[]
  /** The catalogue held more than the search is willing to read; the oldest or newest end is cut. */
  truncated: boolean
  /** Items read before grouping. */
  itemsRead: number
  /** The cut-down STAC item behind each scene id, for the operations that read its pixels. Not sent to clients. */
  itemsById: Map<string, any>
}
export type SceneSearchOutcome = SceneSearchResult | { ok: false; message: string }

/** At most this many STAC items are read for one search (6 pages of 250). */
// Earth Search answers a page that is too large (a busy tile in 2019 at 250) with a 502; 100 is safe
const PAGE_SIZE = 100
const MAX_PAGES = 10
const RETRIES = 3
/** Searches in flight at once (the years of a long archive). */
const CONCURRENCY = 5
export const MAX_ITEMS = PAGE_SIZE * MAX_PAGES

const day = (t: number) => new Date(t).toISOString().slice(0, 10)
const DAY_MS = 86_400_000

/** A STAC item cut down to what the list and the tile builders read, so a long archive caches small. */
function compact(item: any, keep: string[]): any {
  const assets: Record<string, { href: string }> = {}
  for (const k of keep) if (typeof item?.assets?.[k]?.href === 'string') assets[k] = { href: item.assets[k].href }
  const self = (item?.links as any[] | undefined)?.find((l) => l.rel === 'self')
  return {
    id: item.id,
    collection: item.collection,
    bbox: item.bbox,
    properties: item.properties,
    assets,
    links: self ? [{ rel: 'self', href: self.href }] : [],
  }
}

async function collectItems(info: SensorInfo, body: Record<string, unknown>, maxItems = MAX_ITEMS): Promise<{ items: any[]; truncated: boolean }> {
  const items: any[] = []
  let next: { url: string; body: any; method: 'POST' | 'GET' } | null = { url: info.searchUrl, body, method: 'POST' }
  let pages = 0
  let truncated = false
  while (next) {
    if (pages >= MAX_PAGES || items.length >= maxItems) { truncated = true; break }
    // The public catalogues answer a burst of searches with 502/503/504 now and then: try again after a pause.
    let res: Response
    for (let attempt = 0; ; attempt++) {
      res = await fetchWithRetry(next.url, {
        method: next.method,
        headers: { 'Content-Type': 'application/json' },
        ...(next.method === 'POST' ? { body: JSON.stringify(next.body) } : {}),
      }, { timeoutMs: 45_000 })
      if (res.ok || ![502, 503, 504].includes(res.status) || attempt >= RETRIES) break
      await new Promise((r) => setTimeout(r, Number(process.env.SCENES_RETRY_MS ?? 1500) * (attempt + 1)))
    }
    if (!res.ok) throw new Error(`${info.provider} STAC HTTP ${res.status}`)
    const page: any = await res.json()
    for (const f of page.features ?? []) items.push(compact(f, info.keepAssets))
    pages++
    const link = (page.links ?? []).find((l: any) => l.rel === 'next')
    if (!link || (page.features ?? []).length === 0) { next = null; break }
    if (link.body) {
      next = { url: link.href ?? info.searchUrl, body: link.merge ? { ...next.body, ...link.body } : link.body, method: 'POST' }
    } else if (link.href) next = { url: link.href, body: null, method: 'GET' }
    else next = null
  }
  return { items, truncated }
}

/** One search per calendar year, a few at a time: a long archive of a busy tile is thousands of items, and
 *  one serial page chain would take minutes. Years are independent, so the whole archive is read, oldest to
 *  newest, and a year that is itself too large is the only thing ever reported truncated. */
async function collectByYear(info: SensorInfo, base: Record<string, unknown>, from: string, to: string): Promise<{ items: any[]; truncated: boolean }> {
  const windows: string[] = []
  const y0 = Number(from.slice(0, 4))
  const y1 = Number(to.slice(0, 4))
  for (let y = y0; y <= y1; y++) {
    const a = y === y0 ? from : `${y}-01-01`
    const b = y === y1 ? to : `${y}-12-31`
    windows.push(toRfc3339Interval(`${a}/${b}`))
  }
  const parts: { items: any[]; truncated: boolean }[] = new Array(windows.length)
  let nextWindow = 0
  const worker = async () => {
    for (;;) {
      const i = nextWindow++
      if (i >= windows.length) return
      parts[i] = await collectItems(info, { ...base, datetime: windows[i] }, 1000)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, windows.length) }, worker))
  const seen = new Set<string>()
  const items: any[] = []
  for (const part of parts) for (const it of part.items) if (!seen.has(it.id)) { seen.add(it.id); items.push(it) }
  return { items, truncated: parts.some((p) => p.truncated) }
}

/** Overlap of the item's footprint box with the area's box, as a share of the area's box. */
function overlapPct(aoi: number[], b: number[] | undefined): number {
  if (!b || b.length < 4) return 0
  const w = Math.max(0, Math.min(aoi[2], b[2]) - Math.max(aoi[0], b[0]))
  const h = Math.max(0, Math.min(aoi[3], b[3]) - Math.max(aoi[1], b[1]))
  const area = (aoi[2] - aoi[0]) * (aoi[3] - aoi[1])
  return area > 0 ? Math.min(100, (w * h * 100) / area) : 0
}

/** The tile template that draws this item in the render mode, or null when it lacks the assets. */
export function sceneTileUrl(sensor: SceneSensor, render: SceneRender, item: any): string | null {
  if (sensor === 'sentinel-1') return sarTileUrl({ tileItem: item }, 'VV', SAR_RANGE, 'greys_r')
  if (sensor === 'sentinel-2') {
    const href = getStacItemHref(item)
    if (!href) return null
    const target = { kind: 'stac' as const, base: TITILER_BASE, itemHref: href }
    if (render === 'ndvi') {
      const keys = [pickAssetKey(item, S2_ASSET_KEYS.B08), pickAssetKey(item, S2_ASSET_KEYS.B04)]
      if (keys.some((k) => !k)) return null
      const { transforms } = resolveBandSetReflectance(item, keys as string[], { isSentinel2: true })
      return buildRasterTileUrl({ target, assets: keys as string[], expression: scaleExpression('(b1-b2)/(b1+b2)', transforms), rescale: [NDVI_RANGE], colormap: 'rdylgn' })
    }
    const keys = [S2_ASSET_KEYS.B04, S2_ASSET_KEYS.B03, S2_ASSET_KEYS.B02].map((k) => pickAssetKey(item, k))
    if (keys.some((k) => !k)) return null
    const w = trueColorRescale(item, keys as string[])
    return buildRasterTileUrl({ target, assets: keys as string[], rescale: [w, w, w] })
  }
  // Landsat, through the Planetary Computer data API (it signs the blobs itself).
  const spec = sensorById('landsat-c2-l2')!
  const target = { kind: 'pc' as const, base: PC_DATA, collection: spec.collection, itemId: String(item.id) }
  const have = (k: string) => (item?.assets?.[k]?.href ? k : null)
  if (render === 'ndvi') {
    const keys = [have('nir08'), have('red')]
    if (keys.some((k) => !k)) return null
    const { transforms } = resolveBandSetReflectance(item, keys as string[], { isSentinel2: false, fallback: { scale: spec.scale, offset: spec.offset, note: 'Landsat C2 L2 surface-reflectance scaling' } })
    return buildRasterTileUrl({ target, assets: keys as string[], expression: scaleExpression('(b1-b2)/(b1+b2)', transforms), rescale: [NDVI_RANGE], colormap: 'rdylgn' })
  }
  const keys = [have('red'), have('green'), have('blue')]
  if (keys.some((k) => !k)) return null
  // reflectance 0 to 0.3 in this sensor's own digital numbers
  const w: [number, number] = [Math.round(-spec.offset / spec.scale), Math.round((0.3 - spec.offset) / spec.scale)]
  return buildRasterTileUrl({ target, assets: keys as string[], rescale: [w, w, w] })
}

function toRecord(sensor: SceneSensor, render: SceneRender, item: any, bbox: number[], ids: string[]): SceneRecord {
  const info = SCENE_SENSOR_INFO[sensor]
  const datetime = String(item?.properties?.datetime ?? '')
  const cloud = info.hasCloud && typeof item?.properties?.['eo:cloud_cover'] === 'number' ? (item.properties['eo:cloud_cover'] as number) : null
  const thumb = item?.assets?.thumbnail?.href ?? item?.assets?.rendered_preview?.href ?? null
  return {
    id: String(item.id),
    datetime,
    date: datetime.slice(0, 10),
    sensor,
    platform: String(item?.properties?.platform ?? info.short),
    collection: info.collection,
    cloudPct: cloud != null ? Number(cloud.toFixed(1)) : null,
    cloudBasis: cloud != null ? 'scene' : 'none',
    coveragePct: Number(overlapPct(bbox, item.bbox).toFixed(1)),
    thumbnail: typeof thumb === 'string' ? thumb : null,
    tileUrl: sceneTileUrl(sensor, render, item),
    itemIds: ids,
  }
}

/** Folds the items of one day into the best one: the most of the area covered, then the clearest. */
function foldDays(items: any[], bbox: number[]): { best: any; ids: string[] }[] {
  const byDay = new Map<string, any[]>()
  for (const it of items) {
    const d = String(it?.properties?.datetime ?? '').slice(0, 10)
    if (!d) continue
    const list = byDay.get(d)
    if (list) list.push(it)
    else byDay.set(d, [it])
  }
  return [...byDay.values()].map((list) => {
    const ranked = [...list].sort((a, b) =>
      overlapPct(bbox, b.bbox) - overlapPct(bbox, a.bbox) ||
      Number(a.properties?.['eo:cloud_cover'] ?? 100) - Number(b.properties?.['eo:cloud_cover'] ?? 100))
    return { best: ranked[0], ids: ranked.map((i) => String(i.id)) }
  })
}

/** The archive's end date is open until it is old: a closed window older than this is cached a day. */
const SETTLED_AGE_DAYS = 14

/** Search the catalogue. A failed request is `ok: false` with a message that says it was a failure to
 *  look; an empty `scenes` array means the catalogue answered and holds none. */
export async function searchSceneCatalogue(p: SceneSearch, now = Date.now()): Promise<SceneSearchOutcome> {
  const info = SCENE_SENSOR_INFO[p.sensor]
  const from = p.from ?? info.from
  const to = p.to ?? day(now)
  const order = p.order ?? 'asc'
  const group = p.group ?? 'day'
  const render = p.render ?? 'true_colour'
  const maxCloud = info.hasCloud ? (p.maxCloud ?? 100) : 100

  const body: Record<string, unknown> = {
    collections: [info.collection],
    bbox: p.bbox,
    sortby: [{ field: 'properties.datetime', direction: 'asc' }],
    limit: PAGE_SIZE,
    fields: { include: info.fields },
    ...(maxCloud < 100 ? { query: { 'eo:cloud_cover': { lte: maxCloud } } } : {}),
  }
  const settled = Date.parse(`${to}T00:00:00Z`) <= now - SETTLED_AGE_DAYS * DAY_MS
  let read: { items: any[]; truncated: boolean }
  try {
    read = await cachedFetchJson(`scenes:${p.sensor}:${from}:${to}:${JSON.stringify(body)}`, settled ? 24 * 3_600_000 : 15 * 60_000, () => collectByYear(info, body, from, to))
  } catch (err: any) {
    log.warn({ sensor: p.sensor, err: err?.message }, 'scene catalogue search failed')
    return { ok: false, message: fetchFailureNote(`the ${info.label} catalogue (${info.provider})`, err) }
  }

  let scenes: SceneRecord[]
  if (p.sensor === 'sentinel-1') {
    // one acquisition is one relative orbit on one day; its slices are folded (group=scene keeps every slice)
    const grouped = groupScenes(read.items, { lng: (p.bbox[0] + p.bbox[2]) / 2, lat: (p.bbox[1] + p.bbox[3]) / 2 })
    scenes = (group === 'scene' ? read.items.map((it) => ({ it, ids: [String(it.id)], orbit: undefined as string | undefined, rel: undefined as number | null | undefined })) : grouped.map((g) => ({ it: g.tileItem, ids: g.items.map((i: any) => String(i.id)), orbit: g.orbit, rel: g.relativeOrbit })))
      .map(({ it, ids, orbit, rel }) => ({ ...toRecord('sentinel-1', render, it, p.bbox, ids), ...(orbit ? { orbit } : {}), ...(rel !== undefined ? { relativeOrbit: rel } : {}) }))
  } else if (group === 'scene') {
    scenes = read.items.map((it) => toRecord(p.sensor, render, it, p.bbox, [String(it.id)]))
  } else {
    scenes = foldDays(read.items, p.bbox).map(({ best, ids }) => toRecord(p.sensor, render, best, p.bbox, ids))
  }
  scenes.sort((a, b) => a.datetime.localeCompare(b.datetime) || a.id.localeCompare(b.id))
  if (order === 'desc') scenes.reverse()

  return {
    ok: true,
    sensor: p.sensor,
    label: info.label,
    provider: info.provider,
    render: renderInfo(p.sensor, render),
    window: { from, to },
    scenes,
    truncated: read.truncated,
    itemsRead: read.items.length,
    itemsById: new Map(read.items.map((i) => [String(i.id), i])),
  }
}

// ---------------------------------------------------------------------------
// One scene by id (the `scene_id` argument of the operations)
// ---------------------------------------------------------------------------

/** STAC item ids are file-name-like; anything else is refused before it reaches a URL. */
export const SCENE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{5,99}$/

export type SceneByIdOutcome =
  | { ok: true; item: any; date: string }
  | { ok: false; message: string; failed?: boolean }

/** Look one scene up in its catalogue and check it is the right sensor, covers the area and, when the
 *  caller also gave a date, is of that day. A missing scene is a refusal; an unreachable catalogue is a
 *  failure, and the two are told apart. */
export async function resolveSceneById(sensor: SceneSensor, id: string, bbox: number[], date?: string): Promise<SceneByIdOutcome> {
  const info = SCENE_SENSOR_INFO[sensor]
  if (!SCENE_ID_PATTERN.test(id)) return { ok: false, message: `\`scene_id\` "${id.slice(0, 60)}" is not a scene identifier.` }
  const base = sensor === 'sentinel-2' ? 'https://earth-search.aws.element84.com/v1' : 'https://planetarycomputer.microsoft.com/api/stac/v1'
  const url = `${base}/collections/${info.collection}/items/${encodeURIComponent(id)}`
  let item: any
  try {
    const res = await cachedFetchJson(`scene-by-id:${url}`, { source: 'stac' }, async () => {
      const r = await fetchWithRetry(url, {}, { timeoutMs: 20_000 })
      if (r.status === 404) return { missing: true as const }
      if (!r.ok) throw new Error(`STAC HTTP ${r.status}`)
      return { missing: false as const, item: await r.json() }
    })
    if (res.missing) return { ok: false, message: `Scene \`${id}\` is not in the ${info.label} catalogue (${info.provider}). Nothing was substituted.` }
    item = res.item
  } catch (err) {
    return { ok: false, failed: true, message: fetchFailureNote(`the ${info.label} catalogue (${info.provider})`, err) }
  }
  if (overlapPct(bbox, item?.bbox) <= 0) return { ok: false, message: `Scene \`${id}\` does not cover the drawn area.` }
  const d = String(item?.properties?.datetime ?? '').slice(0, 10)
  if (date && d && date !== d) return { ok: false, message: `Scene \`${id}\` was acquired on ${d}, not ${date}. Give the scene's own date, or omit \`date\`.` }
  return { ok: true, item, date: d }
}
