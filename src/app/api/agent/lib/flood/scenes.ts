/** Sentinel-1 RTC scene discovery, grouping, before/after selection and dB reads.
 *
 *  Source: Microsoft Planetary Computer `sentinel-1-rtc` (radiometrically terrain-corrected
 *  gamma-nought, linear power, 10 m). Blobs need a SAS token, so reads go through
 *  `/cog/feature.npy` with a signed href (same route as the dataset readers). Linear power is
 *  converted to dB per pixel here, never averaged in linear space first.
 */

import turfArea from '@turf/area'
import intersect from '@turf/intersect'
import { cachedFetchJson, fetchWithRetry } from '../cache'
import { getLogger } from '../logger'
import { fetchCogFeatureGrid } from '../pixels'
import { signPCAsset } from '../stac'
import { PC_DATA } from '../analysis/sensors'
import { linearToDb, resampleNearest } from './sar'

const log = getLogger('agent/flood')

export const S1_COLLECTION = 'sentinel-1-rtc'
const PC_SEARCH = 'https://planetarycomputer.microsoft.com/api/stac/v1/search'
export const DAY_MS = 86_400_000

export type Polarization = 'VV' | 'VH'

export interface S1Scene {
  /** `<relative orbit>/<yyyy-mm-dd>` — one acquisition over the AOI. */
  key: string
  date: string
  datetime: string
  orbit: 'ascending' | 'descending' | 'unknown'
  relativeOrbit: number | null
  platform: string
  /** All STAC items of this pass that touch the AOI (a pass can be cut into slices). */
  items: any[]
  /** The item used for the tile layer: the one covering the AOI centre, else the first. */
  tileItem: any
}

export type SearchOutcome = { ok: true; items: any[] } | { ok: false; message: string }

/** Cached Planetary Computer search for Sentinel-1 RTC items over `bbox` between two YYYY-MM-DD days (inclusive). */
export async function searchS1Rtc(bbox: number[], startDay: string, endDay: string): Promise<SearchOutcome> {
  const body = {
    collections: [S1_COLLECTION],
    bbox,
    datetime: `${startDay}T00:00:00Z/${endDay}T23:59:59Z`,
    sortby: [{ field: 'properties.datetime', direction: 'asc' }],
    limit: 200,
  }
  try {
    const data = await cachedFetchJson(`s1rtc-search:${JSON.stringify(body)}`, { source: 'pc-stac' }, async () => {
      const features: any[] = []
      let next: { url: string; body: any } | null = { url: PC_SEARCH, body }
      for (let page = 0; next && page < 5; page++) {
        const res: Response = await fetchWithRetry(next.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next.body),
        }, { timeoutMs: 30_000 })
        if (!res.ok) throw new Error(`Planetary Computer STAC HTTP ${res.status}`)
        const j: any = await res.json()
        features.push(...(j.features ?? []))
        const link = (j.links ?? []).find((l: any) => l.rel === 'next' && l.body)
        next = link ? { url: link.href ?? PC_SEARCH, body: link.merge ? { ...next.body, ...link.body } : link.body } : null
      }
      return { features }
    })
    return { ok: true, items: data.features as any[] }
  } catch (err: any) {
    log.warn({ err: err?.message }, 'sentinel-1 rtc search failed')
    return { ok: false, message: `The Sentinel-1 catalogue search failed (${err?.message ?? 'unknown error'}).` }
  }
}

function bboxContains(g: any, lng: number, lat: number): boolean {
  const b: number[] | undefined = g?.bbox
  return !!b && lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3]
}

/** Group STAC items into acquisitions (same relative orbit and day), oldest first. */
export function groupScenes(items: any[], aoiCentre?: { lng: number; lat: number }): S1Scene[] {
  const groups = new Map<string, any[]>()
  for (const it of items) {
    const dt = String(it?.properties?.datetime ?? '')
    if (!dt) continue
    const rel = it.properties?.['sat:relative_orbit']
    const key = `${rel ?? '?'}/${dt.slice(0, 10)}`
    const list = groups.get(key)
    if (list) list.push(it)
    else groups.set(key, [it])
  }
  const scenes: S1Scene[] = []
  for (const [key, list] of groups) {
    list.sort((a, b) => String(a.properties.datetime).localeCompare(String(b.properties.datetime)))
    const p = list[0].properties
    const state = String(p['sat:orbit_state'] ?? '').toLowerCase()
    const tile = (aoiCentre && list.find((it) => bboxContains(it, aoiCentre.lng, aoiCentre.lat))) || list[0]
    scenes.push({
      key,
      date: String(p.datetime).slice(0, 10),
      datetime: String(p.datetime),
      orbit: state === 'ascending' || state === 'descending' ? state : 'unknown',
      relativeOrbit: typeof p['sat:relative_orbit'] === 'number' ? p['sat:relative_orbit'] : null,
      platform: String(p.platform ?? list[0].id?.slice(0, 3) ?? 'sentinel-1'),
      items: list,
      tileItem: tile,
    })
  }
  return scenes.sort((a, b) => a.datetime.localeCompare(b.datetime))
}

/** Share (0..1) of the AOI polygon inside the scene's footprint (the union of its slices), from the STAC item
 *  geometries. null when no item carries a geometry (then nothing is known and nothing is excluded). A pass
 *  whose swath edge cuts a small AOI covers only part of it; reading that scene yields a "does not cover 80%"
 *  refusal even though another pass within the date slack covers it completely. */
export function footprintCoverage(scene: S1Scene, aoi: any): number | null {
  const aoiFeature = { type: 'Feature', properties: {}, geometry: aoi } as any
  const aoiArea = turfArea(aoiFeature)
  if (!(aoiArea > 0)) return null
  let covered = 0
  let known = false
  for (const it of scene.items) {
    if (!it?.geometry) continue
    known = true
    try {
      const x = intersect({ type: 'FeatureCollection', features: [aoiFeature, { type: 'Feature', properties: {}, geometry: it.geometry }] } as any)
      if (x) covered += turfArea(x)
    } catch {
      // a degenerate footprint adds nothing
    }
  }
  return known ? Math.min(1, covered / aoiArea) : null
}

export const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`)

/** Scene nearest to `day`; ties go to `prefer` (same orbit as another scene), then to the earlier one. */
export function nearestScene(scenes: S1Scene[], day: string, prefer?: (s: S1Scene) => boolean): S1Scene | null {
  let best: S1Scene | null = null
  let bestScore = Infinity
  for (const s of scenes) {
    const score = Math.abs(dayMs(s.date) - dayMs(day)) + (prefer && !prefer(s) ? 0.5 * DAY_MS : 0)
    if (score < bestScore) { best = s; bestScore = score }
  }
  return best
}

/** 'sentinel-1a' -> 'Sentinel-1A'. */
export const platformName = (p: string) => {
  const m = p.match(/^sentinel-?(\d)([a-z])?$/i)
  return m ? `Sentinel-${m[1]}${(m[2] ?? '').toUpperCase()}` : p
}

export const sceneLabel = (s: S1Scene) =>
  `${s.date} (${s.orbit}${s.relativeOrbit != null ? `, relative orbit ${s.relativeOrbit}` : ''}, ${platformName(s.platform)})`

export interface SeriesPoint {
  scene: S1Scene
  /** Water share of observed AOI pixels, 0..1; null when nothing was observed. */
  fraction: number | null
  /** Share of the AOI observed by this scene, 0..100. */
  coveragePct: number
}

export interface PairChoice {
  before: SeriesPoint
  after: SeriesPoint
  /** How each was chosen, in words. */
  how: string
  /** 'orbit' = same relative orbit, 'direction' = same flight direction only, 'any' = mixed geometry. */
  match: 'orbit' | 'direction' | 'any'
}

/** A scene may anchor a comparison only if it observed this much of the AOI. */
export const MIN_COVERAGE_PCT = 80
/** "Dry" = within the lowest quarter of the water range seen before the peak. */
export const DRY_QUANTILE = 0.25

/**
 * Window mode: `after` = the scene with the most water (unless forced); `before` = the nearest
 * EARLIER scene that is "dry" — water fraction in the lowest quarter of the range between the
 * driest earlier scene and the peak — taken from the same relative orbit when one exists, else the same
 * flight direction, else any (and the match tier is reported, because mixed geometry weakens a comparison).
 */
export function pickPair(
  series: SeriesPoint[],
  force: { after?: string; before?: string } = {},
): PairChoice | { error: string } {
  const ok = series.filter((p) => p.fraction != null && p.coveragePct >= MIN_COVERAGE_PCT)
  if (ok.length === 0) return { error: `no Sentinel-1 scene observed at least ${MIN_COVERAGE_PCT}% of the AOI` }

  let after: SeriesPoint
  let afterHow: string
  if (force.after) {
    const s = nearestScene(ok.map((p) => p.scene), force.after)!
    after = ok.find((p) => p.scene.key === s.key)!
    afterHow = `the scene nearest the requested after-date ${force.after}`
  } else {
    after = ok.reduce((best, p) => (p.fraction! >= best.fraction! ? p : best))
    afterHow = `the peak-water scene of the window (${(after.fraction! * 100).toFixed(1)}% water, highest of ${ok.length} scenes)`
  }

  const earlier = ok.filter((p) => dayMs(p.scene.date) < dayMs(after.scene.date))
  if (earlier.length === 0) return { error: `no usable Sentinel-1 scene earlier than ${after.scene.date} in the window to act as the before-scene` }

  if (force.before) {
    const s = nearestScene(earlier.map((p) => p.scene), force.before, (x) => x.relativeOrbit === after.scene.relativeOrbit)!
    const before = earlier.find((p) => p.scene.key === s.key)!
    return {
      before, after, match: tierOf(before.scene, after.scene),
      how: `after = ${afterHow}; before = the earlier scene nearest the requested before-date ${force.before}`,
    }
  }

  const tiers: Array<[PairChoice['match'], (s: S1Scene) => boolean]> = [
    ['orbit', (s) => s.relativeOrbit != null && s.relativeOrbit === after.scene.relativeOrbit],
    ['direction', (s) => s.orbit !== 'unknown' && s.orbit === after.scene.orbit],
    ['any', () => true],
  ]
  for (const [match, same] of tiers) {
    const cand = earlier.filter((p) => same(p.scene))
    if (cand.length === 0) continue
    const lo = Math.min(...cand.map((p) => p.fraction!))
    const cut = Math.max(lo, lo + DRY_QUANTILE * (after.fraction! - lo)) // never excludes the driest candidate
    const dry = cand.filter((p) => p.fraction! <= cut + 1e-12)
    const before = dry[dry.length - 1] // series is chronological: the latest = nearest earlier
    const tier = match === 'orbit' ? `same relative orbit ${after.scene.relativeOrbit}`
      : match === 'direction' ? `same ${after.scene.orbit} direction (no earlier scene on relative orbit ${after.scene.relativeOrbit})`
        : 'any geometry (no earlier scene with the same orbit or direction)'
    return {
      before, after, match,
      how:
        `after = ${afterHow}; before = the nearest earlier dry-season scene on the ${tier}: ` +
        `of ${cand.length} earlier candidate(s) with ${(lo * 100).toFixed(1)}-${(Math.max(...cand.map((p) => p.fraction!)) * 100).toFixed(1)}% water, ` +
        `"dry" means at most ${(cut * 100).toFixed(1)}% water (lowest ${DRY_QUANTILE * 100}% of the range up to the peak), and the latest such scene was taken`,
    }
  }
  return { error: 'no before-scene candidate' }
}

function tierOf(a: S1Scene, b: S1Scene): PairChoice['match'] {
  if (a.relativeOrbit != null && a.relativeOrbit === b.relativeOrbit) return 'orbit'
  if (a.orbit !== 'unknown' && a.orbit === b.orbit) return 'direction'
  return 'any'
}

/** Explicit-date mode: the nearest scene to `day`, preferring `like`'s relative orbit, then its direction. */
export function nearestLike(scenes: S1Scene[], day: string, like?: S1Scene): S1Scene | null {
  if (!like) return nearestScene(scenes, day)
  const sameOrbit = scenes.filter((s) => s.relativeOrbit != null && s.relativeOrbit === like.relativeOrbit)
  if (sameOrbit.length) return nearestScene(sameOrbit, day)
  const sameDir = scenes.filter((s) => s.orbit !== 'unknown' && s.orbit === like.orbit)
  return nearestScene(sameDir.length ? sameDir : scenes, day)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface DbRead {
  /** dB per pixel, NaN outside the polygon / nodata. Row 0 = north. */
  db: Float32Array
  width: number
  height: number
}

/** One scene's dB grid over the polygon: every item of the pass is read and merged (first valid pixel wins). */
export async function readSceneDb(scene: S1Scene, geom: any, maxSize: number, pol: Polarization): Promise<DbRead> {
  const key = pol.toLowerCase()
  let out: DbRead | null = null
  let lastErr = ''
  for (const item of scene.items) {
    const href = item?.assets?.[key]?.href
    if (!href) { lastErr = `scene ${item?.id} has no ${pol} asset`; continue }
    let g: Awaited<ReturnType<typeof fetchCogFeatureGrid>> | null = null
    // titiler.xyz is shared and slow on 100 MB-class COG windows: one retry before giving up on the item.
    for (let attempt = 0; attempt < 2 && !g; attempt++) {
      try {
        g = await fetchCogFeatureGrid({ cogUrl: await signPCAsset(href), geom, maxSize, cacheTag: 'flood-s1' })
      } catch (err: any) {
        lastErr = err?.message ?? 'read failed'
      }
    }
    if (!g) continue
    let db = linearToDb(g)
    if (!out) { out = { db, width: g.width, height: g.height }; continue }
    if (g.width !== out.width || g.height !== out.height) db = resampleNearest(db, g.width, g.height, out.width, out.height)
    for (let i = 0; i < out.db.length; i++) if (out.db[i] !== out.db[i] && db[i] === db[i]) out.db[i] = db[i]
  }
  if (!out) throw new Error(lastErr || `no readable ${pol} asset for ${scene.key}`)
  return out
}

/** Run `fn` over `xs` with at most `n` in flight; results keep input order. */
export async function mapLimit<T, R>(xs: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (next < xs.length) {
      const i = next++
      out[i] = await fn(xs[i], i)
    }
  }))
  return out
}

/** XYZ template for a scene's dB tiles from the Planetary Computer data API (SAS handled server-side). */
export function sarTileUrl(scene: Pick<S1Scene, 'tileItem'>, pol: Polarization, rescale: [number, number] = [-25, 0], colormap = 'greys_r'): string {
  const key = pol.toLowerCase()
  const p = new URLSearchParams()
  p.set('collection', S1_COLLECTION)
  p.set('item', String(scene.tileItem.id))
  p.append('assets', key)
  p.set('expression', `10*log10(${key})`)
  p.set('asset_as_band', 'true')
  p.append('rescale', `${rescale[0]},${rescale[1]}`)
  p.set('colormap_name', colormap)
  p.set('return_mask', 'true')
  return `${PC_DATA}/item/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${p}`
}
