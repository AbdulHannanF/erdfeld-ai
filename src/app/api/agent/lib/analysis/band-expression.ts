/** A tiny arithmetic evaluator for titiler band expressions (`(b1-b2)/(b1+b2)`).
 *
 *  WHY THIS EXISTS. `analyze_raster` needs the index values and the SCL cloud
 *  mask on the SAME pixel grid. Fetching them as two titiler requests does not
 *  guarantee that: `max_size` is a CAP, not a target, so the 10 m index bands
 *  came back 256×256 while the 20 m SCL band came back 210×210 over the same
 *  polygon (measured live 2026-08-11). Masking one grid with the other would
 *  have silently masked the wrong pixels — the exact failure mode Phase 0
 *  exists to prevent.
 *
 *  The fix is one request carrying the bands AND the SCL asset, which titiler
 *  reads onto a single common grid. That means the index has to be computed
 *  here rather than by titiler's `expression` parameter — and it must be
 *  computed from the SAME formula string, so `SPECTRAL_INDEX_TILE_CONFIG`
 *  remains the one definition of every index. Hence: evaluate the formula,
 *  do not re-implement it.
 *
 *  Supports: decimal literals, `b1`…`bN` band references, `+ - * /`, unary
 *  minus, and parentheses. Anything else is rejected by name — an expression
 *  this cannot parse must not fall back to an approximation.
 */

type Token =
  | { t: 'num'; v: number }
  | { t: 'band'; i: number }
  | { t: 'op'; v: '+' | '-' | '*' | '/' | 'u-' }
  | { t: 'lp' }
  | { t: 'rp' }

const PRECEDENCE: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, 'u-': 3 }

function tokenize(expr: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < expr.length) {
    const c = expr[i]
    if (c === ' ' || c === '\t') { i++; continue }
    if (c === '(') { out.push({ t: 'lp' }); i++; continue }
    if (c === ')') { out.push({ t: 'rp' }); i++; continue }
    if ('+-*/'.includes(c)) {
      const prev = out[out.length - 1]
      const unary = c === '-' && (!prev || prev.t === 'op' || prev.t === 'lp')
      out.push({ t: 'op', v: unary ? 'u-' : (c as '+' | '-' | '*' | '/') })
      i++
      continue
    }
    if (/[0-9.]/.test(c)) {
      let j = i
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++
      const v = Number(expr.slice(i, j))
      if (!Number.isFinite(v)) throw new Error(`bad number "${expr.slice(i, j)}" in expression`)
      out.push({ t: 'num', v })
      i = j
      continue
    }
    if (c === 'b' || c === 'B') {
      let j = i + 1
      while (j < expr.length && /[0-9]/.test(expr[j])) j++
      if (j === i + 1) throw new Error(`band reference without an index at "${expr.slice(i, i + 6)}"`)
      out.push({ t: 'band', i: Number(expr.slice(i + 1, j)) })
      i = j
      continue
    }
    throw new Error(`unsupported character "${c}" in band expression`)
  }
  return out
}

/** Shunting-yard → reverse Polish. */
function toRpn(tokens: Token[]): Token[] {
  const out: Token[] = []
  const ops: Token[] = []
  for (const tk of tokens) {
    if (tk.t === 'num' || tk.t === 'band') { out.push(tk); continue }
    if (tk.t === 'lp') { ops.push(tk); continue }
    if (tk.t === 'rp') {
      while (ops.length && ops[ops.length - 1].t !== 'lp') out.push(ops.pop()!)
      if (!ops.length) throw new Error('unbalanced parentheses in band expression')
      ops.pop()
      continue
    }
    // Left-associative for the binaries, right-associative for unary minus.
    while (ops.length) {
      const top = ops[ops.length - 1]
      if (top.t !== 'op') break
      const higher = PRECEDENCE[top.v] > PRECEDENCE[tk.v]
      const equalLeft = PRECEDENCE[top.v] === PRECEDENCE[tk.v] && tk.v !== 'u-'
      if (!higher && !equalLeft) break
      out.push(ops.pop()!)
    }
    ops.push(tk)
  }
  while (ops.length) {
    const top = ops.pop()!
    if (top.t === 'lp') throw new Error('unbalanced parentheses in band expression')
    out.push(top)
  }
  return out
}

/** A compiled expression: give it the band values, get the index value. */
export type CompiledExpression = (bands: ArrayLike<number>) => number

/**
 * Compile a titiler-style band expression into a function of `b1`-indexed band
 * values (1-based, matching titiler's own convention).
 *
 * Throws on anything it cannot parse — a formula that cannot be evaluated
 * exactly must not be approximated.
 */
export function compileBandExpression(expr: string): CompiledExpression {
  const rpn = toRpn(tokenize(expr))
  if (rpn.length === 0) throw new Error('empty band expression')

  // Validate arity once, at compile time, instead of per pixel.
  let depth = 0
  for (const tk of rpn) {
    if (tk.t === 'num' || tk.t === 'band') depth++
    else if (tk.t === 'op' && tk.v === 'u-') { if (depth < 1) throw new Error('malformed band expression') }
    else { depth--; if (depth < 1) throw new Error('malformed band expression') }
  }
  if (depth !== 1) throw new Error('malformed band expression')

  // Parentheses never survive the shunting yard; narrowing here keeps the hot
  // loop free of a type test that can no longer be true.
  const ops = rpn as Array<Extract<Token, { t: 'num' } | { t: 'band' } | { t: 'op' }>>
  const stack = new Float64Array(rpn.length)
  return (bands: ArrayLike<number>): number => {
    let sp = 0
    for (const tk of ops) {
      if (tk.t === 'num') { stack[sp++] = tk.v; continue }
      if (tk.t === 'band') { stack[sp++] = bands[tk.i - 1] ?? NaN; continue }
      if (tk.v === 'u-') { stack[sp - 1] = -stack[sp - 1]; continue }
      const b = stack[--sp]
      const a = stack[--sp]
      stack[sp++] =
        tk.v === '+' ? a + b :
        tk.v === '-' ? a - b :
        tk.v === '*' ? a * b :
        a / b
    }
    return stack[0]
  }
}

/** Convert a `SPECTRAL_INDEX_TILE_CONFIG` template (`BAND0`, `BAND1`, …) into
 *  titiler's positional form (`b1`, `b2`, …) — the exact substitution the
 *  tile/statistics paths already perform, kept in one place. */
export function toPositionalExpression(template: string): string {
  return template.replace(/BAND(\d)/g, (_, i) => `b${Number(i) + 1}`)
}
