import { describe, expect, it } from 'vitest'
import {
  classifyAoiSize,
  EXCESSIVE_AOI_KM2,
  LARGE_AOI_KM2,
} from '../aoi-guard'

describe('classifyAoiSize', () => {
  describe('thresholds', () => {
    it('exports the documented thresholds', () => {
      expect(LARGE_AOI_KM2).toBe(50)
      expect(EXCESSIVE_AOI_KM2).toBe(5000)
    })
  })

  describe("'ok' tier", () => {
    it('classifies a small area as ok with no warning and no refusal', () => {
      const result = classifyAoiSize(1)
      expect(result.tier).toBe('ok')
      expect(result.warning).toBeNull()
      expect(result.shouldRefuse).toBe(false)
    })

    it('classifies exactly 50 km² (the boundary) as ok', () => {
      const result = classifyAoiSize(50)
      expect(result.tier).toBe('ok')
      expect(result.warning).toBeNull()
      expect(result.shouldRefuse).toBe(false)
    })
  })

  describe("'large' tier", () => {
    it('classifies just above 50 km² as large with a warning and no refusal', () => {
      const result = classifyAoiSize(50.001)
      expect(result.tier).toBe('large')
      expect(result.warning).toBeTruthy()
      expect(result.shouldRefuse).toBe(false)
    })

    it('classifies exactly 5000 km² (the boundary) as large', () => {
      const result = classifyAoiSize(5000)
      expect(result.tier).toBe('large')
      expect(result.warning).toBeTruthy()
      expect(result.shouldRefuse).toBe(false)
    })
  })

  describe("'excessive' tier", () => {
    it('classifies just above 5000 km² as excessive and refuses', () => {
      const result = classifyAoiSize(5000.001)
      expect(result.tier).toBe('excessive')
      expect(result.warning).toBeTruthy()
      expect(result.shouldRefuse).toBe(true)
    })

    it('classifies the QA-reported 23,315,369 km² as excessive and refuses', () => {
      const result = classifyAoiSize(23_315_369)
      expect(result.tier).toBe('excessive')
      expect(result.shouldRefuse).toBe(true)
    })
  })

  describe('bad input (never throws, always refuses)', () => {
    const badInputs: Array<[string, unknown]> = [
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
      ['negative', -1],
      ['zero', 0],
      ['string', '50'],
      ['null', null],
      ['undefined', undefined],
      ['object', {}],
      ['array', [50]],
    ]

    it.each(badInputs)('handles %s safely', (_label, input) => {
      const result = classifyAoiSize(input as number)
      expect(result.tier).toBe('excessive')
      expect(result.warning).toBeTruthy()
      expect(result.shouldRefuse).toBe(true)
    })
  })
})
