import { describe, expect, it } from 'vitest'
import { barSpec, histogramSpec, isDateSeries, lineSpec, seriesSpec, specHasFid, withHighlight } from '../chart-spec'

describe('chart templates', () => {
  const dated = [{ label: '2025-05-01', value: 0.3 }, { label: '2025-06-01', value: 0.5 }]
  const cats = [{ label: 'Trees', value: 60 }, { label: 'Crops', value: 40 }]

  it('picks a line for dated series and bars otherwise (one auto-chart path)', () => {
    expect(isDateSeries(dated)).toBe(true)
    expect(isDateSeries(cats)).toBe(false)
    expect(seriesSpec(dated).mark).toMatchObject({ type: 'line' })
    expect(seriesSpec(dated).encoding.x.type).toBe('temporal')
    expect(seriesSpec(cats).mark).toMatchObject({ type: 'bar' })
  })
  it('carries the real values and keeps category order', () => {
    expect(barSpec(cats).data.values).toEqual(cats)
    expect(barSpec(cats).encoding.x.sort).toBeNull()
    expect(lineSpec(cats, { area: true }).mark.type).toBe('area')
  })
  it('histogram adds a modal rule layer only when a mode exists', () => {
    const bins = [{ bin: 0.1, pixels: 5 }, { bin: 0.2, pixels: 9 }]
    expect(histogramSpec(bins).layer).toBeUndefined()
    expect(histogramSpec(bins, { modal: 0.2 }).layer).toHaveLength(2)
  })
})

describe('map link', () => {
  const linked = { data: { values: [{ _fid: 0, v: 1 }] }, mark: 'point', encoding: { x: { field: 'v', type: 'quantitative' } } }

  it('detects feature ids in inline rows', () => {
    expect(specHasFid(linked)).toBe(true)
    expect(specHasFid({ data: { values: [{ v: 1 }] }, mark: 'point' })).toBe(false)
  })
  it('withHighlight adds the signal param and dims non-selected marks', () => {
    const h = withHighlight(linked)
    expect(h.params).toEqual([{ name: 'hlFid', value: null }])
    expect(h.encoding.opacity.condition.test).toBe('hlFid === null || datum._fid === hlFid')
    expect(h.encoding.opacity.value).toBe(0.25)
    expect(linked).not.toHaveProperty('params')
  })
  it('respects an existing opacity encoding and leaves encoding-less layers alone', () => {
    const own = { ...linked, encoding: { ...linked.encoding, opacity: { value: 0.5 } } }
    expect(withHighlight(own).encoding.opacity).toEqual({ value: 0.5 })
    const layered = withHighlight({ layer: [linked, { mark: 'rule' }] })
    expect(layered.layer[0].encoding.opacity).toBeDefined()
    expect(layered.layer[1]).toEqual({ mark: 'rule' })
  })
})
