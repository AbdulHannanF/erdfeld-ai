import { describe, expect, it } from 'vitest'
import { assignThemes } from '../themes'
import { THEMES } from '../types'

describe('assignThemes: curated mapping table', () => {
  it.each([
    [{ title: 'Sentinel-1 RTC backscatter' }, 'sar'],
    [{ title: 'ALOS PALSAR yearly mosaic' }, 'sar'],
    [{ title: 'NASADEM HGT v001' }, 'elevation'],
    [{ title: 'Copernicus DEM GLO-30' }, 'elevation'],
    [{ id: 'cop-dem-glo-90', title: 'Thing' }, 'elevation'],
    [{ title: 'SRTM 90m' }, 'elevation'],
    [{ title: 'ASTER GDEM' }, 'elevation'],
    [{ title: 'ALOS World 3D 30 m' }, 'elevation'],
    [{ title: 'USGS 3DEP Lidar Point Cloud' }, 'lidar'],
    [{ title: 'GEDI L2A canopy height' }, 'lidar'],
    [{ id: 'x', title: 'Thing', keywords: ['copc'] }, 'lidar'],
    [{ title: 'ESA WorldCover' }, 'land-cover'],
    [{ title: 'ERA5 reanalysis' }, 'climate'],
    [{ title: 'CHIRPS daily rainfall' }, 'precipitation'],
    [{ title: 'SoilGrids clay content' }, 'soil'],
    [{ title: 'WorldPop population counts' }, 'population'],
    [{ title: 'VIIRS DNB nighttime lights' }, 'nightlights'],
    [{ title: 'FIRMS active fire hotspots' }, 'fire'],
    [{ title: 'Sentinel-5P NO2 tropospheric column' }, 'air-quality'],
    [{ title: 'Overture building footprints' }, 'buildings'],
    [{ title: 'Satellite Embedding V1' }, 'embeddings'],
    [{ title: 'Global Forest Change tree cover loss' }, 'forest'],
    [{ title: 'JRC Global Surface Water' }, 'water'],
    [{ title: 'MODIS snow cover daily' }, 'snow-ice'],
    [{ title: 'GHSL built-up surface' }, 'urban'],
    [{ title: 'WDPA protected areas' }, 'biodiversity'],
    [{ title: 'GADM administrative boundaries' }, 'boundaries'],
  ])('%j -> %s', (input, theme) => {
    expect(assignThemes(input as any)).toContain(theme)
  })
})

describe('assignThemes: guard rails', () => {
  it('matches whole words only ("dem" never matches "demand")', () => {
    expect(assignThemes({ title: 'Electricity demand model' })).not.toContain('elevation')
    expect(assignThemes({ title: 'Residual demographic trends' })).not.toContain('elevation')
  })
  it('does not treat a satellite name as a theme ("Suomi NPP" is not net primary production)', () => {
    expect(assignThemes({ title: 'VIIRS/NPP Cloud Mask L2' })).not.toContain('vegetation')
  })
  it('needs two distinct description hits when title and keywords say nothing', () => {
    expect(assignThemes({ title: 'Product X', description: 'Uses a lidar sensor.' })).not.toContain('lidar')
    expect(assignThemes({ title: 'Product X', description: 'Airborne laser scanning with a lidar sensor produces a point cloud.' })).toContain('lidar')
  })
  it('returns controlled vocabulary only, capped, deterministic', () => {
    const input = { title: 'Soil moisture, precipitation, temperature, snow, ocean, fire reanalysis climate forecast', keywords: ['sar', 'lidar'] }
    const a = assignThemes(input)
    expect(a.length).toBeLessThanOrEqual(5)
    expect(a.every((t) => (THEMES as readonly string[]).includes(t))).toBe(true)
    expect(assignThemes(input)).toEqual(a)
  })
  it('maps catalog-declared categories (Earth Engine) and ignores the generic CMR "atmosphere" level', () => {
    expect(assignThemes({ title: 'Thing', categories: ['elevation-topography'] })).toContain('elevation')
    expect(assignThemes({ title: 'Thing', categories: ['atmosphere'] })).not.toContain('air-quality')
  })
  it('gives unrelated records no theme rather than a wrong one', () => {
    expect(assignThemes({ title: 'Quarterly staff newsletter' })).toEqual([])
  })
})
