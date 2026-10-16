import { describe, expect, it } from 'vitest'
import { parseCoordinates } from '../coordinates'

describe('parseCoordinates', () => {
  it('reads decimal pairs, latitude first', () => {
    expect(parseCoordinates('31.13, 74.06')).toEqual({ kind: 'ok', lat: 31.13, lng: 74.06 })
    expect(parseCoordinates('31.13 74.06')).toEqual({ kind: 'ok', lat: 31.13, lng: 74.06 })
    expect(parseCoordinates('-33.9, 18.4')).toEqual({ kind: 'ok', lat: -33.9, lng: 18.4 })
  })
  it('reads hemisphere letters, before or after, and honours a longitude-first order that names its axes', () => {
    expect(parseCoordinates('36.1N 112.12W')).toEqual({ kind: 'ok', lat: 36.1, lng: -112.12 })
    expect(parseCoordinates('N36.1, W112.12')).toEqual({ kind: 'ok', lat: 36.1, lng: -112.12 })
    expect(parseCoordinates('74.06E 31.13N')).toEqual({ kind: 'ok', lat: 31.13, lng: 74.06 })
    expect(parseCoordinates('33.9 S, 18.4 E')).toEqual({ kind: 'ok', lat: -33.9, lng: 18.4 })
  })
  it('refuses an out-of-range value instead of swapping it', () => {
    const r = parseCoordinates('74.06, 31.13')
    expect(r).toEqual({ kind: 'ok', lat: 74.06, lng: 31.13 })
    const bad = parseCoordinates('112.12, 36.1')
    expect(bad.kind).toBe('invalid')
    expect(parseCoordinates('10, 200').kind).toBe('invalid')
    expect(parseCoordinates('10N, 20N').kind).toBe('invalid')
  })
  it('leaves place names and single numbers to the place search', () => {
    expect(parseCoordinates('Grand Canyon').kind).toBe('none')
    expect(parseCoordinates('42').kind).toBe('none')
    expect(parseCoordinates('').kind).toBe('none')
    expect(parseCoordinates('Route 66, Arizona').kind).toBe('none')
  })
})
