import { describe, expect, it } from 'vitest'
import { dedupeEntries, identityKey, productCodeKey, titleSimilarity } from '../dedupe'
import type { DatasetEntry } from '../types'

function entry(id: string, over: Partial<DatasetEntry> = {}): DatasetEntry {
  const source = id.slice(0, id.indexOf(':'))
  return {
    id, title: id, description: '', source, providers: [], themes: [], variables: [],
    spatial: { bbox: [-180, -90, 180, 90], global: true }, temporal: { start: '2015-01-01', end: null },
    resolution_m: null, license: 'various',
    access: { kind: 'stac-cog', url: `https://${source}.test/${id}`, requires_auth: null, notes: '' },
    keywords: [], ...over,
  }
}

describe('product codes', () => {
  it.each([
    ['cmr:LPCLOUD/MOD13A1_061', 'mod13a1:061'],
    ['gee:MODIS/061/MOD13A1', 'mod13a1:061'],
    ['planetary-computer:modis-13A1-061', 'mod13a1:061'],
    ['planetary-computer:modis-64A1-061', 'mcd64a1:061'],
    ['cmr:LPCLOUD/MCD64A1_061', 'mcd64a1:061'],
  ])('%s -> %s', (id, key) => {
    expect(productCodeKey(entry(id))).toBe(key)
  })
  it('does not equate different collection versions', () => {
    expect(productCodeKey(entry('cmr:LPCLOUD/MOD13A1_006'))).not.toBe(productCodeKey(entry('cmr:LPCLOUD/MOD13A1_061')))
  })
})

describe('dedupeEntries', () => {
  it('folds the same dataset on several catalogs into one entry with alternates', () => {
    const { entries, merged } = dedupeEntries([
      entry('gee:COPERNICUS/S2_SR_HARMONIZED', { resolution_m: 10 }),
      entry('planetary-computer:sentinel-2-l2a', { resolution_m: null, themes: ['optical'] }),
      entry('element84:sentinel-2-l2a'),
      entry('cdse:sentinel-2-l2a'),
    ])
    expect(merged).toBe(3)
    expect(entries).toHaveLength(1)
    const e = entries[0]
    expect(e.id).toBe('planetary-computer:sentinel-2-l2a') // highest-priority route is primary
    expect(e.alternates?.map((a) => a.id).sort()).toEqual(['cdse:sentinel-2-l2a', 'element84:sentinel-2-l2a', 'gee:COPERNICUS/S2_SR_HARMONIZED'])
    expect(e.resolution_m).toBe(10) // filled from an alternate
    expect(e.alternates!.find((a) => a.source === 'gee')!.access.url).toContain('gee.test')
  })

  it('merges MODIS products across PC, Earth Engine and CMR by product code + version', () => {
    const { entries } = dedupeEntries([
      entry('planetary-computer:modis-13A1-061'),
      entry('gee:MODIS/061/MOD13A1'),
      entry('cmr:LPCLOUD/MOD13A1_061'),
      entry('gee:MODIS/006/MOD13A1'),
    ])
    expect(entries).toHaveLength(2)
    expect(entries.find((e) => e.id === 'planetary-computer:modis-13A1-061')!.alternates).toHaveLength(2)
  })

  it('merges equal STAC ids only when the titles look alike', () => {
    const same = dedupeEntries([
      entry('planetary-computer:naip', { title: 'NAIP: National Agriculture Imagery Program' }),
      entry('element84:naip', { title: 'NAIP National Agriculture Imagery Program' }),
    ])
    expect(same.entries).toHaveLength(1)
    const different = dedupeEntries([
      entry('planetary-computer:landsat', { title: 'Landsat Collection 2 Level-2' }),
      entry('element84:landsat', { title: 'Totally unrelated glacier inventory' }),
    ])
    expect(different.entries).toHaveLength(2)
  })

  it('never merges two entries of the same catalog', () => {
    const { entries } = dedupeEntries([
      entry('cmr:LPCLOUD/MOD13A1_061'),
      entry('cmr:LAADS/MOD13A1_061'),
    ])
    expect(entries).toHaveLength(2)
  })

  it('leaves unrelated entries untouched and returns a stable id order', () => {
    const input = [entry('gee:Z/b'), entry('gee:A/a'), entry('overture:buildings')]
    const { entries, merged } = dedupeEntries(input)
    expect(merged).toBe(0)
    expect(entries.map((e) => e.id)).toEqual(['gee:A/a', 'gee:Z/b', 'overture:buildings'])
  })

  it('does not mutate its input', () => {
    const a = entry('planetary-computer:sentinel-2-l2a')
    const b = entry('element84:sentinel-2-l2a')
    dedupeEntries([a, b])
    expect(a.alternates).toBeUndefined()
  })

  it('identityKey is null for sources with no identity rule', () => {
    expect(identityKey(entry('overture:buildings'))).toBeNull()
  })

  it('title similarity is symmetric and bounded', () => {
    expect(titleSimilarity('Sentinel-2 Level-2A', 'Sentinel 2 level 2A')).toBeGreaterThan(0.5)
    expect(titleSimilarity('a b c', 'x y z')).toBe(0)
    expect(titleSimilarity('', 'x')).toBe(0)
  })
})
