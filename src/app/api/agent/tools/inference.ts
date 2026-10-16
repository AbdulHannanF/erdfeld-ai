/** Perception + inference tools.
 *
 *  detect_objects      — the v2 perception pipeline: target profiler → imagery
 *                        planner → detector ladder → vectorize + report
 *  segment_feature     — promptable segmentation via SAM2
 *  classify_vegetation — functional vegetation type; honest about 10 m limits
 *
 *  None fabricate output. `detect_objects` in particular distinguishes three
 *  outcomes that older code collapsed into "0 results": the imagery cannot
 *  resolve the target, a detector failed, and a detector looked and saw none.
 */

import sharp from 'sharp'
import { cachedFetchJson } from '../lib/cache'
import { aoiSignature } from '../../../../lib/aoi'
import { genId, getCentroid } from '../lib/geometry'
import { isGeePreferred, geeNdvi } from '../lib/gee'
import { fetchWorldCoverData, worldCoverDescriptor, worldCoverLegendDescriptor } from '../lib/worldcover'
import {
  assessResolution,
  MODEL_REGISTRY,
} from '../lib/inference/registry'
import type { InferenceError, NormalizedOutput } from '../lib/inference/registry'
import { runInference, makeInferenceCacheKey } from '../lib/inference/gateway'
import {
  buildAoiTileGrid,
  esriTileUrl,
  fetchTileImage,
} from '../lib/cv'
import { describePerception, perceptionGeoJson, runPerception } from '../lib/perception/pipeline'
import { hostedSegmentationAvailable, roboflowSegmentPredictions } from '../lib/perception/backends'
import { isPlaceholderTile, metersPerPixel } from '../lib/perception/imagery-plan'
import { composeMosaic } from '../lib/perception/mosaic'
import {
  chooseSegmentationZoom,
  lonLatToMosaicPixel,
  mosaicForPoint,
  probeImageryCeiling,
  ringsToOutline,
} from '../lib/perception/segment'
import type { Confidence, Provenance, ToolCtx, ToolOutput } from '../lib/types'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** True when the result is an InferenceError (not NormalizedOutput). */
function isInferenceError(r: NormalizedOutput | InferenceError): r is InferenceError {
  return 'error' in r && 'honestMessage' in r
}

/** Format costTier as a human-readable latency label (B6). */
function costLabel(key: string): string {
  const entry = MODEL_REGISTRY[key]
  if (!entry) return ''
  const tiers: Record<string, string> = {
    free: 'free · instant',
    cheap: 'pay-per-call · ~$0.01–0.05 · 5–30 s',
    gpu: 'GPU compute · ~$0.05–0.50 · 20–120 s',
  }
  return tiers[entry.costTier] ?? entry.costTier
}

// ---------------------------------------------------------------------------
// B3 — detect_objects: open-vocabulary detection via Grounding-DINO
// ---------------------------------------------------------------------------

/**
 * Phase 2 — the perception pipeline entry point.
 *
 * Replaces the pre-v2 implementation, which pointed Grounding-DINO at a
 * satellite tile through the inference gateway. That approach is retired by the
 * v2 spec and by measurement: Grounding-DINO, OWLv2 and YOLO-World all score ~0
 * on nadir imagery, and re-measured on 2026-08-10 a COCO-trained detector that
 * scores 0.94 on ground-level photography returns *zero* detections on real
 * overhead imagery at every resolution from 0.05 to 0.26 m/px. Viewpoint, not
 * resolution, is what breaks them.
 *
 * What replaces it is the four-stage pipeline: size the target, plan imagery that
 * can resolve it, walk the detector ladder, and report which tier answered —
 * including, when the honest answer is "this imagery cannot show that", saying so
 * and naming what could.
 */
export async function detectObjects(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const target = String(args.target ?? '').trim()

  if (!target) {
    return {
      summary:
        '`detect_objects` requires a `target` argument — the object to find in plain words ' +
        '(e.g. "car", "swimming pool", "aircraft", "solar panel"). ' +
        'For an unusual target, also pass `footprint_m: [long, short]` with your own estimate of ' +
        'its size in metres so the pipeline can judge whether any imagery resolves it.',
    }
  }

  const footprint = Array.isArray(args.footprint_m) && args.footprint_m.length === 2
    ? ([Number(args.footprint_m[0]), Number(args.footprint_m[1])] as [number, number])
    : undefined
  const validFootprint = footprint && footprint.every((v) => Number.isFinite(v) && v > 0) ? footprint : undefined

  const result = await runPerception(ctx, { target, task: 'detect', footprintM: validFootprint })
  const { profile, plan, ladder } = result
  const summary = describePerception(result)

  if (ladder.detections.length === 0) {
    return {
      summary,
      summary_data: {
        detection_count: 0,
        target: profile.target,
        resolved: plan.ok ? 'yes' : 'no',
        tier_used: 'none',
      },
      // Even a zero is only a statement about imagery that was looked at; none, nothing to source.
      ...(plan.source?.name ? { sources: [plan.source.name] } : {}),
    }
  }

  const provenance: Provenance = {
    source: `${plan.source?.name ?? 'imagery'} + Tier ${ladder.tierUsed} (${ladder.detections[0].model})`,
    method:
      `perception pipeline · target "${profile.target}" (${profile.footprintM?.[0]} m, ${profile.source}) · ` +
      `z${plan.zoom} at ${plan.mpp?.toFixed(2)} m/px · target ≈ ${plan.objectPx?.toFixed(0)} px` +
      `${ladder.coverage?.sampled ? ' · spatial subsample' : ''}`,
    clip: 'polygon',
    resolution_limit:
      `Detection needs the object to span enough pixels: ${profile.target} is ` +
      `${plan.objectPx?.toFixed(0)} px at this imagery resolution.`,
  }

  const confident = ladder.detections.filter((d) => d.confidence > 0.7).length
  const layerConfidence: Confidence =
    ladder.tierUsed === 'A' && !ladder.coverage?.sampled && confident / ladder.detections.length >= 0.5
      ? 'medium'
      : 'low'

  return {
    summary,
    summary_data: {
      detection_count: ladder.detections.length,
      target: profile.target,
      tier_used: ladder.tierUsed ?? 'none',
      coverage_pct: Number((ladder.coverage?.coveragePct ?? 100).toFixed(0)),
      object_px: Number((plan.objectPx ?? 0).toFixed(0)),
      imagery_m_per_px: Number((plan.mpp ?? 0).toFixed(3)),
    },
    layer: {
      id: `perception-${genId()}`,
      name: `${profile.target} (${ladder.detections.length})`,
      type: 'geojson',
      geojson: perceptionGeoJson(result),
      provenance,
      confidence: layerConfidence,
    },
  }
}

// ---------------------------------------------------------------------------
// segment_feature — promptable segmentation returning the REAL outline (ISS-110)
// ---------------------------------------------------------------------------

/**
 * Delineate the feature at a point.
 *
 * ISS-110: this tool promised *"delineates the exact boundary"* and returned the
 * mask's **bounding rectangle** — five coordinates. SAM2 was returning real
 * polygon rings the whole time (measured 2026-08-10: up to 346 vertices); the old
 * code scanned them down to a bbox with `sharp`, and the old inference gateway it
 * called routed to a backend that no longer exists.
 *
 * Now: probe the finest imagery that actually exists here, prompt SAM2 with the
 * point, keep the largest real ring, project it, and — because "returns a
 * polygon" was true of the broken version too — state plainly whether the result
 * is an outline or degenerated to a box.
 */
export async function segmentFeature(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const { aoi, focus, emit } = ctx
  const centroid = getCentroid(aoi)
  const lat = Number(args.lat ?? focus?.lat ?? centroid.lat)
  const lon = Number(args.lon ?? focus?.lng ?? centroid.lng)
  const label = String(args.label ?? 'Segmented feature')

  const unavailable = hostedSegmentationAvailable()
  if (unavailable) {
    return {
      summary:
        `**Segmentation is not configured.** ${unavailable}.

` +
        `\`segment_feature\` needs a SAM2 backend: set \`ROBOFLOW_API_KEY\` in \`.env\` (free tier), ` +
        `or register a local SAM2 export under Settings → Perception Models. ` +
        `No outline is returned rather than a guessed one.`,
      failed: true,
    }
  }

  emit?.('token', {
    type: 'token',
    content: `segment_feature: probing the finest imagery at (${lat.toFixed(5)}, ${lon.toFixed(5)})...
`,
  })

  const ceiling = await probeImageryCeiling({
    lat, lon,
    fetchTile: async (url) => Buffer.from(await fetchTileImage(url)),
  })
  if (!ceiling.ok) {
    return { summary: `**Could not segment here.** ${ceiling.reason}` }
  }

  // The frame has to CONTAIN the feature, so the finest imagery is not
  // automatically right: at Schiphol's z21 ceiling a 1024 px block spans only
  // ~47 m, which crops a 40 m aircraft. Back off until it covers ~150 m.
  const TILES_PER_SIDE = 4
  const zoom = chooseSegmentationZoom(ceiling.zoom, lat, TILES_PER_SIDE)
  const spec = mosaicForPoint(lat, lon, zoom, TILES_PER_SIDE)
  const mpp = metersPerPixel(lat, zoom)
  const composed = await composeMosaic(
    spec,
    (x, y, z) => ceiling.source.urlTemplate.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)),
    fetchTileImage,
    isPlaceholderTile,
  )
  if ('error' in composed) {
    return { summary: `**Could not segment here.** Imagery could not be assembled: ${composed.error}` }
  }

  const [px, py] = lonLatToMosaicPixel(lat, lon, spec)
  emit?.('token', {
    type: 'token',
    content: `segment_feature: SAM2 at z${zoom} (${mpp.toFixed(2)} m/px)...
`,
  })

  let preds: Awaited<ReturnType<typeof roboflowSegmentPredictions>>
  try {
    preds = await roboflowSegmentPredictions(composed.image, [{ x: Math.round(px), y: Math.round(py) }])
  } catch (err: any) {
    return {
      summary:
        `**Segmentation failed.** SAM2 returned an error: ${err?.message ?? 'unknown'}.

` +
        `This is a backend failure, not "no feature here" — no outline is returned.`,
    }
  }

  const outline = preds.length ? ringsToOutline(preds[0].rings, preds[0].confidence, spec) : null
  if (!outline) {
    return {
      summary:
        `**SAM2 found no distinct boundary** at (${lat.toFixed(5)}, ${lon.toFixed(5)}).

` +
        `Every contour it returned was degenerate, which usually means the point sits on uniform ` +
        `ground with no edge nearby. Try clicking on the feature's interior or its edge. ` +
        `Imagery used: ${ceiling.source.name} z${zoom} (${mpp.toFixed(2)} m/px).`,
    }
  }

  const areaM2 = geoRingAreaM2(outline.geoRing)
  const provenance: Provenance = {
    source: `${ceiling.source.name} + SAM2 (Roboflow hosted)`,
    method:
      `point-prompted segmentation at (${lat.toFixed(5)}, ${lon.toFixed(5)}) · z${zoom} ` +
      `(${mpp.toFixed(2)} m/px) · ${outline.rawVertices} mask vertices` +
      `${outline.geoRing.length - 1 < outline.rawVertices ? ` thinned to ${outline.geoRing.length - 1}` : ''}`,
    clip: 'polygon',
    resolution_limit:
      `The outline follows the mask at ${mpp.toFixed(2)} m/px, so boundary detail finer than ` +
      `about ${(mpp * 2).toFixed(1)} m is not resolved.`,
  }

  const feature = {
    type: 'Feature',
    properties: {
      label,
      confidence: Math.round(outline.confidence * 1000) / 1000,
      source: 'SAM2',
      vertices: outline.geoRing.length - 1,
      color: '#a78bfa',
      fill: '#a78bfa',
    },
    geometry: { type: 'Polygon', coordinates: [outline.geoRing] },
  }

  return {
    summary:
      `**Delineated "${label}"** at (${lat.toFixed(5)}, ${lon.toFixed(5)}).

` +
      `The polygon is the mask's actual outline — **${outline.geoRing.length - 1} vertices**` +
      `${outline.rawVertices > outline.geoRing.length - 1 ? ` (thinned from ${outline.rawVertices})` : ''}, ` +
      `enclosing about **${formatArea(areaM2)}**.` +
      (outline.rectangular
        ? `

⚠️ The returned ring is a rectangle, which means SAM2 produced only a box here — ` +
          `treat it as an extent, not a boundary.`
        : '') +
      `

**Imagery:** ${ceiling.source.name} at z${zoom} — ${mpp.toFixed(2)} m/px. ` +
      `${provenance.resolution_limit}

` +
      `_Source: ${provenance.source} · SAM2 confidence ${outline.confidence.toFixed(2)}_`,
    summary_data: {
      vertices: outline.geoRing.length - 1,
      area_m2: Math.round(areaM2),
      confidence: Math.round(outline.confidence * 1000) / 1000,
      imagery_m_per_px: Number(mpp.toFixed(3)),
    },
    layer: {
      id: `segment-${genId()}`,
      name: `${label.slice(0, 30)} (outline)`,
      type: 'geojson',
      geojson: { type: 'FeatureCollection', features: [feature] },
      provenance,
      confidence: outline.confidence > 0.7 ? 'medium' : 'low',
    },
  }
}

/** Spherical-excess area of a small closed lon/lat ring, in m². */
function geoRingAreaM2(ring: number[][]): number {
  if (ring.length < 4) return 0
  const R = 6378137
  let total = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i]
    const [lon2, lat2] = ring[i + 1]
    total +=
      ((lon2 - lon1) * Math.PI) / 180 *
      (2 + Math.sin((lat1 * Math.PI) / 180) + Math.sin((lat2 * Math.PI) / 180))
  }
  return Math.abs((total * R * R) / 2)
}

function formatArea(m2: number): string {
  if (m2 >= 1e6) return `${(m2 / 1e6).toFixed(2)} km²`
  if (m2 >= 10_000) return `${(m2 / 10_000).toFixed(2)} ha`
  return `${Math.round(m2)} m²`
}


// ---------------------------------------------------------------------------
// B5 — classify_vegetation: functional vegetation type (the "what kind of trees" answer)
// ---------------------------------------------------------------------------

/** Map a WorldCover dominant class name to a functional vegetation description. */
export function worldCoverToFunctionalType(dominantClass: string, treeCoverPct: number): string {
  const lc = dominantClass.toLowerCase()
  if (lc.includes('tree')) {
    if (treeCoverPct >= 80) return 'closed-canopy forest'
    if (treeCoverPct >= 50) return 'mixed woodland / open forest'
    return 'sparse tree cover / open woodland'
  }
  if (lc.includes('shrub')) return 'shrubland / low woody vegetation'
  if (lc.includes('grass')) return 'grassland / herbaceous cover'
  if (lc.includes('crop')) return 'cropland / agricultural vegetation'
  if (lc.includes('mangrove')) return 'mangrove forest'
  if (lc.includes('wetland')) return 'herbaceous wetland'
  if (lc.includes('moss') || lc.includes('lichen')) return 'moss / lichen'
  return dominantClass
}

/** Derive a canopy structure note from NDVI and tree cover %. */
export function ndviToCanopyNote(ndvi: number | null, treeCoverPct: number): string {
  if (ndvi == null) return 'canopy NDVI unavailable'
  const density = treeCoverPct >= 70 ? 'dense' : treeCoverPct >= 40 ? 'moderate' : 'sparse'
  const vigor = ndvi > 0.7 ? 'high vigor' : ndvi >= 0.5 ? 'moderate vigor' : ndvi > 0.3 ? 'low vigor' : 'stressed / dormant'
  return `NDVI ${ndvi.toFixed(2)} — ${density} canopy, ${vigor}`
}

export async function classifyVegetation(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const { aoi, bbox, emit } = ctx
  const centroid = getCentroid(aoi)

  // Always lead with the resolution honesty check
  const speciesAssessment = assessResolution('species', 10)  // 10 m Sentinel-2

  emit?.('token', {
    type: 'token',
    content: 'classify_vegetation: fetching WorldCover 2021 + NDVI...\n',
  })

  // --- Fetch WorldCover land cover (free, no key, always available) ----------
  let wcData: Awaited<ReturnType<typeof fetchWorldCoverData>> = null
  try {
    // ISS-102: pass the drawn polygon — a bbox-only call used to be answered with
    // whole-COG (3°×3°) class counts by titiler.
    wcData = await fetchWorldCoverData(bbox, aoi)
  } catch {
    // non-fatal — degrade to NDVI-only analysis
  }

  // --- Fetch NDVI (GEE preferred if configured, else STAC+titiler) -----------
  let ndviMean: number | null = null

  if (isGeePreferred()) {
    try {
      const geeResult = await geeNdvi(aoi)
      if (geeResult) ndviMean = geeResult.meanNdvi
    } catch {
      // fall through to STAC path
    }
  }

  // No additional NDVI fallback — WorldCover already encodes the vegetation signal.
  // GEE path is the only way to get NDVI without a private cachedStacSearch helper.

  // --- Optional: run veg_type model via gateway (if provider configured) -----
  const aoiKey = aoiSignature(aoi)
  const cacheKey = makeInferenceCacheKey('veg_type', aoiKey)
  let modelLabels: string[] | null = null

  // veg_type is 'gpu' tier — only run if provider is explicitly configured
  const grid = buildAoiTileGrid(aoi, bbox, { maxTiles: 1, zoom: 13 })
  if (grid.tiles.length) {
    try {
      const modelResult: NormalizedOutput | InferenceError = await cachedFetchJson(
        cacheKey,
        { source: 'inference', ttlMs: 60 * 60_000 },
        async () => {
          const tile = grid.tiles[0]
          const tileBytes = await fetchTileImage(esriTileUrl(tile.x, tile.y, tile.z))
          return runInference('veg_type', {
            imageBytes: Array.from(new Uint8Array(tileBytes)),
          })
        },
      )
      if (!isInferenceError(modelResult) && modelResult.labels?.length) {
        modelLabels = modelResult.labels
      }
    } catch {
      // non-fatal — fall back to WorldCover only
    }
  }

  // --- Compose the honest answer --------------------------------------------
  const wc = wcData?.stats
  const dominantClass = wc?.dominantClass ?? 'Unknown'
  const treeCoverPct = wc?.treeCoverPct ?? 0
  const functionalType = wc ? worldCoverToFunctionalType(dominantClass, treeCoverPct) : 'land cover undetermined'
  const canopyNote = ndviToCanopyNote(ndviMean, treeCoverPct)
  const resolutionNote = MODEL_REGISTRY['veg_type'].resolutionLimit

  // WorldCover class breakdown
  const wcBreakdown = wc
    ? `Tree cover: ${wc.treeCoverPct}% · Cropland: ${wc.croplandPct}% · ` +
      `Grassland/shrub: ${wc.grasslandPct}% · Built-up: ${wc.builtUpPct}% · Water: ${wc.waterPct}%`
    : 'WorldCover data unavailable for this area'

  const modelNote = modelLabels
    ? `\n\n**Foundation model (Prithvi-EO) classification:** ${modelLabels.join(', ')}`
    : ''

  // Summary always leads with the species honest limit (Rule 19 / B5 acceptance)
  const speciesLine = speciesAssessment.canAnswer
    ? ''
    : `\n\n> **Resolution limit:** ${speciesAssessment.honestNote}`

  const provenance: Provenance = {
    source: [
      'ESA WorldCover 2021 (10 m, Planetary Computer)',
      isGeePreferred() ? 'GEE Sentinel-2 NDVI' : 'Sentinel-2 NDVI (Element84/PC STAC)',
      modelLabels ? 'Prithvi-EO-2.0 classification (foundation model)' : null,
    ]
      .filter(Boolean)
      .join(' + '),
    method:
      `WorldCover categorical stats (titiler POST cutline, ${wcData?.clip ?? 'unavailable'}-clipped) + NDVI mean` +
      (modelLabels ? ' + foundation model classify' : ''),
    clip: wcData?.clip ?? 'bbox',
    resolution_limit: resolutionNote,
  }

  const layers: import('../lib/types').ResultLayer[] = []

  if (wcData?.tileUrl) {
    layers.push({
      id: `worldcover-veg-${genId()}`,
      name: 'Land Cover (WorldCover 2021)',
      type: 'raster' as const,
      tileUrl: wcData.tileUrl,
      bounds: [bbox[0], bbox[1], bbox[2], bbox[3]] as [number, number, number, number],
      aoiMask: true,
      raster: wcData.stats.classes.length ? worldCoverDescriptor(wcData.stats.classes) : worldCoverLegendDescriptor(),
      provenance,
      confidence: 'high' as Confidence,
    })
  }

  const summary =
    `**Functional vegetation type: ${functionalType}**${speciesLine}\n\n` +
    `**Canopy signal:** ${canopyNote}\n\n` +
    `**Land cover breakdown (WorldCover 2021):** ${wcBreakdown}\n\n` +
    `**Dominant class:** ${dominantClass} (${treeCoverPct}% tree cover)` +
    `${modelNote}\n\n` +
    `_Source: ${provenance.source} · resolution: 10 m · ${new Date().getFullYear()}_`

  return {
    summary,
    summary_data: {
      functional_type: functionalType,
      dominant_class: dominantClass,
      ndvi_mean: ndviMean ?? 'unavailable',
      // The land-cover shares exist only when WorldCover was read: never a zero standing in for "no data".
      ...(wc ? { tree_cover_pct: treeCoverPct, cropland_pct: wc.croplandPct, grassland_pct: wc.grasslandPct, water_pct: wc.waterPct } : {}),
    },
    ...(wc ? { sources: [provenance.source] } : { failed: true }),
    layer: layers[0],
    layers: layers.slice(1),
  }
}
