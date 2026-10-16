/** Inference model registry + resolution-honesty core.
 *
 *  Pure module — no I/O, no process.env reads. Every export is unit-testable
 *  without mocking. The gateway (gateway.ts) and provider clients import from here.
 */

// ---------------------------------------------------------------------------
// Provider + output types (shared with gateway + providers)
// ---------------------------------------------------------------------------

/** The inference backends the gateway supports, plus the "none" sentinel.
 *
 *  `huggingface` was removed (ISS-104). HF serverless serves none of these
 *  models — `grounding-dino-tiny`, `grounding-dino-base`, `sam2-hiera-large`,
 *  `owlv2` and `clip-vit-base-patch32` all report an `inferenceProviderMapping`
 *  with zero providers (verified 2026-08-09, re-verified 2026-08-10). Keeping it
 *  in the auto-order actively harmed routing: HF_API_TOKEN is set on a normal
 *  install so local-onnx can DOWNLOAD weights, and that made the gateway pick a
 *  backend that runs nothing while a working provider sat further down the list.
 *
 *  HF's real role is weight hosting for the `local-onnx` provider in
 *  `inference/model-spec.ts`. */
export type InferenceProvider = 'none' | 'replicate' | 'selfhosted'

/** Providers that can actually serve a request (excludes 'none'). */
export type ConfiguredProvider = Exclude<InferenceProvider, 'none'>

/** Normalized output returned by every provider client. */
export interface NormalizedOutput {
  /** Georeferenced detections / segments as GeoJSON FeatureCollection. */
  geojson?: any
  /** PNG raster mask as base64 data URL or raw base64 string (HF segmentation). */
  maskPng?: string
  /** Public URL to a mask PNG (Replicate output — caller fetches + converts if needed). */
  maskUrl?: string
  /** Classification / label strings, formatted "label:score" or plain "label". */
  labels?: string[]
  /** Human-readable "provider:route" provenance string. */
  provenance: string
  /** 0–1 confidence score. */
  confidence: number
  /** Honest resolution-capability note (from the ModelEntry). */
  resolution_limit: string
}

/** Returned by runInference() when no backend is available or the model is unknown. */
export interface InferenceError {
  error: 'no_provider' | 'unknown_model' | 'provider_error'
  honestMessage: string
}

// ---------------------------------------------------------------------------
// Model registry types
// ---------------------------------------------------------------------------

export interface ModelEntry {
  /** Unique stable key used by tools to request this model. */
  key: string
  /** The model's primary capability class. */
  task: 'detect' | 'segment' | 'classify'
  /** Provider-specific routing identifiers (HF model id / Replicate slug / self-hosted path). */
  routes: Partial<Record<ConfiguredProvider, string>>
  /** The native resolution the model is most useful at, in meters/pixel. */
  inputResolutionM: number
  /** Honest statement of what this model can and cannot answer at its native resolution. */
  resolutionLimit: string
  /** Rough billing/latency tier. */
  costTier: 'free' | 'cheap' | 'gpu'
  /** Primary output format. */
  output: 'geojson' | 'mask' | 'labels'
}

// ---------------------------------------------------------------------------
// MODEL_REGISTRY — one entry per capability, sequenced by value + feasibility
// ---------------------------------------------------------------------------

export const MODEL_REGISTRY: Record<string, ModelEntry> = {
  grounding_dino: {
    key: 'grounding_dino',
    task: 'detect',
    routes: {
      replicate: 'adirik/grounding-dino',
      selfhosted: '/infer/grounding-dino',
    },
    inputResolutionM: 10,
    resolutionLimit:
      '10 m Sentinel-2: detects objects ≥ ~50 m² (large buildings, vehicles not resolvable). ' +
      'Box-level geometry — segment with SAM2 for polygon outlines. ' +
      'Misses classes it was not trained on; label confidence varies by scene.',
    costTier: 'cheap',
    output: 'geojson',
  },

  sam2: {
    key: 'sam2',
    task: 'segment',
    routes: {
      replicate: 'meta/sam-2',
      selfhosted: '/infer/sam2',
    },
    inputResolutionM: 1,
    resolutionLimit:
      'Produces geometry (polygon mask) from any resolution imagery. ' +
      'Labels must come from elsewhere (e.g. Grounding-DINO or user prompt). ' +
      'Minimum meaningful polygon at 10 m ≈ 1 ha (100 × 100 m).',
    costTier: 'cheap',
    output: 'mask',
  },

  veg_type: {
    key: 'veg_type',
    task: 'classify',
    routes: {
      selfhosted: '/infer/veg-type',
    },
    inputResolutionM: 10,
    resolutionLimit:
      '10 m Sentinel-2: functional vegetation type (broadleaf/needleleaf, evergreen/deciduous, ' +
      'open/closed canopy) and canopy NDVI — NOT species. ' +
      'Species identification requires sub-meter or hyperspectral imagery.',
    costTier: 'gpu',
    output: 'labels',
  },

  prithvi_flood: {
    key: 'prithvi_flood',
    task: 'segment',
    routes: {
      replicate: 'ibm-nasa-geospatial/prithvi-eo-2',
      selfhosted: '/infer/prithvi-flood',
    },
    inputResolutionM: 30,
    resolutionLimit:
      '30 m HLS (Harmonized Landsat Sentinel-2) input: flood/burn-scar/crop segmentation. ' +
      'Minimum detectable patch ≈ 1 ha. Requires a task-specific fine-tuned head. ' +
      'Not available via HuggingFace Inference API (weights only).',
    costTier: 'gpu',
    output: 'mask',
  },
}

// ---------------------------------------------------------------------------
// assessResolution — the honesty core (pure, unit-tested)
// ---------------------------------------------------------------------------

export interface ResolutionAssessment {
  /** True when the data resolution is sufficient to honestly answer at this intent level. */
  canAnswer: boolean
  /** When canAnswer=false, the best intent level the data CAN honestly support. */
  downgradedTo?: string
  /** Human-readable explanation (quoted verbatim in agent analysis when present). */
  honestNote: string
}

interface ResolutionRule {
  /** Data must be at or finer than this (≤ minResolutionM) to fully answer. */
  minResolutionM: number
  /** What we CAN answer instead when the data is too coarse. */
  downgradedTo?: string
  /** Called with the actual data resolution to produce the honest note. */
  note: (actualM: number) => string
  /** Note when the data IS fine enough. */
  okNote: string
}

const RESOLUTION_RULES: Record<string, ResolutionRule> = {
  species: {
    minResolutionM: 1,
    downgradedTo: 'functional_type',
    note: (m) =>
      `Species identification requires sub-meter (<1 m) imagery; ` +
      `at ${m} m resolution, the honest answer is functional vegetation type ` +
      `(broadleaf/needleleaf, evergreen/deciduous, open/closed canopy, canopy NDVI). ` +
      `Sub-meter or hyperspectral imagery is required for species-level identification.`,
    okNote: 'Sub-meter imagery available; species-level identification is within scope.',
  },
  individual_tree: {
    minResolutionM: 5,
    downgradedTo: 'canopy_structure',
    note: (m) =>
      `Resolving individual tree crowns requires <5 m imagery; ` +
      `at ${m} m, can characterize canopy structure (height class, cover %, density) ` +
      `but cannot delineate individual crowns.`,
    okNote: 'Resolution sufficient to resolve individual tree crowns.',
  },
  buildings: {
    minResolutionM: 5,
    downgradedTo: 'built_area',
    note: (m) =>
      `ML delineation of individual building footprints requires <5 m imagery; ` +
      `at ${m} m, can estimate built-up area fraction — ` +
      `use query_osm for individual OSM-mapped building outlines.`,
    okNote: 'Resolution sufficient for ML-based individual building delineation.',
  },
  vehicles: {
    minResolutionM: 0.5,
    note: (m) =>
      `Vehicle detection requires sub-meter (<0.5 m) imagery; ` +
      `at ${m} m resolution this is not possible from satellite data.`,
    okNote: 'Sub-meter resolution sufficient for vehicle detection.',
  },
  road_damage: {
    minResolutionM: 2,
    downgradedTo: 'road_network',
    note: (m) =>
      `Road surface damage / pothole detection requires <2 m imagery; ` +
      `at ${m} m, can identify road network presence but not surface conditions.`,
    okNote: 'Resolution sufficient for road surface inspection.',
  },
  // Intents that work at Sentinel-2 10 m resolution
  functional_type: {
    minResolutionM: 30,
    note: (m) =>
      `Functional vegetation type requires ≤30 m imagery; ` +
      `at ${m} m this level of detail is not achievable.`,
    okNote:
      'Functional vegetation type (broadleaf/needleleaf, canopy cover, NDVI) ' +
      'is reliably determinable at 10 m Sentinel-2 resolution.',
  },
  land_cover: {
    minResolutionM: 30,
    note: (m) =>
      `Land cover classification requires ≤30 m imagery; at ${m} m this is not possible.`,
    okNote: 'Land cover classification works reliably at 10 m Sentinel-2 resolution.',
  },
  canopy_height: {
    minResolutionM: 30,
    note: (m) =>
      `Canopy height estimation requires ≤30 m imagery; at ${m} m this is not possible.`,
    okNote:
      'Canopy height estimation available via GEDI-derived products at ~25 m resolution.',
  },
  canopy_structure: {
    minResolutionM: 30,
    note: (m) =>
      `Canopy structure characterization requires ≤30 m imagery; at ${m} m this is not possible.`,
    okNote: 'Canopy structure (height class, cover %, density) is characterizable at 10 m resolution.',
  },
  flood_extent: {
    minResolutionM: 30,
    note: (m) =>
      `Flood extent mapping requires ≤30 m imagery; at ${m} m this is not possible.`,
    okNote: 'Flood extent mapping works at 10 m Sentinel-1 SAR resolution.',
  },
  burn_scar: {
    minResolutionM: 30,
    note: (m) =>
      `Burn scar detection requires ≤30 m imagery; at ${m} m this is not possible.`,
    okNote: 'Burn scar detection works at 10 m Sentinel-2 NBR resolution.',
  },
  built_area: {
    minResolutionM: 30,
    note: (m) =>
      `Built-up area estimation requires ≤30 m imagery; at ${m} m this is not possible.`,
    okNote: 'Built-up area fraction estimation works at 10 m (ESA WorldCover resolution).',
  },
  road_network: {
    minResolutionM: 30,
    note: (m) =>
      `Road network detection requires ≤30 m imagery; at ${m} m this is not possible.`,
    okNote: 'Road network detection works at 10 m resolution (combined with OSM).',
  },
  vegetation_cover: {
    minResolutionM: 30,
    note: (m) =>
      `Vegetation cover estimation requires ≤30 m imagery; at ${m} m this is not possible.`,
    okNote: 'Vegetation cover fraction is derivable from 10 m Sentinel-2 NDVI.',
  },
}

/**
 * Pure honesty assessment: given what the user wants to know (`intent`) and the
 * resolution of the data we actually have (`dataResolutionM`), return whether we
 * can honestly answer and — if not — what we CAN answer instead.
 *
 * This is the function that turns "species" into "functional type" at 10 m.
 * It is threaded into every inference tool result and into a prompt rule so the
 * agent never fabricates precision the data cannot support.
 */
export function assessResolution(intent: string, dataResolutionM: number): ResolutionAssessment {
  const key = intent.toLowerCase().replace(/[^a-z_]/g, '_')
  const rule = RESOLUTION_RULES[key]

  if (!rule) {
    // Unknown intent — conservative default: can answer, generic note
    return {
      canAnswer: true,
      honestNote:
        `No specific resolution constraint found for intent "${intent}" at ${dataResolutionM} m. ` +
        `Free tier uses 10 m Sentinel-2 (coarse for sub-5 m features). ` +
        `State any precision limits explicitly in your analysis.`,
    }
  }

  const canAnswer = dataResolutionM <= rule.minResolutionM
  if (canAnswer) {
    return { canAnswer: true, honestNote: rule.okNote }
  }
  return {
    canAnswer: false,
    downgradedTo: rule.downgradedTo,
    honestNote: rule.note(dataResolutionM),
  }
}
