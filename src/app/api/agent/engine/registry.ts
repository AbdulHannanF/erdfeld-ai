/** The operation registry: the only thing the planner may use (ADR-0001 §1).
 *
 *  Adding an operation is one `defineOperation` entry in `ops/*.ts` listed here; the planner's
 *  tool definitions, `GET /api/operations`, the executor and the UI all read from this map.
 */

import { EXCESSIVE_AOI_KM2 } from '@/lib/aoi-guard'

import { SUBMIT_PLAN_TOOL, submitPlanDefinition } from '../lib/plan'
import { toLlmSchema } from './llm-schema'
import type { AnyOperation } from './operation'
import { climateOps } from './ops/climate'
import { compositeOps } from './ops/composite'
import { cvOps } from './ops/cv'
import { derivedOps } from './ops/derived'
import { digitizeOps } from './ops/digitize'
import { discoveryOps } from './ops/discovery'
import { forecastOps } from './ops/forecast'
import { opticalOps } from './ops/optical'
import { osmOps } from './ops/osm'
import { rasterOps } from './ops/raster'
import { terrainOps } from './ops/terrain'
import { vizOps } from './ops/viz'

const ALL_OPERATIONS: AnyOperation[] = [
  ...opticalOps,
  ...rasterOps,
  ...compositeOps,
  ...forecastOps,
  ...terrainOps,
  ...climateOps,
  ...osmOps,
  ...derivedOps,
  ...digitizeOps,
  ...vizOps,
  ...discoveryOps,
  ...cvOps,
]

/** Names that still resolve for a saved plan or an older transcript, but are not offered to the
 *  model: one tool, one parameter (ISS-116). */
const ALIASES: Record<string, { name: string; args: Record<string, unknown> }> = {
  render_ndvi_colormap: { name: 'fetch_ndvi', args: { product: 'ndvi' } },
  fetch_high_res_imagery: { name: 'fetch_ndvi', args: { product: 'imagery' } },
}

const enabled = (op: AnyOperation) => op.enabled?.() ?? true

/** Operations that can run now (an op gated by an env flag is absent while the flag is off). */
export function listOperations(): AnyOperation[] {
  return ALL_OPERATIONS.filter(enabled)
}

export function getOperation(name: string): AnyOperation | undefined {
  const op = ALL_OPERATIONS.find((o) => o.name === name)
  return op && enabled(op) ? op : undefined
}

/** Resolve a called name (alias or real) to its operation and arguments. */
export function resolveOperation(name: string, args: Record<string, unknown>): { op: AnyOperation; args: Record<string, unknown> } | null {
  const alias = ALIASES[name]
  const op = getOperation(alias ? alias.name : name)
  if (!op) return null
  return { op, args: alias ? { ...alias.args, ...args } : args }
}

/** The "Fetching NDVI..." line shown while a tool runs. */
export function labelFor(name: string): string {
  return resolveOperation(name, {})?.op.label ?? `Running ${name}...`
}

/** Operations the planner is offered. */
export function plannerOperations(): AnyOperation[] {
  return listOperations().filter((o) => o.modelFacing !== false)
}

/**
 * The area past which most operations are outside their contract. It is the median of the
 * planner-facing operations' `limits.maxAreaKm2` (an operation without one is held to the
 * app-wide ceiling), so it moves with the contracts instead of being a number written down here.
 * Above it a run is likely to be slow or to have steps refused; below it nothing needs saying.
 */
export function typicalAreaLimitKm2(): number {
  const limits = plannerOperations().map((o) => o.limits?.maxAreaKm2 ?? EXCESSIVE_AOI_KM2).sort((a, b) => a - b)
  if (limits.length === 0) return EXCESSIVE_AOI_KM2
  const mid = Math.floor(limits.length / 2)
  return limits.length % 2 ? limits[mid] : (limits[mid - 1] + limits[mid]) / 2
}

/** The tool definitions sent to the model: every planner-facing operation, plus `submit_plan`. */
export function getToolDefinitions() {
  return [
    ...plannerOperations().map((op) => ({
      type: 'function',
      function: { name: op.name, description: op.description, parameters: toLlmSchema(op.params) },
    })),
    submitPlanDefinition(),
  ]
}

/** What `GET /api/operations` returns, and what the planner can read: each operation's contract. */
export function registryJson() {
  return plannerOperations().map((op) => ({
    name: op.name,
    version: op.version,
    description: op.description,
    params: toLlmSchema(op.params),
    output: op.output,
    sensors: op.sensors ?? [],
    resolution_m: op.resolution_m ?? null,
    limits: {
      maxAreaKm2: op.limits?.maxAreaKm2 ?? EXCESSIVE_AOI_KM2,
      minAreaKm2: op.limits?.minAreaKm2 ?? null,
      earliest: op.limits?.earliest ?? null,
      needsDates: op.limits?.needsDates ?? false,
    },
    input_result: op.inputResult ?? null,
    cost: op.cost,
    limitations: op.limitations,
    confidence: op.confidence,
  }))
}

export { SUBMIT_PLAN_TOOL }
