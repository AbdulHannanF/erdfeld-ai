/** GeoResult — the one result every registered operation returns (ADR-0001 §4).
 *
 *  Shared by the server (the executor builds it) and the browser (it renders it), so this file
 *  is pure: zod and types only, no node APIs. Layers, charts and stats keep the shapes the map
 *  and chat already render; what this adds is the envelope that makes a result checkable:
 *  a content-addressed id, the operation@version that made it, provenance down to the data
 *  items, and the validation checks that ran before and after it.
 */

import { z } from 'zod'

import type { ResultLayer } from '@/app/api/agent/lib/types'
import type { ChartItem } from '@/lib/chart-spec'
import type { LegendItem, VectorStyle } from '@/lib/vector-style'

// zod probes `new Function('')` to JIT its object parsers; under the CSP (no 'unsafe-eval') that probe
// is reported as a violation. In the browser use the interpreter path from the start.
if (typeof window !== 'undefined') z.config({ jitless: true })

export const GEO_RESULT_SCHEMA = 'geo-result/1'

export const ValidationCheckSchema = z.object({
  /** Stable machine id, e.g. `aoi_area`, `bands_exist`, `index_range`. */
  id: z.string(),
  phase: z.enum(['static', 'dynamic']),
  status: z.enum(['pass', 'warn', 'fail']),
  message: z.string(),
})
export type ValidationCheck = z.infer<typeof ValidationCheckSchema>

/** `ok` every check passed or warned; `flagged` ran, but a dynamic check failed (shown, never as
 *  fine); `refused` a static check failed so nothing ran; `failed` the run threw or an upstream
 *  could not be read (a fetch failure, which is not "no data"). */
export const GeoResultStatusSchema = z.enum(['ok', 'flagged', 'refused', 'failed'])
export type GeoResultStatus = z.infer<typeof GeoResultStatusSchema>

const SummaryDatumSchema = z.union([
  z.number(),
  z.string(),
  z.array(z.object({ label: z.string(), value: z.number() })),
])

// Layers, charts and styles are already typed by the modules that build and draw them; the
// envelope only insists on the fields every consumer reads.
const LayerSchema = z.custom<ResultLayer>(
  (v) => !!v && typeof v === 'object' && typeof (v as any).id === 'string' && typeof (v as any).type === 'string',
  'layer needs an id and a type',
)
const ChartSchema = z.custom<ChartItem>(
  (v) => !!v && typeof v === 'object' && typeof (v as any).id === 'string' && typeof (v as any).spec === 'object',
  'chart needs an id and a spec',
)

export const GeoProvenanceSchema = z.object({
  /** Human-readable data sources (deduplicated). */
  sources: z.array(z.string()),
  /** Ids of the data items actually read: scene ids, dataset ids, release tags. */
  items: z.array(z.string()),
  method: z.string(),
  date: z.string().optional(),
  /** sha256 over operation@version, arguments, AOI and focus (see `engine/hash.ts`). */
  inputs_hash: z.string(),
  /** Set only on a result served from the result cache (Q-47): nothing was recomputed. */
  cached: z.literal(true).optional(),
  /** ISO time the stored result was originally computed; set together with `cached`. */
  computed_at: z.string().optional(),
})
export type GeoProvenance = z.infer<typeof GeoProvenanceSchema>

export const GeoResultSchema = z.object({
  schema: z.literal(GEO_RESULT_SCHEMA),
  /** `r_` + 16 hex of sha256(inputs_hash + sorted provenance items): same inputs and same data
   *  items give the same id. This is the id the model cites as `[[result_id#key]]`. */
  result_id: z.string(),
  op: z.object({ name: z.string(), version: z.string() }),
  status: GeoResultStatusSchema,
  summary: z.string(),
  /** Primary layer first. */
  layers: z.array(LayerSchema),
  charts: z.array(ChartSchema).optional(),
  /** Citable figures: `[[result_id#key]]`. */
  stats: z.record(z.string(), SummaryDatumSchema).optional(),
  layer_style: z.custom<{ layer_id: string; style: VectorStyle; legend: LegendItem[] }>(
    (v) => v === undefined || (!!v && typeof v === 'object' && typeof (v as any).layer_id === 'string'),
  ).optional(),
  provenance: GeoProvenanceSchema,
  uncertainty: z.object({
    notes: z.array(z.string()),
    ranges: z.record(z.string(), z.tuple([z.number(), z.number()])).optional(),
  }).optional(),
  validation: z.array(ValidationCheckSchema),
  artifacts: z.array(z.object({
    kind: z.string(),
    name: z.string(),
    url: z.string().optional(),
    data: z.string().optional(),
  })).optional(),
  /** OSM came back empty and a computer-vision model could digitize it (parked behind
   *  GEOAGENT_ENABLE_CV): the model name, otherwise absent. */
  cv_fallback_model: z.string().optional(),
})
export type GeoResult = z.infer<typeof GeoResultSchema>

/** The checks that did not pass, failures first: what a badge or tooltip should list. */
export function failingChecks(validation: ValidationCheck[]): ValidationCheck[] {
  const rank = (c: ValidationCheck) => (c.status === 'fail' ? 0 : 1)
  return validation.filter((c) => c.status !== 'pass').sort((a, b) => rank(a) - rank(b))
}
