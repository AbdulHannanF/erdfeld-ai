/**
 * A small, safe expression language for filtering a vector layer's features by their attributes
 * (the workbench's "SQL / expressions" tab). It is a parser and an evaluator: there is no `eval`,
 * no `Function`, no property access beyond the feature's own attributes, so an expression typed by
 * a person can only read the feature it is run against.
 *
 *   area_km2 > 0.5 AND class IN ('crop', 'grass')
 *   lower(name) LIKE '%field%' OR confidence BETWEEN 0.6 AND 0.9
 *   "Flood depth" >= 1.5 AND $area < 2
 *
 * Grammar (keywords are case-insensitive):
 *   or      := and ( OR and )*
 *   and     := not ( AND not )*
 *   not     := NOT not | compare
 *   compare := sum [ (= | == | != | <> | < | <= | > | >=) sum
 *                  | [NOT] (LIKE | ILIKE) sum
 *                  | [NOT] IN ( sum, ... )
 *                  | [NOT] BETWEEN sum AND sum
 *                  | IS [NOT] NULL ]
 *   sum     := term ( (+ | -) term )*
 *   term    := unary ( (* | / | %) unary )*
 *   unary   := - unary | primary
 *   primary := number | 'text' | TRUE | FALSE | NULL | field | "field" | `field`
 *            | $area | $length | $x | $y | name( sum, ... ) | ( or )
 *
 * Comparing with a missing value (NULL) gives NULL, and a row whose result is not true is not
 * selected: the usual SQL three-valued rule, so a feature that lacks the field never matches
 * `field > 3` and never matches `field <= 3` either.
 */

export type Value = number | string | boolean | null

export class ExpressionError extends Error {
  constructor(message: string, readonly position: number) {
    super(message)
    this.name = 'ExpressionError'
  }
}

type Token =
  | { t: 'num'; v: number; at: number }
  | { t: 'str'; v: string; at: number }
  | { t: 'id'; v: string; at: number; quoted: boolean }
  | { t: 'op'; v: string; at: number }
  | { t: 'end'; at: number }

const KEYWORDS = new Set(['and', 'or', 'not', 'like', 'ilike', 'in', 'between', 'is', 'null', 'true', 'false'])

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    const at = i
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))!
      out.push({ t: 'num', v: Number(m[0]), at })
      i += m[0].length
      continue
    }
    if (c === "'") {
      let s = ''
      i++
      for (;;) {
        if (i >= src.length) throw new ExpressionError('Unterminated text: add a closing quote', at)
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            s += "'"
            i += 2
            continue
          }
          i++
          break
        }
        s += src[i++]
      }
      out.push({ t: 'str', v: s, at })
      continue
    }
    if (c === '"' || c === '`') {
      const end = src.indexOf(c, i + 1)
      if (end < 0) throw new ExpressionError('Unterminated field name: add the closing quote', at)
      out.push({ t: 'id', v: src.slice(i + 1, end), at, quoted: true })
      i = end + 1
      continue
    }
    if (c === '$') {
      const m = /^\$[A-Za-z_]+/.exec(src.slice(i))
      if (!m) throw new ExpressionError('A $ must start a geometry value: $area, $length, $x or $y', at)
      out.push({ t: 'id', v: m[0].toLowerCase(), at, quoted: false })
      i += m[0].length
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i))!
      out.push({ t: 'id', v: m[0], at, quoted: false })
      i += m[0].length
      continue
    }
    const two = src.slice(i, i + 2)
    if (['<=', '>=', '<>', '!=', '=='].includes(two)) {
      out.push({ t: 'op', v: two, at })
      i += 2
      continue
    }
    if ('=<>+-*/%(),'.includes(c)) {
      out.push({ t: 'op', v: c, at })
      i++
      continue
    }
    throw new ExpressionError(`Unexpected "${c}"`, at)
  }
  out.push({ t: 'end', at: src.length })
  return out
}

// ---------------------------------------------------------------------------
// Syntax tree
// ---------------------------------------------------------------------------

export type Node =
  | { k: 'lit'; v: Value }
  | { k: 'field'; name: string; at: number }
  | { k: 'geom'; name: '$area' | '$length' | '$x' | '$y'; at: number }
  | { k: 'unary'; op: '-' | 'not'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'like'; a: Node; b: Node; ci: boolean; neg: boolean }
  | { k: 'in'; a: Node; list: Node[]; neg: boolean }
  | { k: 'between'; a: Node; lo: Node; hi: Node; neg: boolean }
  | { k: 'isnull'; a: Node; neg: boolean }
  | { k: 'call'; name: string; args: Node[]; at: number }

class Parser {
  private p = 0
  constructor(private readonly toks: Token[]) {}

  private get cur(): Token {
    return this.toks[this.p]
  }
  private isKw(w: string): boolean {
    const t = this.cur
    return t.t === 'id' && !t.quoted && t.v.toLowerCase() === w
  }
  private isOp(v: string): boolean {
    const t = this.cur
    return t.t === 'op' && t.v === v
  }
  private eatKw(w: string): boolean {
    if (!this.isKw(w)) return false
    this.p++
    return true
  }
  private eatOp(v: string): boolean {
    if (!this.isOp(v)) return false
    this.p++
    return true
  }
  private expectOp(v: string, why: string): void {
    if (!this.eatOp(v)) throw new ExpressionError(`Expected "${v}" ${why}`, this.cur.at)
  }

  parse(): Node {
    const n = this.or()
    if (this.cur.t !== 'end') throw new ExpressionError(`Unexpected ${describe(this.cur)} after a complete expression`, this.cur.at)
    return n
  }

  private or(): Node {
    let a = this.and()
    while (this.eatKw('or')) a = { k: 'bin', op: 'or', a, b: this.and() }
    return a
  }
  private and(): Node {
    let a = this.not()
    while (this.eatKw('and')) a = { k: 'bin', op: 'and', a, b: this.not() }
    return a
  }
  private not(): Node {
    if (this.eatKw('not')) return { k: 'unary', op: 'not', a: this.not() }
    return this.compare()
  }
  private compare(): Node {
    const a = this.sum()
    const t = this.cur
    if (t.t === 'op' && ['=', '==', '!=', '<>', '<', '<=', '>', '>='].includes(t.v)) {
      this.p++
      return { k: 'bin', op: t.v === '==' ? '=' : t.v === '<>' ? '!=' : t.v, a, b: this.sum() }
    }
    if (this.eatKw('is')) {
      const neg = this.eatKw('not')
      if (!this.eatKw('null')) throw new ExpressionError('Expected NULL after IS', this.cur.at)
      return { k: 'isnull', a, neg }
    }
    const neg = this.isKw('not') && ['like', 'ilike', 'in', 'between'].includes(this.peekKw(1))
    if (neg) this.p++
    if (this.isKw('like') || this.isKw('ilike')) {
      const ci = this.isKw('ilike')
      this.p++
      return { k: 'like', a, b: this.sum(), ci, neg }
    }
    if (this.eatKw('in')) {
      this.expectOp('(', 'after IN')
      const list: Node[] = [this.sum()]
      while (this.eatOp(',')) list.push(this.sum())
      this.expectOp(')', 'to close the IN list')
      return { k: 'in', a, list, neg }
    }
    if (this.eatKw('between')) {
      const lo = this.sum()
      if (!this.eatKw('and')) throw new ExpressionError('BETWEEN needs AND: field BETWEEN low AND high', this.cur.at)
      return { k: 'between', a, lo, hi: this.sum(), neg }
    }
    return a
  }
  private peekKw(n: number): string {
    const t = this.toks[this.p + n]
    return t && t.t === 'id' && !t.quoted ? t.v.toLowerCase() : ''
  }
  private sum(): Node {
    let a = this.term()
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.cur as { v: string }).v
      this.p++
      a = { k: 'bin', op, a, b: this.term() }
    }
    return a
  }
  private term(): Node {
    let a = this.unary()
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = (this.cur as { v: string }).v
      this.p++
      a = { k: 'bin', op, a, b: this.unary() }
    }
    return a
  }
  private unary(): Node {
    if (this.eatOp('-')) return { k: 'unary', op: '-', a: this.unary() }
    return this.primary()
  }
  private primary(): Node {
    const t = this.cur
    if (t.t === 'num') {
      this.p++
      return { k: 'lit', v: t.v }
    }
    if (t.t === 'str') {
      this.p++
      return { k: 'lit', v: t.v }
    }
    if (t.t === 'op' && t.v === '(') {
      this.p++
      const n = this.or()
      this.expectOp(')', 'to close the bracket')
      return n
    }
    if (t.t === 'id') {
      if (!t.quoted) {
        const w = t.v.toLowerCase()
        if (w === 'true' || w === 'false') {
          this.p++
          return { k: 'lit', v: w === 'true' }
        }
        if (w === 'null') {
          this.p++
          return { k: 'lit', v: null }
        }
        if (w.startsWith('$')) {
          if (!['$area', '$length', '$x', '$y'].includes(w)) throw new ExpressionError(`Unknown geometry value ${t.v}. Use $area, $length, $x or $y`, t.at)
          this.p++
          return { k: 'geom', name: w as '$area', at: t.at }
        }
        if (KEYWORDS.has(w)) throw new ExpressionError(`"${t.v}" is not allowed here`, t.at)
        const next = this.toks[this.p + 1]
        if (next.t === 'op' && next.v === '(') {
          this.p += 2
          const args: Node[] = []
          if (!this.isOp(')')) {
            args.push(this.or())
            while (this.eatOp(',')) args.push(this.or())
          }
          this.expectOp(')', `to close ${t.v}(`)
          if (!Object.hasOwn(FUNCTIONS, w)) throw new ExpressionError(`Unknown function ${t.v}. Available: ${Object.keys(FUNCTIONS).join(', ')}`, t.at)
          const [min, max] = FUNCTIONS[w].arity
          if (args.length < min || args.length > max) throw new ExpressionError(`${t.v} takes ${min === max ? min : `${min} to ${max}`} argument${max === 1 ? '' : 's'}`, t.at)
          return { k: 'call', name: w, args, at: t.at }
        }
      }
      this.p++
      return { k: 'field', name: t.v, at: t.at }
    }
    throw new ExpressionError(t.t === 'end' ? 'The expression ends early: a value is missing' : `Unexpected ${describe(t)}`, t.at)
  }
}

function describe(t: Token): string {
  return t.t === 'end' ? 'end of the expression' : t.t === 'str' ? `text '${t.v}'` : t.t === 'num' ? `number ${t.v}` : `"${t.v}"`
}

const FUNCTIONS: Record<string, { arity: [number, number]; fn: (args: Value[]) => Value }> = {
  abs: { arity: [1, 1], fn: ([a]) => num1(a, Math.abs) },
  round: { arity: [1, 2], fn: ([a, d]) => num1(a, (x) => { const f = 10 ** (typeof d === 'number' ? d : 0); return Math.round(x * f) / f }) },
  floor: { arity: [1, 1], fn: ([a]) => num1(a, Math.floor) },
  ceil: { arity: [1, 1], fn: ([a]) => num1(a, Math.ceil) },
  sqrt: { arity: [1, 1], fn: ([a]) => num1(a, (x) => (x < 0 ? NaN : Math.sqrt(x))) },
  lower: { arity: [1, 1], fn: ([a]) => (a == null ? null : String(a).toLowerCase()) },
  upper: { arity: [1, 1], fn: ([a]) => (a == null ? null : String(a).toUpperCase()) },
  length: { arity: [1, 1], fn: ([a]) => (a == null ? null : String(a).length) },
  coalesce: { arity: [1, 8], fn: (args) => args.find((a) => a != null) ?? null },
  min: { arity: [2, 8], fn: (args) => (args.some((a) => typeof a !== 'number') ? null : Math.min(...(args as number[]))) },
  max: { arity: [2, 8], fn: (args) => (args.some((a) => typeof a !== 'number') ? null : Math.max(...(args as number[]))) },
}

function num1(a: Value, f: (x: number) => number): Value {
  if (typeof a !== 'number') return null
  const r = f(a)
  return Number.isFinite(r) ? r : null
}

export interface Compiled {
  node: Node
  /** Field names the expression reads (exact, as written). */
  fields: string[]
}

/** Parse an expression; throws `ExpressionError` with the character position on a mistake. */
export function compile(source: string): Compiled {
  if (!source.trim()) throw new ExpressionError('Type an expression, for example: confidence > 0.8', 0)
  const node = new Parser(tokenize(source)).parse()
  const fields = new Set<string>()
  const walk = (n: Node): void => {
    switch (n.k) {
      case 'field': fields.add(n.name); break
      case 'unary': walk(n.a); break
      case 'bin': walk(n.a); walk(n.b); break
      case 'like': walk(n.a); walk(n.b); break
      case 'in': walk(n.a); n.list.forEach(walk); break
      case 'between': walk(n.a); walk(n.lo); walk(n.hi); break
      case 'isnull': walk(n.a); break
      case 'call': n.args.forEach(walk); break
      default: break
    }
  }
  walk(node)
  return { node, fields: [...fields] }
}

/** What a feature offers the expression: its attributes and lazily-computed geometry values. */
export interface Row {
  props: Record<string, unknown>
  geom: (name: '$area' | '$length' | '$x' | '$y') => number | null
}

function asValue(v: unknown): Value {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' || typeof v === 'boolean') return v
  return String(v)
}

/** A numeric-looking string compares as a number against a number, as a CSV import yields. */
function cmp(a: Value, b: Value): number | null {
  if (a == null || b == null) return null
  if (typeof a === 'number' && typeof b === 'string' && b.trim() !== '' && Number.isFinite(Number(b))) b = Number(b)
  if (typeof b === 'number' && typeof a === 'string' && a.trim() !== '' && Number.isFinite(Number(a))) a = Number(a)
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  const x = String(a)
  const y = String(b)
  return x < y ? -1 : x > y ? 1 : 0
}

function likeRegex(pattern: string, ci: boolean): RegExp {
  const body = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')
  return new RegExp(`^${body}$`, ci ? 'is' : 's')
}

function truthy(v: Value): boolean | null {
  if (v == null) return null
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  return v.length > 0
}

export function evaluate(node: Node, row: Row): Value {
  switch (node.k) {
    case 'lit':
      return node.v
    case 'field':
      return Object.hasOwn(row.props, node.name) ? asValue(row.props[node.name]) : null
    case 'geom':
      return row.geom(node.name)
    case 'unary': {
      const a = evaluate(node.a, row)
      if (node.op === '-') return typeof a === 'number' ? -a : null
      const t = truthy(a)
      return t == null ? null : !t
    }
    case 'bin': {
      if (node.op === 'and' || node.op === 'or') {
        const a = truthy(evaluate(node.a, row))
        const b = truthy(evaluate(node.b, row))
        if (node.op === 'and') return a === false || b === false ? false : a == null || b == null ? null : true
        return a === true || b === true ? true : a == null || b == null ? null : false
      }
      const a = evaluate(node.a, row)
      const b = evaluate(node.b, row)
      if (['=', '!=', '<', '<=', '>', '>='].includes(node.op)) {
        const c = cmp(a, b)
        if (c == null) return null
        return node.op === '=' ? c === 0 : node.op === '!=' ? c !== 0 : node.op === '<' ? c < 0 : node.op === '<=' ? c <= 0 : node.op === '>' ? c > 0 : c >= 0
      }
      if (node.op === '+' && (typeof a === 'string' || typeof b === 'string') && a != null && b != null) return `${a}${b}`
      if (typeof a !== 'number' || typeof b !== 'number') return null
      const r = node.op === '+' ? a + b : node.op === '-' ? a - b : node.op === '*' ? a * b : node.op === '/' ? (b === 0 ? NaN : a / b) : b === 0 ? NaN : a % b
      return Number.isFinite(r) ? r : null
    }
    case 'like': {
      const a = evaluate(node.a, row)
      const b = evaluate(node.b, row)
      if (a == null || b == null) return null
      const hit = likeRegex(String(b), node.ci).test(String(a))
      return node.neg ? !hit : hit
    }
    case 'in': {
      const a = evaluate(node.a, row)
      if (a == null) return null
      let unknown = false
      for (const e of node.list) {
        const c = cmp(a, evaluate(e, row))
        if (c === 0) return !node.neg
        if (c == null) unknown = true
      }
      return unknown ? null : node.neg
    }
    case 'between': {
      const a = evaluate(node.a, row)
      const lo = cmp(a, evaluate(node.lo, row))
      const hi = cmp(a, evaluate(node.hi, row))
      if (lo == null || hi == null) return null
      const inside = lo >= 0 && hi <= 0
      return node.neg ? !inside : inside
    }
    case 'isnull': {
      const isNull = evaluate(node.a, row) == null
      return node.neg ? !isNull : isNull
    }
    case 'call':
      return FUNCTIONS[node.name].fn(node.args.map((a) => evaluate(a, row)))
  }
}

export interface FilterResult {
  /** Indices (into the input) of the features the expression selects. */
  matches: number[]
  /** Features for which the expression gave NULL (a field was missing): reported, never guessed. */
  unknown: number
  /** Fields the expression reads that no feature has: almost always a typo. */
  missingFields: string[]
}

/** Run an expression over rows. A non-boolean result counts as a selection when it is non-zero. */
export function filterRows(source: string, rows: Row[]): FilterResult {
  const { node, fields } = compile(source)
  const known = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r.props)) known.add(k)
  const missingFields = fields.filter((f) => !known.has(f))
  const matches: number[] = []
  let unknown = 0
  rows.forEach((row, i) => {
    const t = truthy(evaluate(node, row))
    if (t === true) matches.push(i)
    else if (t == null) unknown++
  })
  return { matches, unknown, missingFields }
}
