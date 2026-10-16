/**
 * Q-08 — the one place API input is validated (zod 4).
 *
 * Every route parses its body, route params and query string through a schema from this module
 * and answers a bad request with the same shape:
 *
 *     400 { error: 'invalid_request', issues: [{ path: 'aoi.coordinates.0', message: '…' }] }
 *
 * A body over its byte cap is `413 { error: 'payload_too_large', max_bytes }`; a body that is not
 * JSON is `400 { error: 'invalid_json' }`. Nothing is run for a request that fails here.
 *
 * AOI geometry is normalised once, in `AoiSchema`: a GeoJSON Feature or single-feature
 * FeatureCollection is unwrapped to its bare Polygon / MultiPolygon, so everything downstream sees
 * a geometry (Q-05). Pure and framework-free apart from `Request` / `Response`, so the schemas can
 * also be used on the client.
 */

import { z } from 'zod'

import { FAMILY_IDS } from '@/app/api/agent/investigator/catalogue'

import { isValidShareToken } from './projects'
import { QUICK_LAYER_IDS } from './quick-layers'

// ── Failure responses ────────────────────────────────────────────────────────────────────────

export interface ApiIssue {
  path: string
  message: string
}

export function issuesOf(error: z.ZodError): ApiIssue[] {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
}

/** 400 with the field errors. */
export function invalidRequest(issues: ApiIssue[]): Response {
  return Response.json({ error: 'invalid_request', issues }, { status: 400 })
}

// ── Body reading (size cap + JSON) ───────────────────────────────────────────────────────────

/** Byte caps per route family. A request over its cap is refused before it is parsed. */
export const BODY_LIMITS = {
  /** /api/agent: the AOI, the query and the reusable-layer manifest (feature rows included). */
  agent: 4 * 1024 * 1024,
  /** /api/investigate: an AOI and a short question. */
  investigate: 1024 * 1024,
  quickLayer: 256 * 1024,
  /** A saved project carries layer GeoJSON and raster images. */
  project: 32 * 1024 * 1024,
  /** /api/jobs: up to MAX_JOBS_PER_BATCH polygons with their arguments. */
  jobs: 8 * 1024 * 1024,
  small: 16 * 1024,
} as const

export type BodyResult<T> = { ok: true; data: T } | { ok: false; response: Response }

const tooLarge = (max: number): Response =>
  Response.json({ error: 'payload_too_large', max_bytes: max }, { status: 413 })

/** Read the raw body, refusing as soon as it exceeds `max` bytes (the declared length is checked
 *  first, the bytes actually received after, so a lying or absent Content-Length cannot get past). */
async function readCapped(req: Request, max: number): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) return { ok: false, response: tooLarge(max) }
  if (!req.body) return { ok: true, text: '' }
  const reader = req.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > max) {
      await reader.cancel().catch(() => {})
      return { ok: false, response: tooLarge(max) }
    }
    text += decoder.decode(value, { stream: true })
  }
  return { ok: true, text: text + decoder.decode() }
}

/** Parse a JSON body against `schema`. `optional` accepts an empty body as `{}`. */
export async function parseBody<S extends z.ZodType>(
  req: Request,
  schema: S,
  opts: { max: number; optional?: boolean },
): Promise<BodyResult<z.output<S>>> {
  const raw = await readCapped(req, opts.max)
  if (!raw.ok) return raw
  let json: unknown = {}
  if (raw.text.trim() === '') {
    if (!opts.optional) {
      return { ok: false, response: Response.json({ error: 'invalid_json', message: 'The request body must be JSON.' }, { status: 400 }) }
    }
  } else {
    try {
      json = JSON.parse(raw.text)
    } catch {
      return { ok: false, response: Response.json({ error: 'invalid_json', message: 'The request body is not valid JSON.' }, { status: 400 }) }
    }
  }
  return validate(schema, json)
}

/** Validate any already-parsed input (route params, query string) against `schema`. */
export function validate<S extends z.ZodType>(schema: S, input: unknown): BodyResult<z.output<S>> {
  const parsed = schema.safeParse(input)
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, response: invalidRequest(issuesOf(parsed.error)) }
}

/** A query string as a plain object: repeated keys become arrays. */
export function queryObject(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key)
    out[key] = all.length > 1 ? all : all[0]
  }
  return out
}

// ── AOI geometry ─────────────────────────────────────────────────────────────────────────────

/** Unwrap a GeoJSON Feature / FeatureCollection (first feature) to its bare geometry; a bare
 *  geometry and falsy input pass through unchanged. */
export function toGeometry(input: any): any {
  if (input?.type === 'Feature') return input.geometry ?? null
  if (input?.type === 'FeatureCollection') return toGeometry(input.features?.[0])
  return input
}

/** A drawn area is a few hundred vertices; this stops a payload that is one giant ring. */
const MAX_VERTICES = 20_000

const Lon = z.number().finite().min(-180).max(180)
const Lat = z.number().finite().min(-90).max(90)
const Position = z.tuple([Lon, Lat]).rest(z.number().finite())
const Ring = z.array(Position).min(4, 'a ring needs at least 4 positions')
const PolygonCoords = z.array(Ring).min(1)

const PolygonGeometry = z.object({ type: z.literal('Polygon'), coordinates: PolygonCoords })
const MultiPolygonGeometry = z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(PolygonCoords).min(1) })
const PointGeometry = z.object({ type: z.literal('Point'), coordinates: Position })

const countVertices = (g: { type: string; coordinates: unknown }): number =>
  (g.coordinates as unknown[]).flat(g.type === 'MultiPolygon' ? 2 : 1).length

/** Unwrap a Feature / FeatureCollection before validating. A FeatureCollection must hold exactly
 *  one feature: silently analysing the first of several would answer a different question. */
const unwrapped = (input: unknown, ctx: z.RefinementCtx): unknown => {
  const fc = input as { type?: unknown; features?: unknown } | null
  if (fc?.type === 'FeatureCollection' && (!Array.isArray(fc.features) || fc.features.length !== 1)) {
    ctx.addIssue({ code: 'custom', message: 'a FeatureCollection AOI must contain exactly one Feature (use a MultiPolygon for several areas)' })
    return z.NEVER
  }
  const geometry = toGeometry(input)
  if (geometry === null || geometry === undefined) {
    ctx.addIssue({ code: 'custom', message: 'the AOI has no geometry' })
    return z.NEVER
  }
  return geometry
}

/** The area to analyse: a Polygon or MultiPolygon, given bare or inside a Feature /
 *  FeatureCollection, always yielding the bare geometry. A Point has no area, so it is refused. */
export const AoiSchema = z
  .unknown()
  .transform(unwrapped)
  .pipe(
    z
      .discriminatedUnion('type', [PolygonGeometry, MultiPolygonGeometry], {
        error: 'the AOI must be a GeoJSON Polygon or MultiPolygon (a Point has no area to analyse)',
      })
      .refine((g) => countVertices(g) <= MAX_VERTICES, `the AOI has more than ${MAX_VERTICES} vertices`),
  )
export type Aoi = z.output<typeof AoiSchema>

/** Any geometry a saved project's AOI may hold (the same, plus a Point), bare or wrapped. */
export const GeometrySchema = z
  .unknown()
  .transform(unwrapped)
  .pipe(z.discriminatedUnion('type', [PolygonGeometry, MultiPolygonGeometry, PointGeometry]))

// ── /api/agent ───────────────────────────────────────────────────────────────────────────────

/** Longest question accepted. */
export const QUERY_MAX_CHARS = 4000

/** Providers a request may name. `default` defers to the server; `stub` is test-only and is
 *  refused at the LLM layer unless the server sets AGENT_ALLOW_STUB=1. */
export const PROVIDER_IDS = ['default', 'claude', 'openai', 'gemini', 'ollama', 'custom', 'stub'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]
export const ProviderSchema = z.enum(PROVIDER_IDS)

const Text = (max: number) => z.string().max(max)
const Json = z.record(z.string(), z.unknown())

/** A clicked point (P4.3). */
export const FocusSchema = z.object({
  lat: Lat,
  lng: Lon,
  kind: z.literal('point').optional(),
})

export const MAX_MANIFEST_LAYERS = 24
export const MAX_SUMMARY_FIELDS = 16

/** A layer already on the map that the agent may reuse (P4.4). */
export const ManifestLayerSchema = z.object({
  result_id: Text(128).min(1),
  tool: Text(100).min(1),
  name: Text(300).optional(),
  provenance: Json.optional(),
  confidence: Text(20).optional(),
  summary_data: Json.optional(),
  layer_id: Text(128).optional(),
  feature_rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(5000).optional(),
})

/** User-registered perception models: JSON text from the Settings field, or the parsed array.
 *  Each spec is validated field by field by `parseModelSpecList`; this only bounds the input. */
export const CustomModelsSchema = z.union([Text(64 * 1024), z.array(Json).max(50)])

export const AgentRequestSchema = z.object({
  aoi: AoiSchema,
  query: z.string().trim().min(1, 'the question is empty').max(QUERY_MAX_CHARS, `the question is longer than ${QUERY_MAX_CHARS} characters`),
  lang: Text(35).optional(),
  focus: FocusSchema.optional(),
  layers: z.array(ManifestLayerSchema).optional(),
  aiProvider: ProviderSchema.optional(),
  aiApiKey: Text(512).optional(),
  aiBaseUrl: Text(2048).optional(),
  aiModel: Text(200).optional(),
  customModels: CustomModelsSchema.optional(),
})
export type AgentRequest = z.output<typeof AgentRequestSchema>

// ── /api/investigate ─────────────────────────────────────────────────────────────────────────

/** A window date: a day, a month (widened to its first or last day) or a year. */
const WindowDate = z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'use YYYY, YYYY-MM or YYYY-MM-DD')

/** Body of `POST /api/investigate`: an area, and optionally what to explain, when, and which kind
 *  of change it is. With neither a question nor a family the area is scanned for where to look. */
export const InvestigateRequestSchema = z.object({
  aoi: AoiSchema,
  question: z.string().trim().max(QUERY_MAX_CHARS, `the question is longer than ${QUERY_MAX_CHARS} characters`).optional(),
  window: z.object({ start: WindowDate, end: WindowDate }).optional(),
  family: z.enum(FAMILY_IDS).optional(),
  aiProvider: ProviderSchema.optional(),
  aiApiKey: Text(512).optional(),
  aiBaseUrl: Text(2048).optional(),
  aiModel: Text(200).optional(),
})
export type InvestigateRequest = z.output<typeof InvestigateRequestSchema>

// ── /api/quick-layer ─────────────────────────────────────────────────────────────────────────

/** Body of `POST /api/quick-layer`: which quick layer, over which drawn area. */
export const QuickLayerRequestSchema = z.object({
  op: z.enum(QUICK_LAYER_IDS),
  aoi: AoiSchema,
})
export type QuickLayerRequest = z.output<typeof QuickLayerRequestSchema>

// ── Projects ─────────────────────────────────────────────────────────────────────────────────

export const MAX_PROJECT_LAYERS = 64
export const MAX_PROJECT_MESSAGES = 500

const ProjectAoiSchema = z.object({
  type: z.enum(['Polygon', 'Rectangle', 'Circle', 'Freehand']),
  geometry: GeometrySchema,
  center: z.object({ lat: Lat, lng: Lon }).optional(),
  radiusKm: z.number().finite().nonnegative().optional(),
})

export const ProjectLayerSchema = z.object({
  id: Text(200).min(1),
  name: Text(300),
  type: z.enum(['raster', 'geojson', '3dtiles', 'heatmap']),
  tileUrl: Text(8192).optional(),
  geojson: z.object({ type: z.literal('FeatureCollection'), features: z.array(z.unknown()) }).loose().optional(),
  imageBase64: Text(16 * 1024 * 1024).optional(),
  color: Text(64).optional(),
  intensityProperty: Text(200).optional(),
  render: z.literal('extrusion').optional(),
  heightProperty: Text(200).optional(),
  bounds: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
  palette: Json.optional(),
  provenance: Json.optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  resultId: Text(128).optional(),
  tool: Text(100).optional(),
  summaryData: Json.optional(),
  aoiKey: Text(2048).optional(),
  opacity: z.number().finite().min(0).max(1),
  visible: z.boolean(),
})

export const ProjectMessageSchema = z.object({
  id: Text(200).min(1),
  role: z.enum(['user', 'assistant']),
  content: Text(200_000),
  resultId: Text(128).optional(),
  toolResults: z.array(z.unknown()).max(200).optional(),
})

const projectFields = {
  name: Text(200),
  aoi: ProjectAoiSchema.nullable(),
  mapStyle: Text(64),
  layers: z.array(ProjectLayerSchema).max(MAX_PROJECT_LAYERS, `a project holds at most ${MAX_PROJECT_LAYERS} layers`),
  messages: z.array(ProjectMessageSchema).max(MAX_PROJECT_MESSAGES, `a project holds at most ${MAX_PROJECT_MESSAGES} messages`),
}

/** `POST /api/projects`. Every field is optional, but something must be worth saving. */
export const ProjectCreateSchema = z
  .object(projectFields)
  .partial()
  .refine((p) => !!p.aoi || (p.layers?.length ?? 0) > 0 || (p.messages?.length ?? 0) > 0, {
    message: 'Nothing to save — draw an AOI or run an analysis first.',
  })

/** `PATCH /api/projects/:id`: only the fields present are changed (layers / messages are replaced whole). */
export const ProjectPatchSchema = z.object(projectFields).partial()

// ── Route params, query strings ──────────────────────────────────────────────────────────────

const Slug = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be 1-64 letters, digits, "_" or "-"')

export const ProjectIdParams = z.object({ id: Slug })
export const RunIdParams = z.object({ runId: Slug })
export const CaseIdParams = z.object({ id: Slug })

/** `GET /api/ledger` and `GET /api/jobs`: newest first, `limit` per page, `cursor` = the last id of the previous page. */
export const ListQuerySchema = z.object({
  limit: z.string().regex(/^\d{1,3}$/, 'must be an integer').transform(Number).pipe(z.number().min(1).max(100)).default(20),
  cursor: Slug.optional(),
})

// ── GET /api/scenes ─────────────────────────────────────────────────────────────────────────

const IsoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, 'must be a real calendar date')

/** `bbox=west,south,east,north` in degrees, no wider than an analysis area may be. */
const BboxParam = z
  .string()
  .regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/, 'must be west,south,east,north in decimal degrees')
  .transform((s) => s.split(',').map(Number) as [number, number, number, number])
  .pipe(
    z
      .tuple([Lon, Lat, Lon, Lat])
      .refine(([w, s, e, n]) => w < e && s < n, 'west must be less than east and south less than north')
      .refine(([w, s, e, n]) => (e - w) * Math.cos((((s + n) / 2) * Math.PI) / 180) * 111.32 * (n - s) * 110.57 <= 5000, 'the area is larger than 5,000 km2; draw a smaller one'),
  )

/** The scene catalogue over an area: one sensor, an optional window and cloud ceiling, the scenes
 *  oldest first (or newest), `limit` per page, `cursor` = how many came before (the previous `next`). */
export const ScenesQuerySchema = z
  .object({
    bbox: BboxParam,
    sensor: z.enum(['sentinel-2', 'landsat', 'sentinel-1']).default('sentinel-2'),
    from: IsoDay.optional(),
    to: IsoDay.optional(),
    maxCloud: z.string().regex(/^\d{1,3}(\.\d+)?$/, 'must be a number from 0 to 100').transform(Number).pipe(z.number().min(0).max(100)).default(100),
    order: z.enum(['asc', 'desc']).default('asc'),
    group: z.enum(['day', 'scene']).default('day'),
    render: z.enum(['true_colour', 'ndvi']).default('true_colour'),
    limit: z.string().regex(/^\d{1,3}$/, 'must be an integer').transform(Number).pipe(z.number().min(1).max(250)).default(60),
    cursor: z.string().regex(/^\d{1,6}$/, 'must be the next value of the previous page').transform(Number).default(0),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: '`from` is after `to`', path: ['from'] })
export type ScenesQuery = z.output<typeof ScenesQuerySchema>

/** POST /api/cases (Q-27): a claim type (`id` or `id@semver`), its parameters, and the plot. The
 *  parameters are checked against the recipe's own schema when the case runs. */
const ClaimTypeSchema = z.string().regex(/^[a-z][a-z0-9_]*(@\d+\.\d+\.\d+)?$/, 'a claim type such as not_cleared_since or flooded_on@1.0.0')
const ClaimParamsSchema = z.record(z.string(), z.union([z.string().max(64), z.number().finite()]))
const PlotSchema = AoiSchema.refine((g) => g.type === 'Polygon', 'the plot must be a single Polygon')

export const CaseCreateSchema = z.object({
  claim_type: ClaimTypeSchema,
  params: ClaimParamsSchema.default({}),
  geometry: PlotSchema,
}).strict()

/** POST /api/cases/batch (Q-28): one claim type and shared parameters for N plots. A plot's own
 *  `params` (e.g. a `date` column of the uploaded file) override the shared ones for that plot. Each
 *  plot's parameters are checked against the recipe before anything is queued. */
export const MAX_BATCH_PLOTS = 500
export const CaseBatchSchema = z.object({
  claim_type: ClaimTypeSchema,
  params: ClaimParamsSchema.default({}),
  label: z.string().trim().max(200).optional(),
  plots: z.array(z.object({
    name: z.string().trim().max(120).optional(),
    geometry: PlotSchema,
    params: ClaimParamsSchema.optional(),
  }).strict()).min(1).max(MAX_BATCH_PLOTS),
}).strict()

/** GET /api/cases/batch/:id/export?format= */
export const BatchExportQuery = z.object({ format: z.enum(['csv', 'geojson', 'kml', 'shapefile']).default('csv') })
export const ResultIdParams = z.object({ resultId: Slug })
export const ShareTokenParams = z.object({
  token: z.string().refine(isValidShareToken, 'not a share token'),
})

/** `POST /api/ledger/:runId/rerun` takes no options today; an empty body is the request. */
export const RerunBodySchema = z.object({}).strict()

/** `GET /api/operations[?name=<operation>]`. */
export const OperationsQuerySchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'must be an operation name such as fetch_ndvi').optional(),
})

const int = (max: number) => z.string().regex(/^\d{1,8}$/, 'must be a non-negative integer').transform(Number).pipe(z.number().max(max))

/** `GET /api/geo/tiles/:id/:z/:x/:y?rescale&colormap_name&bidx`. Only a composite id, a tile inside
 *  the zoom's range and the three style params the geo service understands pass, so the route
 *  cannot be turned into an open proxy. */
export const GEO_TILE_MAX_ZOOM = 24
export const GeoTileParamsSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{24}$/, 'must be a 24-character composite id'),
    z: int(GEO_TILE_MAX_ZOOM),
    x: int(2 ** GEO_TILE_MAX_ZOOM),
    y: int(2 ** GEO_TILE_MAX_ZOOM),
  })
  .refine((p) => p.x < 2 ** p.z && p.y < 2 ** p.z, { message: 'x and y must be below 2^z', path: ['x'] })

export const GeoTileQuerySchema = z.object({
  rescale: z
    .string()
    .regex(/^-?\d+(\.\d+)?(e-?\d+)?,-?\d+(\.\d+)?(e-?\d+)?$/i, "must be 'min,max'")
    .optional(),
  colormap_name: z.string().regex(/^[A-Za-z0-9_]{1,40}$/, 'must be a colormap name').optional(),
  bidx: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .pipe(z.array(z.string().regex(/^[1-9]$/, 'must be a band index 1-9')).max(9))
    .optional(),
})

// ── Upload ───────────────────────────────────────────────────────────────────────────────────

/** Metadata of an uploaded file, as the multipart form reports it. The extension / content-type /
 *  size policy is `validateUpload` (lib/upload.ts); this checks the field itself is a file. */
export const UploadFormSchema = z.object({
  file: z.custom<File>((v) => typeof File !== 'undefined' && v instanceof File, 'a `file` field holding the GeoTIFF/COG is required'),
})
export const UploadFileMetaSchema = z.object({
  name: z.string().min(1, 'the file has no name').max(255, 'the file name is longer than 255 characters'),
  size: z.number().int().positive('the file is empty'),
})

// ---------------------------------------------------------------------------
// /api/jobs (Q-24)
// ---------------------------------------------------------------------------

export const MAX_JOBS_PER_BATCH = 500

/** POST /api/jobs: one job per entry, an operation, its arguments and the polygon to run it on. */
export const CreateJobsBodySchema = z.object({
  label: z.string().trim().max(200).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  jobs: z.array(z.object({
    op: z.string().min(1).max(100),
    args: z.record(z.string(), z.unknown()).default({}),
    aoi: AoiSchema,
  })).min(1).max(MAX_JOBS_PER_BATCH),
})
