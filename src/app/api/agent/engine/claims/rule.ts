/** The decision rule of a claim recipe, evaluated. Pure: no I/O, no clock, no registry.
 *
 *  Input is what the engine recorded (each plan node's status and figures) and the resolved
 *  parameters; output is the verdict, a confidence for Supported / Contradicted, the rule that
 *  fired, its reason in words, and the value of every named input, so the verdict can be checked
 *  against the evidence by hand. Anything missing is `undefined`, never zero: a comparison that
 *  involves it is false, and `missing` says so explicitly.
 */

import type { ConfidenceSpec, Cond, Decision, Operand, AbstainKind, Verdict } from './schema'

export type Figure = number | string | Array<{ label: string; value: number }>

export interface NodeRecord {
  idx: number
  op: string
  status: 'ok' | 'flagged' | 'refused' | 'failed' | 'skipped'
  /** The result's `stats` (its citable figures). */
  stats?: Record<string, Figure> | null
  /** First line of the result's summary, for words about a node that produced no figures. */
  summary?: string
  /** Messages of the checks that did not pass. */
  flags?: string[]
}

export interface EvalInput {
  params: Record<string, string | number>
  nodes: NodeRecord[]
}

export interface Decided {
  verdict: Verdict
  /** 0..1 for Supported / Contradicted; null for Cannot determine. */
  confidence: number | null
  rule: string
  kind?: AbstainKind
  reason: string
  /** Every named input at decision time (null: missing). */
  inputs: Record<string, number | string | null>
}

type Value = number | string | boolean | undefined

const DAY_MS = 86_400_000
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

const dayMs = (v: Value): number | undefined => {
  if (typeof v !== 'string' || !ISO_DAY.test(v)) return undefined
  const t = Date.parse(`${v}T00:00:00Z`)
  return Number.isNaN(t) ? undefined : t
}
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const num = (v: Value): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Latest date <= `asOf` with the month and day of `date`, if that is at least a year after
 *  `date`; otherwise `asOf` itself (a shorter span has no same-season anniversary). */
export function anniversaryBefore(date: string, asOf: string): string | undefined {
  const d = dayMs(date)
  const a = dayMs(asOf)
  if (d === undefined || a === undefined || a < d) return undefined
  const [, m, dd] = date.split('-').map(Number)
  const at = (year: number) => {
    const t = Date.UTC(year, m - 1, dd)
    return new Date(t).getUTCMonth() === m - 1 ? t : Date.UTC(year, m - 1, dd - 1) // 29 Feb -> 28 Feb
  }
  let y = new Date(a).getUTCFullYear()
  while (at(y) > a) y--
  return at(y) - d >= 364 * DAY_MS ? isoDay(at(y)) : asOf
}

/** Days between two dates' positions in the year, 0..182 (circular): how far apart the seasons are. */
export function dayOfYearGap(a: string, b: string): number | undefined {
  const x = dayMs(a)
  const y = dayMs(b)
  if (x === undefined || y === undefined) return undefined
  // Position in a common non-leap year, so the same calendar day is the same position every year.
  const doy = (ms: number) => { const d = new Date(ms); return Math.round((Date.UTC(2001, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(2001, 0, 1)) / DAY_MS) }
  const gap = Math.abs(doy(x) - doy(y))
  return Math.min(gap, 365 - gap)
}

export interface Scope {
  params: Record<string, Value>
  nodes: NodeRecord[]
  inputs: Record<string, Value>
  /** Area of the plot polygon, hectares. */
  plotAreaHa?: number
}

export function evalOperand(op: Operand, scope: Scope): Value {
  if (typeof op !== 'object') return op
  if ('stat' in op) {
    const [idx, key] = [Number(op.stat.split('.')[0]), op.stat.slice(op.stat.indexOf('.') + 1)]
    const v = scope.nodes.find((n) => n.idx === idx)?.stats?.[key]
    return typeof v === 'number' || typeof v === 'string' ? v : undefined
  }
  if ('param' in op) return scope.params[op.param]
  if ('ref' in op) return op.ref in scope.inputs ? scope.inputs[op.ref] : scope.params[op.ref]
  const args = op.args.map((a) => evalOperand(a, scope))
  const n = args.map(num)
  switch (op.fn) {
    case 'plot_area_ha': return scope.plotAreaHa
    case 'abs': return n[0] === undefined ? undefined : Math.abs(n[0])
    case 'sub': return n[0] === undefined || n[1] === undefined ? undefined : n[0] - n[1]
    case 'add': return n[0] === undefined || n[1] === undefined ? undefined : n[0] + n[1]
    case 'mul': return n[0] === undefined || n[1] === undefined ? undefined : n[0] * n[1]
    case 'div': return n[0] === undefined || n[1] === undefined || n[1] === 0 ? undefined : n[0] / n[1]
    case 'min': return n.length && n.every((x) => x !== undefined) ? Math.min(...(n as number[])) : undefined
    case 'max': return n.length && n.every((x) => x !== undefined) ? Math.max(...(n as number[])) : undefined
    case 'abs_days': {
      const a = dayMs(args[0]); const b = dayMs(args[1])
      return a === undefined || b === undefined ? undefined : Math.abs(a - b) / DAY_MS
    }
    case 'add_days': {
      const a = dayMs(args[0])
      return a === undefined || n[1] === undefined ? undefined : isoDay(a + n[1] * DAY_MS)
    }
    case 'day_of_year_gap': return typeof args[0] === 'string' && typeof args[1] === 'string' ? dayOfYearGap(args[0], args[1]) : undefined
    case 'anniversary_before': return typeof args[0] === 'string' && typeof args[1] === 'string' ? anniversaryBefore(args[0], args[1]) : undefined
  }
}

export function evalCond(c: Cond, scope: Scope): boolean {
  if ('all' in c) return c.all.every((x) => evalCond(x, scope))
  if ('any' in c) return c.any.some((x) => evalCond(x, scope))
  if ('not' in c) return !evalCond(c.not, scope)
  if ('missing' in c) return evalOperand(c.missing, scope) === undefined
  const [op, [l, r]] = Object.entries(c)[0] as [string, [Operand, Operand]]
  const a = evalOperand(l, scope)
  const b = evalOperand(r, scope)
  if (a === undefined || b === undefined) return false
  if (op === 'eq') return a === b
  if (op === 'ne') return a !== b
  if (typeof a !== 'number' || typeof b !== 'number') return false
  return op === 'lt' ? a < b : op === 'lte' ? a <= b : op === 'gt' ? a > b : a >= b
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function computeConfidence(spec: ConfidenceSpec, scope: Scope): number {
  let c = spec.base
  for (const t of spec.terms) {
    const v = num(evalOperand(t.value, scope))
    if (v === undefined || t.to === t.from) continue
    c += t.weight * clamp((v - t.from) / (t.to - t.from), 0, 1)
  }
  return Number(clamp(c, 0, spec.cap).toFixed(3))
}

/** Format a value for a reason: numbers to 3 significant figures, missing as "n/a". */
export function show(v: Value): string {
  if (v === undefined) return 'n/a'
  if (typeof v === 'number') return String(Number(v.toPrecision(3)))
  return String(v)
}

export const fillTemplate = (tpl: string, lookup: (name: string) => Value): string =>
  tpl.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, name: string) => show(lookup(name)))

export const templateNames = (tpl: string): string[] => [...tpl.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1])

const NODE_WORDS: Record<string, { kind: AbstainKind; lead: string }> = {
  failed: { kind: 'fetch_failed', lead: 'could not be read (a failure, not an absence of data)' },
  skipped: { kind: 'fetch_failed', lead: 'did not run because a step before it failed' },
  refused: { kind: 'out_of_scope', lead: 'was refused before running' },
  flagged: { kind: 'insufficient_quality', lead: 'ran but failed its own validation' },
}

export function decide(decision: Decision, input: EvalInput): Decided {
  const scope: Scope = { params: input.params, nodes: input.nodes, inputs: {}, plotAreaHa: num(input.params.plot_area_ha) }
  const trace = (): Decided['inputs'] => Object.fromEntries(Object.entries(scope.inputs).map(([k, v]) => [k, typeof v === 'boolean' ? String(v) : v ?? null]))

  // A node the decision cannot do without must have produced figures it can trust.
  for (const idx of decision.requires) {
    const node = input.nodes.find((n) => n.idx === idx)
    const bad = !node ? { kind: 'fetch_failed' as const, lead: 'was not run' } : node.status === 'ok' ? null : NODE_WORDS[node.status]
    if (bad) {
      const detail = node?.flags?.length ? ` ${node.flags.join(' ')}` : node?.summary ? ` ${node.summary}` : ''
      return {
        verdict: 'cannot_determine', confidence: null, rule: `node_${idx}_${node?.status ?? 'missing'}`, kind: bad.kind,
        reason: `Step ${idx}${node ? ` (${node.op})` : ''} ${bad.lead}.${detail}`.trim(), inputs: {},
      }
    }
  }

  for (const [name, op] of Object.entries(decision.inputs)) scope.inputs[name] = evalOperand(op, scope)
  const lookup = (name: string): Value => (name in scope.inputs ? scope.inputs[name] : scope.params[name])

  for (const rule of decision.rules) {
    if (!evalCond(rule.when, scope)) continue
    return {
      verdict: rule.verdict,
      confidence: rule.confidence ? computeConfidence(rule.confidence, scope) : null,
      rule: rule.id,
      ...(rule.kind ? { kind: rule.kind } : {}),
      reason: fillTemplate(rule.reason, lookup),
      inputs: trace(),
    }
  }
  return {
    verdict: 'cannot_determine', confidence: null, rule: 'otherwise', kind: decision.otherwise.kind,
    reason: fillTemplate(decision.otherwise.reason, lookup), inputs: trace(),
  }
}
