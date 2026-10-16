import { describe, expect, it } from 'vitest'
import { RegistryIndex, coverageVerdict, expandQuery, isOpenLicense, overlapsTime, stem, tokenize } from '../search'
import type { DatasetEntry, Theme } from '../types'

function e(id: string, title: string, over: Partial<DatasetEntry> = {}): DatasetEntry {
  const source = id.slice(0, id.indexOf(':'))
  return {
    id, title, description: '', source, providers: [], themes: [], variables: [],
    spatial: { bbox: [-180, -90, 180, 90], global: true }, temporal: { start: '2000-01-01', end: null },
    resolution_m: null, license: 'CC-BY-4.0',
    access: { kind: 'stac-cog', url: 'https://x.test', requires_auth: null, notes: '' }, keywords: [], ...over,
  }
}

const US: [number, number, number, number] = [-125, 24, -66, 50]

const ENTRIES: DatasetEntry[] = [
  e('a:srtm', 'NASA SRTM Digital Elevation 30m', { themes: ['elevation'], resolution_m: 30, keywords: ['dem', 'srtm', 'elevation'] }),
  e('a:nasadem', 'NASADEM Merged DEM Global 1 arc second', { themes: ['elevation'], resolution_m: 31, keywords: ['dem'] }),
  e('a:ned', 'USGS National Elevation Dataset', { themes: ['elevation'], resolution_m: 10, spatial: { bbox: US, global: false }, license: 'public-domain' }),
  e('a:smap', 'SMAP L3 Soil Moisture Active Passive 9 km', { themes: ['soil', 'hydrology'], resolution_m: 9000, access: { kind: 'stac-other', url: 'u', requires_auth: 'earthdata', notes: '' } }),
  e('a:soilgrids', 'SoilGrids 2.0 soil properties', { themes: ['soil'], resolution_m: 250, keywords: ['clay', 'sand'] }),
  e('a:hansen', 'Hansen Global Forest Change tree cover loss', { themes: ['forest'], resolution_m: 30, temporal: { start: '2000-01-01', end: '2023-12-31' } }),
  e('a:old', 'Historic land cover 1975', { themes: ['land-cover'], temporal: { start: '1975-01-01', end: '1976-01-01' }, license: 'proprietary' }),
  e('a:worldpop', 'WorldPop population counts', { themes: ['population'], resolution_m: 100 }),
  e('a:noisy', 'Elevation of things', { themes: ['elevation'], description: 'dem '.repeat(50) }),
]

describe('tokenizer', () => {
  it('stems plurals lightly', () => {
    expect(stem('buildings')).toBe('building')
    expect(stem('glaciers')).toBe('glacier')
    expect(stem('boundaries')).toBe('boundary')
    expect(stem('gas')).toBe('gas')
    expect(stem('analysis')).toBe('analysis')
  })
  it('joins letter+digit and digit+unit pairs', () => {
    expect(tokenize('Sentinel-2 L2A')).toContain('sentinel2')
    expect(tokenize('30 m DEM')).toContain('30m')
    expect(tokenize('30m DEM')).toContain('30m')
    expect(tokenize('PM2.5')).toContain('pm25')
    expect(tokenize('L-band SAR')).toContain('lband')
  })
  it('drops single letters and (optionally) stop words', () => {
    expect(tokenize('a b of data', { dropStop: true })).toEqual([])
  })
})

describe('query expansion', () => {
  it('expands domain vocabulary but keeps the typed words primary', () => {
    const q = expandQuery('soil moisture')
    expect(q.primary).toEqual(['soil', 'moisture'])
    expect(q.expanded).toContain('smap')
    expect(q.themes).toContain('soil')
  })
  it.each([
    ['deforestation', ['hansen', 'radd', 'glad']],
    ['population', ['worldpop', 'ghsl', 'kontur']],
    ['canopy height', ['gedi']],
    ['flood', ['sentinel1']],
    ['subsidence', ['insar']],
    ['srtm', ['nasadem']],
  ])('"%s" expands to include %j', (q, terms) => {
    const { expanded } = expandQuery(q)
    for (const t of terms) expect(expanded.join(' ')).toContain(t)
  })
  it('supports both-words-anywhere rules', () => {
    expect(expandQuery('how bright is the city at night').expanded).toContain('black')
  })
})

describe('RegistryIndex.search', () => {
  const idx = new RegistryIndex(ENTRIES)

  it('ranks the best title match first', () => {
    const r = idx.search('NASADEM')
    expect(r.hits[0].entry.id).toBe('a:nasadem')
  })

  it('uses synonyms to bridge vocabulary ("srtm" finds NASADEM too)', () => {
    const ids = idx.search('srtm').hits.map((h) => h.entry.id)
    expect(ids).toContain('a:srtm')
    expect(ids).toContain('a:nasadem')
  })

  it('answers a domain question via expansion ("soil moisture" -> SMAP)', () => {
    expect(idx.search('soil moisture').hits[0].entry.id).toBe('a:smap')
  })

  it('does not let a stuffed description outrank a title match', () => {
    const r = idx.search('digital elevation model 30 m')
    expect(r.hits[0].entry.id).toBe('a:srtm')
  })

  it('AOI filter: global datasets always pass, regional ones need an intersection', () => {
    const inUS = idx.search('elevation', { aoi: [-100, 35, -99, 36] }).hits.map((h) => h.entry.id)
    expect(inUS).toContain('a:ned')
    const inEurope = idx.search('elevation', { aoi: [5, 45, 6, 46] }).hits.map((h) => h.entry.id)
    expect(inEurope).not.toContain('a:ned')
    expect(inEurope).toContain('a:srtm')
  })

  it('reports a coverage verdict', () => {
    expect(coverageVerdict(ENTRIES[2], [-100, 35, -99, 36])).toBe('covers')
    expect(coverageVerdict(ENTRIES[2], [-130, 35, -120, 36])).toBe('partial')
    expect(coverageVerdict(ENTRIES[2], [5, 45, 6, 46])).toBeNull()
    expect(coverageVerdict(ENTRIES[0], [5, 45, 6, 46])).toBe('global')
    expect(coverageVerdict(ENTRIES[2], undefined)).toBe('unknown')
  })

  it('handles boxes that cross the antimeridian (minLon > maxLon)', () => {
    const fiji = e('a:fiji', 'Fiji', { spatial: { bbox: [170, -22, -175, -12], global: false } })
    expect(coverageVerdict(fiji, [178, -19, 179, -18])).toBe('covers')
    expect(coverageVerdict(fiji, [-179, -19, -178, -18])).toBe('covers')
    expect(coverageVerdict(fiji, [100, -19, 110, -18])).toBeNull()
    expect(coverageVerdict(fiji, [160, -19, 175, -18])).toBe('partial')
  })

  it('time filter: overlap semantics, open-ended datasets, unknown start passes', () => {
    expect(overlapsTime(ENTRIES[5], { start: '2010', end: '2012' })).toBe(true)
    expect(overlapsTime(ENTRIES[5], { start: '2024-06-01' })).toBe(false)
    expect(overlapsTime(ENTRIES[0], { start: '2024-06-01' })).toBe(true) // open-ended
    expect(overlapsTime(ENTRIES[6], { start: '1990' })).toBe(false)
    expect(overlapsTime(e('a:x', 'x', { temporal: { start: null, end: null } }), { start: '1990', end: '1991' })).toBe(true)
    const ids = idx.search('land cover forest', { time: { start: '2020' } }).hits.map((h) => h.entry.id)
    expect(ids).not.toContain('a:old')
  })

  it('theme filter is a hard any-of filter', () => {
    const themes: Theme[] = ['soil']
    const hits = idx.search('moisture elevation population', { themes }).hits
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.entry.themes.includes('soil'))).toBe(true)
  })

  it('max resolution filter keeps unknown-resolution entries unless told otherwise', () => {
    const noRes = new RegistryIndex([...ENTRIES, e('a:unk', 'Unknown resolution elevation', { themes: ['elevation'] })])
    const ids = (opts: object) => noRes.search('elevation', opts).hits.map((h) => h.entry.id)
    expect(ids({ maxResolutionM: 30 })).not.toContain('a:nasadem')
    expect(ids({ maxResolutionM: 30 })).toContain('a:ned')
    expect(ids({ maxResolutionM: 30 })).toContain('a:unk')
    expect(ids({ maxResolutionM: 30, excludeUnknownResolution: true })).not.toContain('a:unk')
  })

  it('licence filter supports ids and the "open" pseudo-value', () => {
    const open = idx.search('land cover forest elevation', { license: ['open'] }).hits.map((h) => h.entry.id)
    expect(open).not.toContain('a:old') // proprietary
    expect(open).toContain('a:ned') // public-domain
    const only = idx.search('elevation', { license: ['public-domain'] }).hits.map((h) => h.entry.id)
    expect(only).toEqual(['a:ned'])
    expect(isOpenLicense('CC-BY-4.0')).toBe(true)
    expect(isOpenLicense('proprietary')).toBe(false)
  })

  it('flags auth availability but never hides the entry', () => {
    const without = idx.search('soil moisture', { availableAuth: [] }).hits.find((h) => h.entry.id === 'a:smap')!
    expect(without.authAvailable).toBe(false)
    const withAuth = idx.search('soil moisture', { availableAuth: ['earthdata'] }).hits.find((h) => h.entry.id === 'a:smap')!
    expect(withAuth.authAvailable).toBe(true)
    expect(idx.search('soil moisture').hits.find((h) => h.entry.id === 'a:soilgrids')!.authAvailable).toBeNull()
  })

  it('golden entries get a rank boost for their theme', () => {
    const plain = new RegistryIndex(ENTRIES)
    const golden = new RegistryIndex(ENTRIES, { 'a:nasadem': ['elevation'] })
    const q = 'dem'
    expect(plain.search(q).hits[0].entry.id).not.toBe('a:nasadem')
    expect(golden.search(q).hits[0].entry.id).toBe('a:nasadem')
    expect(golden.search(q).hits[0].golden).toBe(true)
  })

  it('golden ids resolve through alternates', () => {
    const merged = e('a:primary', 'Primary route DEM', { alternates: [{ source: 'b', id: 'b:alt', access: ENTRIES[0].access }] })
    expect(RegistryIndex.unresolvedGolden([merged], { 'b:alt': ['elevation'], 'c:gone': ['elevation'] })).toEqual(['c:gone'])
  })

  it('is not confident about nonsense, and names the unknown words', () => {
    const gib = idx.search('quokka enclosure census')
    expect(gib.confident).toBe(false)
    expect(gib.unknownTerms).toContain('quokka')
    expect(idx.search('xyzzy plugh').hits).toEqual([])
    const mixed = idx.search('unicorn population density')
    expect(mixed.confident).toBe(false)
  })

  it('limit is respected and results are deterministic', () => {
    const a = idx.search('elevation dem', { limit: 2 }).hits.map((h) => h.entry.id)
    expect(a).toHaveLength(2)
    expect(idx.search('elevation dem', { limit: 2 }).hits.map((h) => h.entry.id)).toEqual(a)
  })

  it('does not leak scratch state between queries', () => {
    const first = idx.search('soil').hits.map((h) => [h.entry.id, h.score])
    idx.search('elevation')
    expect(idx.search('soil').hits.map((h) => [h.entry.id, h.score])).toEqual(first)
  })
})
