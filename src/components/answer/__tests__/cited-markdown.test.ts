import { describe, expect, it } from 'vitest'
import { markerStandsInForFigure } from '../CitedMarkdown'

describe('markerStandsInForFigure', () => {
  it('prints the value when the sentence leaves the number out ("holds [..] fields over [..] ha")', () => {
    expect(markerStandsInForFigure('This area holds ')).toBe(true)
    expect(markerStandsInForFigure(' fields over ')).toBe(true)
    expect(markerStandsInForFigure('')).toBe(true)
  })

  it('keeps the footnote number when the number is already written before the marker', () => {
    expect(markerStandsInForFigure('Mean NDVI was 0.42')).toBe(false)
    expect(markerStandsInForFigure('covering 64%')).toBe(false)
    expect(markerStandsInForFigure('a mean of 412.4 m')).toBe(false)
    expect(markerStandsInForFigure('over 142 ha ')).toBe(false)
  })
})
