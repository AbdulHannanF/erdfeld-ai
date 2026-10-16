import { describe, it, expect } from 'vitest'
import { detectionStats } from '../detection-stats'

const poly = { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }
const fc = (props: Record<string, unknown>[]) => ({
  type: 'FeatureCollection' as const,
  features: props.map((properties) => ({ type: 'Feature' as const, properties, geometry: poly })),
})

describe('detectionStats', () => {
  it('summarises CV detection layers by label', () => {
    const s = detectionStats([
      { id: 'cv-solar_panel-1', tool: 'run_cv_detector', geojson: fc([{ label: 'solar_panel', confidence: 0.8 }, { label: 'solar_panel', confidence: 0.6 }]) },
      { id: 'perception-2', geojson: fc([{ label: 'building', confidence: 0.9 }]) },
    ])
    expect(s).toEqual([{ label: 'solar_panel', count: 2, confidence: 70 }, { label: 'building', count: 1, confidence: 90 }])
  })

  it('ignores delineated fields and other polygon layers that carry confidence + class', () => {
    const fields = fc([{ class: 'winter_crop', confidence: 0.7 }, { class: 'non_field', confidence: 0.4 }])
    expect(detectionStats([{ id: 'fields-1', tool: 'delineate_fields', geojson: fields }])).toEqual([])
    expect(detectionStats([{ id: 'fields-1', geojson: fields }])).toEqual([])
    expect(detectionStats([{ id: 'osm-1', tool: 'query_osm', geojson: fc([{ label: 'x', confidence: 0.5 }]) }])).toEqual([])
  })
})
