import { describe, expect, it } from 'vitest'

import { chartDataNames, pickableResults } from '../pickable-results'

const A = 'r_aaaaaaaaaaaaaaaa'
const B = 'r_bbbbbbbbbbbbbbbb'
const C = 'r_cccccccccccccccc'
const tr = (resultId: string, tool: string, keys: string[]) => ({ tool, resultId, summaryData: Object.fromEntries(keys.map((k) => [k, 1])) })
const vec = { resultId: B, name: 'Buildings (25)', type: 'geojson', geojson: { features: [{}] } }

describe('pickableResults', () => {
  it('lists stored results newest first, with the figures a chart can name', () => {
    const list = pickableResults({ [A]: tr(A, 'fetch_ndvi', ['mean']), [B]: tr(B, 'query_3d_tiles', ['building_count']) }, [vec])
    expect(list.map((r) => r.resultId)).toEqual([B, A])
    expect(list[0]).toMatchObject({ label: 'Query 3d tiles · Buildings (25)', keys: ['building_count'], hasFeatures: true })
    expect(chartDataNames(list[0])).toEqual([`${B}#building_count`, `${B}#features`])
    expect(chartDataNames(list[1])).toEqual([`${A}#mean`])
  })

  it('a restyle only offers results with a vector layer on the map', () => {
    const list = pickableResults({ [A]: tr(A, 'fetch_ndvi', ['mean']), [B]: tr(B, 'query_3d_tiles', []) }, [vec], { vectorOnly: true })
    expect(list.map((r) => r.resultId)).toEqual([B])
  })

  it('ignores results the evidence store cannot hold (ids that are not content hashes) and empty ones', () => {
    const list = pickableResults({ 'classify_land_cover-1': tr('classify_land_cover-1', 'x', ['a']), [C]: tr(C, 'noop', []) }, [{ resultId: 'layer-9', name: 'x', type: 'geojson', geojson: { features: [{}] } }])
    expect(list).toEqual([])
  })

  it('a layer without a figure record is still pickable by its name', () => {
    expect(pickableResults({}, [vec]).map((r) => [r.resultId, r.label])).toEqual([[B, 'Buildings (25)']])
  })
})
