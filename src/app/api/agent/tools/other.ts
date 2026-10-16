/** Parked computer-vision detector (GEOAGENT_ENABLE_CV=1) and the offline render_to_map fixture. */

import { genId } from '../lib/geometry'
import { mapFeatureToCvModel } from '../lib/overpass'
import type { Confidence, Provenance, ToolCtx, ToolOutput } from '../lib/types'
import {
  approxTileCoverageKm2,
  buildAoiTileGrid,
  CV_MODEL_MAP,
  dedupeDetections,
  esriTileUrl,
  fetchTileImage,
  ONNX_SUPPORTED_MODELS,
  pickCvProvider,
  predictionToDetection,
  resolveModelSlug,
  runRoboflowInference,
  runWithConcurrency,
  type GeoDetection,
} from '../lib/cv'
import { ONNX_MODEL_REGISTRY, runOnnxInference } from '../lib/cv-onnx'

export async function runCvDetector(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const { aoi, bbox, areaKm2, emit } = ctx
  const rawModel = String(args.model || 'informal_struct')

  // ---- Phase 1: registered models take precedence --------------------------
  // A model the user added in Settings (or an operator added via GEOAGENT_MODELS)
  // is addressed by its own id and runs through the provider adapters, reusing
  // the tiling / georeferencing / dedupe below unchanged.
  const registered = ctx.models?.models.get(rawModel)
  if (registered) return runRegisteredDetector(ctx, registered, args)

  // Registered but excluded — say why rather than silently falling through to a
  // different model that happens to share a name prefix.
  const skipped = ctx.models?.skipped.find((s) => s.id === rawModel)
  if (skipped) {
    return {
      summary:
        `Model **${rawModel}** is registered but not available on this machine: ${skipped.reason}\n\n` +
        `No detections fabricated.`,
      failed: true,
    }
  }

  const model = CV_MODEL_MAP[rawModel] ? rawModel : mapFeatureToCvModel(rawModel)
  const modelInfo = CV_MODEL_MAP[model]
  if (!modelInfo) {
    const registeredIds = [...(ctx.models?.models.keys() ?? [])]
    return {
      summary:
        `Unknown CV model "${rawModel}". Built-in: ${Object.keys(CV_MODEL_MAP).join(', ')}.` +
        (registeredIds.length ? ` Registered: ${registeredIds.join(', ')}.` : ''),
    }
  }

  // ---- Provider selection --------------------------------------------------
  const provider = pickCvProvider(model, args)

  if (provider === 'none') {
    const onnxEligible = ONNX_SUPPORTED_MODELS.has(model)
    if (onnxEligible) {
      return {
        summary:
          `Computer vision detection (model: **${model}**) failed to select a provider.\n\n` +
          `This model supports key-free ONNX inference but the model file could not be loaded. ` +
          `See \`public/models/README.md\` for download instructions.\n\n` +
          `Alternatively, set \`ROBOFLOW_API_KEY\` in \`.env\` (free at roboflow.com).`,
      }
    }
    return {
      summary:
        `Computer vision detection (model: **${model}**) has no backend that can run it here.\n\n` +
        (args.text_prompt
          ? `**For an open-vocabulary request like "${String(args.text_prompt)}", use \`detect_objects\`** — ` +
            `it runs the key-free local aerial detector and escalates imagery on its own. ` +
            `This tool's text-prompt route used to go to HuggingFace Grounding-DINO, which was withdrawn: ` +
            `\`api-inference.huggingface.co\` no longer resolves, and HF serverless served those models for ` +
            `nobody even before that. No key can revive it.\n\n`
          : '') +
        `**Otherwise:** set \`ROBOFLOW_API_KEY=<your-key>\` in \`.env\` (free at roboflow.com).\n\n` +
        `Optionally override the default model slug:\n` +
        `- \`${modelInfo.envVar}=<workspace>/<project>/<version>\` (defaults to \`${modelInfo.defaultSlug}\`)\n\n` +
        `After adding the key, restart the dev server and re-run this tool. No fabricated detections returned.`,
    }
  }

  // The HF Grounding-DINO path was withdrawn 2026-08-16 (ISS-128) — see the
  // `CvProvider` note. `pickCvProvider` can no longer return 'hf', so there is
  // nothing to dispatch here; a text-prompt request now falls through to ONNX
  // or to the honest 'none' refusal below, which names `detect_objects`.

  // ---- Common tile grid setup (Roboflow + ONNX paths) ----------------------
  const confidence = clamp01(Number(args.confidence) || modelInfo.defaultConfidence)
  const zoom = Number(args.zoom) || modelInfo.zoom
  const MAX_TILES = 25

  const grid = buildAoiTileGrid(aoi, bbox, { maxTiles: MAX_TILES, zoom })
  emit?.('token', {
    type: 'token',
    content:
      `CV [${provider}]: tiling AOI at z${grid.z} → ${grid.tiles.length} tile(s)` +
      `${grid.sampled ? ` (sampled from ${grid.totalCandidates})` : ''}\n`,
  })

  // ---- Per-tile fetch + inference (concurrency-capped) --------------------
  const tileResults = await runWithConcurrency(grid.tiles, 4, async (tile) => {
    const url = esriTileUrl(tile.x, tile.y, tile.z)
    let bytes: ArrayBuffer
    try {
      bytes = await fetchTileImage(url)
    } catch (err: any) {
      return { tile, error: `tile fetch failed: ${err?.message || 'unknown'}` as string }
    }

    if (provider === 'roboflow') {
      const slug = resolveModelSlug(model)!
      const inf = await runRoboflowInference(slug, bytes, process.env.ROBOFLOW_API_KEY!, confidence)
      return { tile, inference: inf }
    }

    // ONNX path
    const inf = await runOnnxInference(model, bytes, confidence)
    return { tile, inference: inf }
  })

  // ---- Surface fatal Roboflow-specific error (model 404) ------------------
  if (provider === 'roboflow') {
    const slug = resolveModelSlug(model)!
    const modelMissing = tileResults.some((r) => 'inference' in r && r.inference?.modelMissing)
    if (modelMissing) {
      return {
        summary:
          `Roboflow model **${slug}** is not available (HTTP 404). The default slug for "${model}" did not resolve.\n\n` +
          `**To fix:** find a verified Roboflow Universe model for this feature and set:\n` +
          `\`${modelInfo.envVar}=<workspace>/<project>/<version>\`\n\n` +
          `No detections fabricated.`,
        failed: true,
      }
    }
  }

  const tileFails = tileResults.filter((r) => 'error' in r || r.inference?.error).length
  const fullFailure = tileFails === tileResults.length
  if (fullFailure) {
    const firstErr =
      tileResults.find((r) => 'error' in r)?.error ||
      tileResults.find((r) => 'inference' in r && r.inference?.error)?.inference?.error ||
      'unknown'
    const providerHint =
      provider === 'onnx'
        ? ` See \`public/models/README.md\` — model file may need to be downloaded.`
        : ''
    return {
      summary:
        `CV detection failed for all ${tileResults.length} tile(s). First error: **${firstErr}**.${providerHint}\n\n` +
        `No detections fabricated.`,
      failed: true,
    }
  }

  // ---- Georeference → merge → dedupe -------------------------------------
  const rawDetections: GeoDetection[] = []
  let analyzedTiles = 0
  for (const r of tileResults) {
    if ('error' in r) continue
    if (!r.inference || r.inference.error) continue
    analyzedTiles++
    for (const p of r.inference.predictions) {
      rawDetections.push(predictionToDetection(p, r.tile))
    }
  }
  const detections = dedupeDetections(rawDetections, modelInfo.dedupeMeters)

  // ---- Coverage + provenance + summary ------------------------------------
  const coverageKm2 = approxTileCoverageKm2(grid.tiles.slice(0, analyzedTiles))
  const coveragePct = areaKm2 > 0 ? Math.min(100, (coverageKm2 / areaKm2) * 100) : 100
  const sampled = grid.sampled || tileFails > 0
  const coverageLine = sampled
    ? `Analyzed ${analyzedTiles}/${grid.tiles.length} tiles at z${grid.z} — ~${coveragePct.toFixed(0)}% of AOI sampled (representative subset, not a full census)`
    : `Analyzed ${analyzedTiles}/${grid.tiles.length} tiles at z${grid.z} — full AOI coverage at this resolution`

  // Build provenance line — different for each provider.
  const slug = provider === 'roboflow' ? resolveModelSlug(model)! : null
  const onnxInfo = provider === 'onnx' ? ONNX_MODEL_REGISTRY[model] : null
  const provSource =
    provider === 'roboflow'
      ? `Esri World Imagery + Roboflow (${slug})`
      : provider === 'onnx'
      ? `Esri World Imagery + ONNX YOLO (self-hosted · ${onnxInfo?.license ?? 'AGPL-3.0'})`
      : `Esri World Imagery + HF Grounding-DINO`
  const provMethod =
    provider === 'onnx'
      ? `tiled ONNX YOLO · self-hosted · weights from ${onnxInfo?.source ?? 'see public/models/README.md'} · z${grid.z} · ${analyzedTiles} tiles · confidence ≥ ${confidence.toFixed(2)}${sampled ? ' · spatial subsample' : ''}`
      : `tiled CV detection · z${grid.z} · ${analyzedTiles} tiles · confidence ≥ ${confidence.toFixed(2)}${sampled ? ' · spatial subsample' : ''}`

  if (detections.length === 0) {
    const provenance: Provenance = { source: provSource, method: provMethod, clip: 'polygon' }
    return {
      summary:
        `Computer vision detection (model: **${model}**, provider: \`${provider}\`) found **0 detections** across the AOI.\n\n` +
        `${coverageLine}.${tileFails > 0 ? `\n${tileFails} tile(s) failed (skipped).` : ''}\n\n` +
        `No objects matching this model were detected. Try:\n` +
        `- A larger AOI or different location\n` +
        `- A different model: ${Object.keys(CV_MODEL_MAP).join(', ')}\n` +
        `- Lowering \`confidence\` (currently ${confidence.toFixed(2)})` +
        `${modelInfo.note ? `\n\n_Model note:_ ${modelInfo.note}` : ''}\n\n` +
        `_Source: ${provenance.source} · confidence: low (no positives)_`,
      layer: undefined,
    }
  }

  const highConf = detections.filter((d) => d.confidence > 0.8).length
  const medConf = detections.filter((d) => d.confidence > 0.6 && d.confidence <= 0.8).length
  const lowConf = detections.length - highConf - medConf
  const classCounts: Record<string, number> = {}
  for (const d of detections) classCounts[d.class] = (classCounts[d.class] ?? 0) + 1
  const classList = Object.entries(classCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} (${v})`)
    .join(', ')

  const positiveRate = detections.length > 0 ? (highConf + medConf) / detections.length : 0
  let layerConfidence: Confidence = 'medium'
  if (!sampled && positiveRate >= 0.6) layerConfidence = 'high'
  else if (sampled && positiveRate < 0.4) layerConfidence = 'low'

  const provenance: Provenance = { source: provSource, method: provMethod, clip: 'polygon' }
  const featureSource = provider === 'roboflow' ? `Roboflow (${slug})` : provider === 'onnx' ? 'ONNX YOLO (self-hosted)' : 'HF Grounding-DINO'

  const features = detections.map((d) => {
    const color = d.confidence > 0.8 ? '#22c55e' : d.confidence > 0.6 ? '#f59e0b' : '#ef4444'
    const props = {
      label: d.class,
      confidence: Math.round(d.confidence * 1000) / 1000,
      source: featureSource,
      color,
      tile_z: d.tile.z,
    }
    if (modelInfo.geom === 'point') {
      return {
        type: 'Feature',
        properties: props,
        geometry: { type: 'Point', coordinates: d.centroid },
      }
    }
    return {
      type: 'Feature',
      properties: { ...props, fill: color },
      geometry: { type: 'Polygon', coordinates: d.polygon },
    }
  })

  const headline = `**Detected ${detections.length.toLocaleString()} ${model.replace(/_/g, ' ')}${detections.length === 1 ? '' : 's'}**`
  const dupesRemoved = rawDetections.length - detections.length
  const dupeNote = dupesRemoved > 0 ? ` (deduped ${dupesRemoved} seam-overlap${dupesRemoved === 1 ? '' : 's'})` : ''
  const tileFailNote = tileFails > 0 ? `\n⚠️ ${tileFails} tile(s) failed to analyze and were skipped.` : ''
  const modelNote = modelInfo.note ? `\n\n_Model note:_ ${modelInfo.note}` : ''
  const providerLine = provider === 'onnx'
    ? `\n\n_Open-weight ONNX model — ${onnxInfo?.license ?? 'AGPL-3.0'} · ${onnxInfo?.source ?? 'see public/models/README.md'}_`
    : ''

  return {
    summary:
      `Computer vision detection (model: **${model}**, provider: \`${provider}\`).\n\n` +
      `${headline}${dupeNote}.\n\n` +
      `**Coverage:** ${coverageLine}.${tileFailNote}\n\n` +
      `**Confidence breakdown:**\n` +
      `- High (>0.8): ${highConf} (green)\n` +
      `- Medium (0.6–0.8): ${medConf} (amber)\n` +
      `- Low (<0.6): ${lowConf} (red)\n\n` +
      `**Detected classes:** ${classList}\n\n` +
      `Map markers show each detection — click for class + confidence. Aggregate confidence: **${layerConfidence}**.` +
      `${modelNote}${providerLine}\n\n` +
      `_Source: ${provenance.source} · ${provenance.method} · confidence: ${layerConfidence}_`,
    summary_data: {
      detection_count: detections.length,
      high_confidence: highConf,
      medium_confidence: medConf,
      low_confidence: lowConf,
      coverage_pct: Number(coveragePct.toFixed(0)),
      model,
      provider,
      class_counts: Object.entries(classCounts).map(([label, value]) => ({ label, value })),
    },
    layer: {
      id: `cv-${model}-${genId()}`,
      name: `CV: ${model.replace(/_/g, ' ')} (${detections.length})`,
      type: 'geojson',
      geojson: { type: 'FeatureCollection', features },
      provenance,
      confidence: layerConfidence,
    },
  }
}

function clamp01(n: number): number {
  if (!isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

// ---------------------------------------------------------------------------
// Phase 1 — registered models (Settings / GEOAGENT_MODELS / built-ins)
// ---------------------------------------------------------------------------

/**
 * Run a model registered through the Phase 1 registry.
 *
 * Deliberately reuses the same tiling, georeferencing, seam-dedupe and coverage
 * accounting as the built-in models — a user-registered model is not a
 * second-class path, and its answers carry the same honesty guarantees:
 *
 *  - a provider failure is reported as a failure, never as "0 detections";
 *  - coverage is stated as the fraction of AOI actually analysed;
 *  - provenance names the model id, its provider, and its declared licence;
 *  - the model's own `resolutionLimit` is quoted rather than one we invented.
 */
async function runRegisteredDetector(
  ctx: ToolCtx,
  spec: import('../lib/inference/model-spec').ModelSpec,
  args: Record<string, any>,
): Promise<ToolOutput> {
  const { aoi, bbox, areaKm2, emit } = ctx
  const { runModel, describeProviderRequirement } = await import('../lib/inference/adapters')

  if (spec.task !== 'detect' && spec.task !== 'segment') {
    return {
      summary:
        `Model **${spec.id}** is registered for task "${spec.task}", which \`run_cv_detector\` cannot use ` +
        `(it needs "detect" or "segment").`,
    }
  }

  const confidence = clamp01(Number(args.confidence) || spec.defaultConfidence || 0.3)
  const zoom = Number(args.zoom) || 18
  const grid = buildAoiTileGrid(aoi, bbox, { maxTiles: 25, zoom })
  const source = ctx.models?.sourceOf(spec.id) ?? 'registered'

  emit?.('token', {
    type: 'token',
    content:
      `CV [${spec.provider}] ${spec.id} (${source}): tiling AOI at z${grid.z} → ${grid.tiles.length} tile(s)` +
      `${grid.sampled ? ` (sampled from ${grid.totalCandidates})` : ''}\n`,
  })

  const tileResults = await runWithConcurrency(grid.tiles, 4, async (tile) => {
    let bytes: ArrayBuffer
    try {
      bytes = await fetchTileImage(esriTileUrl(tile.x, tile.y, tile.z))
    } catch (err: any) {
      return { tile, error: `tile fetch failed: ${err?.message || 'unknown'}` as string }
    }
    const out = await runModel(spec, {
      imageBytes: Buffer.from(bytes),
      prompt: typeof args.text_prompt === 'string' ? args.text_prompt : undefined,
      confidence,
    })
    return { tile, out }
  })

  // Every tile failing is a provider problem, not an empty scene. Say which.
  const failures = tileResults
    .map((r) => ('error' in r ? r.error : r.out.ok ? null : r.out.error))
    .filter((e): e is string => !!e)
  if (failures.length === tileResults.length) {
    return {
      summary:
        `Model **${spec.id}** (${spec.provider}) could not analyse any of the ${tileResults.length} tile(s).\n\n` +
        `**First error:** ${failures[0]}\n\n` +
        `${describeProviderRequirement(spec.provider)}\n\n` +
        `No detections fabricated — this is a failure, not an empty result.`,
    }
  }

  const rawDetections: GeoDetection[] = []
  let analyzedTiles = 0
  for (const r of tileResults) {
    if ('error' in r || !r.out.ok) continue
    analyzedTiles++
    for (const p of r.out.predictions) rawDetections.push(predictionToDetection(p, r.tile))
  }

  // Dedupe radius from the model's own footprint when it declares one; a car at
  // 4.5 m must not collapse with its neighbour the way a building would.
  const dedupeMeters = Math.max(3, Math.round((spec.resolutionM ?? 0.3) * 20))
  const detections = dedupeDetections(rawDetections, dedupeMeters)

  const coverageKm2 = approxTileCoverageKm2(grid.tiles.slice(0, analyzedTiles))
  const coveragePct = areaKm2 > 0 ? Math.min(100, (coverageKm2 / areaKm2) * 100) : 100
  const sampled = grid.sampled || failures.length > 0
  const coverageLine = sampled
    ? `Analyzed ${analyzedTiles}/${grid.tiles.length} tiles at z${grid.z} — ~${coveragePct.toFixed(0)}% of AOI sampled (representative subset, not a full census)`
    : `Analyzed ${analyzedTiles}/${grid.tiles.length} tiles at z${grid.z} — full AOI coverage at this resolution`

  const provenance: Provenance = {
    source: `Esri World Imagery + ${spec.provider}:${spec.id}${spec.license ? ` (${spec.license})` : ''}`,
    method:
      `tiled detection via the ${spec.provider} adapter · model registered from ${source} · ` +
      `z${grid.z} · ${analyzedTiles} tiles · confidence ≥ ${confidence.toFixed(2)}` +
      `${sampled ? ' · spatial subsample' : ''}`,
    clip: 'polygon',
    ...(spec.resolutionLimit ? { resolution_limit: spec.resolutionLimit } : {}),
  }

  const limitNote = spec.resolutionLimit ? `\n\n_Model limits (as declared): ${spec.resolutionLimit}_` : ''
  const partialNote = failures.length
    ? `\n\n${failures.length} tile(s) failed and were excluded from coverage. First error: ${failures[0]}`
    : ''

  if (detections.length === 0) {
    return {
      summary:
        `Model **${spec.id}** (${spec.provider}) found **0 detections** across the AOI.\n\n` +
        `${coverageLine}.${partialNote}${limitNote}\n\n` +
        `_Source: ${provenance.source} · confidence: low (no positives)_`,
      summary_data: { detection_count: 0, coverage_pct: Number(coveragePct.toFixed(0)), model: spec.id },
      sources: [provenance.source],
    }
  }

  const features = detections.map((d) => {
    const color = d.confidence > 0.8 ? '#22c55e' : d.confidence > 0.6 ? '#f59e0b' : '#ef4444'
    const props = {
      label: d.class,
      confidence: Math.round(d.confidence * 1000) / 1000,
      source: `${spec.provider}:${spec.id}`,
      color,
      fill: color,
      tile_z: d.tile.z,
    }
    return { type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: d.polygon } }
  })

  const layerConfidence: Confidence = sampled ? 'low' : 'medium'
  const byClass = detections.reduce<Record<string, number>>((acc, d) => {
    acc[d.class] = (acc[d.class] ?? 0) + 1
    return acc
  }, {})

  return {
    summary:
      `Model **${spec.id}** (${spec.provider}, registered from ${source}) detected ` +
      `**${detections.length} object(s)**: ${Object.entries(byClass).map(([c, n]) => `${n} × ${c}`).join(', ')}.\n\n` +
      `**Coverage:** ${coverageLine}.${partialNote}${limitNote}\n\n` +
      `_Source: ${provenance.source} · confidence: ${layerConfidence}_`,
    summary_data: {
      detection_count: detections.length,
      coverage_pct: Number(coveragePct.toFixed(0)),
      model: spec.id,
      provider: spec.provider,
    },
    layer: {
      id: `cv-${spec.id}-${genId()}`,
      name: `${spec.id} (${detections.length})`,
      type: 'geojson',
      geojson: { type: 'FeatureCollection', features },
      provenance,
      confidence: layerConfidence,
    },
  }
}

/**
 * ISS-111 — the SSE contract fixture, and nothing else.
 *
 * This used to be a tool the model could call. It advertised "Render data as a
 * named map layer" and returned `{ id, name, type }` with **no geojson, no
 * tiles and no data** — a layer shell that renders nothing, plus a summary
 * telling the LLM it had rendered something. The agent would then cite it.
 *
 * It is not offered to the model any more (the registry marks it `modelFacing: false`), and it is not
 * implemented either, because there is no honest implementation: a tool that
 * renders whatever the model hands it renders invented geometry. Every layer on
 * the map comes from the tool that measured it.
 *
 * What remains is its one legitimate use — the offline SSE contract test needs a
 * network-free tool that emits a real `layer` event so the event ordering
 * (plan → tool_call → layer → done) can be checked hermetically. So the registry gates it
 * behind `AGENT_ALLOW_STUB=1`, the same flag that unlocks the stub provider it
 * exists to serve, and it emits the **AOI the user actually drew** rather than
 * an empty shell — real geometry, correctly labelled as a test fixture.
 */
export async function renderToMap(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const geom = ctx.aoi?.type === 'Feature' ? ctx.aoi.geometry : ctx.aoi?.geometry ?? ctx.aoi
  const name = String(args.name || 'Contract Test Layer')
  // `fixture: 'fields'` (stub only): a 3x2 grid of fake parcels with numeric + text
  // properties, so the style_layer / make_chart path can be driven end to end offline.
  if (args.fixture === 'fields') {
    const [w, s, e, n] = ctx.bbox
    const crops = ['maize', 'wheat', 'soy']
    const ndvi = [0.31, 0.47, 0.58, 0.66, 0.74, 0.82]
    const features = ndvi.map((v, i) => {
      const x0 = w + ((i % 3) * (e - w)) / 3 + (e - w) * 0.02
      const x1 = w + (((i % 3) + 1) * (e - w)) / 3 - (e - w) * 0.02
      const y0 = s + (Math.floor(i / 3) * (n - s)) / 2 + (n - s) * 0.03
      const y1 = s + ((Math.floor(i / 3) + 1) * (n - s)) / 2 - (n - s) * 0.03
      return {
        type: 'Feature' as const,
        properties: { name: `Field ${String.fromCharCode(65 + i)}`, crop: crops[i % 3], ndvi: v, area_ha: 4 + i },
        geometry: { type: 'Polygon' as const, coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
      }
    })
    return {
      summary: `SSE contract fixture: ${features.length} fake parcels with ndvi, crop and area_ha properties (AGENT_ALLOW_STUB=1; not an analysis).`,
      layer: {
        id: `fields-${genId()}`,
        name,
        type: 'geojson',
        geojson: { type: 'FeatureCollection', features },
        bounds: ctx.bbox,
        confidence: 'low',
        provenance: { source: 'none — SSE contract test fixture', method: 'synthetic parcels', clip: 'bbox' },
      },
    }
  }
  return {
    summary:
      `SSE contract fixture: emitted the drawn AOI as layer "${name}". ` +
      `This is a test path (AGENT_ALLOW_STUB=1), not an analysis — it measures nothing.`,
    layer: {
      id: `render-${genId()}`,
      name,
      type: 'geojson',
      geojson: {
        type: 'FeatureCollection',
        features: geom
          ? [{ type: 'Feature' as const, properties: { fixture: true }, geometry: geom }]
          : [],
      },
      bounds: ctx.bbox,
      confidence: 'low',
      provenance: {
        source: 'none — SSE contract test fixture',
        method: 'echoes the drawn AOI polygon so the layer event carries real geometry',
        clip: 'polygon',
      },
    },
  }
}
