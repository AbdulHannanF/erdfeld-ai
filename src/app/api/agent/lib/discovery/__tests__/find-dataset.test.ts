/** Phase 3 — dataset discovery (v2 spec §3.7).
 *
 *  > `find_dataset` federating STAC Index's 118 public catalogs (verified live,
 *  > no key) plus Planetary Computer, Element84, and LandsatLook, so the agent
 *  > can locate data it was not pre-wired for.
 *
 *  Verified live 2026-08-10: STAC Index returns 118 catalogs (96 public, 58
 *  APIs); Planetary Computer exposes 135 collections, of which **72** cover
 *  Lahore and are not already wired into a GeoAgent tool.
 *
 *  The ranking is the part worth testing hard. A search that returns something
 *  for every query is the ISS-107 failure again — so these tests pin that
 *  irrelevant collections score zero and are dropped, not merely ranked last.
 */

import { describe, expect, it } from 'vitest'
import {
  collectionCoversBbox,
  isWiredAlready,
  rankCollections,
  scoreCollection,
  summariseExtent,
} from '../find-dataset'

const GLOBAL_BBOX: [number, number, number, number] = [-180, -90, 180, 90]
const LAHORE_BBOX: [number, number, number, number] = [74.30, 31.51, 74.34, 31.53]

const IO_LULC = {
  id: 'io-lulc-annual-v02',
  title: '10m Annual Land Use Land Cover (9-class) V2',
  description: 'Global land use and land cover maps at 10 m resolution derived from Sentinel-2.',
  keywords: ['land cover', 'land use', 'sentinel', 'global'],
  license: 'CC-BY-4.0',
  extent: { spatial: { bbox: [GLOBAL_BBOX] }, temporal: { interval: [['2017-01-01T00:00:00Z', null]] } },
}
const COP_DEM = {
  id: 'cop-dem-glo-30',
  title: 'Copernicus DEM GLO-30',
  description: 'Digital surface model at 30 metre resolution, global.',
  keywords: ['dem', 'elevation', 'terrain'],
  license: 'proprietary',
  extent: { spatial: { bbox: [GLOBAL_BBOX] }, temporal: { interval: [['2021-04-22T00:00:00Z', '2021-04-22T00:00:00Z']] } },
}
// NOTE: Planetary Computer's real 3dep-seamless entry declares the bbox
// [-174, -15, 164, 72] for data that only covers the United States — a near-global
// extent for a national dataset. Declared extents are therefore a necessary filter
// but NOT proof of coverage; only an item search settles it, which is what
// `use_dataset` does. This fixture uses an honest US bbox so the filter itself is
// what is under test here.
const US_ONLY = {
  id: '3dep-seamless',
  title: 'USGS 3DEP Seamless DEMs',
  description: 'Elevation data covering the United States.',
  keywords: ['dem', 'elevation'],
  license: 'proprietary',
  extent: { spatial: { bbox: [[-125, 24, -66, 50]] }, temporal: { interval: [[null, null]] } },
}
const GBIF = {
  id: 'gbif',
  title: 'Global Biodiversity Information Facility (GBIF)',
  description: 'Species occurrence records.',
  keywords: ['biodiversity', 'species'],
  license: 'CC-BY-4.0',
  extent: { spatial: { bbox: [GLOBAL_BBOX] }, temporal: { interval: [[null, null]] } },
}
// DEFECT 3 fixtures: real-shaped population and land-surface-temperature
// collections, used to prove the fix rejects a nonsense-mixed query while
// still answering a genuine one.
const WORLDPOP = {
  id: 'worldpop-population-density',
  title: 'WorldPop Global Population Density',
  description: 'Estimated number of people per grid cell, gridded to 100 m resolution.',
  keywords: ['population', 'density', 'demographics'],
  license: 'CC-BY-4.0',
  extent: { spatial: { bbox: [GLOBAL_BBOX] }, temporal: { interval: [['2020-01-01T00:00:00Z', null]] } },
}
const MODIS_LST = {
  id: 'modis-11a1-061',
  title: 'MODIS Land Surface Temperature/Emissivity Daily Global 1km',
  description: 'Daily per-pixel land surface temperature and emissivity.',
  keywords: ['land surface temperature', 'lst', 'thermal'],
  license: 'proprietary',
  extent: { spatial: { bbox: [GLOBAL_BBOX] }, temporal: { interval: [['2000-02-24T00:00:00Z', null]] } },
}

describe('collectionCoversBbox', () => {
  it('accepts a global collection over any AOI', () => {
    expect(collectionCoversBbox(IO_LULC, LAHORE_BBOX)).toBe(true)
  })

  it('rejects a US-only collection over Lahore', () => {
    expect(collectionCoversBbox(US_ONLY, LAHORE_BBOX)).toBe(false)
  })

  it('accepts a US-only collection over a US AOI', () => {
    expect(collectionCoversBbox(US_ONLY, [-74, 40.7, -73.9, 40.8])).toBe(true)
  })

  it('treats a missing extent as unknown coverage rather than assuming global', () => {
    expect(collectionCoversBbox({ id: 'x' }, LAHORE_BBOX)).toBe(false)
  })
})

describe('scoreCollection', () => {
  it('scores an on-topic collection above an off-topic one', () => {
    expect(scoreCollection(IO_LULC, 'land cover')).toBeGreaterThan(scoreCollection(GBIF, 'land cover'))
  })

  it('gives an unrelated collection ZERO, so it can be dropped rather than ranked', () => {
    expect(scoreCollection(GBIF, 'elevation')).toBe(0)
  })

  it('matches on the id as well as the title', () => {
    expect(scoreCollection(COP_DEM, 'cop-dem')).toBeGreaterThan(0)
  })

  it('matches a multi-word query when the words are spread across fields', () => {
    expect(scoreCollection(IO_LULC, 'global land use')).toBeGreaterThan(0)
  })

  it('is not fooled by a query word appearing only as a substring of another word', () => {
    // "dem" must not match "Modern" / "demand"; it should match the DEM collection.
    const decoy = { id: 'x', title: 'Modern demand modelling', description: '', keywords: [], extent: COP_DEM.extent }
    expect(scoreCollection(decoy, 'dem')).toBe(0)
    expect(scoreCollection(COP_DEM, 'dem')).toBeGreaterThan(0)
  })

  // DEFECT 3 (2026-08-17): "unicorn population density" returned real
  // population-density collections as confident matches. "population" and
  // "density" are genuine words that legitimately hit WorldPop-style
  // metadata — the bug was that a query only PARTLY covered by a collection
  // (2 of 3 terms) still scored above zero, so the unmatched "unicorn" was
  // silently dropped instead of disqualifying the match.
  it('gives ZERO to a query mixing a real subject with a nonsense term the collection never mentions', () => {
    expect(scoreCollection(WORLDPOP, 'unicorn population density')).toBe(0)
  })

  it('still matches the real query once the nonsense term is removed', () => {
    expect(scoreCollection(WORLDPOP, 'population density')).toBeGreaterThan(0)
  })

  it('keeps a genuinely good multi-word query working — "land surface temperature"', () => {
    expect(scoreCollection(MODIS_LST, 'land surface temperature')).toBeGreaterThan(0)
  })
})

describe('isWiredAlready', () => {
  it('flags collections GeoAgent already has a dedicated tool for', () => {
    expect(isWiredAlready('sentinel-2-l2a')).toBe(true)
    expect(isWiredAlready('landsat-c2-l2')).toBe(true)
    expect(isWiredAlready('esa-worldcover')).toBe(true)
  })

  it('does not flag genuinely new datasets', () => {
    expect(isWiredAlready('io-lulc-annual-v02')).toBe(false)
    expect(isWiredAlready('chloris-biomass')).toBe(false)
    expect(isWiredAlready('cop-dem-glo-30')).toBe(false)
  })
})

describe('rankCollections', () => {
  const catalog = { id: 'pc', name: 'Planetary Computer', url: 'https://example/stac/v1' }
  const all = [IO_LULC, COP_DEM, US_ONLY, GBIF].map((c) => ({ catalog, collection: c }))

  it('returns only collections that both match AND cover the AOI', () => {
    const out = rankCollections(all, 'elevation', LAHORE_BBOX)
    expect(out.map((r) => r.collection.id)).toEqual(['cop-dem-glo-30'])
  })

  it('drops zero-score matches entirely — a search must be able to return nothing', () => {
    expect(rankCollections(all, 'quokka census', LAHORE_BBOX)).toEqual([])
  })

  it('orders by score, best first', () => {
    const out = rankCollections(all, 'land cover global', LAHORE_BBOX)
    expect(out.length).toBeGreaterThan(0)
    expect(out[0].collection.id).toBe('io-lulc-annual-v02')
    for (let i = 1; i < out.length; i++) expect(out[i].score).toBeLessThanOrEqual(out[i - 1].score)
  })

  it('marks which hits GeoAgent already covers, without hiding them', () => {
    const withWired = [...all, { catalog, collection: { ...IO_LULC, id: 'esa-worldcover', title: 'ESA WorldCover' } }]
    const out = rankCollections(withWired, 'land cover', LAHORE_BBOX)
    const wired = out.find((r) => r.collection.id === 'esa-worldcover')
    expect(wired?.alreadyWired).toBe(true)
    expect(out.some((r) => !r.alreadyWired)).toBe(true)
  })

  it('excludes a US-only collection from a Lahore search even on a perfect keyword match', () => {
    const out = rankCollections(all, '3dep-seamless', LAHORE_BBOX)
    expect(out).toEqual([])
  })

  // DEFECT 3 (2026-08-17): the end-to-end path a `find_dataset` call takes.
  it('returns an honest empty result for "unicorn population density" instead of real population hits', () => {
    const withPop = [...all, { catalog, collection: WORLDPOP }]
    expect(rankCollections(withPop, 'unicorn population density', LAHORE_BBOX)).toEqual([])
  })

  it('still returns the real population collection once the query is sane', () => {
    const withPop = [...all, { catalog, collection: WORLDPOP }]
    const out = rankCollections(withPop, 'population density', LAHORE_BBOX)
    expect(out.map((r) => r.collection.id)).toEqual(['worldpop-population-density'])
  })

  it('still returns a genuinely good query — "land surface temperature"', () => {
    const withLst = [...all, { catalog, collection: MODIS_LST }]
    const out = rankCollections(withLst, 'land surface temperature', LAHORE_BBOX)
    expect(out.map((r) => r.collection.id)).toEqual(['modis-11a1-061'])
  })
})

describe('summariseExtent', () => {
  it('describes a global, open-ended collection', () => {
    const s = summariseExtent(IO_LULC)
    expect(s).toMatch(/global/i)
    expect(s).toMatch(/2017/)
  })

  it('describes a bounded region', () => {
    expect(summariseExtent(US_ONLY)).not.toMatch(/global/i)
  })
})
