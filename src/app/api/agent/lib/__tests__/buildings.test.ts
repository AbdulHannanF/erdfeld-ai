import { describe, expect, it } from 'vitest'
import { buildingTypeColor, parseBuildingHeight } from '../buildings'

describe('parseBuildingHeight', () => {
  it('parses an explicit metric height', () => {
    expect(parseBuildingHeight({ height: '24' })).toEqual({ height: 24, source: 'explicit' })
  })

  it('parses an explicit imperial (ft) height and converts to meters', () => {
    const { height, source } = parseBuildingHeight({ height: '100ft' })
    expect(source).toBe('explicit')
    expect(height).toBeCloseTo(30.48, 1)
  })

  it('strips spaces from height values', () => {
    expect(parseBuildingHeight({ height: '  18 ' })).toEqual({ height: 18, source: 'explicit' })
  })

  it('falls back to levels × 3.5 when no height tag is set', () => {
    expect(parseBuildingHeight({ 'building:levels': '4' })).toEqual({ height: 14, source: 'levels' })
  })

  it('returns the tower default for tower/skyscraper types', () => {
    expect(parseBuildingHeight({ building: 'skyscraper' })).toEqual({ height: 30, source: 'type_default' })
    expect(parseBuildingHeight({ building: 'tower' })).toEqual({ height: 30, source: 'type_default' })
  })

  it('returns the residential apartments default', () => {
    expect(parseBuildingHeight({ building: 'apartments' })).toEqual({ height: 12, source: 'type_default' })
  })

  it('returns the generic 8m default for unknown building types', () => {
    expect(parseBuildingHeight({ building: 'mystery' })).toEqual({ height: 8, source: 'type_default' })
  })

  it('falls back to type default when height tag is unparseable', () => {
    const result = parseBuildingHeight({ height: 'tall', building: 'house' })
    expect(result.source).toBe('type_default')
    expect(result.height).toBe(6)
  })
})

describe('buildingTypeColor', () => {
  it('maps commercial buildings to amber', () => {
    expect(buildingTypeColor({ building: 'commercial' })).toBe('#f59e0b')
  })

  it('maps residential buildings to blue', () => {
    expect(buildingTypeColor({ building: 'apartments' })).toBe('#60a5fa')
  })

  it('falls back to neutral slate for unknown types', () => {
    expect(buildingTypeColor({ building: 'mystery' })).toBe('#94a3b8')
  })
})
