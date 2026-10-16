import { describe, expect, it } from 'vitest'
import { ExpressionError, compile, evaluate, filterRows, type Row } from '../expression'

const row = (props: Record<string, unknown>, geom: Row['geom'] = () => null): Row => ({ props, geom })
const run = (src: string, props: Record<string, unknown> = {}) => evaluate(compile(src).node, row(props))

describe('expression: values and arithmetic', () => {
  it('evaluates literals and precedence', () => {
    expect(run('1 + 2 * 3')).toBe(7)
    expect(run('(1 + 2) * 3')).toBe(9)
    expect(run('-2 + 5')).toBe(3)
    expect(run('10 % 4')).toBe(2)
    expect(run("'a' + 'b'")).toBe('ab')
  })
  it('division by zero is NULL, not Infinity', () => {
    expect(run('1 / 0')).toBeNull()
  })
  it('reads fields, quoted names and dotted names', () => {
    expect(run('a + b', { a: 2, b: 3 })).toBe(5)
    expect(run('"Flood depth" * 2', { 'Flood depth': 1.5 })).toBe(3)
    expect(run('`my field` = 1', { 'my field': 1 })).toBe(true)
    expect(run('props.x > 1', { 'props.x': 2 })).toBe(true)
  })
})

describe('expression: comparison and three-valued logic', () => {
  it('a missing field never matches either side of a comparison', () => {
    expect(run('x > 3', {})).toBeNull()
    expect(run('x <= 3', {})).toBeNull()
    expect(run('x = x', {})).toBeNull()
  })
  it('AND / OR follow SQL NULL rules', () => {
    expect(run('x > 3 AND 1 = 2', {})).toBe(false)
    expect(run('x > 3 OR 1 = 1', {})).toBe(true)
    expect(run('x > 3 OR 1 = 2', {})).toBeNull()
    expect(run('NOT (x > 3)', {})).toBeNull()
  })
  it('compares numeric strings as numbers (CSV imports)', () => {
    expect(run('conf > 0.5', { conf: '0.8' })).toBe(true)
    expect(run("name = 'Dry 2'", { name: 'Dry 2' })).toBe(true)
  })
  it('IS NULL, IN, BETWEEN, LIKE', () => {
    expect(run('x IS NULL', {})).toBe(true)
    expect(run('x IS NOT NULL', { x: 0 })).toBe(true)
    expect(run("c IN ('a','b')", { c: 'b' })).toBe(true)
    expect(run("c NOT IN ('a','b')", { c: 'z' })).toBe(true)
    expect(run('n BETWEEN 1 AND 3', { n: 3 })).toBe(true)
    expect(run('n NOT BETWEEN 1 AND 3', { n: 4 })).toBe(true)
    expect(run("name LIKE 'Fie%'", { name: 'Field 7' })).toBe(true)
    expect(run("name LIKE 'fie%'", { name: 'Field 7' })).toBe(false)
    expect(run("name ILIKE 'fie%'", { name: 'Field 7' })).toBe(true)
    expect(run("name LIKE 'F_eld%'", { name: 'Field 7' })).toBe(true)
  })
  it('LIKE escapes regex characters in the pattern', () => {
    expect(run("name LIKE 'a.c'", { name: 'abc' })).toBe(false)
    expect(run("name LIKE 'a.c'", { name: 'a.c' })).toBe(true)
  })
})

describe('expression: functions and geometry values', () => {
  it('has a small set of functions', () => {
    expect(run('round(2.567, 1)')).toBe(2.6)
    expect(run("upper('ab')")).toBe('AB')
    expect(run("length('abcd')")).toBe(4)
    expect(run('coalesce(x, 7)', {})).toBe(7)
    expect(run('max(1, 5, 3)')).toBe(5)
    expect(run('sqrt(-1)')).toBeNull()
  })
  it('reads $area and the other geometry values from the row', () => {
    const r = row({}, (n) => (n === '$area' ? 2.5 : null))
    expect(evaluate(compile('$area > 2').node, r)).toBe(true)
    expect(evaluate(compile('$length > 2').node, r)).toBeNull()
  })
})

describe('expression: refusals', () => {
  it('reports the position of a syntax error', () => {
    try {
      compile('a > ')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ExpressionError)
      expect((e as ExpressionError).message).toMatch(/ends early/)
    }
    expect(() => compile('a >> 1')).toThrow(/Unexpected/)
    expect(() => compile("a = 'x")).toThrow(/Unterminated text/)
    expect(() => compile('(a = 1')).toThrow(/Expected "\)"/)
    expect(() => compile('')).toThrow(/Type an expression/)
  })
  it('refuses unknown functions and geometry values', () => {
    expect(() => compile('eval(1)')).toThrow(/Unknown function/)
    expect(() => compile('$foo > 1')).toThrow(/Unknown geometry value/)
    expect(() => compile('abs(1, 2)')).toThrow(/takes 1 argument/)
  })
  it('cannot reach anything but the row: no property access, no calls through fields', () => {
    expect(() => compile('constructor.constructor("return 1")()')).toThrow()
    expect(run('constructor', {})).toBeNull()
    expect(run('__proto__', {})).toBeNull()
  })
})

describe('filterRows', () => {
  const rows = [row({ c: 'crop', n: 1 }), row({ c: 'grass', n: 5 }), row({ c: 'crop' }), row({ c: 'water', n: 9 })]
  it('selects, counts unknowns and names fields no feature has', () => {
    const r = filterRows("c = 'crop' AND n > 0", rows)
    expect(r.matches).toEqual([0])
    expect(r.unknown).toBe(1)
    expect(r.missingFields).toEqual([])
    expect(filterRows('colour = 1', rows).missingFields).toEqual(['colour'])
  })
})
