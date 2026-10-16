/** Computer-vision detectors (parked behind GEOAGENT_ENABLE_CV=1) and the offline SSE fixture. */

import { z } from 'zod'

import { renderToMap, runCvDetector } from '../../tools/other'
import { detectObjects, segmentFeature } from '../../tools/inference'
import { allowStub, isCvEnabled } from '../flags'
import { defineOperation, type AnyOperation } from '../operation'

export const cvOps: AnyOperation[] = [
  defineOperation({
    name: 'run_cv_detector',
    label: 'Running CV Detection...',
    version: '1.0.0',
    description: 'Run aerial-trained computer vision across the WHOLE AOI to count and locate objects from satellite imagery. Tiles the AOI into Esri World Imagery tiles (z17–18), runs inference per tile (Roboflow if ROBOFLOW_API_KEY is set, otherwise local ONNX YOLO for the three priority models), georeferences each detection, then merges + dedupes across tile seams. Returns: a real total count, per-detection confidence, coverage labeling ("analyzed N tiles, ~X% of AOI"), and points (for small repeated objects like solar panels / manholes) or polygons (for structures / roads / water). Honest when the AOI exceeds the tile budget. Available models: solar_panel (counts panels — key-free ONNX available), informal_struct (unmapped buildings — key-free ONNX available), road_damage (potholes/distress — key-free ONNX available), manhole, water_channel, roof_material. For open-vocabulary detection ("find every X") use `detect_objects` instead — this tool runs a SPECIFIC named model.',
    params: z.object({
      model: z.string().describe('Detection model to use. solar_panel, informal_struct, road_damage work without any API key (ONNX path). Others require ROBOFLOW_API_KEY. Built-in: manhole, informal_struct, road_damage, water_channel, solar_panel, roof_material; or the id of a model registered in Settings.'),
      confidence: z.number().optional().describe('Min prediction confidence (0–1). Lower → more detections, more false positives. Default 0.30–0.35 depending on model.'),
      provider: z.enum(['auto', 'roboflow', 'onnx']).optional().describe('Inference provider override. "auto" (default) picks Roboflow if a key is set, else local ONNX for the three priority models. "roboflow" forces Roboflow. "onnx" forces local ONNX.'),
    }),
    output: 'vector',
    sensors: ['esri-world-imagery'],
    resolution_m: 0.5,
    limits: { maxAreaKm2: 100 },
    cost: { typicalSeconds: 40 },
    // Not cached: model inference: the model version is not part of the content hash yet.
    limitations: [
      'Runs a SPECIFIC named detector over Esri World Imagery tiles; coverage is the tile budget, reported as "analyzed N tiles, ~X% of AOI".',
      'Only models that are installed run; one that is not installed is reported as such, not as zero detections.',
      'Roboflow models need ROBOFLOW_API_KEY.',
    ],
    confidence: 'per-detection model confidence; not a calibrated probability.',
    enabled: isCvEnabled,
    run: (ctx, args) => runCvDetector(ctx, args),
  }),
  defineOperation({
    name: 'detect_objects',
    label: 'Detecting objects (target profile → imagery plan → detector ladder)...',
    version: '1.0.0',
    description: 'THE object-detection tool. Finds any physical object named in plain words across the AOI and returns georeferenced GeoJSON polygons. Runs a four-stage pipeline: sizes the target, picks the coarsest imagery that still resolves it (probing the provider for the real per-location ceiling), then walks a detector ladder (A curated aerial model → B open-vocabulary SAM2+CLIP → C indirect evidence). Free and key-free: the curated aerial detector runs on local ONNX weights. Crucially it distinguishes three different answers that all look like "0": the imagery cannot resolve this object, a detector failed, and a detector looked and found none. When it cannot resolve the target it says so AND names the imagery resolution that would. Examples: "car", "aircraft", "swimming pool", "storage tank", "ship", "water tower".',
    params: z.object({
      target: z.string().describe('The object to find, as a plain singular noun phrase: "car", "swimming pool", "aircraft", "solar panel". Not a prompt string — do not use dot-separated class lists.'),
      footprint_m: z.array(z.number()).optional().describe('Optional [long, short] size of ONE such object in metres. Supply your own best estimate whenever the target is unusual (e.g. "grain silo" → [12, 12]); the pipeline uses it to decide whether any available imagery can resolve the object. Common targets (car, house, pool, aircraft, …) are already sized — omit it for those.'),
    }),
    output: 'vector',
    sensors: ['esri-world-imagery'],
    resolution_m: 0.5,
    limits: { maxAreaKm2: 100 },
    cost: { typicalSeconds: 60 },
    // Not cached: model inference: the model version is not part of the content hash yet.
    limitations: [
      'Distinguishes three answers that all look like zero: imagery too coarse to resolve the target, a detector failed, a detector ran and found none.',
      'Provider imagery has a per-location resolution ceiling; below the detector\'s minimum pixel size the answer is "cannot resolve", never "none".',
      'Large AOIs are sampled, not censused, and the output says so.',
    ],
    confidence: 'per-detection model confidence plus the ladder tier that answered (A curated aerial model, B open-vocabulary, C indirect evidence).',
    enabled: isCvEnabled,
    run: (ctx, args) => detectObjects(ctx, args),
  }),
  defineOperation({
    name: 'segment_feature',
    label: 'Tracing feature outline (SAM2)...',
    version: '1.0.0',
    description: 'Promptable segmentation via SAM2. Given a point, returns the actual OUTLINE of the object there as a GeoJSON polygon — the real mask boundary (typically 100–400 vertices), not a bounding box. Picks the finest imagery that still frames the whole feature (~150 m), and reports the vertex count, enclosed area and the boundary detail the resolution supports. Needs ROBOFLOW_API_KEY (free tier); says so plainly rather than returning a guessed shape. Use for "outline this", "delineate this feature", "trace the boundary of this", "segment this field/lake/building". Pairs with detect_objects (detect first, then segment one). The geometry is real; the LABEL is whatever you pass — SAM2 segments shapes, it does not name them.',
    params: z.object({
      lat: z.number().optional().describe('Latitude of the prompt point (decimal degrees). Defaults to AOI centroid.'),
      lon: z.number().optional().describe('Longitude of the prompt point (decimal degrees). Defaults to AOI centroid.'),
      label: z.string().optional().describe('Human-readable label for the segmented feature (e.g. "Field boundary", "Lake outline").'),
    }),
    output: 'vector',
    sensors: ['esri-world-imagery'],
    resolution_m: 0.5,
    limits: { maxAreaKm2: 25 },
    cost: { typicalSeconds: 15 },
    // Not cached: model inference: the model version is not part of the content hash yet.
    limitations: [
      'Segments a shape around a point; it does not name what it outlined (the label is whatever the caller passes).',
      'Needs ROBOFLOW_API_KEY and says so instead of returning a guessed shape.',
    ],
    confidence: 'the mask boundary is real; what it is, is the caller\'s label.',
    enabled: isCvEnabled,
    run: (ctx, args) => segmentFeature(ctx, args),
  }),
  defineOperation({
    name: 'render_to_map',
    label: 'Emitting the SSE contract fixture layer...',
    version: '1.0.0',
    description: 'Offline SSE-contract fixture: emits a named layer from built-in geometry. Never offered to the model.',
    params: z.object({
      name: z.string().optional(),
      data_type: z.string().optional(),
      fixture: z.string().optional(),
    }),
    output: 'vector',
    cost: { typicalSeconds: 1 },
    // Not cached: reads this request's own results, not only its arguments.
    limitations: [
      'Built-in fixture geometry only; it measures nothing and exists to test the event stream.',
    ],
    confidence: 'not applicable: not a measurement.',
    enabled: allowStub,
    modelFacing: false,
    run: (ctx, args) => renderToMap(ctx, args),
  }),
]
