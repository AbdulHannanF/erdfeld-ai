import { describe, expect, it } from 'vitest'
import { compactEntry, expandEntry } from '../compact'
import { curatedEntries } from '../curated'
import { cmrCollectionToEntry, geeCollectionToEntry, openTopographyToEntry, stacCollectionToEntry } from '../normalize'
import type { DatasetEntry } from '../types'

const bbox = { spatial: { bbox: [[-180, -90, 180, 90]] }, temporal: { interval: [['2000-01-01T00:00:00Z', null]] } }

describe('compact snapshot form', () => {
  const samples: DatasetEntry[] = [
    ...curatedEntries(),
    stacCollectionToEntry({ id: 'cop-dem-glo-30', title: 'Copernicus DEM GLO-30', description: 'DEM', extent: bbox.spatial && { ...bbox }, license: 'proprietary', item_assets: { d: { type: 'image/tiff; application=geotiff; profile=cloud-optimized' } } }, { source: 'planetary-computer', root: 'https://planetarycomputer.microsoft.com/api/stac/v1', auth: null })!,
    cmrCollectionToEntry({ id: 'MOD13A1_061', title: 'MODIS Terra VI 500m', description: 'x', keywords: ['VEGETATION'], extent: bbox }, 'LPCLOUD', 'https://cmr.earthdata.nasa.gov/stac')!,
    geeCollectionToEntry({ id: 'A/B', title: 'Thing 30 m', description: 'x', extent: bbox, license: 'CC-BY-4.0', 'gee:type': 'image_collection' })!,
    openTopographyToEntry({ Dataset: { name: 'Lidar X', identifier: { value: 'OTLAS.1' }, temporalCoverage: '2020-01-01', spatialCoverage: { geo: { geojson: { features: [{ geometry: { coordinates: [[[1, 1], [2, 1], [2, 2], [1, 1]]] } }] } } } } }, 'PointCloud')!,
    openTopographyToEntry({ Dataset: { name: 'DEM Y', identifier: { value: 'OTSDEM.2' }, spatialCoverage: { geo: { geojson: { features: [{ geometry: { coordinates: [[[1, 1], [2, 1], [2, 2], [1, 1]]] } }] } } } } }, 'Raster')!,
  ]

  it.each(samples.map((e) => [e.id, e] as const))('round-trips %s exactly', (_id, e) => {
    expect(expandEntry(JSON.parse(JSON.stringify(compactEntry(e))))).toEqual(e)
  })

  it('drops fields that equal their source default', () => {
    const cmr = samples.find((e) => e.id.startsWith('cmr:'))!
    const c = compactEntry(cmr)
    expect(c.a).toBeUndefined() // kind, url, auth and notes all derivable
    expect(c.l).toBeUndefined() // licence "various"
    expect(JSON.stringify(c).length).toBeLessThan(JSON.stringify(cmr).length * 0.7)
  })

  it('keeps an explicit "no auth" on a source whose default needs auth', () => {
    const e = { ...samples.find((x) => x.id.startsWith('cmr:'))!, access: { kind: 'stac-other' as const, url: 'https://x.test/y', requires_auth: null, notes: 'open copy' } }
    const back = expandEntry(JSON.parse(JSON.stringify(compactEntry(e))))
    expect(back.access.requires_auth).toBeNull()
    expect(back.access.url).toBe('https://x.test/y')
  })

  it('preserves alternates', () => {
    const e = { ...samples[0], alternates: [{ source: 'gee', id: 'gee:A/B', access: { kind: 'earthengine' as const, url: 'https://g.test', requires_auth: 'earthengine' as const, notes: 'n' } }] }
    expect(expandEntry(JSON.parse(JSON.stringify(compactEntry(e)))).alternates).toEqual(e.alternates)
  })
})
