import { describe, expect, it } from 'vitest'
import {
  cleanText, cmrCollectionToEntry, extentBbox, geeCollectionToEntry, gfwDatasetToEntry, isGlobalBbox,
  normalizeLicense, openEoCollectionToEntry, openTopographyToEntry, parseResolutionFromDescription,
  parseResolutionFromTitle, stacAccessKind, stacCollectionToEntry, stacResolution, stacVariables,
} from '../normalize'

const PC = { source: 'planetary-computer', root: 'https://planetarycomputer.microsoft.com/api/stac/v1', auth: null as null }

describe('cleanText', () => {
  it('strips markdown, html and urls, then trims on a word boundary', () => {
    const t = cleanText('# Title\n\nSee [the docs](https://x.y/z) for <b>more</b> info. ' + 'word '.repeat(200), 100)
    expect(t).not.toMatch(/[#<>\[\]()]/)
    expect(t).not.toMatch(/https?:/)
    expect(t.length).toBeLessThanOrEqual(101)
    expect(t.endsWith('…')).toBe(true)
  })
  it('leaves short text alone', () => expect(cleanText('Short  text\n here', 400)).toBe('Short text here'))
})

describe('resolution parsing', () => {
  it.each([
    ['Sentinel-2 10 m, 20 m, 60 m', 10],
    ['Global 1km and 500m SIN Grid', 500],
    ['GLO-30 Copernicus DEM', 30],
    ['1 arc-second SRTM', 31],
    ['0.25 degree reanalysis', 27830],
    ['clms_ba_global_300m_daily_v3_cog', 300],
    ['50 Centimeter Digital Elevation Models', 0.5],
  ])('title "%s" -> %s m', (t, m) => {
    const got = parseResolutionFromTitle(t)
    expect(got).not.toBeNull()
    expect(Math.abs((got as number) - m) / m).toBeLessThan(0.02)
  })
  it('ignores units that are not resolution (m/s, min, km swath)', () => {
    expect(parseResolutionFromTitle('Wind speed 10 m/s over 10 min')).toBeNull()
    expect(parseResolutionFromTitle('Volume in m3')).toBeNull()
  })
  it('only trusts description numbers next to a resolution cue', () => {
    expect(parseResolutionFromDescription('A swath of 290 km is covered. Accuracy is 5 m.')).toBeNull()
    expect(parseResolutionFromDescription('Pixel size is 30 m at the equator.')).toBe(30)
  })
  it('prefers declared gsd over text', () => {
    expect(stacResolution({ id: 'x', title: 'Thing 500 m', summaries: { 'eo:bands': [{ name: 'B1', gsd: 20 }, { name: 'B2', gsd: 10 }] } })).toBe(10)
    expect(stacResolution({ id: 'x', summaries: { gsd: [30, 15] } })).toBe(15)
    expect(stacResolution({ id: 'x', item_assets: { a: { 'raster:bands': [{ spatial_resolution: 90 }] } } })).toBe(90)
  })
})

describe('extent and licence', () => {
  it('reads 2D and 3D bboxes, clamps, rejects junk', () => {
    expect(extentBbox({ spatial: { bbox: [[-10, -5, 10, 5]] } })).toEqual([-10, -5, 10, 5])
    expect(extentBbox({ spatial: { bbox: [[-10, -5, 0, 10, 5, 100]] } })).toEqual([-10, -5, 10, 5])
    expect(extentBbox({ spatial: { bbox: [[-200, -95, 200, 95]] } })).toEqual([-180, -90, 180, 90])
    expect(extentBbox({ spatial: { bbox: [[170, -22, -175, -12]] } })).toEqual([170, -22, -175, -12]) // antimeridian
    expect(extentBbox({ spatial: { bbox: [[0, 10, 5, -10]] } })).toEqual([0, -10, 5, 10]) // swapped latitudes
    expect(extentBbox({})).toBeNull()
    expect(extentBbox({ spatial: { bbox: [['a', 1, 2, 3]] } })).toBeNull()
  })
  it('decides global coverage', () => {
    expect(isGlobalBbox([-180, -90, 180, 90])).toBe(true)
    expect(isGlobalBbox([-180, -56, 180, 60])).toBe(true) // SRTM
    expect(isGlobalBbox([-125, 24, -66, 50])).toBe(false)
    expect(isGlobalBbox([-10, -90, -12, 90])).toBe(true) // wrapped box spanning almost 360 degrees
  })
  it('normalises licences', () => {
    expect(normalizeLicense('CC-BY-4.0')).toBe('CC-BY-4.0')
    expect(normalizeLicense('not-provided')).toBe('various')
    expect(normalizeLicense('')).toBe('various')
    expect(normalizeLicense('x'.repeat(80))).toBe('various')
    expect(normalizeLicense('proprietary')).toBe('proprietary')
  })
})

describe('STAC collection mapping', () => {
  const col = {
    id: 'cop-dem-glo-30',
    title: 'Copernicus DEM GLO-30',
    description: 'The Copernicus DEM is a **Digital Surface Model** (DSM) at [30 m](https://x).',
    keywords: ['Copernicus', 'DEM', 'elevation'],
    license: 'proprietary',
    providers: [{ name: 'ESA' }, { name: 'Microsoft' }],
    extent: { spatial: { bbox: [[-180, -90, 180, 90]] }, temporal: { interval: [['2010-01-01T00:00:00Z', '2015-01-31T00:00:00Z']] } },
    item_assets: { data: { type: 'image/tiff; application=geotiff; profile=cloud-optimized', 'raster:bands': [{ unit: 'm', spatial_resolution: 30 }] } },
  }
  it('maps the schema fields', () => {
    const e = stacCollectionToEntry(col, PC)!
    expect(e.id).toBe('planetary-computer:cop-dem-glo-30')
    expect(e.source).toBe('planetary-computer')
    expect(e.spatial).toEqual({ bbox: [-180, -90, 180, 90], global: true })
    expect(e.temporal).toEqual({ start: '2010-01-01', end: '2015-01-31' })
    expect(e.resolution_m).toBe(30)
    expect(e.license).toBe('proprietary')
    expect(e.access.kind).toBe('stac-cog')
    expect(e.access.url).toBe('https://planetarycomputer.microsoft.com/api/stac/v1/collections/cop-dem-glo-30')
    expect(e.themes).toContain('elevation')
    expect(e.description).not.toMatch(/\*\*|\]\(/)
    expect(e.variables).toEqual([{ name: 'data', unit: 'm' }])
  })
  it('drops a record without an extent instead of inventing global coverage', () => {
    expect(stacCollectionToEntry({ id: 'x', title: 'No extent' }, PC)).toBeNull()
  })
  it('detects access kinds', () => {
    expect(stacAccessKind({ item_assets: { a: { type: 'application/vnd+zarr' } } })).toBe('stac-zarr')
    expect(stacAccessKind({ item_assets: { a: { type: 'application/x-netcdf' } } })).toBe('stac-other')
    expect(stacAccessKind({ assets: { t: { type: 'image/png', roles: ['thumbnail'] } } })).toBe('stac-other')
  })
  it('collects band units, capped', () => {
    const vars = stacVariables({ summaries: { 'eo:bands': Array.from({ length: 40 }, (_, i) => ({ name: `b${i}`, 'gee:units': i === 0 ? 'm' : undefined })) } })
    expect(vars).toHaveLength(24)
    expect(vars[0]).toEqual({ name: 'b0', unit: 'm' })
  })
  it('flags SAR from the sar extension even without keywords', () => {
    const e = stacCollectionToEntry({ id: 'zzz', title: 'Thing', description: '', stac_extensions: ['https://stac-extensions.github.io/sar/v1.0.0/schema.json'], extent: col.extent }, PC)!
    expect(e.themes).toContain('sar')
  })
})

describe('other source mappers', () => {
  it('CMR: namespaced id, earthdata auth, short description', () => {
    const e = cmrCollectionToEntry({
      id: 'MOD13A1_061', title: 'MODIS/Terra Vegetation Indices 16-Day L3 Global 500m SIN Grid V061',
      description: 'x'.repeat(900), keywords: ['EARTH SCIENCE', 'BIOSPHERE', 'VEGETATION', 'VEGETATION INDEX'],
      license: 'not-provided', summaries: { platform: ['Terra'], instruments: ['MODIS'] },
      extent: { spatial: { bbox: [[-180, -90, 180, 90]] }, temporal: { interval: [['2000-02-18T00:00:00.000Z', null]] } },
    }, 'LPCLOUD', 'https://cmr.earthdata.nasa.gov/stac')!
    expect(e.id).toBe('cmr:LPCLOUD/MOD13A1_061')
    expect(e.access.requires_auth).toBe('earthdata')
    expect(e.license).toBe('various')
    expect(e.resolution_m).toBe(500)
    expect(e.description.length).toBeLessThanOrEqual(241)
    expect(e.keywords).toContain('modis')
    expect(e.keywords).not.toContain('earth science')
    expect(e.temporal.end).toBeNull()
    expect(e.themes).toContain('vegetation')
  })
  it('CMR: drops collections without bbox', () => {
    expect(cmrCollectionToEntry({ id: 'A', title: 'T', extent: {} }, 'P', 'r')).toBeNull()
  })
  it('GEE: earthengine access with constructor hint, units from bands', () => {
    const e = geeCollectionToEntry({
      id: 'CGIAR/SRTM90_V4', title: 'SRTM Digital Elevation Data Version 4', description: 'Elevation.', keywords: ['dem', 'srtm'],
      license: 'proprietary', 'gee:type': 'image', 'gee:categories': ['elevation-topography'],
      extent: { spatial: { bbox: [[-180, -56, 180, 60]] }, temporal: { interval: [['2000-02-11T00:00:00Z', '2000-02-22T00:00:00Z']] } },
      summaries: { 'eo:bands': [{ name: 'elevation', 'gee:units': 'm', gsd: 90 }] },
    })!
    expect(e.access.kind).toBe('earthengine')
    expect(e.access.requires_auth).toBe('earthengine')
    expect(e.access.notes).toContain("ee.Image('CGIAR/SRTM90_V4')")
    expect(e.resolution_m).toBe(90)
    expect(e.variables).toEqual([{ name: 'elevation', unit: 'm' }])
    expect(e.themes[0]).toBe('elevation')
  })
  it('GEE: skips deprecated collections', () => {
    expect(geeCollectionToEntry({ id: 'A/B', title: 'Old', 'gee:status': 'deprecated', extent: { spatial: { bbox: [[-1, -1, 1, 1]] } } })).toBeNull()
  })
  it('OpenTopography: bbox from polygon, lidar theme, per-survey', () => {
    const e = openTopographyToEntry({
      Dataset: {
        name: 'USGS 3DEP Lidar, Example County 2021', identifier: { value: 'OTLAS.012021.26911.1' }, temporalCoverage: '2021-03-01 / 2021-04-15',
        spatialCoverage: { geo: { geojson: { features: [{ geometry: { type: 'Polygon', coordinates: [[[-120, 40], [-119, 40], [-119, 41], [-120, 41], [-120, 40]]] } }] } } },
      },
    }, 'PointCloud')!
    expect(e.id).toBe('opentopography:OTLAS.012021.26911.1')
    expect(e.spatial).toEqual({ bbox: [-120, 40, -119, 41], global: false })
    expect(e.temporal).toEqual({ start: '2021-03-01', end: '2021-04-15' })
    expect(e.themes).toContain('lidar')
    expect(e.access.requires_auth).toBe('opentopography')
  })
  it('OpenTopography: rasters get the elevation theme and a parsed resolution', () => {
    const e = openTopographyToEntry({
      Dataset: { name: 'Switzerland 50 Centimeter Digital Elevation Models', identifier: { value: 'OTSDEM.1' }, temporalCoverage: '2017-03-01',
        spatialCoverage: { geo: { geojson: { features: [{ geometry: { type: 'Polygon', coordinates: [[[6, 46], [10, 46], [10, 48], [6, 48], [6, 46]]] } }] } } } },
    }, 'Raster')!
    expect(e.themes).toContain('elevation')
    expect(e.resolution_m).toBe(0.5)
  })
  it('OpenTopography: projected (non lon/lat) coordinates are ignored, not turned into a bbox', () => {
    const mk = (coords: number[][][]) => ({ Dataset: { name: 'x', identifier: { value: 'y' }, spatialCoverage: { geo: { geojson: { features: [{ geometry: { coordinates: coords } }] } } } } })
    expect(openTopographyToEntry(mk([[[500000, 4000000], [510000, 4000000], [510000, 4010000]]]), 'Raster')).toBeNull()
    expect(openTopographyToEntry(mk([[[5, 5], [6, 5], [6, 6]]]), 'Raster')!.spatial.bbox).toEqual([5, 5, 6, 6])
  })
  it('OpenTopography: no footprint -> skipped', () => {
    expect(openTopographyToEntry({ Dataset: { name: 'x', identifier: { value: 'y' }, spatialCoverage: {} } }, 'Raster')).toBeNull()
  })
  it('GFW: key-requiring REST entry, resolution from metadata', () => {
    const e = gfwDatasetToEntry({
      dataset: 'birdlife_biodiversity_intactness',
      metadata: { title: 'Biodiversity Intactness', subtitle: '2018, 1 km, global', overview: 'Forest biodiversity intactness.', spatial_resolution: 1000, geographic_coverage: 'Forested Biomes Globally', scale: 'global', license: 'TBD', tags: ['biodiversity'] },
    })!
    expect(e.id).toBe('gfw:birdlife_biodiversity_intactness')
    expect(e.resolution_m).toBe(1000)
    expect(e.license).toBe('various')
    expect(e.access.kind).toBe('rest')
    expect(e.access.requires_auth).toBe('api-key')
    expect(e.themes).toContain('biodiversity')
  })
  it('GFW: skips datasets with no metadata title', () => {
    expect(gfwDatasetToEntry({ dataset: 'x', metadata: {} })).toBeNull()
  })
  it('openEO: bands become variables, copernicus auth', () => {
    const e = openEoCollectionToEntry({
      id: 'SENTINEL2_L2A', title: 'Sentinel-2 L2A', description: 'MSI surface reflectance', license: 'proprietary',
      extent: { spatial: { bbox: [[-180, -90, 180, 90]] }, temporal: { interval: [['2015-06-27T00:00:00Z', null]] } },
      'cube:dimensions': { bands: { type: 'bands', values: ['B02', 'B03', 'B04'] }, x: { type: 'spatial' } },
    }, 'https://openeo.dataspace.copernicus.eu/openeo/1.2')!
    expect(e.id).toBe('openeo-cdse:SENTINEL2_L2A')
    expect(e.variables.map((v) => v.name)).toEqual(['B02', 'B03', 'B04'])
    expect(e.access.kind).toBe('openeo')
    expect(e.access.requires_auth).toBe('copernicus')
  })
})
