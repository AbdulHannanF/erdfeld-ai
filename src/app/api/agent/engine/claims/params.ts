/** Resolving a claim's parameters against its recipe, and writing them into the plan. Pure. */

import turfArea from '@turf/area'

import { evalOperand } from './rule'
import type { ParamSpec, Recipe } from './schema'

export type ParamValues = Record<string, string | number>

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const isRealDay = (s: string) => ISO_DAY.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s

export type ParamResult = { ok: true; params: ParamValues } | { ok: false; errors: string[] }

function check(name: string, spec: ParamSpec, raw: unknown, today: string): { value?: string | number; error?: string } {
  const given = raw === undefined || raw === null || raw === '' ? (spec.default === 'today' ? today : spec.default) : raw
  if (given === undefined) return spec.required ? { error: `${name} is required` } : {}
  if (spec.type === 'date') {
    if (typeof given !== 'string' || !isRealDay(given)) return { error: `${name} must be a calendar date, YYYY-MM-DD` }
    return { value: given }
  }
  if (spec.type === 'string') return typeof given === 'string' ? { value: given } : { error: `${name} must be text` }
  if (typeof given !== 'number' || !Number.isFinite(given)) return { error: `${name} must be a number` }
  if (spec.type === 'integer' && !Number.isInteger(given)) return { error: `${name} must be a whole number` }
  if (spec.min !== undefined && given < spec.min) return { error: `${name} must be at least ${spec.min}` }
  if (spec.max !== undefined && given > spec.max) return { error: `${name} must be at most ${spec.max}` }
  return { value: given }
}

/** Parameters from the request plus the recipe's defaults and derived values. `today` is the
 *  default of any date parameter that says so; it is stored with the case, so a later re-read
 *  never recomputes it. */
export function resolveParams(recipe: Recipe, raw: Record<string, unknown>, geometry: unknown, today: string): ParamResult {
  const errors: string[] = []
  const params: ParamValues = {}
  for (const key of Object.keys(raw)) if (!(key in recipe.params)) errors.push(`${key} is not a parameter of ${recipe.id}`)
  for (const [name, spec] of Object.entries(recipe.params)) {
    const r = check(name, spec, raw[name], today)
    if (r.error) errors.push(r.error)
    else if (r.value !== undefined) params[name] = r.value
  }
  if (errors.length) return { ok: false, errors }

  let plotAreaHa: number | undefined
  try {
    plotAreaHa = turfArea({ type: 'Feature', properties: {}, geometry } as any) / 1e4
  } catch { /* an unusable geometry is rejected by the route before this */ }
  for (const [name, op] of Object.entries(recipe.derived)) {
    const v = evalOperand(op, { params, nodes: [], inputs: {}, plotAreaHa })
    if (typeof v === 'number' || typeof v === 'string') params[name] = typeof v === 'number' ? Number(v.toFixed(4)) : v
    else errors.push(`${name} could not be derived from the parameters`)
  }
  return errors.length ? { ok: false, errors } : { ok: true, params }
}

const isParamRef = (v: unknown): v is { param: string } =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as any).param === 'string'

/** The recipe's plan with `{ "param": name }` replaced by the resolved value. `from_node`
 *  references are left for the plan executor. */
export function instantiatePlan(recipe: Recipe, params: ParamValues): Array<{ tool: string; args: Record<string, unknown>; reason: string; depends_on?: number[] }> {
  const walk = (v: unknown): unknown => {
    if (isParamRef(v)) {
      if (!(v.param in params)) throw new Error(`The plan uses parameter ${v.param}, which the recipe does not declare`)
      return params[v.param]
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return recipe.plan.map((s) => ({ tool: s.tool, args: walk(s.args) as Record<string, unknown>, reason: s.reason, ...(s.depends_on ? { depends_on: s.depends_on } : {}) }))
}
