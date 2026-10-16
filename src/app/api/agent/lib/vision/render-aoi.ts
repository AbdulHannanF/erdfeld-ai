/** Render the AOI to a picture a vision model can look at — Phase 2.5 (spec §3.6 A).
 *
 *  Two subjects, both real pixels clipped to the drawn polygon:
 *
 *    `truecolor` — the scene as the satellite saw it, NOT cloud-masked. Masking
 *                  first would delete the very thing the inspection exists to
 *                  find. This is how the agent gets to see a cloud.
 *    `index`     — a spectral index rendered with its own colormap, for checking
 *                  that a pattern in the numbers has a pattern in the picture.
 *
 *  The scene is chosen the same way `analyze_raster` chooses it, so the picture
 *  and the statistic describe the same acquisition. That is what makes the
 *  cross-check meaningful rather than two unrelated observations.
 */

import { cachedFetchJson } from '../cache'
import { clarityNote, pickClearestScene, sceneClarity, type SceneClarity } from '../cloud'
import { fetchFailureNote } from '../fetch-failure'
import { getLogger } from '../logger'
import { toGeometry } from '../pixels'
import { STAC_SEARCH_URL, toRfc3339Interval } from '../stac'
import {
  buildStacIndexClipPng,
  buildStacTrueColorClipPng,
  SPECTRAL_INDEX_TILE_CONFIG,
} from '../titiler'
import { aoiCoveragePct, dateWindow } from '../analysis/grid-source'

const log = getLogger('agent/vision-render')

export type RenderSubject = 'truecolor' | 'index'

export interface RenderAoiOptions {
  aoi: any
  bbox: [number, number, number, number]
  subject: RenderSubject
  /** Spectral index for `subject: 'index'`. */
  index?: string
  /** Target date; the chosen scene falls within ±30 days of it. */
  date?: string
  /** `clearest` matches what the statistics used; `newest` inspects the latest
   *  acquisition regardless of cloud — the right choice for "is it cloudy now?". */
  scene?: 'clearest' | 'newest'
  maxSize?: number
}

export interface RenderedAoi {
  imageBase64: string
  subject: RenderSubject
  index?: string
  sceneId: string
  sceneDate: string
  sceneCloudPct: number | null
  /** AOI-local clarity from SCL, when it could be read. This is the NUMBER the
   *  picture gets cross-checked against. */
  clarity: SceneClarity | null
  /** % of the drawn polygon the chosen scene actually observed. */
  coveragePct: number
  /** How the scene was picked, for the provenance line. */
  selection: 'clearest' | 'newest'
  windowLabel: string
}

export type RenderOutcome =
  | { ok: true; render: RenderedAoi }
  | { ok: false; message: string }

/** % of the polygon a grid of `observed` in-polygon pixels actually covers. */
function coverageOf(
  geom: any,
  observed: number,
  bbox: [number, number, number, number],
  width: number,
  height: number,
): number {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const midLat = (minLat + maxLat) / 2
  const cellXm = ((maxLng - minLng) / width) * 111_320 * Math.cos((midLat * Math.PI) / 180)
  const cellYm = ((maxLat - minLat) / height) * 110_540
  return aoiCoveragePct(geom, observed, cellXm, cellYm)
}

async function searchS2(bbox: number[], datetime: string, limit: number): Promise<any[]> {
  const body = {
    collections: ['sentinel-2-l2a'],
    bbox,
    datetime: toRfc3339Interval(datetime),
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    limit,
  }
  try {
    const data = await cachedFetchJson(`vision-stac:${JSON.stringify(body)}`, 10 * 60 * 1000, async () => {
      const res = await fetch(STAC_SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) throw new Error(`STAC HTTP ${res.status}`)
      return res.json()
    })
    return (data?.features as any[]) ?? []
  } catch (err: any) {
    log.warn({ err: err?.message }, 'vision STAC search failed')
    throw err
  }
}

/** Render the AOI for inspection. Returns an honest message rather than a
 *  placeholder image when there is nothing real to show. */
export async function renderAoi(opts: RenderAoiOptions): Promise<RenderOutcome> {
  const geom = toGeometry(opts.aoi)
  if (!geom) {
    return { ok: false, message: 'A polygon AOI is required to render the area (draw a polygon, rectangle, or circle).' }
  }
  const subject = opts.subject
  const index = String(opts.index || 'NDVI').toUpperCase()
  if (subject === 'index' && !SPECTRAL_INDEX_TILE_CONFIG[index]) {
    return {
      ok: false,
      message: `Unsupported index "${opts.index}". Supported: ${Object.keys(SPECTRAL_INDEX_TILE_CONFIG).join(', ')}.`,
    }
  }

  const selection = opts.scene ?? 'clearest'
  const window = dateWindow(opts.date)
  let items: any[]
  try {
    items = await searchS2(opts.bbox, window.datetime, 12)
  } catch (err) {
    return { ok: false, message: fetchFailureNote('the Sentinel-2 catalogue (AWS Earth Search)', err) }
  }
  if (items.length === 0) {
    return { ok: false, message: `No Sentinel-2 L2A scene covers this AOI in the ${window.label} (AWS Earth Search).` }
  }

  let item: any
  let clarity: SceneClarity | null = null
  if (selection === 'newest') {
    // "Newest" must still mean newest scene that actually SHOWS the AOI. A tile
    // clipping one corner returns a frame that is 98% transparent and scores
    // its cloud fraction over the 2% it saw — measured 2026-08-11, where the
    // newest scene covered 5 184 of 262 144 pixels. Score the newest few and
    // take the newest with real coverage.
    const scored = await Promise.all(
      items.slice(0, 4).map(async (it) => ({ it, c: await sceneClarity(it, geom, 96) })),
    )
    const withCoverage = scored.map(({ it, c }) => ({
      it, c,
      coverage: c ? coverageOf(geom, c.totalPx, opts.bbox, c.grid.width, c.grid.height) : 0,
    }))
    const best = Math.max(...withCoverage.map((s) => s.coverage), 0)
    const covering = withCoverage.find((s) => s.coverage >= Math.max(50, best * 0.8))
    const chosen = covering ?? withCoverage[0]
    item = chosen.it
    clarity = chosen.c
  } else {
    const choice = await pickClearestScene(items, geom, { maxCandidates: 6 })
    if (choice) {
      item = choice.item
      clarity = choice.clarity
    } else {
      // Every candidate is clouded. Showing the newest one IS the answer here —
      // the agent should look at the cloud rather than refuse to look.
      item = items[0]
      clarity = await sceneClarity(item, geom, 96)
    }
  }

  const maxSize = Math.max(256, Math.min(1024, Math.round(opts.maxSize ?? 768)))
  const imageBase64 = subject === 'truecolor'
    ? await buildStacTrueColorClipPng(item, geom, maxSize)
    : await buildStacIndexClipPng(item, index, geom, maxSize)

  if (!imageBase64) {
    return {
      ok: false,
      message:
        `titiler could not render the ${subject === 'truecolor' ? 'true-colour' : index} clip for scene ` +
        `${String(item?.id ?? 'unknown')}. The public titiler.xyz instance is rate-limited — retry, or ` +
        `self-host (TITILER_ENDPOINT).`,
    }
  }

  return {
    ok: true,
    render: {
      imageBase64,
      subject,
      index: subject === 'index' ? index : undefined,
      sceneId: String(item?.id ?? 'unknown'),
      sceneDate: String(item?.properties?.datetime ?? '').slice(0, 10),
      sceneCloudPct:
        typeof item?.properties?.['eo:cloud_cover'] === 'number' ? item.properties['eo:cloud_cover'] : null,
      clarity,
      coveragePct: clarity
        ? coverageOf(geom, clarity.totalPx, opts.bbox, clarity.grid.width, clarity.grid.height)
        : 0,
      selection,
      windowLabel: window.label,
    },
  }
}

/** One-line description of what the picture is, used in the VLM prompt and in
 *  the tool's own provenance. */
export function renderLabel(r: RenderedAoi): string {
  const what = r.subject === 'truecolor' ? 'true-colour (red/green/blue)' : `${r.index} index`
  return `Sentinel-2 L2A ${what} composite, ${r.sceneDate}, clipped to the drawn AOI polygon`
}

/** The SCL numbers the picture will be checked against, or an honest absence. */
export function clarityLine(r: RenderedAoi): string {
  if (!r.clarity) return 'AOI-local cloud screening (SCL) could not be read for this scene.'
  const cov = r.coveragePct < 95 ? ' The scene covers ' + r.coveragePct.toFixed(0) + '% of the polygon.' : ''
  return `SCL over the AOI polygon: ${clarityNote(r.clarity)}.${cov}`
}
