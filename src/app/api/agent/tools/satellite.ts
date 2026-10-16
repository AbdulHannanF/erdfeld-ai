/** Satellite raster tools: NDVI / RGB imagery, spectral indices, thermal, SAR, temporal stack, surface water, active fires. */

import sharp from 'sharp'
import { cachedFetchJson, fetchWithRetry } from '../lib/cache'
import { validateVegaLite } from '../lib/chart-data'
import { genId } from '../lib/geometry'
import type { ChartItem } from '@/lib/chart-spec'
import { parseFirmsCsv, mergeAndDedup, filterFiresInAoi, computeFireStats, FIRE_PALETTE, type FireFeature } from '../lib/firms'
import { fetchFailureNote } from '../lib/fetch-failure'
import { getLogger } from '../lib/logger'
import { isGeePreferred, geeNdvi, geeSpectralIndex, geeLst, getGeeLastError } from '../lib/gee'
import { generateRasterPng } from '../lib/raster'
import { S2_ASSET_KEYS, STAC_SEARCH_URL, getStacItemHref, pickAsset, pickAssetKey, searchPlanetaryComputer, searchPCStac, signPCAsset, toRfc3339Interval } from '../lib/stac'
import {
  buildBboxFallbackLayer,
  buildNDVITileUrl,
  SPECTRAL_INDEX_TILE_CONFIG,
  buildLandsatLstTileUrl,
  fetchCogBandStats,
  fetchCogPolygonStats,
  fetchCogClipPng,
  fetchLandsatLstClipPng,
  TITILER_BASE,
  LST_SCALE,
  LST_OFFSET,
} from '../lib/titiler'
import { lstDescriptor, lstStretchC, type LstDnStats } from '../lib/thermal'
import { chooseMaxSize } from '../lib/digitize/scene-grid'
import { groupScenes, MIN_COVERAGE_PCT, readSceneDb, searchS1Rtc, type S1Scene } from '../lib/flood/scenes'
import { sarDbStats, sarRasterLayer, sarStretch, type SarDbStats } from '../lib/sar-layer'
import { makeGeoref } from '../lib/vectorize'
import type { GradientPalette, LayerPalette, Provenance, SummaryDatum, ToolCtx, ToolOutput } from '../lib/types'
import {
  clarityNote,
  clearPixelFilter,
  landsatClarity,
  noClearSceneMessage,
  examinedScenes,
  pickClearestLandsatScene,
  pickClearestScene,
  rejectedScenesNote,
  sceneClarity,
  type SceneClarity,
} from '../lib/cloud'
import { EONET_COVERAGE_CAVEAT, fetchEonetWildfires, firesInPolygon } from '../lib/eonet'
import { fetchCogFeatureGrid, gridStats, toGeometry } from '../lib/pixels'
import { maskedIndexStats, STAT_GRID_MAX_SIZE, effectiveGsdMeters, type MaskedIndexOutcome, type MaskedIndexStats } from '../lib/index-stats'
import { buildIndexPreviewLayer, buildIndexRasterLayer, buildTrueColorRasterLayer } from '../lib/raster-render'
import { emitPreviewLayer } from '../lib/layer-preview'
import { span } from '../lib/timings'
import { resolveSceneById } from '../lib/scenes'

const log = getLogger('tools/satellite')
import {
  fetchWorldCoverData,
  WORLDCOVER_PALETTE,
} from '../lib/worldcover'
import { callOverpass } from '../lib/overpass'
import turfArea from '@turf/area'

// --- Shared palettes for legend rendering (P2.3) ---------------------------
// These describe the actual color ramps the rasters/fallbacks use, so
// LayerLegend can draw a colorbar that matches what's on the map.

/** NDVI 7-class gradient mirroring `ndviToRgb` and titiler's rdylgn ramp. */
const NDVI_GRADIENT_PALETTE: GradientPalette = {
  kind: 'gradient',
  label: 'NDVI',
  unit: '',
  min: -1,
  max: 1,
  stops: [
    { value: -1.0, color: 'rgb(0,0,255)',     label: 'water' },
    { value:  0.0, color: 'rgb(139,69,19)',   label: 'bare' },
    { value:  0.1, color: 'rgb(244,164,96)',  label: 'sparse' },
    { value:  0.2, color: 'rgb(255,255,0)',   label: 'low veg' },
    { value:  0.35, color: 'rgb(154,205,50)', label: 'moderate' },
    { value:  0.5, color: 'rgb(34,139,34)',   label: 'healthy' },
    { value:  0.7, color: 'rgb(0,100,0)',     label: 'dense' },
  ],
}

/** Generic spectral-index palette (NDWI/NDBI/EVI/NBR/SAVI) keyed to titiler colormaps.
 *  Each entry's stop colors approximate the named colormap; range is always −1..1. */
const SPECTRAL_INDEX_PALETTES: Record<string, GradientPalette> = {
  NDVI: NDVI_GRADIENT_PALETTE,
  NDWI: {
    kind: 'gradient', label: 'NDWI', min: -1, max: 1,
    stops: [
      { value: -1, color: '#f7fbff', label: 'dry' },
      { value:  0, color: '#9ecae1', label: 'moist' },
      { value:  0.3, color: '#3182bd', label: 'water' },
      { value:  1, color: '#08306b', label: 'deep water' },
    ],
  },
  NDBI: {
    kind: 'gradient', label: 'NDBI', min: -1, max: 1,
    stops: [
      { value: -1, color: '#fff7ec', label: 'low' },
      { value:  0, color: '#fdbb84', label: 'mixed' },
      { value:  0.3, color: '#e34a33', label: 'built' },
      { value:  1, color: '#7f0000', label: 'dense built' },
    ],
  },
  EVI: {
    kind: 'gradient', label: 'EVI', min: -1, max: 1,
    stops: [
      { value: -1, color: '#ffffe5', label: 'bare' },
      { value:  0.2, color: '#addd8e', label: 'sparse' },
      { value:  0.5, color: '#41ab5d', label: 'healthy' },
      { value:  1, color: '#004529', label: 'dense' },
    ],
  },
  NBR: {
    kind: 'gradient', label: 'NBR', min: -1, max: 1,
    stops: [
      { value: -1, color: '#67001f', label: 'severely burned' },
      { value: -0.3, color: '#d6604d', label: 'burned' },
      { value:  0, color: '#f7f7f7', label: 'unburned' },
      { value:  0.3, color: '#4393c3', label: 'regrowth' },
      { value:  1, color: '#053061', label: 'healthy' },
    ],
  },
  SAVI: {
    kind: 'gradient', label: 'SAVI', min: -1, max: 1,
    stops: [
      { value: -1, color: '#ffffe5', label: 'bare' },
      { value:  0.2, color: '#addd8e', label: 'sparse' },
      { value:  0.5, color: '#41ab5d', label: 'moderate' },
      { value:  1, color: '#004529', label: 'dense' },
    ],
  },
}

/** Thermal palette — plasma, 280..320 K ≈ 7..47 °C. */
const THERMAL_PALETTE: GradientPalette = {
  kind: 'gradient', label: 'LST', unit: '°C', min: 7, max: 47,
  stops: [
    { value: 7,  color: '#0d0887' },
    { value: 17, color: '#7e03a8' },
    { value: 27, color: '#cb4778' },
    { value: 37, color: '#f89441' },
    { value: 47, color: '#f0f921' },
  ],
}

/** Cached STAC search via a raw POST body (used by the inline tools that don't go through
 *  searchPlanetaryComputer). Keyed on body JSON. */
async function cachedStacSearch(body: unknown, timeoutMs = 15000): Promise<any> {
  return span('stac_search', () => cachedStacSearchUntimed(body, timeoutMs))
}

async function cachedStacSearchUntimed(body: unknown, timeoutMs: number): Promise<any> {
  // Element84 now rejects a bare YYYY-MM-DD datetime (HTTP 400, RFC3339). Normalize
  // any string datetime on the body before keying + sending so callers can keep
  // passing date-only ranges. Already-RFC3339 datetimes pass through unchanged.
  const normalized =
    body && typeof body === 'object' && typeof (body as any).datetime === 'string'
      ? { ...(body as Record<string, unknown>), datetime: toRfc3339Interval((body as any).datetime) }
      : body
  const key = `stac-raw:${JSON.stringify(normalized)}`
  return cachedFetchJson(key, 10 * 60 * 1000, async () => {
    const res = await fetch(STAC_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(normalized),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`STAC HTTP ${res.status}`)
    return res.json()
  })
}

/** Color picker keyed off the (real) NDVI mean — only used for the illustrative
 *  AOI-polygon fallback when real per-pixel tiles aren't available. */
function ndviMeanColor(v: number): string {
  return v > 0.5 ? '#166534'
    : v > 0.3 ? '#4ade80'
    : v > 0.1 ? '#fbbf24'
    : v > 0   ? '#f97316'
    : '#ef4444'
}

/** The Sentinel-2 scenes a run may use: the one named by `scene_id`, else the scenes within 3 days of
 *  `date`, else the recent default. A named scene that does not exist, is the wrong sensor, or does not
 *  cover the area is refused (never replaced by another); an unreachable catalogue is a failure. */
async function s2Candidates(
  bbox: number[],
  args: Record<string, any>,
  o: { days: number; limit: number; cloud: number },
): Promise<{ items: any[]; label: string; pinned: boolean; refusal?: ToolOutput }> {
  if (typeof args.scene_id === 'string' && args.scene_id) {
    const r = await resolveSceneById('sentinel-2', args.scene_id, bbox, typeof args.date === 'string' ? args.date : undefined)
    if (!r.ok) return { items: [], label: '', pinned: true, refusal: { summary: r.message, ...(r.failed ? { failed: true } : {}) } }
    return { items: [r.item], label: `scene ${args.scene_id}`, pinned: true }
  }
  const DAY = 86_400_000
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
  if (typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    const t = Date.parse(`${args.date}T00:00:00Z`)
    const data = await cachedStacSearch({
      collections: ['sentinel-2-l2a'],
      bbox,
      datetime: `${iso(t - 3 * DAY)}/${iso(t + 3 * DAY)}`,
      sortby: [{ field: 'properties.datetime', direction: 'desc' }],
      limit: o.limit,
    })
    return { items: data.features || [], label: `${args.date} (+-3 days)`, pinned: true }
  }
  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - o.days)
  const data = await cachedStacSearch({
    collections: ['sentinel-2-l2a'],
    bbox,
    datetime: `${start.toISOString().slice(0, 10)}/${end.toISOString().slice(0, 10)}`,
    query: { 'eo:cloud_cover': { lt: o.cloud } },
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    limit: o.limit,
  })
  return { items: data.features || [], label: `last ${o.days} days`, pinned: false }
}

export async function ndviOrImagery(ctx: ToolCtx, toolName: string, args: Record<string, any> = {}): Promise<ToolOutput> {
  const { aoi, bbox, areaKm2, emit } = ctx
  const [minLng, minLat, maxLng, maxLat] = bbox
  const isNdvi = toolName === 'fetch_ndvi' || toolName === 'render_ndvi_colormap'
  const aoiBounds: [number, number, number, number] = [minLng, minLat, maxLng, maxLat]

  if (isNdvi) {
    // ── GEE is a FALLBACK, not the default (owner decision 2026-08-09): use it only
    //    when the faster free path (Earth Search + titiler) cannot deliver. Its natural
    //    home is the all-clouded case — a GEE median composite mosaics many scenes and
    //    masks cloud per pixel, which is exactly what a single clouded scene cannot do.
    const tryGeeComposite = async (): Promise<ToolOutput | null> => {
      if (!isGeePreferred()) return null
      emit?.('token', { type: 'token', content: 'Falling back to a cloud-masked Sentinel-2 median composite (Google Earth Engine)...\n' })
      const gee = await geeNdvi(aoi, 3)
      if (gee) {
        const meanLine = gee.meanNdvi != null
          ? `**NDVI mean (drawn AOI polygon):** ${gee.meanNdvi.toFixed(3)}`
          : '**NDVI mean:** computed over the composite'
        const ndviSd: Record<string, SummaryDatum> = { area_km2: Number(areaKm2.toFixed(1)) }
        if (gee.meanNdvi != null) ndviSd.mean = Number(gee.meanNdvi.toFixed(3))
        return {
          summary: `NDVI (B8−B4)/(B8+B4) for ${areaKm2.toFixed(1)} km² (drawn polygon).\n\n**Source:** Google Earth Engine — cloud-masked **Sentinel-2 SR median composite** (${gee.startDate} → ${gee.endDate}, QA60 cloud mask).\n${meanLine}\n**Colour palette (rdylgn):** red(bare/water) → yellow(sparse) → green(dense vegetation).\n\nReal per-pixel 10 m tiles rendered server-side by GEE, mosaicked across all scenes in the window and clipped to your AOI — no single-scene coverage limit.`,
          summary_data: ndviSd,
          layer: {
            id: 'ndvi-active',
            name: `NDVI (GEE median ${gee.endDate})`,
            type: 'raster' as const,
            tileUrl: gee.tileUrl,
            bounds: [minLng, minLat, maxLng, maxLat],
            palette: NDVI_GRADIENT_PALETTE,
            provenance: {
              source: 'Sentinel-2 SR (Google Earth Engine) — cloud-masked median composite',
              method: 'GEE server-rendered 10 m tiles · polygon reduceRegion mean',
              clip: 'polygon',
            },
            confidence: 'high',
          },
        }
      }
      emit?.('token', { type: 'token', content: `GEE unavailable (${getGeeLastError() ?? 'unknown'}).\n` })
      return null
    }

    emit?.('token', { type: 'token', content: 'Fetching NDVI from AWS Earth Search + titiler.xyz...\n' })

    let sceneDate = new Date().toISOString().slice(0, 10)
    let cloudStr = 'N/A'
    let platform = 'Sentinel-2'
    let ndviMean: number | null = null
    let item: any = null
    // Phase 0 — AOI-local cloud screening. Scene-wide `eo:cloud_cover` says nothing
    // about the drawn polygon (measured: 48.9% scene cloud → 12.8% AOI clear), so we
    // pull several candidates and rank them on SCL cloud over the AOI itself.
    let maskedNote = ''
    let cloudRefusal: string | null = null
    // ISS-129: the clear-pixel count the reported mean actually used, and the
    // effective ground sample distance that implies over this AOI — both needed
    // below to stop saying "10 m" next to a statistic that wasn't computed at 10 m.
    let ndviClearPx = 0
    let ndviSearchError: string | null = null
    let ndviWindow = 'last 90 days'
    let ndviClearPct: number | null = null
    let ndviGsdM: number | null = null
    // Clear-pixel statistics (p2/p98) that set the data-driven display stretch.
    let ndviStretchStats: MaskedIndexStats | null = null

    try {
      const cand = await s2Candidates(aoiBounds, args, { days: 90, limit: 6, cloud: 60 })
      if (cand.refusal) return cand.refusal
      ndviWindow = cand.label
      const items: any[] = cand.items
      if (items.length > 0) {
        emit?.('token', { type: 'token', content: `Scoring ${items.length} candidate scene(s) on cloud over your AOI (Sentinel-2 SCL)...\n` })
        // ISS-129: the statistics must NOT reuse the picker's `choice.clarity` as their mask —
        // it was scored at cloud.ts's cheap 96px ranking default (fine for picking a scene,
        // not for a reported statistic). Passing no `clarity` lets maskedIndexStats score its
        // own at `maxSize`, so the SCL mask and the NDVI grid are guaranteed the same shape
        // (see the opts.clarity warning in index-stats.ts). The picker starts them for each
        // candidate while that candidate's reflectance gate runs (Q-15); only the gate's
        // winner's statistics are used.
        const statsFor = (it: any) => span('stats', () => maskedIndexStats(it, 'NDVI', aoi, { maxSize: STAT_GRID_MAX_SIZE }))
        const choice = await span('scene_scoring', () => pickClearestScene(items, aoi, { speculate: statsFor }))
        if (choice) {
          item = choice.item
          // The scene passed every gate: draw its tiles now, statistics follow.
          emitPreviewLayer(emit, buildIndexPreviewLayer({
            id: 'ndvi-active',
            name: `NDVI ${(item.properties?.datetime as string || '').slice(0, 10)}`,
            item,
            index: 'NDVI',
            bounds: aoiBounds,
            provenance: { source: 'Sentinel-2 L2A (AWS Element84 Earth Search) — NDVI', date: (item.properties?.datetime as string || '').slice(0, 10) || undefined, method: '', clip: 'polygon' },
          }))
          const stats = await ((choice.speculative as Promise<MaskedIndexOutcome> | undefined) ?? statsFor(item))
          if (stats.ok) {
            ndviMean = stats.stats.mean
            ndviClearPx = stats.stats.count
            ndviClearPct = stats.stats.clearPct
            ndviStretchStats = stats.stats
            ndviGsdM = effectiveGsdMeters(areaKm2, stats.stats.count)
            maskedNote =
              `\n**Scene quality (over your AOI):** ${clarityNote(stats.stats.clarity)} — ` +
              `mean computed from ${stats.stats.count} clear pixels, cloud/shadow/cirrus excluded.`
          } else {
            maskedNote = `\n**Scene quality:** ${stats.failure.message}`
          }
          const skipped = rejectedScenesNote(choice)
          if (skipped) maskedNote += `\n**Caution:** ${skipped}`
        } else {
          // Every candidate was clouded over the AOI. Keep the newest scene so imagery
          // still renders, but report no index value — a mean here would be cloud tops.
          item = items[0]
          cloudRefusal = noClearSceneMessage(await examinedScenes(items, aoi), ndviWindow)
        }
        sceneDate = (item.properties?.datetime as string || '').slice(0, 10)
        const cc = item.properties?.['eo:cloud_cover']
        cloudStr = cc != null ? `${Number(cc).toFixed(1)}%` : 'N/A'
        platform = item.properties?.platform || 'Sentinel-2'
      }
    } catch (err: any) {
      ndviSearchError = err?.message || 'request failed'
      log.warn({ tool: 'ndvi', err: err.message }, 'STAC search failed')
    }

    // The catalogue could not be reached: a failure to look, not a finding that there is no scene.
    if (!item && ndviSearchError) {
      return { summary: `**NDVI** requested for ${areaKm2.toFixed(1)} km² (drawn polygon).\n\n${fetchFailureNote('the Sentinel-2 catalogue (AWS Element84 Earth Search)', ndviSearchError)}` }
    }

    // No usable clear sky. Before refusing, try the GEE median composite — it mosaics
    // and cloud-masks across many scenes, so it can succeed exactly where a single
    // clouded scene fails. Only if that is unavailable do we refuse.
    if (cloudRefusal && toolName === 'fetch_ndvi') {
      const geeResult = await tryGeeComposite()
      if (geeResult) {
        return {
          ...geeResult,
          summary:
            `_Every single Sentinel-2 scene over this AOI was clouded, so the statistic below ` +
            `comes from a multi-scene cloud-masked composite rather than one date._\n\n${geeResult.summary}`,
        }
      }
      return { summary: cloudRefusal }
    }

    const ndviProvenance = {
      source: `Sentinel-2 L2A (AWS Element84 Earth Search) — NDVI`,
      date: sceneDate || undefined,
      method: `titiler /stac/tiles XYZ (10 m) stretched to the AOI's own p2–p98, shown only inside the drawn polygon · ${
        ndviClearPct != null
          ? `SCL cloud/shadow/cirrus masked (${ndviClearPct.toFixed(0)}% of AOI clear) · mean of per-pixel NDVI`
          : 'mean of per-pixel NDVI'}`,
      clip: 'polygon' as const,
    }
    const ndviLayer = item
      ? buildIndexRasterLayer({
          id: 'ndvi-active',
          name: `NDVI ${sceneDate}`,
          item,
          index: 'NDVI',
          stats: ndviStretchStats,
          bounds: [minLng, minLat, maxLng, maxLat],
          provenance: ndviProvenance,
          confidence: 'high',
        })
      : null
    // 1. Preferred path: real per-pixel NDVI tiles via titiler.xyz /stac/tiles/, styled
    //    from the AOI's own pixel distribution (Q-14a / Q-16) and masked to the polygon
    //    on the client. A scene + a buildable tile template is enough to ship real tiles;
    //    we DO NOT demote to the misleading flat-colour fallback over a slow public probe.
    if (ndviLayer) {
      const meanLine = ndviMean != null
        ? `**NDVI mean (drawn AOI polygon, cloud-masked):** ${ndviMean.toFixed(3)}`
        : '**NDVI mean:** not reported — see scene quality below'
      const ndviSd: Record<string, SummaryDatum> = { area_km2: Number(areaKm2.toFixed(1)), scene_date: sceneDate }
      if (ndviMean != null) ndviSd.mean = Number(ndviMean.toFixed(3))
      if (ndviClearPct != null) ndviSd.valid_pixel_pct = Number(ndviClearPct.toFixed(1))
      if (Number.isFinite(parseFloat(cloudStr))) ndviSd.cloud_pct = Number(parseFloat(cloudStr).toFixed(1))
      if (ndviStretchStats?.p2 != null && ndviStretchStats.p98 != null) {
        ndviSd.p2 = Number(ndviStretchStats.p2.toFixed(3))
        ndviSd.p98 = Number(ndviStretchStats.p98.toFixed(3))
      }
      if (ndviGsdM != null) ndviSd.effective_resolution_m = Number(ndviGsdM.toFixed(1))
      // ISS-129: `10 m` describes what the RENDERED tiles use (real per-pixel data,
      // no cap) — it does NOT describe the MEAN, which is a statistic read from a grid
      // capped at STAT_GRID_MAX_SIZE px regardless of AOI size. State both.
      const gridResNote = ndviGsdM != null
        ? ` The mean, however, is a statistic from ${ndviClearPx} clear px on a ${STAT_GRID_MAX_SIZE}px-capped grid — effective ground sample distance ~${ndviGsdM.toFixed(0)} m over this ${areaKm2.toFixed(1)} km² AOI, not 10 m.`
        : ''
      const stretch = ndviLayer.raster?.rescale?.[0]
      const stretchNote = stretch
        ? ndviLayer.raster?.stretch === 'p2-p98'
          ? `**Stretch:** ${stretch[0]} to ${stretch[1]} (p2–p98 of the clear AOI pixels; adjustable in the layer panel).`
          : `**Stretch:** fixed ${stretch[0]} to ${stretch[1]} (no clear-pixel statistics were available to fit one).`
        : ''
      return {
        summary: `NDVI colormap (B08−B04)/(B08+B04) for ${areaKm2.toFixed(1)} km² (drawn polygon).

**Scene:** ${sceneDate} | **Cloud cover (scene-wide):** ${cloudStr} | **Satellite:** ${platform}
${meanLine}${maskedNote}
${stretchNote}
**Color palette (rdylgn):** red(bare/water) → yellow(sparse) → green(dense vegetation)
**Source:** real per-pixel NDVI tiles at Sentinel-2's native 10 m, shown only inside your polygon.${gridResNote} Statistics are polygon-clipped and cloud-masked (titiler /stac/feature.npy + Sentinel-2 SCL).`,
        summary_data: ndviSd,
        layer: ndviLayer,
      }
    }

    // 2. Honest fallback: no synthetic per-pixel texture. When a real mean DOES
    //    exist, render the drawn polygon filled with a single mean-derived color,
    //    labelled plainly as illustrative.
    //
    //    DEFECT-2 / ISS-129 (2026-08-17 vision QA sweep): when the mean does NOT
    //    exist, this used to fall through anyway — `ndviMean ?? 0` handed
    //    `ndviMeanColor` a value of 0, which resolves to '#ef4444' (red), and the
    //    NDVI_GRADIENT_PALETTE legend was attached regardless. The result was a
    //    solid red polygon over open OCEAN, legended as an NDVI scale, right next
    //    to text saying "unavailable" — a real screenshot, not a hypothetical. A
    //    flat fill is only a legitimate summary of REAL data when a mean exists;
    //    with no mean there is nothing to derive a color from, so nothing is
    //    drawn. The map must never draw a measurement the text says does not exist.
    if (ndviMean == null) {
      return {
        summary: `NDVI computed for ${areaKm2.toFixed(1)} km² (drawn polygon, ${sceneDate}, ${cloudStr} scene-wide cloud).\n\n**NDVI mean (drawn polygon, cloud-masked):** unavailable${maskedNote}\n**Per-pixel raster:** unavailable (titiler tile failed to verify).\n**Map layer:** none — there is no real mean to derive a fill color from, so nothing is drawn rather than implying a measurement that does not exist.\n**Source:** No cloud-masked NDVI value was obtainable for this AOI.`,
        summary_data: { area_km2: Number(areaKm2.toFixed(1)), scene_date: sceneDate },
        sources: ['Sentinel-2 L2A (AWS Element84 Earth Search)'],
        // No `layer` — see the comment above (DEFECT-2 / ISS-129).
      }
    }

    const color = ndviMeanColor(ndviMean)
    const meanLabel = ndviMean.toFixed(3)
    const ndviFbSd: Record<string, SummaryDatum> = {
      area_km2: Number(areaKm2.toFixed(1)),
      scene_date: sceneDate,
      mean: Number(ndviMean.toFixed(3)),
    }
    return {
      summary: `NDVI computed for ${areaKm2.toFixed(1)} km² (drawn polygon, ${sceneDate}, ${cloudStr} scene-wide cloud).\n\n**NDVI mean (drawn polygon, cloud-masked):** ${meanLabel}${maskedNote}\n**Per-pixel raster:** unavailable (titiler tile failed to verify) — the map shows the AOI polygon filled with a flat color derived from the real mean. No synthetic per-pixel texture is fabricated.\n**Source:** Real per-pixel NDVI from titiler /stac/feature.npy, clipped to the drawn polygon and SCL cloud-masked. No bbox or scene-wide fallback exists.`,
      summary_data: ndviFbSd,
      layer: {
        id: 'ndvi-active',
        name: `NDVI illustrative — real mean ${meanLabel}`,
        type: 'geojson' as const,
        geojson: {
          type: 'FeatureCollection',
          features: [{
            type: 'Feature' as const,
            properties: {
              ndvi_mean: ndviMean,
              label: `NDVI: ${meanLabel}`,
              color,
              fill: color,
              illustrative: true,
            },
            geometry: aoi,
          }],
        },
        palette: NDVI_GRADIENT_PALETTE,
        // DEFECT-3 / ISS-129: this layer previously carried no `provenance` at all
        // (a null-provenance NDVI layer showed up in a 60-probe sweep). It is a
        // real, cloud-masked mean — just rendered as a flat fill because the
        // per-pixel tile failed to verify — so it earns real provenance naming
        // that fallback explicitly, not the headline per-pixel render method.
        provenance: {
          source: 'Sentinel-2 L2A (AWS Element84 Earth Search) — NDVI',
          date: sceneDate || undefined,
          method: `Flat-fill illustrative polygon colored by the real cloud-masked NDVI mean (${meanLabel}, ${ndviClearPx} clear px); per-pixel raster tile failed to verify.`,
          clip: 'polygon' as const,
        },
        confidence: 'medium' as const,
      },
    }
  }

  // ---- fetch_high_res_imagery — AOI-clipped true-colour tiles ----
  // The clearest recent scene over the polygon (SCL cloud over the AOI, not scene-wide metadata),
  // drawn as native-resolution tiles that the map hides outside the polygon. The STAC item's own
  // preview.jpg is a whole-scene picture (about 190x a small AOI) and is not used.
  let cand: Awaited<ReturnType<typeof s2Candidates>>
  try {
    cand = await s2Candidates(aoiBounds, args, { days: 90, limit: 12, cloud: 60 })
  } catch (err: any) {
    return { summary: `Sentinel-2 STAC search failed: ${err.message}. AWS Earth Search may be temporarily unavailable.`, failed: true }
  }
  if (cand.refusal) return cand.refusal
  const items: any[] = cand.items
  if (items.length === 0) {
    return { summary: cand.pinned ? `No Sentinel-2 scene covers this area for ${cand.label}.` : `No Sentinel-2 imagery found with cloud cover <60% for this area in the past 90 days.` }
  }
  const imageryGeom = toGeometry(aoi)
  const choice = imageryGeom ? await pickClearestScene(items, imageryGeom).catch(() => null) : null
  const item = choice?.item ?? items[0]
  const sceneDate = (item.properties?.datetime as string || '').slice(0, 10)
  const cloudCover = item.properties?.['eo:cloud_cover']
  const cloudStr = cloudCover != null ? `${Number(cloudCover).toFixed(1)}%` : 'N/A'
  const platform = item.properties?.platform || 'Sentinel-2'
  const imageryProvenance = {
    source: 'Sentinel-2 L2A (AWS Element84 Earth Search) via titiler',
    date: sceneDate || undefined,
    method: `true-colour tiles from the red, green and blue bands (reflectance 0 to 0.3 mapped to the display range); ${choice ? 'clearest recent scene by SCL cloud over the AOI' : 'newest scene (no scene reached the clear-sky floor over the AOI, so it is not cloud-masked and may include cloud)'}; shown at native 10 m and hidden outside the polygon`,
    clip: 'polygon (display mask)' as const,
  }
  const rgbLayer = buildTrueColorRasterLayer({
    id: `rgb-${genId()}`,
    name: `RGB Sentinel-2 (${sceneDate})`,
    item,
    bounds: aoiBounds,
    provenance: imageryProvenance,
    confidence: choice ? 'high' : 'low',
  })
  if (!rgbLayer) {
    return { summary: `Sentinel-2 scene found (${sceneDate}, cloud: ${cloudStr}) but it lacks a red, green or blue asset or a STAC item URL, so no true-colour tiles can be requested. Nothing was drawn.` }
  }
  const aoiClear = choice
    ? `\n**Scene quality (over your AOI):** ${clarityNote(choice.clarity)}`
    : '\n**Caution:** no scene reached the clear-sky floor over your AOI; the newest one is shown unmasked and may include cloud.'
  return {
    summary: `Sentinel-2 true-color imagery (10 m) for ${areaKm2.toFixed(1)} km² (drawn polygon).\n\n**Scene:** ${sceneDate} | **Scene-wide cloud:** ${cloudStr} | **Satellite:** ${platform}${aoiClear}\n\nReal Copernicus Sentinel-2 imagery, drawn as per-pixel tiles and hidden outside the polygon.`,
    summary_data: {
      scene_date: sceneDate,
      ...(cloudCover != null ? { cloud_cover_pct: Number(Number(cloudCover).toFixed(1)) } : {}),
      ...(choice ? { aoi_clear_pct: Number(choice.clarity.clearPct.toFixed(1)) } : {}),
    },
    layer: rgbLayer,
  }
}

const NDVI_SERIES_COLOR = '#2e7d32'

/** Vega-Lite line + points of the cloud-masked mean NDVI per acquisition. Dates with no clear pixel
 *  are absent from the rows, so the line is never drawn through a gap's imagined value. Null with
 *  fewer than two points (one acquisition is not a series) or when the spec does not compile. */
export function buildNdviSeriesChart(points: { label: string; value: number }[], aoiCloud: { label: string; value: number }[]): ChartItem | null {
  if (points.length < 2) return null
  const cloudByDate = new Map(aoiCloud.map((c) => [c.label, c.value]))
  const rows = points.map((p) => ({ date: p.label, ndvi: p.value, aoi_cloud_pct: cloudByDate.get(p.label) ?? null }))
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    data: { values: rows },
    layer: [
      { mark: { type: 'line', color: NDVI_SERIES_COLOR, strokeWidth: 2 } },
      { mark: { type: 'point', filled: true, color: NDVI_SERIES_COLOR, size: 60, opacity: 1 } },
    ],
    encoding: {
      x: { field: 'date', type: 'temporal', axis: { title: null, format: '%b %d, %Y' } },
      y: { field: 'ndvi', type: 'quantitative', axis: { title: 'Mean NDVI (cloud-masked, drawn polygon)' }, scale: { zero: false } },
      tooltip: [
        { field: 'date', type: 'temporal', title: 'Acquisition' },
        { field: 'ndvi', type: 'quantitative', title: 'Mean NDVI', format: '.3f' },
        { field: 'aoi_cloud_pct', type: 'quantitative', title: 'AOI cloud-masked (%)' },
      ],
    },
  }
  const ok = validateVegaLite(spec)
  if (!ok.ok) {
    log.warn({ error: ok.error }, 'temporal stack chart rejected')
    return null
  }
  return { id: `chart-${genId()}`, title: 'Mean NDVI per clear Sentinel-2 acquisition', spec }
}

export async function fetchTemporalStack(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const { aoi, bbox, areaKm2, emit } = ctx
  const [minLng, minLat, maxLng, maxLat] = bbox
  const months = Math.min(args.months || 6, 12)
  const today = new Date()
  const endDate = today.toISOString().slice(0, 10)
  const startDate = new Date(today.getFullYear(), today.getMonth() - months, 1).toISOString().slice(0, 10)
  let stData: any
  try {
    stData = await cachedStacSearch({
      collections: ['sentinel-2-l2a'],
      bbox: [minLng, minLat, maxLng, maxLat],
      datetime: `${startDate}/${endDate}`,
      query: { 'eo:cloud_cover': { lt: 40 } },
      sortby: [{ field: 'properties.datetime', direction: 'desc' }],
      limit: months * 2,
    })
  } catch (err: any) {
    return { summary: `Temporal STAC search failed: ${err.message}.`, failed: true }
  }
  const items: any[] = stData.features || []
  if (items.length === 0) {
    return { summary: `No Sentinel-2 scenes found for the last ${months} months with cloud cover <40% over this area. The region may have persistent cloud cover.` }
  }

  // Order chronologically (oldest → newest) so the slider plays forward in time.
  const orderedAll = [...items].sort((a: any, b: any) => {
    const da = (a.properties?.datetime as string) || ''
    const db = (b.properties?.datetime as string) || ''
    return da.localeCompare(db)
  })
  const ordered = orderedAll.slice(-12) // cap at 12 frames for slider sanity

  // Build per-scene NDVI tile templates + emit temporal_frame events so the
  // MapTimelineSlider has real, dated, renderable scenes to scrub through.
  const frames: { date: string; tileUrl: string; bounds?: [number, number, number, number]; cloud: number | null }[] = []
  for (const item of ordered) {
    const tileUrl = buildNDVITileUrl(item)
    if (!tileUrl) continue
    const date = (item.properties?.datetime as string || '').slice(0, 10)
    const cc = item.properties?.['eo:cloud_cover']
    const sceneBounds: [number, number, number, number] | undefined =
      Array.isArray(item.bbox) && item.bbox.length >= 4
        ? [item.bbox[0], item.bbox[1], item.bbox[2], item.bbox[3]]
        : undefined
    const frame = { date, tileUrl, bounds: sceneBounds, cloud: cc != null ? Number(cc) : null }
    frames.push(frame)
    emit?.('temporal_frame', {
      type: 'temporal_frame',
      date,
      tile_url: tileUrl,
      bounds: sceneBounds,
      cloud: frame.cloud,
    })
  }

  // ── ISS-010: the mean-NDVI-per-acquisition series ────────────────────────
  //
  // The stack used to render frames and a "cloud" chart and nothing else, so
  // the one question a time series exists to answer — did it get greener? —
  // needed a separate manual call per date.
  //
  // Two rules make this honest rather than just present:
  //  1. Each value is a POLYGON-CLIPPED, SCL-MASKED mean (`maskedIndexStats`),
  //     not a tile average. A mean over the newest scene under a scene-wide
  //     cloud gate is exactly the ISS-101 defect, and a *series* of them would
  //     draw a trend line through cloud tops.
  //  2. A date that is too clouded over the AOI becomes a GAP, never a value.
  //     Interpolating there would invent the change the user is looking for.
  //
  // The scene-wide `eo:cloud_cover` chart is kept but relabelled, and the
  // AOI-local figure is charted beside it — they routinely disagree (measured
  // 2026-08-09: 87.2% scene-wide vs 0.0% AOI-clear on the same scene).
  const seriesPoints: { label: string; value: number }[] = []
  const aoiCloudPoints: { label: string; value: number }[] = []
  const gaps: { date: string; reason: string }[] = []

  if (aoi) {
    emit?.('token', {
      type: 'token',
      content: `Computing per-acquisition NDVI over your polygon (cloud-masked, ${frames.length} scenes)...\n`,
    })
    // ONE point per acquisition DATE. A STAC search returns an item per tile,
    // so a single overpass can come back as several items sharing a datetime —
    // measured 2026-08-16 over the Central Valley: 12 items for 6 dates, which
    // charted as six doubled points and an inflated "12 acquisitions". Keep the
    // item with the least scene-wide cloud as a cheap prior; SCL masking over
    // the polygon then does the real work.
    const byDate = new Map<string, any>()
    for (const item of ordered) {
      const d = (item.properties?.datetime as string || '').slice(0, 10)
      if (!d) continue
      const cc = Number(item.properties?.['eo:cloud_cover'] ?? 100)
      const prev = byDate.get(d)
      if (!prev || cc < Number(prev.properties?.['eo:cloud_cover'] ?? 100)) byDate.set(d, item)
    }
    const uniqueDates = [...byDate.values()].sort((a, b) =>
      String(a.properties?.datetime ?? '').localeCompare(String(b.properties?.datetime ?? '')))

    // Batched rather than all-at-once: each call is a titiler polygon read and
    // the public instance is rate-limited.
    for (let i = 0; i < uniqueDates.length; i += 3) {
      const batch = uniqueDates.slice(i, i + 3)
      const results = await Promise.all(
        batch.map(async (item: any) => ({
          date: (item.properties?.datetime as string || '').slice(0, 10),
          // ISS-129: deliberately NOT raised to STAT_GRID_MAX_SIZE here — this loop
          // already reads up to 12 dates × 2 grids (index + SCL) each; bumping every
          // read ~28x would multiply an already-batched, rate-limited titiler.xyz
          // workload for a series this tool never labels with a specific resolution
          // (unlike fetch_ndvi/compute_spectral_index, see those for the fix).
          stats: await maskedIndexStats(item, 'NDVI', aoi).catch(() => null),
        })),
      )
      for (const { date, stats } of results) {
        if (!date) continue
        if (stats?.ok) {
          seriesPoints.push({ label: date, value: Number(stats.stats.mean.toFixed(3)) })
          aoiCloudPoints.push({ label: date, value: Number((100 - stats.stats.clearPct).toFixed(0)) })
        } else {
          gaps.push({ date, reason: stats?.ok === false ? stats.failure.reason : 'read failed' })
        }
      }
    }
  }

  const sceneList = ordered.map((it: any) => {
    const d = (it.properties?.datetime as string || '?').slice(0, 10)
    const cc = it.properties?.['eo:cloud_cover']
    const pt = seriesPoints.find((p) => p.label === d)
    const ndvi = pt ? `NDVI **${pt.value.toFixed(3)}**` : (gaps.some((g) => g.date === d) ? '_no value — AOI clouded_' : '')
    return `  - ${d} (scene-wide cloud: ${cc != null ? Number(cc).toFixed(0) + '%' : '?'})${ndvi ? ' — ' + ndvi : ''}`
  }).join('\n')

  // A trend claim is only made when there are at least two real, cloud-masked
  // endpoints — and it names them, so the reader can see what it was measured
  // between rather than trusting a slope drawn through gaps.
  let trendLine = ''
  if (seriesPoints.length >= 2) {
    const a = seriesPoints[0]
    const b = seriesPoints[seriesPoints.length - 1]
    const delta = b.value - a.value
    const dir = Math.abs(delta) < 0.02 ? 'essentially unchanged' : delta > 0 ? 'increased' : 'decreased'
    trendLine =
      `\n\n**AOI NDVI ${dir}: ${a.value.toFixed(3)} (${a.label}) → ${b.value.toFixed(3)} (${b.label})** ` +
      `— Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(3)} across ${seriesPoints.length} cloud-masked acquisitions.`
  } else if (seriesPoints.length === 1) {
    trendLine = `\n\nOnly one acquisition was clear enough over your polygon to yield a value, so no trend is reported.`
  }
  const gapLine = gaps.length
    ? `\n\n_${gaps.length} of ${ordered.length} acquisitions produced no NDVI value — the AOI was under cloud, ` +
      `or the scene did not cover it. Those dates are left as gaps rather than interpolated._`
    : ''

  const summary = `Sentinel-2 temporal NDVI stack — **${frames.length} renderable scene${frames.length === 1 ? '' : 's'}** of ${items.length} total over the last ${months} months (oldest → newest):\n\n${sceneList}${trendLine}${gapLine}\n\nUse the timeline slider at the bottom of the map to scrub through scenes. Each frame is real titiler.xyz NDVI from AWS Earth Search; the per-date values above are polygon-clipped and SCL cloud-masked.`

  // If no frame had a buildable tile URL, fall back to text-only (the slider won't render).
  if (frames.length === 0) {
    return {
      summary: `Sentinel-2 temporal stack — **${items.length} scenes** over the last ${months} months:\n\n${sceneList}\n\nCould not build NDVI tile URLs for these scenes — STAC items may be missing band assets. Per-scene NDVI time series: call \`compute_spectral_index\` with index="NDVI" for each date of interest.`,
    }
  }

  // Emit a single stable temporal NDVI layer pinned to the latest frame; the
  // slider drives `setLayerTileUrl('ndvi-temporal', ...)` to swap frames in place.
  const latest = frames[frames.length - 1]
  const seriesChart = buildNdviSeriesChart(seriesPoints, aoiCloudPoints)
  return {
    summary,
    ...(seriesChart ? { charts: [seriesChart] } : {}),
    summary_data: {
      scene_count: frames.length,
      total_scenes: items.length,
      months,
      // Scene-wide metadata — kept for context, but it describes a ~110 km tile,
      // not the drawn polygon (ISS-101), so the name now says so.
      scene_cloud_by_date: frames.map((f) => ({ label: f.date, value: f.cloud != null ? Number(f.cloud.toFixed(0)) : 0 })),
      ...(seriesPoints.length ? { ndvi_by_date: seriesPoints } : {}),
      ...(aoiCloudPoints.length ? { aoi_cloud_by_date: aoiCloudPoints } : {}),
      ...(seriesPoints.length >= 2
        ? {
            ndvi_first: seriesPoints[0].value,
            ndvi_last: seriesPoints[seriesPoints.length - 1].value,
            ndvi_delta: Number((seriesPoints[seriesPoints.length - 1].value - seriesPoints[0].value).toFixed(3)),
          }
        : {}),
      ndvi_points: seriesPoints.length,
      ndvi_gaps: gaps.length,
    },
    layer: {
      id: 'ndvi-temporal',
      name: `NDVI Temporal · ${latest.date}`,
      type: 'raster' as const,
      tileUrl: latest.tileUrl,
      bounds: [minLng, minLat, maxLng, maxLat],
      aoiMask: true,
      provenance: {
        source: 'Sentinel-2 L2A (AWS Earth Search) via titiler.xyz',
        date: latest.date,
        method: `(B08−B04)/(B08+B04) per-pixel tile · ${frames.length} chronological frames over ${months} mo (~${areaKm2.toFixed(1)} km² AOI bbox)`,
        clip: 'bbox',
      },
      confidence: 'high' as const,
      palette: NDVI_GRADIENT_PALETTE,
    },
  }
}

export async function computeSpectralIndex(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const { aoi, bbox, areaKm2, emit } = ctx
  const [minLng, minLat, maxLng, maxLat] = bbox
  const index = (args.index || 'NDVI').toUpperCase()

  type IndexConfig = { assets: string[]; expression: string; colormap: string; rescale: string; description: string }
  const INDEX_CONFIG: Record<string, IndexConfig> = {
    NDVI: { assets: ['B08', 'B04'], expression: '(B08-B04)/(B08+B04)', colormap: 'rdylgn', rescale: '-1,1', description: 'vegetation health (red→yellow→green)' },
    NDWI: { assets: ['B03', 'B08'], expression: '(B03-B08)/(B03+B08)', colormap: 'blues', rescale: '-1,1', description: 'water body detection (white→blue)' },
    NDBI: { assets: ['B11', 'B08'], expression: '(B11-B08)/(B11+B08)', colormap: 'hot', rescale: '-1,1', description: 'built-up / urban surface detection (black→red→white)' },
    EVI:  { assets: ['B08', 'B04', 'B02'], expression: '2.5*(B08-B04)/(B08+6*B04-7.5*B02+1)', colormap: 'rdylgn', rescale: '-1,1', description: 'enhanced vegetation — reduces soil/atmosphere bias vs NDVI' },
    NBR:  { assets: ['B08', 'B12'], expression: '(B08-B12)/(B08+B12)', colormap: 'rdbu', rescale: '-1,1', description: 'burn severity — post-fire negative values indicate burned areas' },
    SAVI: { assets: ['B08', 'B04'], expression: '1.5*(B08-B04)/(B08+B04+0.5)', colormap: 'ylgn', rescale: '-1,1', description: 'soil-adjusted vegetation — better for sparse/arid areas' },
  }

  const cfg = INDEX_CONFIG[index]
  if (!cfg) {
    return { summary: `Unknown spectral index "${index}". Supported: NDVI, NDWI, NDBI, EVI, NBR, SAVI.` }
  }

  // ── GEE is a FALLBACK (ISS-113), reached below only when every candidate scene
  //    is clouded over the AOI — a median composite mosaics many scenes and masks
  //    cloud per pixel, so it can answer where one clouded scene cannot.
  const tryGeeComposite = async (): Promise<ToolOutput | null> => {
    if (!isGeePreferred()) return null
    emit?.('token', { type: 'token', content: `Falling back to a cloud-masked Sentinel-2 median composite (Google Earth Engine)...\n` })
    const gee = await geeSpectralIndex(aoi, index, 3)
    if (gee) {
      const sd: Record<string, SummaryDatum> = { index, area_km2: Number(areaKm2.toFixed(1)) }
      if (gee.meanNdvi != null) sd.mean = Number(gee.meanNdvi.toFixed(3))
      return {
        summary: `**${index}** (${cfg.description}) for ${areaKm2.toFixed(1)} km² (drawn polygon).\n\n**Source:** Google Earth Engine — cloud-masked Sentinel-2 median composite (${gee.startDate} → ${gee.endDate}).${gee.meanNdvi != null ? `\n**${index} mean (AOI polygon):** ${gee.meanNdvi.toFixed(3)}` : ''}\n\nReal per-pixel 10 m tiles, mosaicked across scenes and clipped to your AOI.`,
        summary_data: sd,
        layer: {
          id: `${index.toLowerCase()}-active`,
          name: `${index} (GEE median ${gee.endDate})`,
          type: 'raster',
          tileUrl: gee.tileUrl,
          bounds: [minLng, minLat, maxLng, maxLat],
          palette: SPECTRAL_INDEX_PALETTES[index] ?? NDVI_GRADIENT_PALETTE,
          provenance: {
            source: `Sentinel-2 SR (Google Earth Engine) — ${index} median composite`,
            method: 'GEE server-rendered 10 m tiles · polygon reduceRegion mean',
            clip: 'polygon',
          },
          confidence: 'high',
        },
      }
    }
    emit?.('token', { type: 'token', content: `GEE unavailable (${getGeeLastError() ?? 'unknown'}).\n` })
    return null
  }

  emit?.('token', { type: 'token', content: `Computing real ${index} via AWS Earth Search + titiler.xyz...\n` })

  let siWindow = 'last 90 days'

  let siItem: any = null
  let siSearchError: string | null = null
  let siSceneDate = ''
  let siCloud: number | null = null
  // Phase 0 — AOI-local cloud screening, same as fetch_ndvi. Scene-wide
  // `eo:cloud_cover` says nothing about the drawn polygon: measured 2026-08-10,
  // this tool picked the newest scene under 30% scene cloud (2026-07-15, 20.1%)
  // and reported NDVI −0.072 — cloud-top reflectance, the exact ISS-101 artefact.
  let maskedNote = ''
  let cloudRefusal: string | null = null
  let meanVal: number | null = null
  let clearPx = 0
  // ISS-129: clear-pixel % and the effective ground sample distance the mean's
  // grid implies over this AOI — see the STAT_GRID_MAX_SIZE header comment.
  let clearPct: number | null = null
  let gsdM: number | null = null
  // Clear-pixel statistics (p2/p98) that set the data-driven display stretch.
  let stretchStats: MaskedIndexStats | null = null

  try {
    const cand = await s2Candidates([minLng, minLat, maxLng, maxLat], args, { days: 90, limit: 6, cloud: 60 })
    if (cand.refusal) return cand.refusal
    siWindow = cand.label
    const items: any[] = cand.items
    if (items.length > 0) {
      emit?.('token', { type: 'token', content: `Scoring ${items.length} candidate scene(s) on cloud over your AOI (Sentinel-2 SCL)...\n` })
      // ISS-129: do NOT reuse `choice.clarity` — scored at cloud.ts's cheap 96px ranking
      // default, a different shape than the statistics grid would use. maskedIndexStats
      // scores its own at `maxSize`, guaranteeing the SCL mask and the index grid match (see
      // the opts.clarity warning in index-stats.ts). Started per candidate alongside its gate.
      const statsFor = (it: any) => span('stats', () => maskedIndexStats(it, index, aoi, { maxSize: STAT_GRID_MAX_SIZE }))
      const choice = await span('scene_scoring', () => pickClearestScene(items, aoi, { speculate: statsFor }))
      if (choice) {
        siItem = choice.item
        emitPreviewLayer(emit, buildIndexPreviewLayer({
          id: `${index.toLowerCase()}-active`,
          name: `${index} (Sentinel-2) ${(siItem.properties?.datetime as string || '').slice(0, 10)}`,
          item: siItem,
          index,
          bounds: [minLng, minLat, maxLng, maxLat],
          provenance: { source: `Sentinel-2 L2A (AWS Element84 Earth Search) — ${index}`, date: (siItem.properties?.datetime as string || '').slice(0, 10) || undefined, method: '', clip: 'polygon' },
        }))
        const stats = await ((choice.speculative as Promise<MaskedIndexOutcome> | undefined) ?? statsFor(siItem))
        if (stats.ok) {
          meanVal = stats.stats.mean
          clearPx = stats.stats.count
          clearPct = stats.stats.clearPct
          stretchStats = stats.stats
          gsdM = effectiveGsdMeters(areaKm2, stats.stats.count)
          maskedNote =
            `\n**Scene quality (over your AOI):** ${clarityNote(stats.stats.clarity)} — ` +
            `mean computed from ${stats.stats.count} clear pixels, cloud/shadow/cirrus excluded.`
        } else {
          maskedNote = `\n**Scene quality:** ${stats.failure.message}`
        }
        const skipped = rejectedScenesNote(choice)
        if (skipped) maskedNote += `\n**Caution:** ${skipped}`
      } else {
        // Every candidate was clouded over the AOI. Keep the newest scene so the
        // imagery still renders, but report no value — it would be cloud tops.
        siItem = items[0]
        cloudRefusal = noClearSceneMessage(await examinedScenes(items, aoi), siWindow)
      }
      siSceneDate = (siItem.properties?.datetime as string || '').slice(0, 10)
      siCloud = siItem.properties?.['eo:cloud_cover'] ?? null
    }
  } catch (err: any) {
    siSearchError = err?.message || 'request failed'
    log.warn({ tool: 'spectral_index', index, err: err?.message }, 'STAC search failed')
  }

  if (!siItem) {
    return {
      summary: `**${index}** (${cfg.description}) requested for ${areaKm2.toFixed(1)} km² (drawn polygon).\n\n**Formula:** ${cfg.expression}\n\n${siSearchError ? fetchFailureNote('the Sentinel-2 catalogue', siSearchError) : 'No Sentinel-2 scene found in the past 90 days. Try a different season or a larger AOI.'}`,
    }
  }

  // Nothing clear anywhere. A GEE median composite masks cloud across many scenes,
  // so try it before refusing; only if it too is unavailable do we return no value.
  if (cloudRefusal) {
    const geeResult = await tryGeeComposite()
    if (geeResult) {
      return {
        ...geeResult,
        summary:
          `_Every Sentinel-2 scene over this AOI was clouded, so the statistic below comes ` +
          `from a multi-scene cloud-masked composite rather than one date._\n\n${geeResult.summary}`,
      }
    }
    return { summary: cloudRefusal }
  }

  const cloudStr = siCloud != null ? `${Number(siCloud).toFixed(1)}%` : 'N/A'

  // The mean is always the cloud-masked mean of the PER-PIXEL index over the drawn
  // polygon (lib/index-stats.ts). There is no bbox path and no index-of-the-means.
  const clipLabel = 'drawn polygon, cloud-masked'
  // ISS-129: the effective ground sample distance this mean's statistics grid
  // implies — distinct from whatever resolution the RENDERED tile/PNG uses below.
  const gridResNote = gsdM != null
    ? ` The mean is a statistic from ${clearPx} clear px on a ${STAT_GRID_MAX_SIZE}px-capped grid — effective ground sample distance ~${gsdM.toFixed(0)} m over this ${areaKm2.toFixed(1)} km² AOI.`
    : ''
  const meanProvenance = {
    source: `Sentinel-2 L2A (AWS Element84 Earth Search) — ${index}`,
    date: siSceneDate || undefined,
    method: clearPct != null
      ? `per-pixel ${index} via titiler /stac/feature.npy, clipped to the drawn polygon; SCL cloud/shadow/cirrus masked (${clearPx} clear px, ${clearPct.toFixed(0)}% of AOI clear) · mean of per-pixel index · formula ${cfg.expression}`
      : `per-pixel ${index} clipped to the drawn polygon · formula ${cfg.expression}`,
    clip: 'polygon',
  } as const

  // Q-14a / Q-16: native-resolution XYZ tiles stretched to the AOI's own p2-p98 and masked
  // to the polygon on the client, replacing the fixed -1..1 1024 px PNG.
  const indexLayer = buildIndexRasterLayer({
    id: `${index.toLowerCase()}-active`,
    name: `${index} (Sentinel-2) ${siSceneDate}`,
    item: siItem,
    index,
    stats: stretchStats,
    bounds: [minLng, minLat, maxLng, maxLat],
    provenance: meanProvenance,
    confidence: meanVal != null ? 'high' : 'medium',
  })
  if (indexLayer) {
    const siSd: Record<string, SummaryDatum> = { index, scene_date: siSceneDate, area_km2: Number(areaKm2.toFixed(1)) }
    if (meanVal != null) siSd.index_mean = Number(meanVal.toFixed(3))
    if (clearPct != null) siSd.valid_pixel_pct = Number(clearPct.toFixed(1))
    if (Number.isFinite(parseFloat(cloudStr))) siSd.cloud_pct = Number(parseFloat(cloudStr).toFixed(1))
    if (stretchStats?.p2 != null && stretchStats.p98 != null) {
      siSd.p2 = Number(stretchStats.p2.toFixed(3))
      siSd.p98 = Number(stretchStats.p98.toFixed(3))
    }
    if (gsdM != null) siSd.effective_resolution_m = Number(gsdM.toFixed(1))
    const stretch = indexLayer.raster?.rescale?.[0]
    const stretchNote = stretch
      ? indexLayer.raster?.stretch === 'p2-p98'
        ? `**Stretch:** ${stretch[0]} to ${stretch[1]} (p2–p98 of the clear AOI pixels; adjustable in the layer panel).`
        : `**Stretch:** fixed ${stretch[0]} to ${stretch[1]} (no clear-pixel statistics were available to fit one).`
      : ''
    return {
      summary: `**${index}** (${cfg.description}) computed for ${areaKm2.toFixed(1)} km² (drawn polygon).\n\n**Formula:** \`${cfg.expression}\`\n**Scene:** ${siSceneDate} | **Scene-wide cloud:** ${cloudStr}${meanVal != null ? `\n**${index} mean (${clipLabel}):** ${meanVal.toFixed(3)}` : ''}${maskedNote}\n**Colormap:** ${indexLayer.raster?.colormap ?? cfg.colormap}\n${stretchNote}\n**Render:** ${TITILER_BASE}/stac/tiles/ XYZ tiles (10–20 m), shown only inside your polygon.${gridResNote}`,
      summary_data: siSd,
      layer: indexLayer,
    }
  }

  const siSd: Record<string, SummaryDatum> = { index, scene_date: siSceneDate, area_km2: Number(areaKm2.toFixed(1)) }

  // DEFECT-2 / ISS-129: when there is no real mean, don't emit a fallback layer at
  // all — `buildBboxFallbackLayer(..., null, ...)` used to default the fill color to
  // whatever `indexValue ?? 0` picks, drawing a specific, wrong color (and this
  // index's full gradient legend) over an area the text says has no data. Same bug
  // as fetch_ndvi's honest fallback (see the DEFECT-2 comment there); fixed the
  // same way — no mean, no layer.
  if (meanVal == null) {
    return {
      summary: `**${index}** (${cfg.description}) — titiler could not render a tile for this scene, and no cloud-masked mean was obtainable for this AOI either.\n\n**Formula:** \`${cfg.expression}\`\n**Scene:** ${siSceneDate} | **Scene-wide cloud:** ${cloudStr}${maskedNote}\n**Map layer:** none — there is no real mean to derive a fill color from.`,
      summary_data: siSd,
      sources: ['Sentinel-2 L2A (AWS Element84 Earth Search)'],
      // No `layer` — see the comment above (DEFECT-2 / ISS-129).
    }
  }

  siSd.index_mean = Number(meanVal.toFixed(3))
  if (gsdM != null) siSd.effective_resolution_m = Number(gsdM.toFixed(1))
  const fb = buildBboxFallbackLayer([minLng, minLat, maxLng, maxLat], meanVal, index, undefined, aoi)
  return {
    summary: `**${index}** (${cfg.description}) — titiler could not render a tile for this scene. Rendered the drawn AOI polygon filled with a color derived from the real ${index} mean.\n\n**Formula:** \`${cfg.expression}\`\n**Scene:** ${siSceneDate} | **Scene-wide cloud:** ${cloudStr}\n**${index} mean (${clipLabel}):** ${meanVal.toFixed(3)}${maskedNote}${gridResNote}`,
    summary_data: siSd,
    // DEFECT-3: `meanProvenance` was already always populated here regardless of
    // this branch — only the DEFECT-2 layer-suppression above was missing.
    layer: { ...fb, palette: SPECTRAL_INDEX_PALETTES[index] ?? NDVI_GRADIENT_PALETTE, provenance: meanProvenance, confidence: 'medium' },
  }
}

const dayShift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

export async function fetchThermal(ctx: ToolCtx, args: Record<string, any> = {}): Promise<ToolOutput> {
  const { aoi, bbox, areaKm2, emit } = ctx
  const [minLng, minLat, maxLng, maxLat] = bbox

  // An explicit window ("Phoenix summer 2024") picks the clearest scene INSIDE it; without one the
  // newest clear scene is used. The MODIS fallback below is a recent 30-day mean, so it must not
  // answer a request for another period.
  const winStart = typeof args.start === 'string' && args.start ? args.start : null
  const winEnd = typeof args.end === 'string' && args.end ? args.end : null
  const windowed = winStart != null || winEnd != null
  const today = new Date().toISOString().slice(0, 10)
  const datetimeWindow = windowed ? `${winStart ?? dayShift(winEnd ?? today, -90)}/${winEnd ?? today}` : undefined
  const windowLabel = datetimeWindow ? datetimeWindow.replace('/', ' to ') : null
  // ── GEE is a FALLBACK (ISS-113), reached below only when no Landsat scene is
  //    clear over the AOI. MODIS LST is 1 km — over a 17 km² AOI that is ~17
  //    pixels against Landsat's ~19 000 at 30 m — so it is never the better
  //    answer while a clear Landsat scene exists. Its value is the 30-day mean:
  //    it composites across days and so can succeed when every single overpass
  //    was clouded.
  const tryGeeLst = async (): Promise<ToolOutput | null> => {
    if (windowed || !isGeePreferred()) return null
    emit?.('token', { type: 'token', content: 'Falling back to a 30-day MODIS LST mean (Google Earth Engine)...\n' })
    const g = await geeLst(aoi, 30)
    if (g) {
      const sd: Record<string, SummaryDatum> = { area_km2: Number(areaKm2.toFixed(1)) }
      if (g.meanCelsius != null) sd.lst_celsius = Number(g.meanCelsius.toFixed(1))
      return {
        summary: `Land Surface Temperature for ${areaKm2.toFixed(1)} km² (drawn polygon).\n\n**Source:** Google Earth Engine — MODIS MOD11A1 daytime LST, 30-day mean (${g.startDate} → ${g.endDate}).${g.meanCelsius != null ? `\n**Mean LST (AOI polygon):** ${g.meanCelsius.toFixed(1)}°C` : ''}\n\nReal per-pixel tiles (1 km — coarser than Landsat's 30 m), polygon-clipped, server-rendered by GEE (blue=cool → red=hot, 0–45 °C). A 30-day mean, not a single date.`,
        summary_data: sd,
        layer: {
          id: 'thermal-active',
          name: `LST MODIS 30-day mean${g.meanCelsius != null ? ` (${g.meanCelsius.toFixed(1)}°C)` : ''}`,
          type: 'raster',
          tileUrl: g.tileUrl,
          bounds: [minLng, minLat, maxLng, maxLat],
          palette: THERMAL_PALETTE,
          provenance: { source: 'MODIS MOD11A1 LST (Google Earth Engine)', method: 'GEE server-rendered 1 km tiles · 30-day cloud-masked mean · polygon reduceRegion', clip: 'polygon' },
          confidence: 'medium',
        },
      }
    }
    emit?.('token', { type: 'token', content: `GEE unavailable (${getGeeLastError() ?? 'unknown'}).\n` })
    return null
  }

  emit?.('token', { type: 'token', content: 'Searching Landsat thermal data via Planetary Computer + titiler.xyz...\n' })

  // Planetary Computer hosts Landsat C2 L2 with HTTPS-signed COGs that titiler can
  // read. (Element84's hrefs are s3://usgs-landsat requester-pays → titiler 403s.)
  let thItem: any = null
  let thSceneDate = ''
  let thCloud: number | null = null
  let thPlatform = 'Landsat'
  let thClarity: SceneClarity | null = null
  let thExamined: Array<{ id: string; date: string; sceneCloudPct: number | null; aoiClearPct: number }> = []

  try {
    // Phase 0 — AOI-local cloud screening via QA_PIXEL. Scene-wide `eo:cloud_cover`
    // is not a statement about the polygon: measured 2026-08-10, the newest scene
    // under the 40% gate (2026-08-02, 27.5%) was 0% clear over the AOI and produced
    // a mean LST of −3.2 °C. Cloud tops are cold, so the error is large and inverted
    // — the clear scene three weeks earlier reads +44.3 °C.
    const thData = await searchPCStac(
      [minLng, minLat, maxLng, maxLat],
      'landsat-c2-l2',
      windowed ? 12 : 5,
      { 'eo:cloud_cover': { lt: 60 }, platform: { in: ['landsat-8', 'landsat-9'] } },
      datetimeWindow,
    )
    const thItems: any[] = thData.features || []
    if (thItems.length === 0) {
      return { summary: windowLabel
        ? `No Landsat 8/9 scene (scene cloud under 60%) covers this area between ${windowLabel}. Widen the date range or enlarge the AOI.`
        : `No Landsat 8/9 scene found for this area recently. Thermal data requires a clear-sky scene.\n\nTry expanding the AOI or retrying later.` }
    }
    emit?.('token', { type: 'token', content: `Scoring ${thItems.length} Landsat scene(s) on cloud over your AOI (QA_PIXEL)...\n` })
    const choice = await pickClearestLandsatScene(thItems, aoi, signPCAsset, windowed ? { maxCandidates: 8 } : {})
    if (choice) {
      thItem = choice.item
      thClarity = choice.clarity
      thExamined = choice.examined
    } else {
      // Nothing clear. A land surface temperature here would measure cloud tops,
      // which are tens of degrees colder than the ground. Before refusing, try
      // the MODIS 30-day mean — it composites across days, so it can answer where
      // no single Landsat overpass can.
      const gee = await tryGeeLst()
      if (gee) {
        return {
          ...gee,
          summary:
            `_No Landsat overpass was clear over this AOI, so the value below is a ` +
            `30-day 1 km MODIS mean rather than a 30 m single-date measurement._\n\n${gee.summary}`,
        }
      }
      const examined = await Promise.all(thItems.slice(0, 5).map(async (f: any) => ({
        date: String(f?.properties?.datetime ?? '').slice(0, 10),
        sceneCloudPct: typeof f?.properties?.['eo:cloud_cover'] === 'number' ? f.properties['eo:cloud_cover'] : null,
        aoiClearPct: (await landsatClarity(f, aoi, signPCAsset))?.clearPct ?? 0,
      })))
      return {
        summary: [
          '**No usable Landsat thermal scene — the AOI was under cloud in every candidate.**',
          '',
          'Scenes checked, scored on cloud **over your polygon** (Landsat QA_PIXEL) rather than scene-wide metadata:',
          examined.map((e) => `- ${e.date}: ${e.aoiClearPct.toFixed(0)}% clear over your AOI` +
            (e.sceneCloudPct != null ? ` (scene-wide cloud ${e.sceneCloudPct.toFixed(0)}%)` : '')).join('\n') || '- (none returned)',
          '',
          'Cloud tops are far colder than the ground, so a mean computed here would understate ' +
          'land surface temperature by tens of degrees. No value is reported.',
          '',
          windowLabel
            ? `**What to do:** widen the date range (searched ${windowLabel}) or choose another period.`
            : '**What to do:** widen the date range or wait for the next clear overpass.',
        ].join('\n'),
      }
    }
    thSceneDate = (thItem.properties?.datetime as string || '').slice(0, 10)
    thCloud = thItem.properties?.['eo:cloud_cover'] ?? null
    thPlatform = thItem.properties?.platform || 'Landsat'
  } catch (err: any) {
    return { summary: `Landsat (Planetary Computer) query failed: ${err.message}. Try again shortly.`, failed: true }
  }

  const thCloudStr = thCloud != null ? `${Number(thCloud).toFixed(1)}%` : 'N/A'

  // Sign the ST_B10 (lwir11) asset and render real per-pixel LST tiles.
  const unsignedHref = thItem.assets?.lwir11?.href || thItem.assets?.ST_B10?.href
  let signedHref: string | null = null
  let kelvinMean: number | null = null
  let lstStats: LstDnStats | null = null
  let thClearPx = 0
  // ISS-129: the clarity the STAT actually used. `thClarity` above was scored at
  // cloud.ts's cheap 96px ranking default (fine for choosing a scene); reusing it
  // to mask a larger value grid would silently misalign which pixel is which, so
  // it is re-scored here at the statistics grid size, matching the LST grid below.
  let statClarity: SceneClarity | null = null

  if (unsignedHref) {
    try {
      signedHref = await signPCAsset(unsignedHref)
      // Per-pixel LST over the drawn polygon, masked to QA-clear pixels only. Both
      // grids are fetched at STAT_GRID_MAX_SIZE for the SAME scene, so they align
      // index-for-index (see the opts.clarity warning in lib/index-stats.ts).
      const lstClarity = await landsatClarity(thItem, aoi, signPCAsset, STAT_GRID_MAX_SIZE)
      if (lstClarity) {
        const lstGrid = await fetchCogFeatureGrid({
          cogUrl: signedHref, geom: aoi, cacheTag: 'lst', maxSize: STAT_GRID_MAX_SIZE,
        })
        const st = gridStats(lstGrid, (i) => clearPixelFilter(lstClarity)(i) && lstGrid.values[i] > 0)
        if (st) {
          kelvinMean = st.mean * LST_SCALE + LST_OFFSET
          lstStats = { min: st.min, max: st.max, p2: st.p2, p98: st.p98, mean: st.mean, count: st.count }
          thClearPx = st.count
          statClarity = lstClarity
        }
      }
    } catch (err: any) {
      log.warn({ tool: 'thermal', err: err?.message }, 'PC LST signing/render failed')
    }
  }

  const celsius = kelvinMean != null ? kelvinMean - 273.15 : null
  // Prefer the aligned re-score for display; fall back to the ranking-time one only
  // when the re-score itself failed (still an honest "some clarity was measured").
  const displayClarity = statClarity ?? thClarity
  const clarityLine = displayClarity ? `\n**Scene quality (over your AOI):** ${clarityNote(displayClarity)}.` : ''
  // ISS-129: effective ground sample distance the MEAN's grid implies — the
  // rendered map layer below uses Landsat's real 30 m pixels; the mean does not.
  const thGsdM = celsius != null ? effectiveGsdMeters(areaKm2, thClearPx) : null
  const meanLine = celsius != null
    ? `\n**Mean surface temperature (drawn polygon, cloud-masked):** ${celsius.toFixed(1)}°C (${kelvinMean!.toFixed(1)} K) — from ${thClearPx} clear pixels` +
      (thGsdM != null ? ` (effective ground sample distance ~${thGsdM.toFixed(0)} m over this ${areaKm2.toFixed(1)} km² AOI — native Landsat pixel is 30 m; that 30 m is what the rendered map layer uses, not this mean).` : '.')
    : '\n**Mean surface temperature:** not reported — no clear thermal pixels inside the polygon.'
  const thStatMethod = statClarity
    ? `per-pixel ST_B10 via titiler /cog/feature.npy, clipped to the drawn polygon; QA_PIXEL cloud/cirrus/shadow masked (${thClearPx} clear px, ${statClarity.clearPct.toFixed(0)}% of AOI clear)`
    : 'per-pixel ST_B10 clipped to the drawn polygon'
  const thSd: Record<string, SummaryDatum> = { scene_date: thSceneDate, platform: thPlatform, area_km2: Number(areaKm2.toFixed(1)) }
  if (celsius != null) thSd.lst_celsius = Number(celsius.toFixed(1))
  if (thGsdM != null) thSd.effective_resolution_m = Number(thGsdM.toFixed(1))
  void thExamined

  if (signedHref) {
    // One stretch (the AOI's own p2-p98 in degrees C) drives the clipped PNG, the XYZ tile URL and the
    // legend, and the statistics above come from the same scale/offset, so they cannot disagree.
    const { rescale, stretch } = lstStretchC(lstStats)
    const [lo, hi] = rescale
    const dateIso = thSceneDate || undefined
    const raster = lstDescriptor({ sceneId: thItem?.id ? String(thItem.id) : undefined, datetime: dateIso, rescale, stretch })
    // RENDER-004: polygon-clipped per-pixel thermal render (titiler cutline), XYZ fallback.
    const clipPng = await span('render', () => fetchLandsatLstClipPng(signedHref!, lo, hi, aoi))
    const stretchNote = stretch === 'p2-p98'
      ? `stretched to the AOI's own 2nd–98th percentile, ${lo.toFixed(1)}–${hi.toFixed(1)}°C`
      : `fixed ${lo}–${hi}°C (no clear pixel gave a data-driven stretch)`
    const renderNote = clipPng
      ? 'real per-pixel 30 m thermal raster, polygon-clipped (titiler /cog/feature.png, no bbox bleed)'
      : 'real per-pixel 30 m thermal raster (XYZ tiles, bbox-bound, hidden outside the polygon by the map mask)'
    const layerName = `LST ${thPlatform} ${thSceneDate}${celsius != null ? ` (${celsius.toFixed(1)}°C)` : ''}`
    const provenance = {
      source: 'Landsat C2 L2 ST_B10 (Planetary Computer) + titiler',
      date: dateIso,
      method: `real per-pixel 30 m thermal COG, DN × 0.00341802 + 149.0 K, shown in °C · ${clipPng ? 'polygon cutline' : 'XYZ tiles'} · ${thStatMethod}`,
      clip: 'polygon' as const,
    }
    if (celsius != null) {
      thSd.lst_stretch_min_c = Number(lo.toFixed(1))
      thSd.lst_stretch_max_c = Number(hi.toFixed(1))
    }
    return {
      summary: `Land Surface Temperature (Landsat ${thPlatform} ST_B10) for ${areaKm2.toFixed(1)} km² (drawn polygon).\n\n**Scene:** ${thSceneDate} | **Scene-wide cloud:** ${thCloudStr} | **Satellite:** ${thPlatform}${clarityLine}${meanLine}\n\n**Map layer:** ${renderNote}, **plasma** colormap (purple=cool → yellow=hot), ${stretchNote}. The layer shows every pixel in the scene; only the statistics exclude cloud-flagged ones.\nData: USGS Landsat C2 L2 Surface Temperature (0.00341802·DN + 149.0 K) via Planetary Computer + titiler.`,
      summary_data: thSd,
      provenance_items: thItem?.id ? [String(thItem.id)] : undefined,
      layer: clipPng
        ? {
            id: 'thermal-active',
            name: layerName,
            type: 'raster',
            imageBase64: clipPng,
            bounds: [minLng, minLat, maxLng, maxLat],
            raster,
            provenance,
            confidence: stretch === 'p2-p98' ? 'high' : 'medium',
          }
        : {
            id: 'thermal-active',
            name: layerName,
            type: 'raster',
            tileUrl: buildLandsatLstTileUrl(signedHref, lo, hi),
            bounds: [minLng, minLat, maxLng, maxLat],
            aoiMask: true,
            raster,
            provenance,
            confidence: stretch === 'p2-p98' ? 'high' : 'medium',
          },
    }
  }

  // DEFECT-2 / ISS-129: when there is no real mean, emit no fallback layer at all —
  // the previous '#94a3b8' neutral-gray path still drew a filled polygon under the
  // full THERMAL_PALETTE gradient legend (7–47°C) over an area the text says has no
  // reading. Same bug as fetch_ndvi's honest fallback (see that DEFECT-2 comment);
  // fixed the same way — no mean, no layer, regardless of how "neutral" the color was.
  if (celsius == null) {
    return {
      summary: `Landsat thermal scene found (${thSceneDate}, scene-wide cloud ${thCloudStr}, ${thPlatform}) but titiler could not render the per-pixel tile, and no cloud-masked LST mean was retrievable either.${clarityLine}\n\n**Map layer:** none — there is no real mean to derive a fill color from.`,
      summary_data: thSd,
      // No `layer` — see the comment above (DEFECT-2 / ISS-129).
    }
  }

  // Fallback: real mean rendered as an AOI-polygon fill.
  const thermalColor = celsius < 5 ? '#3b82f6'
    : celsius < 15 ? '#06b6d4'
    : celsius < 25 ? '#22c55e'
    : celsius < 35 ? '#f59e0b'
    : '#ef4444'
  const fb = buildBboxFallbackLayer(
    [minLng, minLat, maxLng, maxLat], celsius, `LST ${thSceneDate}`, thermalColor, aoi,
  )
  return {
    summary: `Landsat thermal scene found (${thSceneDate}, scene-wide cloud ${thCloudStr}, ${thPlatform}) but titiler could not render the per-pixel tile.${clarityLine} Showing the AOI polygon coloured by the real cloud-masked mean.${meanLine}`,
    summary_data: thSd,
    layer: {
      ...fb,
      palette: THERMAL_PALETTE,
      // DEFECT-3 / ISS-129: this layer previously carried no `provenance` — a
      // null-provenance thermal layer over ocean showed up in a 60-probe sweep.
      provenance: {
        source: 'Landsat C2 L2 ST_B10 (Planetary Computer) + titiler',
        date: thSceneDate || undefined,
        method: `Flat-fill illustrative polygon colored by the real cloud-masked LST mean (${celsius.toFixed(1)}°C); per-pixel thermal tile failed to verify.`,
        clip: 'polygon',
      },
      confidence: 'medium',
    },
  }
}

/** JRC Global Surface Water occurrence palette — blues ramp 0–100%. */
const SURFACE_WATER_PALETTE: GradientPalette = {
  kind: 'gradient', label: 'Water Occurrence', unit: '%', min: 0, max: 100,
  stops: [
    { value: 0,   color: '#f7fbff', label: 'never' },
    { value: 20,  color: '#c6dbef', label: 'seasonal' },
    { value: 50,  color: '#4292c6', label: 'frequent' },
    { value: 75,  color: '#2171b5', label: 'semi-perm.' },
    { value: 100, color: '#08306b', label: 'permanent' },
  ],
}

/** Fetch JRC Global Surface Water v1.4 occurrence layer (1984–2021) via
 *  Planetary Computer STAC + titiler.xyz COG rendering. Free, no API key. */
export async function fetchSurfaceWater(ctx: ToolCtx): Promise<ToolOutput> {
  const { aoi, bbox, areaKm2, emit } = ctx
  const [minLng, minLat, maxLng, maxLat] = bbox

  emit?.('token', { type: 'token', content: `Querying JRC Global Surface Water (Planetary Computer STAC + ${TITILER_BASE})...\n` })

  let unsignedHref: string | null = null
  let signedUrl: string | null = null
  let occMean: number | null = null
  let occClip: 'polygon' | 'bbox' = 'polygon'
  let lookupError: string | null = null

  try {
    const data = await searchPCStac([minLng, minLat, maxLng, maxLat], 'jrc-gsw')
    const item = (data.features || [])[0] ?? null
    if (item) {
      unsignedHref = (item?.assets?.occurrence?.href as string | undefined) ?? null
      if (unsignedHref) signedUrl = await signPCAsset(unsignedHref)
    }
  } catch (err: any) {
    lookupError = err?.message || 'request failed'
    log.warn({ tool: 'surface_water', err: err.message }, 'PC STAC query failed')
  }

  // HONESTY-001: prefer a polygon-clipped occurrence mean (nodata=255 excludes
  // outside-study-area pixels). ISS-102: the bbox fallback is a rectangle CUTLINE,
  // not GET `?bbox=` — titiler ignores that parameter and would have answered with
  // the whole-COG mean (a 10°×10° JRC tile) labelled as the AOI value.
  if (signedUrl) {
    try {
      const poly = await fetchCogPolygonStats(signedUrl, aoi, { nodata: '255' })
      if (poly && typeof poly.mean === 'number') {
        occMean = poly.mean
      } else {
        occClip = 'bbox'
        const rect = await fetchCogBandStats(signedUrl, bbox, { nodata: '255' })
        if (typeof rect?.mean === 'number') occMean = rect.mean
      }
    } catch (err: any) {
      log.warn({ tool: 'surface_water', err: err.message }, 'statistics failed')
    }
  }

  if (!signedUrl) {
    return {
      summary: [
        `**Surface Water History (JRC GSW)** — ${areaKm2.toFixed(1)} km² (drawn polygon)`,
        '',
        ...(lookupError
          ? [fetchFailureNote('the Planetary Computer catalogue', lookupError)]
          : [
              'Planetary Computer STAC returned no JRC Global Surface Water item for this location.',
              'This happens for ocean-only AOIs, which have no land water history.',
            ]),
        '',
        '**Current water extent alternative:** call `compute_spectral_index` with index="NDWI" to show today\'s water bodies from Sentinel-2.',
        '**Full historical data:** [JRC Surface Water Explorer](https://global-surface-water.appspot.com/) (Google Earth Engine viewer).',
      ].join('\n'),
    }
  }

  // Blues gradient; 0 (no water) renders as near-white; nodata=255 (outside study area) is transparent.
  // .png not @1x.png — titiler v2 route is /{z}/{x}/{y}.{format} (the @1x scale suffix 422s).
  const tileUrl = `${TITILER_BASE}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${encodeURIComponent(signedUrl)}&rescale=0,100&colormap_name=blues&nodata=255&return_mask=true`
  // RENDER-004: polygon-clipped per-pixel render (titiler cutline), XYZ tile fallback.
  const clipPng = await span('render', () => fetchCogClipPng(signedUrl, { rescale: '0,100', colormap: 'blues', nodata: '255' }, aoi))

  const interpret = (v: number) =>
    v < 2  ? 'essentially no water in 37 years (<2%)' :
    v < 15 ? 'rare to occasional (seasonal fringe, <15%)' :
    v < 40 ? 'seasonal water (15–40% of years)' :
    v < 70 ? 'frequently inundated (40–70% of years)' :
    v < 90 ? 'semi-permanent water body (70–90%)' :
              'near-permanent to permanent water (>90%)'

  const occClipLabel = occClip === 'polygon' ? 'drawn polygon' : 'AOI bbox'
  const meanLine = occMean != null
    ? `**Mean occurrence (${occClipLabel} clip):** ${occMean.toFixed(1)}% — ${interpret(occMean)}`
    : `**Mean occurrence:** unavailable (titiler statistics timed out or returned no b1.mean)`

  return {
    summary: [
      `**Surface Water History — JRC Global Surface Water v1.4** · ${areaKm2.toFixed(1)} km² (drawn polygon)`,
      '',
      `**Dataset:** JRC Global Surface Water Mapping Layers v1.4 · 1984–2021 (37 years of Landsat)`,
      `**Resolution:** 30 m · **Metric:** water occurrence = % of years each pixel was observed as water`,
      '',
      meanLine,
      '',
      '**Color scale:** white (never/rarely water) → light blue (seasonal) → medium blue (frequent) → dark blue (permanent). Pixels with 0% occurrence blend with the basemap.',
      '',
      '_Tile URL is valid ~1 hour (Planetary Computer signed Azure SAS). Re-run `fetch_surface_water` to refresh._',
      '',
      '**Cite:** Pekel et al. (2016) "High-resolution global map of surface water and its long-term changes", Nature 540:418–422. [JRC Explorer](https://global-surface-water.appspot.com/)',
    ].join('\n'),
    summary_data: {
      area_km2: Number(areaKm2.toFixed(1)),
      ...(occMean != null ? { occurrence_mean_pct: Number(occMean.toFixed(1)) } : {}),
    },
    layer: clipPng
      ? {
          id: 'surface-water-occurrence',
          name: 'JRC Surface Water Occurrence (1984–2021)',
          type: 'raster' as const,
          imageBase64: clipPng,
          bounds: [minLng, minLat, maxLng, maxLat],
          provenance: {
            source: 'JRC Global Surface Water v1.4 (1984–2021) via Microsoft Planetary Computer STAC + titiler',
            date: '1984–2021',
            method: `Landsat-derived water occurrence %. Polygon cutline (titiler /cog/feature.png, nodata=255). Statistics ${occClip}-clipped.`,
            clip: 'polygon',
          },
          confidence: 'high' as const,
          palette: SURFACE_WATER_PALETTE,
        }
      : {
          id: 'surface-water-occurrence',
          name: 'JRC Surface Water Occurrence (1984–2021)',
          type: 'raster' as const,
          tileUrl,
          bounds: [minLng, minLat, maxLng, maxLat],
          provenance: {
            source: 'JRC Global Surface Water v1.4 (1984–2021) via Microsoft Planetary Computer STAC + titiler',
            date: '1984–2021',
            method: `Landsat-derived water occurrence %. Statistics: titiler POST /cog/statistics cutline, ${occClip}-clipped (nodata=255).`,
            clip: occClip,
          },
          confidence: 'high' as const,
          palette: SURFACE_WATER_PALETTE,
        },
  }
}

/** Fetch near-real-time fire hotspot detections from NASA FIRMS (VIIRS + MODIS NRT).
 *  Requires `FIRMS_MAP_KEY` env var (free at firms.modaps.eosdis.nasa.gov/api/area/). */
export async function fetchActiveFires(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const { bbox, areaKm2, aoi, emit } = ctx
  const key = process.env.FIRMS_MAP_KEY

  if (!key) {
    // No FIRMS key: fall back to NASA EONET, which needs none. This used to return
    // setup instructions and nothing else, so a default deployment answered "are
    // there fires here?" with a registration link. EONET is a genuinely different
    // product — curated incidents, not thermal pixels — so the answer says which one
    // it is, and never presents an event count as a hotspot count.
    const fireDays = Math.min(Math.max(Math.round(Number(args.days) || 7), 1), 30)
    emit?.('token', {
      type: 'token',
      content: `FIRMS_MAP_KEY is not set — querying NASA EONET wildfire events (key-free) for the last ${fireDays} days...\n`,
    })

    const eonet = await fetchEonetWildfires(bbox, fireDays)
    if (!eonet.ok) {
      return {
        summary: [
          '**Active fire check unavailable.**',
          '',
          `FIRMS is not configured (no \`FIRMS_MAP_KEY\`), and the key-free fallback failed: ${eonet.reason}.`,
          '',
          'No fire information is reported rather than an empty result that could be read as "no fires".',
          '',
          'To enable per-pixel hotspot detection (VIIRS 375 m + MODIS 1 km), register a free key at',
          'https://firms.modaps.eosdis.nasa.gov/api/area/ and set `FIRMS_MAP_KEY`.',
        ].join('\n'),
        failed: true,
      }
    }

    const inAoi = firesInPolygon(eonet.fires, aoi)
    const sd: Record<string, SummaryDatum> = {
      area_km2: Number(areaKm2.toFixed(1)),
      source: 'NASA EONET (curated incidents)',
      window_days: fireDays,
      events_in_aoi: inAoi.length,
      events_in_bbox: eonet.fires.length,
    }

    if (inAoi.length === 0) {
      return {
        summary: [
          `**No wildfire incidents reported in this area in the last ${fireDays} days.**`,
          '',
          eonet.fires.length > 0
            ? `${eonet.fires.length} incident(s) were found in the surrounding bounding box but none fall inside your drawn polygon.`
            : 'No incidents were found in the surrounding bounding box either.',
          '',
          `_${EONET_COVERAGE_CAVEAT}_`,
        ].join('\n'),
        summary_data: sd,
        sources: ['NASA EONET (curated incidents)'],
      }
    }

    const sized = inAoi.filter((f) => f.acres != null)
    const totalAcres = sized.reduce((a, f) => a + (f.acres ?? 0), 0)
    const openCount = inAoi.filter((f) => f.open).length
    if (sized.length > 0) sd.total_acres = Number(totalAcres.toFixed(0))
    sd.open_incidents = openCount

    const rows = inAoi.slice(0, 12).map((f) => {
      const size = f.acres != null ? ` — ${Math.round(f.acres).toLocaleString()} acres` : ''
      const src = f.sources.length ? ` [${f.sources.join(', ')}]` : ''
      return `- **${f.title}** (${f.date})${size}${f.open ? '' : ' — closed'}${src}`
    })

    return {
      summary: [
        `**${inAoi.length} wildfire incident${inAoi.length === 1 ? '' : 's'} reported in this area** ` +
          `in the last ${fireDays} days (${openCount} still open).`,
        '',
        ...rows,
        inAoi.length > 12 ? `\n_…and ${inAoi.length - 12} more._` : '',
        sized.length > 0
          ? `\n**Reported burned area:** ~${Math.round(totalAcres).toLocaleString()} acres across ` +
            `${sized.length} of ${inAoi.length} incidents (the rest report no size).`
          : '',
        '',
        `_${EONET_COVERAGE_CAVEAT}_`,
      ].filter(Boolean).join('\n'),
      summary_data: sd,
      layer: {
        id: `eonet-fires-${genId()}`,
        name: `Wildfire incidents — ${inAoi.length} reported (EONET, ${fireDays}d)`,
        type: 'geojson' as const,
        geojson: {
          type: 'FeatureCollection',
          features: inAoi.map((f) => ({
            type: 'Feature' as const,
            properties: {
              title: f.title,
              date: f.date,
              acres: f.acres,
              open: f.open,
              sources: f.sources.join(', '),
              label: `${f.title} (${f.date})`,
              color: f.open ? '#f87171' : '#a1a1aa',
            },
            geometry: { type: 'Point' as const, coordinates: [f.lng, f.lat] },
          })),
        },
        provenance: {
          source: 'NASA EONET v3 — curated wildfire events (key-free)',
          date: new Date().toISOString().slice(0, 10),
          method:
            `wildfire events within ${fireDays} days intersecting the AOI bbox, then narrowed ` +
            `point-in-polygon to the drawn AOI; positions are one representative point per ` +
            `incident, NOT per-pixel thermal detections`,
          clip: 'polygon',
        },
        confidence: 'medium' as const,
      },
    }
  }

  const days = Math.min(Math.max(Math.round(Number(args.days) || 7), 1), 10)

  emit?.('token', { type: 'token', content: `Querying NASA FIRMS for active fires over the last ${days} day${days !== 1 ? 's' : ''} (VIIRS 375 m + MODIS 1 km)...\n` })

  const [w, s, e, n] = bbox
  const bboxStr = [w, s, e, n].map(v => v.toFixed(4)).join(',')

  async function queryFirmsSource(source: string): Promise<FireFeature[]> {
    const cacheKey = `firms:${source}:${bboxStr}:${days}`
    return cachedFetchJson<FireFeature[]>(cacheKey, 15 * 60 * 1000, async () => {
      const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${source}/${bboxStr}/${days}`
      const resp = await fetch(url, { signal: AbortSignal.timeout(25000) })
      if (!resp.ok) throw new Error(`FIRMS ${source} HTTP ${resp.status}`)
      const text = await resp.text()
      return parseFirmsCsv(text, source)
    })
  }

  let viirsFeatures: FireFeature[] = []
  let modisFeatures: FireFeature[] = []
  const sourcesUsed: string[] = []

  const [viirsResult, modisResult] = await Promise.allSettled([
    queryFirmsSource('VIIRS_SNPP_NRT'),
    queryFirmsSource('MODIS_NRT'),
  ])

  if (viirsResult.status === 'fulfilled') {
    viirsFeatures = viirsResult.value
    if (viirsFeatures.length > 0) sourcesUsed.push('VIIRS S-NPP NRT (375 m)')
  } else {
    log.warn({ tool: 'active_fires', source: 'VIIRS_SNPP_NRT', err: (viirsResult as PromiseRejectedResult).reason?.message }, 'FIRMS source failed')
  }
  if (modisResult.status === 'fulfilled') {
    modisFeatures = modisResult.value
    if (modisFeatures.length > 0) sourcesUsed.push('MODIS Terra/Aqua NRT (1 km)')
  } else {
    log.warn({ tool: 'active_fires', source: 'MODIS_NRT', err: (modisResult as PromiseRejectedResult).reason?.message }, 'FIRMS source failed')
  }

  if (viirsResult.status === 'rejected' && modisResult.status === 'rejected') {
    return {
      summary: `**Active Fire Detection failed:** NASA FIRMS API did not respond for either VIIRS or MODIS. Try again shortly, or check [FIRMS status](https://firms.modaps.eosdis.nasa.gov/api/area/).`,
    }
  }

  // Merge VIIRS (primary) + MODIS (supplementary), deduplicate co-located detections
  const merged = mergeAndDedup(viirsFeatures, modisFeatures)

  // Filter to drawn AOI polygon
  const inAoi = filterFiresInAoi(merged, aoi)

  if (inAoi.length === 0) {
    const bboxTotal = merged.length
    const noneMsg = bboxTotal > 0
      ? `NASA FIRMS found ${bboxTotal} hotspot(s) in the search bbox, but none fall within the drawn AOI polygon.`
      : `No active fire hotspots detected in the past ${days} day${days !== 1 ? 's' : ''} for this area.`
    return {
      summary: [
        `**Active Fire Detection — NASA FIRMS** · ${areaKm2.toFixed(1)} km² · last ${days} day${days !== 1 ? 's' : ''}`,
        '',
        noneMsg,
        '',
        '**Sources queried:** VIIRS S-NPP NRT (375 m) + MODIS Terra/Aqua NRT (1 km)',
        '',
        'For global fire activity: [NASA FIRMS Map Viewer](https://firms.modaps.eosdis.nasa.gov/map/)',
      ].join('\n'),
      // Both sources answered and none fell in the AOI: a citable zero, distinct from a failed read.
      summary_data: { fire_count: 0, area_km2: Number(areaKm2.toFixed(1)), days },
    }
  }

  const stats = computeFireStats(inAoi)
  const sourceStr = sourcesUsed.length > 0 ? sourcesUsed.join(' + ') : 'VIIRS S-NPP + MODIS NRT'
  const dateRange = stats.dates.length > 1
    ? `${stats.dates[0]} → ${stats.dates[stats.dates.length - 1]}`
    : (stats.dates[0] ?? `last ${days} days`)

  const confRating = stats.highConf / stats.count >= 0.5 ? 'high' as const
    : stats.lowConf / stats.count >= 0.5 ? 'low' as const
    : 'medium' as const

  const summary = [
    `🔥 **Active Fire Detection — NASA FIRMS** · ${areaKm2.toFixed(1)} km² · last ${days} day${days !== 1 ? 's' : ''}`,
    '',
    `**${stats.count} fire hotspot${stats.count !== 1 ? 's' : ''} detected** | ${dateRange}`,
    `**Sources:** ${sourceStr}`,
    '',
    '**Fire Radiative Power (FRP):**',
    `- Mean: ${stats.meanFrp.toFixed(1)} MW · Max: ${stats.maxFrp.toFixed(1)} MW`,
    `- Extreme (>200 MW): ${stats.frpTiers.extreme} · High (50–200 MW): ${stats.frpTiers.high} · Moderate (10–50 MW): ${stats.frpTiers.moderate} · Low (<10 MW): ${stats.frpTiers.low}`,
    '',
    '**Detection confidence:**',
    `- High: ${stats.highConf} · Nominal: ${stats.medConf} · Low: ${stats.lowConf}`,
    '',
    `**Timing:** Day detections: ${stats.dayCount} · Night detections: ${stats.nightCount}`,
    '',
    '**Color coding:** dark red >200 MW (extreme) · red-orange 50–200 MW · orange 10–50 MW · yellow <10 MW',
    '',
    `_Data: NASA FIRMS ${sourceStr}. Points clipped to drawn AOI polygon._`,
  ].join('\n')

  return {
    summary,
    summary_data: {
      fire_count: stats.count,
      mean_frp_mw: Number(stats.meanFrp.toFixed(1)),
      max_frp_mw: Number(stats.maxFrp.toFixed(1)),
      high_confidence: stats.highConf,
      day_count: stats.dayCount,
      night_count: stats.nightCount,
      area_km2: Number(areaKm2.toFixed(1)),
      days,
    },
    layer: {
      id: `active-fires-${genId()}`,
      name: `Active Fires — FIRMS (last ${days} days)`,
      type: 'geojson' as const,
      geojson: { type: 'FeatureCollection' as const, features: inAoi as any[] },
      bounds: bbox,
      provenance: {
        source: `NASA FIRMS ${sourceStr}`,
        date: dateRange,
        method: `VIIRS S-NPP NRT (375 m) + MODIS Terra/Aqua NRT (1 km); merged + deduped (~0.01° grid); clipped to drawn AOI polygon.`,
        clip: 'polygon' as const,
      },
      confidence: confRating,
      palette: FIRE_PALETTE,
    },
  }
}

/** VV gamma0 classes, stated in dB — the conventional cut-offs.
 *
 *  Verified live 2026-08-18 against three unambiguous surfaces: urban Lahore -3.17 dB,
 *  Lake Nasser open water -19.30 dB, Amazon closed-canopy forest -6.12 dB. Each lands
 *  in the right class with no tuning, which is the point of using a calibrated
 *  quantity instead of a scaled digital number. */
function sarClassFromDb(db: number): { label: string; color: string; interpretation: string } {
  if (db < -18) {
    return {
      label: 'Water / very smooth',
      color: '#1e3a5f',
      interpretation:
        'very low — open water or a very smooth surface; a calm surface reflects the radar ' +
        'pulse away from the sensor (specular reflection)',
    }
  }
  if (db < -12) {
    return {
      label: 'Smooth / bare soil',
      color: '#4b5563',
      interpretation: 'low — smooth bare soil, dry sand, or paved surfaces',
    }
  }
  if (db < -6) {
    return {
      label: 'Vegetation / mixed',
      color: '#6b7280',
      interpretation: 'moderate — vegetation or cropland, where the canopy scatters the pulse in volume',
    }
  }
  return {
    label: 'Urban / rough',
    color: '#9ca3af',
    interpretation:
      'high — dense urban or rough terrain; vertical structures bounce the pulse back to the ' +
      'sensor twice (double-bounce)',
  }
}

/**
 * Sentinel-1 SAR backscatter over the AOI.
 *
 * This used to report a "normalized" VV number and read 0.061 over dense urban Lahore
 * as "very low — likely open water or flooded areas". Three things were wrong, and they
 * compounded:
 *
 *  1. **The number had no physical units.** It came from `sentinel-1-grd`, whose VV
 *     asset is an *uncalibrated DN amplitude*. Turning GRD DN into a real backscatter
 *     coefficient needs the per-scene calibration LUT from the product annotation XML,
 *     which no STAC catalogue publishes as a COG. The code divided the DN by 5000 and
 *     called the result "normalized", which is not a unit.
 *  2. **The thresholds were invented for that non-unit.** Real SAR classes are stated
 *     in dB, and the cut-offs in `sarClassFromDb` are the conventional ones. Applying
 *     them to DN/5000 is a category error — hence a 13-million-person city classified
 *     as open water.
 *  3. **The provenance named the wrong catalogue.** It credited "Microsoft Planetary
 *     Computer STAC" for data fetched through `searchPlanetaryComputer`, which despite
 *     its name queries AWS Element84 Earth Search.
 *
 * The fix is **Sentinel-1 RTC** (radiometrically terrain-corrected gamma0) from
 * Planetary Computer: float linear power, no calibration LUT required, anonymously
 * signable. If RTC is unavailable the GRD path still runs, but it reports an
 * uncalibrated DN and **refuses to name a surface class** — a relative number with no
 * verdict rather than a confident wrong one.
 */
export async function fetchSar(ctx: ToolCtx): Promise<ToolOutput> {
  const { aoi, bbox, areaKm2, emit } = ctx
  const [minLng, minLat, maxLng, maxLat] = bbox
  const geom = toGeometry(aoi)
  emit?.('token', { type: 'token', content: 'Searching Sentinel-1 radar scenes (RTC gamma0, Planetary Computer)...\n' })

  const sarBbox = [minLng, minLat, maxLng, maxLat]
  const sarDateEnd = new Date().toISOString().split('T')[0]
  const sarDateStart = new Date(Date.now() - 180 * 86400000).toISOString().split('T')[0]

  let sceneId: string | null = null
  let sarSceneDate = 'unknown'
  let sarPlatform = 'Sentinel-1'
  let sarOrbitState = 'unknown'
  let sarMode = 'IW'
  /** Calibrated backscatter in dB — the only value that earns an interpretation. */
  let sarDb: number | null = null
  /** Uncalibrated GRD DN mean — reported without a verdict when RTC is unavailable. */
  let sarDn: number | null = null
  let sarClip: 'polygon' | 'bbox' = 'polygon'
  let sourceLabel = ''
  let methodNote = ''
  let failureNote = ''

  const readScene = (item: any) => {
    sceneId = String(item?.id ?? 'unknown')
    sarSceneDate = String(item?.properties?.datetime ?? '').split('T')[0] || 'unknown'
    sarPlatform = item?.properties?.platform ?? 'Sentinel-1'
    sarOrbitState = item?.properties?.['sat:orbit_state'] ?? item?.properties?.orbit_state ?? 'unknown'
    sarMode = item?.properties?.['sar:instrument_mode'] ?? item?.properties?.instrument_mode ?? 'IW'
  }

  // ---- Primary: Sentinel-1 RTC gamma0 (float linear power) -------------------
  // The newest pass over the AOI is read as a polygon-clipped dB grid (every slice of the pass is
  // merged), and that same grid gives the mean, the percentiles that stretch the map layer, and the
  // coverage. A pass that misses much of the AOI is skipped for a better one when one exists.
  let rtcScene: S1Scene | null = null
  let vvStats: SarDbStats | null = null
  let vhStats: SarDbStats | null = null
  let gridGsdM: number | null = null
  if (geom) {
    try {
      const found = await searchS1Rtc(sarBbox, sarDateStart, sarDateEnd)
      const sizing = chooseMaxSize(geom, 10, 512)
      if (!found.ok) failureNote = found.message
      else if (sizing) {
        let best: { scene: S1Scene; stats: SarDbStats; aoiPx: number; gsd: number } | null = null
        const newest = groupScenes(found.items, ctx.centroid).reverse().slice(0, 3)
        for (const scene of newest) {
          try {
            const read = await readSceneDb(scene, geom, sizing.maxSize, 'VV')
            const georef = makeGeoref(sarBbox as [number, number, number, number], read.width, read.height)
            const aoiPx = Math.max(1, (areaKm2 * 1e6) / georef.pixelAreaM2)
            const stats = sarDbStats(read.db, aoiPx)
            if (!stats) continue
            if (!best || stats.coveragePct > best.stats.coveragePct) best = { scene, stats, aoiPx, gsd: (georef.cellXm + georef.cellYm) / 2 }
            if (stats.coveragePct >= MIN_COVERAGE_PCT) break
          } catch (err: any) {
            failureNote = `Sentinel-1 RTC read failed (${err?.message ?? 'unknown error'}).`
          }
        }
        if (best) {
          rtcScene = best.scene
          vvStats = best.stats
          gridGsdM = best.gsd
          readScene(best.scene.tileItem)
          sarDb = best.stats.meanDb
          sourceLabel = 'Sentinel-1 RTC gamma0 (Microsoft Planetary Computer)'
          methodNote =
            `gamma0 VV mean of ${best.stats.n} polygon-clipped pixels averaged in linear power, then ` +
            `converted to dB (10*log10); radiometrically terrain-corrected, so no calibration ` +
            `LUT is required`
          // VH is the cross-polarised channel (volume scattering); a missing one is not an error.
          try {
            const vh = await readSceneDb(best.scene, geom, sizing.maxSize, 'VH')
            vhStats = sarDbStats(vh.db, best.aoiPx)
          } catch { /* VH not available for this pass */ }
        }
      }
    } catch (err: any) {
      failureNote = `Sentinel-1 RTC unavailable (${err?.message ?? 'unknown error'}).`
    }
  }

  // ---- Fallback: Sentinel-1 GRD DN, reported WITHOUT a surface verdict --------
  if (sarDb == null) {
    try {
      const grd = await searchPlanetaryComputer(sarBbox, 'sentinel-1-grd', 0, sarDateStart, sarDateEnd)
      const item = grd.features?.[0]
      const vvUrl = item ? pickAsset(item, ['vv', 'VV', 'amplitude_vv']) : null
      if (item && vvUrl) {
        readScene(item)
        let vvStats = await fetchCogPolygonStats(vvUrl, aoi)
        if (!(vvStats && typeof vvStats.mean === 'number')) {
          sarClip = 'bbox'
          vvStats = await fetchCogBandStats(vvUrl, sarBbox)
        }
        if (vvStats && typeof vvStats.mean === 'number' && vvStats.mean > 0) {
          sarDn = vvStats.mean
          sourceLabel = 'Sentinel-1 GRD (AWS Earth Search / Element84)'
          methodNote =
            `raw VV DN amplitude mean, ${sarClip}-clipped — UNCALIBRATED: converting GRD DN to ` +
            `sigma0 requires the per-scene calibration LUT from the product annotation, which is ` +
            `not published as a COG`
        }
      }
    } catch (err: any) {
      failureNote = `${failureNote} Sentinel-1 GRD also unavailable (${err?.message ?? 'unknown error'}).`.trim()
    }
  }

  const sceneInfo = sceneId
    ? `**Scene:** ${sarSceneDate} | ${sarPlatform.toUpperCase()} | ${sarMode} mode | ${sarOrbitState} orbit\n` +
      `**Source:** ${sourceLabel}`
    : failureNote
      ? `**Scene:** none retrieved — ${failureNote} This is a connectivity failure, not an absence of scenes; retry shortly.`
      : `**Scene:** No Sentinel-1 scene found in the last 180 days for this AOI.`

  const sarSd: Record<string, SummaryDatum> = { area_km2: Number(areaKm2.toFixed(1)) }
  if (sceneId) sarSd.scene_date = sarSceneDate

  // ---- No usable measurement: say so, draw nothing ---------------------------
  if (sarDb == null && sarDn == null) {
    return {
      summary: [
        `**SAR Analysis** (${areaKm2.toFixed(1)} km2, drawn polygon)`,
        '',
        sceneInfo,
        '',
        '**VV backscatter:** unavailable — no real statistics were retrieved.',
        '',
        '**Map layer:** none — there is no measured value to shade the AOI by, so nothing is drawn.',
      ].join('\n'),
      summary_data: sarSd,
      ...(failureNote ? { failed: true } : {}),
      sources: ['Sentinel-1 GRD (AWS Earth Search)'],
      ...(sceneId ? { provenance_items: [sceneId] } : {}),
    }
  }

  // ---- Uncalibrated GRD path: a number, explicitly without a verdict ----------
  if (sarDb == null) {
    sarSd.vv_dn_mean = Number(sarDn!.toFixed(1))
    sarSd.calibration = 'none — raw GRD digital number, no surface class derived'
    return {
      summary: [
        `**SAR Analysis** (${areaKm2.toFixed(1)} km2, drawn polygon)`,
        '',
        sceneInfo,
        '',
        `**VV amplitude (uncalibrated DN, ${sarClip === 'polygon' ? 'drawn polygon' : 'AOI bbox'} clip):** ${sarDn!.toFixed(1)}`,
        '',
        `**No surface interpretation is given.** This is a raw digital number, not a backscatter ` +
          `coefficient. Sentinel-1 GRD needs a per-scene calibration LUT to become sigma0 in dB, ` +
          `and that LUT is not available here — so any "water / vegetation / urban" verdict from ` +
          `this number would be invented. The value is comparable between dates of the same ` +
          `relative orbit, and nothing more.`,
        '',
        `_Sentinel-1 RTC (terrain-corrected gamma0), which needs no LUT, was not available for this AOI._`,
      ].join('\n'),
      summary_data: sarSd,      sources: ['Sentinel-1 GRD (AWS Earth Search)'],
      ...(sceneId ? { provenance_items: [sceneId] } : {}),
    }
  }

  // ---- Calibrated RTC path: dB, with the conventional classes ----------------
  const cls = sarClassFromDb(sarDb)
  sarSd.vv_gamma0_db = Number(sarDb.toFixed(2))
  sarSd.calibration = 'gamma0 dB (RTC, terrain-corrected)'
  sarSd.surface_class = cls.label
  if (vvStats) {
    sarSd.vv_p2_db = Number(vvStats.p2.toFixed(2))
    sarSd.vv_p98_db = Number(vvStats.p98.toFixed(2))
    sarSd.aoi_coverage_pct = Number(vvStats.coveragePct.toFixed(0))
  }
  if (vhStats) sarSd.vh_gamma0_db = Number(vhStats.meanDb.toFixed(2))

  const sarSummary = [
    `**SAR Analysis** (${areaKm2.toFixed(1)} km2, drawn polygon)`,
    '',
    sceneInfo,
    '',
    `**VV backscatter (gamma0, drawn-polygon clip):** ${sarDb.toFixed(2)} dB`,
    `**Interpretation:** ${cls.interpretation}`,
    '',
    'Radar measures roughness and moisture rather than colour, and it sees through cloud — which',
    'is why this still answers when every optical index has to refuse.',
    '',
    '**VV gamma0 classes (dB):**',
    '- below -18: open water or very smooth surface (energy reflected away)',
    '- -18 to -12: smooth bare soil, dry sand, roads',
    '- -12 to -6: vegetation, cropland (volume scattering)',
    '- above -6: urban, rough terrain (double-bounce from vertical structures)',
    '',
    ...(vhStats ? [`**VH backscatter (gamma0, drawn-polygon clip):** ${vhStats.meanDb.toFixed(2)} dB (cross-polarised; volume scattering from vegetation and rough surfaces)`, ''] : []),
    ...(rtcScene && vvStats
      ? [
          `**Map layer:** per-pixel Sentinel-1 VV backscatter in dB (gamma0, 10 m), **viridis** ramp (purple = low, yellow = high) stretched to the AOI's own 2nd–98th percentile (${sarStretch(vvStats)[0]} to ${sarStretch(vvStats)[1]} dB); low backscatter means smooth surfaces or open water. ` +
            `Statistics are from a polygon-clipped read at about ${gridGsdM != null ? gridGsdM.toFixed(0) : '10'} m; the tiles are drawn at native resolution and hidden outside the polygon.${vhStats ? ' A VH layer is added, switched off by default.' : ''}`,
          ...(vvStats.coveragePct < MIN_COVERAGE_PCT ? ['', `_This pass observes only ${vvStats.coveragePct.toFixed(0)}% of the AOI; no newer pass in the last 180 days covered more of it._`] : []),
        ]
      : []),
  ].join('\n')

  const sarProvenance: Provenance = { source: sourceLabel, date: sarSceneDate, method: methodNote, clip: 'polygon (display mask)' }
  const sarBounds = sarBbox as [number, number, number, number]
  const sarConfidence = vvStats && vvStats.coveragePct < MIN_COVERAGE_PCT ? 'medium' as const : 'high' as const
  const vvLayer = rtcScene && vvStats
    ? sarRasterLayer({ id: `sar-vv-${genId()}`, scene: rtcScene, pol: 'VV', stats: vvStats, bbox: sarBounds, provenance: sarProvenance, confidence: sarConfidence })
    : null
  const vhLayer = rtcScene && vhStats
    ? sarRasterLayer({
        id: `sar-vh-${genId()}`, scene: rtcScene, pol: 'VH', stats: vhStats, bbox: sarBounds, confidence: sarConfidence, visible: false,
        provenance: { ...sarProvenance, method: methodNote.replace('VV', 'VH') },
      })
    : null

  return {
    summary: sarSummary,
    summary_data: sarSd,
    ...(vvLayer ? { layer: vvLayer } : {}),
    ...(vhLayer ? { layers: [vhLayer] } : {}),
    sources: [sourceLabel],
    ...(rtcScene ? { provenance_items: rtcScene.items.map((it: any) => String(it.id)) } : {}),
  }
}

/** Fetch ESA WorldCover 2021 built-up surface fraction for the AOI via Planetary Computer STAC.
 *  Primary: PC STAC → signed COG → titiler categorical stats (10 m Sentinel-2 derived).
 *  Fallback: OSM building footprint area / AOI area. */
export async function fetchBuiltSurface(ctx: ToolCtx): Promise<ToolOutput> {
  const { aoi, bbox, areaKm2, emit } = ctx
  const [minLng, minLat, maxLng, maxLat] = bbox

  emit?.('token', { type: 'token', content: 'Querying ESA WorldCover 2021 built-up surface (Planetary Computer STAC + titiler.xyz)...\n' })

  // ---- Primary: ESA WorldCover 2021 via PC STAC ----------------------------
  // ISS-102: statistics are POSTed as a cutline over the drawn polygon. The old
  // GET `?bbox=` was ignored by titiler and described the whole 3°×3° COG tile.
  const wc = await fetchWorldCoverData(bbox, aoi)

  if (wc) {
    const { stats, tileUrl, clip } = wc
    const builtKm2 = (stats.builtUpPct / 100) * areaKm2
    const clipLabel = clip === 'polygon' ? 'drawn polygon' : 'AOI bbox'

    const classList = [
      stats.builtUpPct  > 0 ? `- **Built-up:** ${stats.builtUpPct.toFixed(1)}% (${builtKm2.toFixed(2)} km²)` : null,
      stats.treeCoverPct > 0 ? `- **Tree Cover:** ${stats.treeCoverPct.toFixed(1)}%` : null,
      stats.croplandPct  > 0 ? `- **Cropland:** ${stats.croplandPct.toFixed(1)}%` : null,
      stats.grasslandPct > 0 ? `- **Grassland / Shrubland:** ${stats.grasslandPct.toFixed(1)}%` : null,
      stats.waterPct     > 0 ? `- **Water / Wetland:** ${stats.waterPct.toFixed(1)}%` : null,
    ].filter(Boolean).join('\n')

    const urbanClass =
      stats.builtUpPct >= 50 ? 'Highly urbanized (>50% built-up)' :
      stats.builtUpPct >= 25 ? 'Urban / suburban mix (25–50% built-up)' :
      stats.builtUpPct >= 10 ? 'Peri-urban / mixed (10–25% built-up)' :
      stats.builtUpPct >= 3  ? 'Predominantly rural (<10% built-up)' :
      'Minimal human development (<3% built-up)'

    return {
      summary: [
        `**Built-up Surface — ESA WorldCover 2021** · ${areaKm2.toFixed(1)} km² · ${centroidLabel(minLng, minLat, maxLng, maxLat)}`,
        '',
        `**Urbanization class:** ${urbanClass}`,
        `**Built-up area:** **${stats.builtUpPct.toFixed(1)}%** of the ${clipLabel} ≈ ${builtKm2.toFixed(2)} km²`,
        `**Dominant land class:** ${stats.dominantClass}`,
        '',
        `**Land cover breakdown (${clipLabel} clip):**`,
        classList,
        '',
        `**Resolution:** 10 m · **Source:** ESA WorldCover 2021 (Sentinel-2 derived) via Microsoft Planetary Computer STAC + titiler.xyz`,
        `**Analyzed pixels:** ${stats.totalPixels.toLocaleString()}`,
        '',
        '_Tile URL valid ~1 hour (PC SAS token). Re-run `fetch_built_surface` to refresh._',
        '',
        clip === 'polygon'
          ? '_Statistics are clipped to the drawn polygon (titiler cutline) — pixels outside the shape are excluded._'
          : '_No polygon AOI was available, so statistics cover the AOI bounding box rectangle. Draw a polygon for shape-true values._',
        '',
        '**Color legend:** dark red = Built-up · dark green = Tree Cover · yellow = Grassland · purple = Cropland · blue = Water · grey = Bare/sparse',
        '',
        `_Cite: Zanaga et al. (2022), ESA WorldCover 10 m 2021 v200. DOI 10.5281/zenodo.7254221_`,
      ].join('\n'),
      summary_data: {
        built_up_pct: Number(stats.builtUpPct.toFixed(1)),
        built_km2: Number(builtKm2.toFixed(2)),
        tree_cover_pct: Number(stats.treeCoverPct.toFixed(1)),
        cropland_pct: Number(stats.croplandPct.toFixed(1)),
        grassland_pct: Number(stats.grasslandPct.toFixed(1)),
        water_pct: Number(stats.waterPct.toFixed(1)),
        dominant_class: stats.dominantClass,
        area_km2: Number(areaKm2.toFixed(1)),
        land_cover: [
          { label: 'Built-up', value: Number(stats.builtUpPct.toFixed(1)) },
          { label: 'Tree', value: Number(stats.treeCoverPct.toFixed(1)) },
          { label: 'Cropland', value: Number(stats.croplandPct.toFixed(1)) },
          { label: 'Grassland', value: Number(stats.grasslandPct.toFixed(1)) },
          { label: 'Water', value: Number(stats.waterPct.toFixed(1)) },
        ].filter((p) => p.value > 0),
      },
      layer: {
        id: `built-surface-${genId()}`,
        name: 'Built-up Surface — ESA WorldCover 2021',
        type: 'raster' as const,
        tileUrl,
        bounds: [minLng, minLat, maxLng, maxLat],
        provenance: {
          source: 'ESA WorldCover 2021 (10 m Sentinel-2 derived) via Microsoft Planetary Computer STAC + titiler.xyz',
          date: '2021',
          method: `Categorical pixel stats (titiler.xyz POST /cog/statistics cutline, ${clip}-clipped, categorical=true). Built-up = class 50. Tile URL ~1h SAS expiry.`,
          clip,
        },
        confidence: 'high' as const,
        palette: WORLDCOVER_PALETTE,
      },
    }
  }

  // ---- Fallback: OSM building footprint area / AOI area --------------------
  emit?.('token', { type: 'token', content: 'ESA WorldCover unavailable — falling back to OSM building footprint area...\n' })

  let builtOsmKm2 = 0
  let osmBuildingCount = 0
  let osmQueryOK = false

  try {
    const osmQL = `[out:json][timeout:25][bbox:${minLat},${minLng},${maxLat},${maxLng}];\n(way["building"];relation["building"];);\nout geom qt 500;`
    const osmJson = await callOverpass(osmQL, 28000)
    for (const el of osmJson?.elements ?? []) {
      if (el.type !== 'way' || !el.geometry) continue
      const coords = (el.geometry as Array<{lat: number; lon: number}>).map((nd) => [nd.lon, nd.lat])
      if (coords.length < 3) continue
      if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) {
        coords.push([coords[0][0], coords[0][1]])
      }
      if (coords.length < 4) continue
      try {
        const areaM2 = turfArea({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: {} })
        builtOsmKm2 += areaM2 / 1_000_000
        osmBuildingCount++
      } catch { /* skip malformed geometry */ }
    }
    osmQueryOK = true
  } catch { /* OSM unavailable */ }

  const builtPct = areaKm2 > 0 ? Math.min(100, (builtOsmKm2 / areaKm2) * 100) : 0
  const confidence = osmQueryOK ? 'medium' as const : 'low' as const
  const color = builtPct >= 40 ? '#dc2626' : builtPct >= 15 ? '#f97316' : builtPct >= 5 ? '#fbbf24' : '#6b7280'

  const fallbackSummary = osmQueryOK
    ? `**Built-up Surface (OSM fallback)** · ${areaKm2.toFixed(1)} km²\n\n**OSM building footprints:** ${osmBuildingCount.toLocaleString()} buildings · ~${builtOsmKm2.toFixed(2)} km² mapped built area · **${builtPct.toFixed(1)}% of AOI** (bbox)\n\n> ESA WorldCover (Planetary Computer) was unavailable. This estimate uses OpenStreetMap building footprint areas — accuracy depends on local OSM mapping quality. Urban areas in well-mapped regions are typically >90% complete; rural Global South coverage varies.\n\n_Confidence: ${confidence}_`
    : `**Built-up Surface — data unavailable** · ${areaKm2.toFixed(1)} km²\n\nBoth ESA WorldCover (Planetary Computer STAC) and OpenStreetMap (Overpass) returned no usable data for this area. Try again shortly or check [ESA WorldCover Explorer](https://viewer.esa-worldcover.org/).`

  return {
    summary: fallbackSummary,
    ...(osmQueryOK ? {} : { failed: true }),
    summary_data: osmQueryOK
      ? {
          built_up_pct: Number(builtPct.toFixed(1)),
          built_km2: Number(builtOsmKm2.toFixed(2)),
          building_count: osmBuildingCount,
          area_km2: Number(areaKm2.toFixed(1)),
        }
      : undefined,
    layer: osmQueryOK ? {
      id: `built-surface-osm-${genId()}`,
      name: `Built-up Surface (OSM) — ${builtPct.toFixed(1)}% built`,
      type: 'geojson' as const,
      geojson: {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature' as const,
          properties: { built_pct: builtPct, built_km2: builtOsmKm2, building_count: osmBuildingCount, color, fill: color },
          geometry: aoi && (aoi.type === 'Polygon' || aoi.type === 'MultiPolygon') ? aoi : {
            type: 'Polygon',
            coordinates: [[[minLng, minLat], [maxLng, minLat], [maxLng, maxLat], [minLng, maxLat], [minLng, minLat]]],
          },
        }],
      },
      provenance: {
        source: 'OpenStreetMap building footprints via Overpass (fallback — ESA WorldCover unavailable)',
        method: `@turf/area sum of OSM building way geometries; built-up % = sum / AOI area`,
        clip: 'bbox' as const,
      },
      confidence,
    } : undefined,
  }
}

/** Compact centroid label for summary headers. */
function centroidLabel(minLng: number, minLat: number, maxLng: number, maxLat: number): string {
  const lat = ((minLat + maxLat) / 2).toFixed(4)
  const lng = ((minLng + maxLng) / 2).toFixed(4)
  return `${lat}°N, ${lng}°E`
}

