/** Hand-written registry entries for sources that have no STAC catalog.
 *
 *  Every URL below was requested on 2026-10-11 from the harvest sandbox and
 *  answered (200, or 4xx that proves the service is alive: the Open-Meteo
 *  archive/climate endpoints answered 429 under rate limiting, the SoilGrids
 *  query endpoint answers 422 without parameters). Two exceptions are stated in
 *  the entry notes: `overpass-api.de` and `api.worldpop.org` did not answer from
 *  the sandbox's egress proxy, so the entries name an instance / mirror that did.
 *
 *  Facts here (resolutions, periods, licences) come from each publisher's own
 *  documentation. Where a figure is nominal ("11 km global default") the notes
 *  say so.
 */

import type { DatasetEntry, DatasetAccess, DatasetVariable, Theme } from './types'
import { GLOBAL_BBOX } from './types'
import { assignThemes } from './themes'

interface CuratedSpec {
  source: string
  local: string
  title: string
  description: string
  providers: string[]
  themes?: Theme[]
  keywords: string[]
  variables?: DatasetVariable[]
  bbox?: [number, number, number, number]
  global?: boolean
  start: string | null
  end: string | null
  resolution_m: number | null
  license: string
  access: DatasetAccess
}

function cur(s: CuratedSpec): DatasetEntry {
  const themes = [...(s.themes ?? [])]
  for (const t of assignThemes({ id: s.local, title: s.title, keywords: s.keywords, description: s.description })) {
    if (!themes.includes(t)) themes.push(t)
  }
  const bbox = s.bbox ?? GLOBAL_BBOX
  return {
    id: `${s.source}:${s.local}`,
    title: s.title,
    description: s.description,
    source: s.source,
    providers: s.providers,
    themes: themes.slice(0, 6),
    variables: s.variables ?? [],
    spatial: { bbox, global: s.global ?? !s.bbox },
    temporal: { start: s.start, end: s.end },
    resolution_m: s.resolution_m,
    license: s.license,
    access: s.access,
    keywords: s.keywords,
    curated: true,
  }
}

export function curatedEntries(opts: { overtureRelease?: string } = {}): DatasetEntry[] {
  const rel = opts.overtureRelease ?? '2026-09-23.1'
  const overture = (
    local: string, title: string, theme: string, type: string, description: string,
    themes: Theme[], keywords: string[], license: string,
  ) => cur({
    source: 'overture', local, title, description,
    providers: ['Overture Maps Foundation'], themes, keywords: ['overture', 'geoparquet', ...keywords],
    start: null, end: null, resolution_m: null, license,
    access: {
      kind: 'geoparquet',
      url: `https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&prefix=release/${rel}/theme%3D${theme}/`,
      requires_auth: null,
      notes: `GeoParquet on public S3 (s3://overturemaps-us-west-2/release/${rel}/theme=${theme}/${type ? `type=${type}/` : ''}), no key; the URL is the bucket listing for the theme (verified for release ${rel}). Read with DuckDB/pyarrow and bbox-filter on the \`bbox\` column; the \`overturemaps\` CLI also works. Release id changes monthly.`,
    },
  })

  return [
    // --- Overture Maps -------------------------------------------------------
    overture('buildings', 'Overture Maps Buildings', 'buildings', 'building',
      'Global building footprints (about 2.6 billion) conflated from OpenStreetMap, Microsoft ML Buildings, Google Open Buildings, Esri Community Maps and others, with height, floors, class and roof attributes where known.',
      ['buildings', 'urban', 'infrastructure'], ['buildings', 'building footprints', 'height', 'osm', 'microsoft', 'google', 'polygons'], 'various'),
    overture('places', 'Overture Maps Places', 'places', 'place',
      'More than 60 million points of interest worldwide (shops, schools, hospitals, restaurants, landmarks) with categories, names, addresses and confidence scores, from Meta, Microsoft and other sources.',
      ['infrastructure'], ['places', 'poi', 'points of interest', 'amenities', 'schools', 'hospitals', 'shops'], 'CDLA-Permissive-2.0'),
    overture('transportation', 'Overture Maps Transportation', 'transportation', '',
      'Global road, rail and water segments and connectors forming a routable network with class, speed limit, surface and access restrictions, derived mainly from OpenStreetMap.',
      ['infrastructure'], ['roads', 'road network', 'segments', 'connectors', 'rail', 'routing', 'transportation'], 'ODbL-1.0'),
    overture('divisions', 'Overture Maps Divisions (admin boundaries)', 'divisions', '',
      'Administrative divisions from country down to neighborhood (countries, regions, counties, localities) with boundaries, names and hierarchy.',
      ['boundaries'], ['divisions', 'admin boundaries', 'countries', 'regions', 'counties', 'localities', 'administrative'], 'various'),
    overture('base', 'Overture Maps Base (land, water, land use, infrastructure)', 'base', '',
      'Base layer of land cover, land use, water bodies, bathymetry and infrastructure features (bridges, power lines, piers) from OpenStreetMap, Daylight, ESA WorldCover and Natural Earth.',
      ['land-cover', 'water', 'infrastructure'], ['land use', 'land cover', 'water', 'bathymetry', 'infrastructure', 'worldcover', 'natural earth'], 'various'),
    overture('addresses', 'Overture Maps Addresses', 'addresses', '',
      'Address points with street, number, postcode and locality for many countries, from open government and community sources.',
      ['boundaries', 'infrastructure'], ['addresses', 'geocoding', 'postcode', 'street'], 'various'),

    // --- OpenStreetMap -------------------------------------------------------
    cur({
      source: 'osm', local: 'overpass', title: 'OpenStreetMap via Overpass API',
      description: 'Live query access to the full OpenStreetMap database: roads, buildings, land use, water, amenities, power lines, railways, boundaries and any tagged feature, by bounding box or area, using Overpass QL.',
      providers: ['OpenStreetMap contributors'], themes: ['infrastructure', 'buildings', 'boundaries'],
      keywords: ['openstreetmap', 'osm', 'overpass', 'roads', 'buildings', 'amenities', 'land use', 'power', 'railway', 'water', 'vector'],
      start: null, end: null, resolution_m: null, license: 'ODbL-1.0',
      access: {
        kind: 'rest', url: 'https://overpass-api.de/api/interpreter', requires_auth: null,
        notes: 'POST Overpass QL, no key; keep queries bbox-limited and respect fair-use. overpass-api.de did not answer from the harvest sandbox (egress proxy), maps.mail.ru/osm/tools/overpass answered 200; the agent already falls back across instances.',
      },
    }),

    // --- Open-Meteo ----------------------------------------------------------
    cur({
      source: 'open-meteo', local: 'forecast', title: 'Open-Meteo Weather Forecast API',
      description: 'Hourly and daily weather forecasts for any point: temperature, precipitation, wind, humidity, cloud cover, radiation, soil temperature and moisture, from national weather models (ICON, GFS, ECMWF IFS, HRRR, AROME) blended per location. Up to 16 days ahead plus recent days.',
      providers: ['Open-Meteo'], themes: ['weather', 'temperature', 'precipitation'],
      keywords: ['weather', 'forecast', 'open-meteo', 'temperature', 'precipitation', 'wind', 'humidity', 'cloud cover', 'radiation', 'gfs', 'icon', 'ecmwf', 'hrrr'],
      variables: [{ name: 'temperature_2m', unit: '°C' }, { name: 'precipitation', unit: 'mm' }, { name: 'wind_speed_10m', unit: 'km/h' }, { name: 'relative_humidity_2m', unit: '%' }, { name: 'cloud_cover', unit: '%' }, { name: 'shortwave_radiation', unit: 'W/m²' }, { name: 'soil_moisture_0_to_1cm', unit: 'm³/m³' }],
      start: '2022-01-01', end: null, resolution_m: 2000, license: 'CC-BY-4.0',
      access: { kind: 'rest', url: 'https://api.open-meteo.com/v1/forecast', requires_auth: null, notes: 'No key for non-commercial use (rate limited). Nominal global resolution is 11 km; 1 to 3 km regional models (ICON-D2, HRRR, AROME) are the best case. Past model runs: historical-forecast-api.open-meteo.com.' },
    }),
    cur({
      source: 'open-meteo', local: 'era5-archive', title: 'Open-Meteo Historical Weather API (ERA5 reanalysis)',
      description: 'Hourly historical weather for any point from 1940 to a few days ago, served from ECMWF ERA5 and ERA5-Land reanalysis (plus CERRA over Europe and IFS 9 km): temperature, rainfall, snowfall, wind, pressure, radiation, soil moisture.',
      providers: ['Open-Meteo', 'ECMWF Copernicus Climate Change Service'], themes: ['climate', 'weather', 'precipitation', 'temperature'],
      keywords: ['era5', 'era5-land', 'reanalysis', 'historical weather', 'archive', 'climate', 'temperature', 'precipitation', 'snowfall', 'wind', 'open-meteo', 'soil moisture'],
      variables: [{ name: 'temperature_2m', unit: '°C' }, { name: 'precipitation', unit: 'mm' }, { name: 'snowfall', unit: 'cm' }, { name: 'wind_speed_10m', unit: 'km/h' }, { name: 'surface_pressure', unit: 'hPa' }, { name: 'soil_moisture_0_to_7cm', unit: 'm³/m³' }],
      start: '1940-01-01', end: null, resolution_m: 9000, license: 'CC-BY-4.0',
      access: { kind: 'rest', url: 'https://archive-api.open-meteo.com/v1/archive', requires_auth: null, notes: 'No key for non-commercial use; answered 429 (rate limited) from the shared sandbox IP, so expect throttling. ERA5 is 0.25 deg (about 25 km), ERA5-Land 0.1 deg (about 11 km); 9 km is the IFS option.' },
    }),
    cur({
      source: 'open-meteo', local: 'air-quality', title: 'Open-Meteo Air Quality API (CAMS)',
      description: 'Hourly air quality forecasts and recent history from Copernicus CAMS: PM10, PM2.5, carbon monoxide, nitrogen dioxide, sulphur dioxide, ozone, dust, aerosol optical depth, pollen (Europe) and the European and US AQI indices.',
      providers: ['Open-Meteo', 'Copernicus Atmosphere Monitoring Service'], themes: ['air-quality'],
      keywords: ['air quality', 'cams', 'pm2.5', 'pm10', 'no2', 'ozone', 'so2', 'co', 'aerosol', 'dust', 'pollen', 'aqi', 'open-meteo'],
      variables: [{ name: 'pm10', unit: 'μg/m³' }, { name: 'pm2_5', unit: 'μg/m³' }, { name: 'carbon_monoxide', unit: 'μg/m³' }, { name: 'nitrogen_dioxide', unit: 'μg/m³' }, { name: 'sulphur_dioxide', unit: 'μg/m³' }, { name: 'ozone', unit: 'μg/m³' }, { name: 'aerosol_optical_depth' }, { name: 'dust', unit: 'μg/m³' }, { name: 'european_aqi' }, { name: 'us_aqi' }],
      start: '2013-01-01', end: null, resolution_m: 11000, license: 'CC-BY-4.0',
      access: { kind: 'rest', url: 'https://air-quality-api.open-meteo.com/v1/air-quality', requires_auth: null, notes: 'No key for non-commercial use. CAMS Europe 11 km (history from 2013), CAMS Global 40 km (history shorter).' },
    }),
    cur({
      source: 'open-meteo', local: 'climate', title: 'Open-Meteo Climate Change API (CMIP6)',
      description: 'Daily climate projections 1950 to 2050 for any point from downscaled CMIP6 models (EC-Earth3P-HR, MRI-AGCM3-2-S, NICAM16, FGOALS, HiRAM, MPI-ESM1-2-XR, CMCC-CM2-VHR4): temperature, precipitation, wind, radiation, humidity.',
      providers: ['Open-Meteo'], themes: ['climate', 'temperature', 'precipitation'],
      keywords: ['cmip6', 'climate change', 'projections', 'scenario', 'future climate', 'downscaled', 'highresmip', 'open-meteo', 'temperature', 'precipitation'],
      variables: [{ name: 'temperature_2m_mean', unit: '°C' }, { name: 'temperature_2m_max', unit: '°C' }, { name: 'precipitation_sum', unit: 'mm' }, { name: 'wind_speed_10m_mean', unit: 'km/h' }, { name: 'shortwave_radiation_sum', unit: 'MJ/m²' }],
      start: '1950-01-01', end: '2050-12-31', resolution_m: 10000, license: 'CC-BY-4.0',
      access: { kind: 'rest', url: 'https://climate-api.open-meteo.com/v1/climate', requires_auth: null, notes: 'No key for non-commercial use; answered 429 (rate limited) from the shared sandbox IP. Model native grids are 10 to 50 km.' },
    }),
    cur({
      source: 'open-meteo', local: 'marine', title: 'Open-Meteo Marine Weather API (waves)',
      description: 'Hourly ocean wave forecasts and history: significant wave height, period, direction, wind waves, swell, ocean currents and sea surface temperature from MeteoFrance and ERA5-Ocean wave models.',
      providers: ['Open-Meteo'], themes: ['ocean', 'weather'],
      keywords: ['marine', 'waves', 'wave height', 'swell', 'ocean currents', 'sea surface temperature', 'open-meteo', 'era5-ocean'],
      variables: [{ name: 'wave_height', unit: 'm' }, { name: 'wave_period', unit: 's' }, { name: 'wave_direction', unit: '°' }, { name: 'swell_wave_height', unit: 'm' }, { name: 'ocean_current_velocity', unit: 'km/h' }],
      start: '1940-01-01', end: null, resolution_m: 8000, license: 'CC-BY-4.0',
      access: { kind: 'rest', url: 'https://marine-api.open-meteo.com/v1/marine', requires_auth: null, notes: 'No key for non-commercial use. 0.08 deg (about 8 km) MeteoFrance wave model, 0.5 deg ERA5-Ocean.' },
    }),
    cur({
      source: 'open-meteo', local: 'flood', title: 'Open-Meteo Flood API (GloFAS river discharge)',
      description: 'Daily river discharge simulations and forecasts from the Copernicus GloFAS hydrological model at any point: current, historical since 1984 and forecasts up to seven months, with ensemble members.',
      providers: ['Open-Meteo', 'Copernicus Emergency Management Service'], themes: ['hydrology', 'water', 'hazards'],
      keywords: ['flood', 'river discharge', 'glofas', 'streamflow', 'hydrology', 'forecast', 'open-meteo'],
      variables: [{ name: 'river_discharge', unit: 'm³/s' }],
      start: '1984-01-01', end: null, resolution_m: 5000, license: 'CC-BY-4.0',
      access: { kind: 'rest', url: 'https://flood-api.open-meteo.com/v1/flood', requires_auth: null, notes: 'No key for non-commercial use. GloFAS v4 on a 0.05 deg (about 5 km) grid.' },
    }),

    // --- Soil ----------------------------------------------------------------
    cur({
      source: 'isric', local: 'soilgrids', title: 'ISRIC SoilGrids 2.0 (REST point query)',
      description: 'Global digital soil maps at 250 m for clay, sand, silt, organic carbon, nitrogen, pH, bulk density, cation exchange capacity, coarse fragments and carbon stock, at six depth intervals to 2 m, with prediction quantiles and uncertainty.',
      providers: ['ISRIC - World Soil Information'], themes: ['soil', 'agriculture'],
      keywords: ['soilgrids', 'soil', 'clay', 'sand', 'silt', 'soil organic carbon', 'ph', 'nitrogen', 'bulk density', 'cec', 'soil texture', 'isric'],
      variables: [
        { name: 'clay', unit: 'g/kg' }, { name: 'sand', unit: 'g/kg' }, { name: 'silt', unit: 'g/kg' },
        { name: 'soc', unit: 'dg/kg' }, { name: 'ocd', unit: 'hg/m³' }, { name: 'ocs', unit: 't/ha' },
        { name: 'nitrogen', unit: 'cg/kg' }, { name: 'phh2o', unit: 'pH*10' }, { name: 'bdod', unit: 'cg/cm³' },
        { name: 'cec', unit: 'mmol(c)/kg' }, { name: 'cfvo', unit: 'cm³/dm³' },
      ],
      start: null, end: null, resolution_m: 250, license: 'CC-BY-4.0',
      access: { kind: 'rest', url: 'https://rest.isric.org/soilgrids/v2.0/properties/query', requires_auth: null, notes: 'GET ?lon=&lat=&property=&depth=&value=mean; no key, about 5 requests/minute. Depths 0-5, 5-15, 15-30, 30-60, 60-100, 100-200 cm. Use the bulk COG/VRT entry for polygons.' },
    }),
    cur({
      source: 'isric', local: 'soilgrids-bulk', title: 'ISRIC SoilGrids 2.0 (bulk COG / VRT)',
      description: 'The same 250 m SoilGrids 2.0 global soil property maps as Cloud Optimized GeoTIFF and VRT mosaics, readable by window for an area of interest: clay, sand, silt, organic carbon, nitrogen, pH, bulk density, CEC, six depths.',
      providers: ['ISRIC - World Soil Information'], themes: ['soil', 'agriculture'],
      keywords: ['soilgrids', 'soil', 'cog', 'vrt', 'clay', 'sand', 'silt', 'soil organic carbon', 'ph', 'isric', 'soil texture'],
      start: null, end: null, resolution_m: 250, license: 'CC-BY-4.0',
      access: { kind: 'cog', url: 'https://files.isric.org/soilgrids/latest/data/', requires_auth: null, notes: 'Static files over HTTPS, no key; per-property folders with VRT mosaics (Homolosine projection) and tiled GeoTIFFs.' },
    }),

    // --- Population ----------------------------------------------------------
    cur({
      source: 'worldpop', local: 'population', title: 'WorldPop Global Population Counts (100 m, 2000-2020)',
      description: 'Gridded estimates of the number of people per 100 m cell for every country, 2000 to 2020, built from census and survey data with random-forest dasymetric mapping; unconstrained and UN-adjusted variants, plus 1 km aggregates.',
      providers: ['WorldPop, University of Southampton'], themes: ['population'],
      keywords: ['worldpop', 'population', 'population counts', 'gridded population', 'people per pixel', 'demographics', 'ppp'],
      start: '2000-01-01', end: '2020-12-31', resolution_m: 100, license: 'CC-BY-4.0',
      access: { kind: 'rest', url: 'https://hub.worldpop.org/rest/data/pop/wpgp', requires_auth: null, notes: 'Catalog JSON at hub.worldpop.org/rest/data (no key). Direct GeoTIFFs, e.g. https://data.worldpop.org/GIS/Population/Global_2000_2020/2020/PAK/pak_ppp_2020.tif (200). The api.worldpop.org stats service did not answer from the harvest sandbox.' },
    }),
    cur({
      source: 'worldpop', local: 'age-structures', title: 'WorldPop Age and Sex Structures (100 m)',
      description: 'Gridded population by sex and five-year age group (0-1 up to 80+) at 100 m, 2000 to 2020, for every country: children under five, women of reproductive age, elderly populations.',
      providers: ['WorldPop, University of Southampton'], themes: ['population'],
      keywords: ['worldpop', 'age structure', 'sex', 'demographics', 'children', 'elderly', 'women', 'population'],
      start: '2000-01-01', end: '2020-12-31', resolution_m: 100, license: 'CC-BY-4.0',
      access: { kind: 'rest', url: 'https://hub.worldpop.org/rest/data/age_structures', requires_auth: null, notes: 'Catalog JSON, no key; per-country GeoTIFFs on data.worldpop.org.' },
    }),
    cur({
      source: 'kontur', local: 'population', title: 'Kontur Population (H3 hexagons, 400 m)',
      description: 'Global population density on an H3 resolution-8 hexagon grid (about 400 m), combining GHSL, Facebook HRSL, Microsoft buildings, Copernicus land cover and OpenStreetMap; GeoPackage distribution on HDX.',
      providers: ['Kontur'], themes: ['population', 'urban'],
      keywords: ['kontur', 'population', 'h3', 'hexagons', 'population density', 'ghsl', 'hdx'],
      start: '2023-11-01', end: '2023-11-01', resolution_m: 400, license: 'CC-BY-4.0',
      access: { kind: 'rest', url: 'https://data.humdata.org/dataset/kontur-population-dataset', requires_auth: null, notes: 'HDX dataset page (200). Direct file: https://geodata-eu-central-1-kontur-public.s3.amazonaws.com/kontur_datasets/kontur_population_20231101.gpkg.gz (200, large gzip GeoPackage). Release dated 2023-11-01.' },
    }),

    // --- Fire / imagery services --------------------------------------------
    cur({
      source: 'nasa-firms', local: 'active-fires', title: 'NASA FIRMS Active Fire Data (VIIRS and MODIS)',
      description: 'Near-real-time and archived active fire detections from VIIRS (375 m; Suomi NPP, NOAA-20, NOAA-21) and MODIS (1 km) thermal anomalies, with fire radiative power, brightness temperature and confidence; global, within about three hours of overpass.',
      providers: ['NASA LANCE / FIRMS'], themes: ['fire', 'hazards'],
      keywords: ['firms', 'active fire', 'wildfire', 'hotspots', 'viirs', 'modis', 'fire radiative power', 'thermal anomalies', 'burning'],
      variables: [{ name: 'frp', unit: 'MW' }, { name: 'bright_ti4', unit: 'K' }, { name: 'confidence' }, { name: 'acq_date' }],
      start: '2000-11-01', end: null, resolution_m: 375, license: 'public-domain',
      access: { kind: 'rest', url: 'https://firms.modaps.eosdis.nasa.gov/api/area/', requires_auth: 'api-key', notes: 'Free MAP_KEY from firms.modaps.eosdis.nasa.gov/api/map_key; CSV by area, country or bbox, up to 10 days per call. VIIRS from 2012, MODIS from 2000.' },
    }),
    cur({
      source: 'nasa-gibs', local: 'imagery', title: 'NASA GIBS Global Imagery Browse Services (1000+ layers)',
      description: 'Pre-rendered, near-real-time and historical global image layers as WMTS/WMS/TMS tiles: MODIS and VIIRS true color, fires, aerosols, snow, sea ice, land surface temperature, precipitation (IMERG), vegetation indices, night lights. Visualization products, not analysis-ready values.',
      providers: ['NASA ESDIS'], themes: ['optical', 'weather'],
      keywords: ['gibs', 'worldview', 'wmts', 'tiles', 'modis', 'viirs', 'true color', 'imagery', 'snow', 'sea ice', 'aerosol', 'fires', 'imerg', 'land surface temperature'],
      start: '1999-12-18', end: null, resolution_m: 250, license: 'public-domain',
      access: { kind: 'tiles', url: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/wmts.cgi', requires_auth: null, notes: 'No key. Capabilities: https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml. Colour-mapped imagery: good for display, lossy for measurement.' },
    }),
    cur({
      source: 'nasa-gibs', local: 'viirs-black-marble', title: 'NASA GIBS VIIRS Black Marble night lights (tiles)',
      description: 'VIIRS Day/Night Band night-time lights imagery as map tiles, including the Black Marble composite and daily DNB at-sensor radiance layers from Suomi NPP, NOAA-20 and NOAA-21.',
      providers: ['NASA ESDIS', 'NASA Black Marble'], themes: ['nightlights'],
      keywords: ['night lights', 'nighttime lights', 'viirs dnb', 'black marble', 'day/night band', 'gibs', 'tiles'],
      start: '2012-01-19', end: null, resolution_m: 500, license: 'public-domain',
      access: { kind: 'tiles', url: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/wmts.cgi', requires_auth: null, notes: 'Layers VIIRS_Black_Marble, VIIRS_SNPP_DayNightBand_At_Sensor_Radiance, VIIRS_NOAA20_DayNightBand_At_Sensor_Radiance (verified in capabilities). Imagery for display; use VNP46 products for radiance values.' },
    }),

    // --- Forest / canopy -----------------------------------------------------
    cur({
      source: 'hansen', local: 'global-forest-change', title: 'Hansen Global Forest Change 2000-2025 (v1.13)',
      description: 'University of Maryland / Google global 30 m tree cover for 2000, annual forest loss year and gain, derived from Landsat; the reference deforestation dataset behind Global Forest Watch tree cover loss.',
      providers: ['University of Maryland', 'Google', 'USGS', 'NASA'], themes: ['forest', 'land-cover'],
      keywords: ['hansen', 'global forest change', 'gfc', 'deforestation', 'forest loss', 'tree cover', 'forest gain', 'lossyear', 'landsat', 'gfw'],
      variables: [{ name: 'treecover2000', unit: '%' }, { name: 'loss' }, { name: 'gain' }, { name: 'lossyear' }, { name: 'datamask' }],
      start: '2000-01-01', end: '2025-12-31', resolution_m: 30, license: 'CC-BY-4.0',
      access: { kind: 'cog', url: 'https://storage.googleapis.com/earthenginepartners-hansen/GFC-2025-v1.13/download.html', requires_auth: null, notes: '10x10 degree GeoTIFF tiles over HTTPS, no key, e.g. .../GFC-2025-v1.13/Hansen_GFC-2025-v1.13_lossyear_30N_070E.tif (200). Also in Earth Engine as UMD/hansen/global_forest_change_*.' },
    }),
    cur({
      source: 'meta-wri', local: 'canopy-height', title: 'Meta and WRI High Resolution Canopy Height Map (1 m)',
      description: 'Global 1 m canopy top height predicted from Maxar imagery with a deep-learning model calibrated on GEDI and airborne lidar, acquisition years 2009 to 2020; also the tree-cover mask and per-pixel uncertainty.',
      providers: ['Meta', 'World Resources Institute'], themes: ['forest', 'lidar', 'vegetation'],
      keywords: ['canopy height', 'chm', 'tree height', 'meta', 'wri', 'gedi', 'high resolution', 'forest structure', 'dataforgood'],
      variables: [{ name: 'chm', unit: 'm' }, { name: 'msk' }],
      start: '2009-01-01', end: '2020-12-31', resolution_m: 1, license: 'CC-BY-4.0',
      access: { kind: 'cog', url: 'https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/', requires_auth: null, notes: 'Public S3 (s3://dataforgood-fb-data/forests/v1/alsgedi_global_v6_float/): chm/, msk/ tiles indexed by tiles.geojson. No key.' },
    }),

    // --- Lidar / elevation ---------------------------------------------------
    cur({
      source: 'usgs-3dep', local: 'lidar-ept', title: 'USGS 3DEP lidar point clouds (Entwine Point Tiles)',
      description: 'Airborne lidar point clouds of the United States from the USGS 3D Elevation Program, hosted as Entwine Point Tiles on AWS, hundreds of project areas, ground/vegetation/building classified, ready for streaming windowed reads.',
      providers: ['USGS 3DEP', 'Hobu Inc'], themes: ['lidar', 'elevation'],
      keywords: ['3dep', 'lidar', 'point cloud', 'ept', 'entwine', 'laz', 'usgs', 'elevation', 'canopy height', 'dsm', 'dtm'],
      bbox: [-179.2, 17.6, -64.5, 71.5], global: false,
      start: '2000-01-01', end: null, resolution_m: 1, license: 'public-domain',
      access: { kind: 'ept', url: 'https://usgs-lidar-public.s3.amazonaws.com/', requires_auth: null, notes: 'Public S3 bucket usgs-lidar-public (us-west-2): one EPT per project, e.g. USGS_LPC_CA_LosAngeles_2016_LAS_2018/ept.json (200). Project footprints: https://usgs.entwine.io/boundaries/resources.geojson (200). Density varies, typically 1 to 8+ points/m2. Read with PDAL (readers.ept) with a bounds window.' },
    }),

    // --- Climate reanalysis --------------------------------------------------
    cur({
      source: 'arco-era5', local: 'pressure-levels', title: 'ARCO-ERA5 (Analysis-Ready Cloud-Optimized ERA5 Zarr)',
      description: 'ECMWF ERA5 hourly reanalysis 1940 to present on a 0.25 degree grid as chunked Zarr on Google Cloud Storage: 2 m temperature, wind, pressure, precipitation, radiation, humidity, geopotential and 37 pressure levels; time-series and map access without downloads.',
      providers: ['Google Research', 'ECMWF Copernicus Climate Change Service'], themes: ['climate', 'weather', 'temperature', 'precipitation'],
      keywords: ['era5', 'arco-era5', 'zarr', 'reanalysis', 'climate', 'weather', 'temperature', 'precipitation', 'wind', 'ecmwf', 'gcp', 'hourly'],
      variables: [{ name: '2m_temperature', unit: 'K' }, { name: 'total_precipitation', unit: 'm' }, { name: '10m_u_component_of_wind', unit: 'm/s' }, { name: '10m_v_component_of_wind', unit: 'm/s' }, { name: 'surface_pressure', unit: 'Pa' }, { name: 'geopotential', unit: 'm²/s²' }],
      start: '1940-01-01', end: null, resolution_m: 27830, license: 'various',
      access: { kind: 'zarr', url: 'gs://gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3', requires_auth: null, notes: 'Public GCS bucket, anonymous read; open with xarray + gcsfs/zarr (the HTTPS mirror https://storage.googleapis.com/gcp-public-data-arco-era5/ answered 200). Copernicus licence: attribution to the Copernicus Climate Change Service required.' },
    }),

    // --- Buildings -----------------------------------------------------------
    cur({
      source: 'google-open-buildings', local: 'v3', title: 'Google Open Buildings v3 (footprints, Africa, South and Southeast Asia, Latin America)',
      description: 'About 1.8 billion building footprint polygons with confidence scores and Plus Codes, detected from 50 cm satellite imagery across Africa, South Asia, Southeast Asia, Latin America and the Caribbean; companion temporal 2.5D height raster for Africa.',
      providers: ['Google Research'], themes: ['buildings', 'urban', 'infrastructure'],
      keywords: ['open buildings', 'google', 'building footprints', 'africa', 'south asia', 'polygons', 'confidence'],
      bbox: [-120, -60, 180, 40], global: false,
      start: '2023-05-01', end: '2023-05-01', resolution_m: 0.5, license: 'CC-BY-4.0',
      access: { kind: 'rest', url: 'https://sites.research.google/gr/open-buildings/', requires_auth: null, notes: 'Per-S2-cell CSV.gz on GCS (https://storage.googleapis.com/open-buildings-data/v3/, 200) and Earth Engine FeatureCollection GOOGLE/Research/open-buildings/v3/polygons. Licence CC-BY-4.0 and ODbL-1.0 (dual). Coverage box is approximate.' },
    }),
    cur({
      source: 'microsoft-buildings', local: 'global-ml-footprints', title: 'Microsoft Global ML Building Footprints',
      description: 'More than 1.4 billion building footprint polygons from Bing imagery for most countries, with height estimates in many regions, distributed as per-region line-delimited GeoJSON / GeoParquet; also on Planetary Computer as ms-buildings.',
      providers: ['Microsoft'], themes: ['buildings', 'urban', 'infrastructure'],
      keywords: ['microsoft', 'building footprints', 'global ml building footprints', 'bing', 'polygons', 'buildings', 'height'],
      start: null, end: null, resolution_m: null, license: 'ODbL-1.0',
      access: { kind: 'rest', url: 'https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv', requires_auth: null, notes: 'CSV index of per-region files (200), no key. Github README: github.com/microsoft/GlobalMLBuildingFootprints (not reachable from the harvest sandbox proxy). Planetary Computer mirror: planetarycomputer.microsoft.com/dataset/ms-buildings.' },
    }),
    cur({
      source: 'vida', local: 'google-microsoft-osm-buildings', title: 'VIDA Combined Google-Microsoft-OSM Open Buildings (GeoParquet)',
      description: 'Roughly 2.5 billion building footprints merged and de-duplicated from Google Open Buildings, Microsoft ML Buildings and OpenStreetMap, as GeoParquet partitioned by country on Source Cooperative.',
      providers: ['VIDA', 'Source Cooperative'], themes: ['buildings', 'urban', 'infrastructure'],
      keywords: ['buildings', 'footprints', 'geoparquet', 'google', 'microsoft', 'osm', 'source cooperative', 'vida', 'combined'],
      start: null, end: null, resolution_m: null, license: 'ODbL-1.0',
      access: { kind: 'geoparquet', url: 'https://source.coop/vida/google-microsoft-osm-open-buildings', requires_auth: null, notes: 'Source Cooperative page answered 200; data at s3://us-west-2.opendata.source.coop/vida/google-microsoft-osm-open-buildings/geoparquet/by_country/ (anonymous S3; bucket host not reachable from the sandbox proxy).' },
    }),


    // --- Point APIs: climate, hazards, bathymetry ----------------------------
    cur({
      source: 'nasa-power', local: 'daily-point', title: 'NASA POWER (MERRA-2 and CERES point time series)',
      description: 'Daily, hourly and monthly meteorology and solar-energy parameters at any point from NASA MERRA-2 reanalysis and CERES: temperature, precipitation, wind, humidity, solar radiation, from 1981 to near real time, tuned for agriculture and renewable energy.',
      providers: ['NASA Langley Research Center POWER'], themes: ['climate', 'weather', 'temperature', 'agriculture'],
      keywords: ['nasa power', 'merra-2', 'solar radiation', 'insolation', 'meteorology', 'agroclimatology', 'point time series', 'renewable energy'],
      variables: [{ name: 'T2M', unit: '°C' }, { name: 'PRECTOTCORR', unit: 'mm/day' }, { name: 'ALLSKY_SFC_SW_DWN', unit: 'kW-hr/m²/day' }, { name: 'WS2M', unit: 'm/s' }, { name: 'RH2M', unit: '%' }],
      start: '1981-01-01', end: null, resolution_m: 55000, license: 'public-domain',
      access: { kind: 'rest', url: 'https://power.larc.nasa.gov/api/temporal/daily/point', requires_auth: null, notes: 'GET ?parameters=&community=AG&longitude=&latitude=&start=&end=&format=JSON; no key (verified 200). MERRA-2 native grid is 0.5 x 0.625 degree.' },
    }),
    cur({
      source: 'usgs-earthquakes', local: 'fdsn-catalog', title: 'USGS Earthquake Catalog (FDSN event service)',
      description: 'Global earthquake catalog from the USGS ComCat: origin time, location, depth, magnitude and felt reports for events worldwide, queryable by time, magnitude and region; GeoJSON, CSV or QuakeML.',
      providers: ['USGS Earthquake Hazards Program'], themes: ['geology', 'hazards'],
      keywords: ['earthquake', 'seismic', 'magnitude', 'comcat', 'usgs', 'fault', 'seismicity', 'catalog'],
      variables: [{ name: 'mag' }, { name: 'depth', unit: 'km' }, { name: 'time' }],
      start: '1900-01-01', end: null, resolution_m: null, license: 'public-domain',
      access: { kind: 'rest', url: 'https://earthquake.usgs.gov/fdsnws/event/1/', requires_auth: null, notes: 'GET /query?format=geojson&starttime=&minmagnitude=&minlatitude=...; no key (count endpoint verified 200); 20k events per request.' },
    }),
    cur({
      source: 'nasa-eonet', local: 'events', title: 'NASA EONET Natural Event Tracker',
      description: 'Curated feed of ongoing and recent natural events with locations and dates: wildfires, severe storms, volcanoes, floods, sea and lake ice, dust and haze, drought, landslides, from NASA and partner sources.',
      providers: ['NASA Earth Observatory'], themes: ['hazards', 'fire', 'weather'],
      keywords: ['eonet', 'natural events', 'wildfires', 'storms', 'volcanoes', 'floods', 'disaster', 'event tracker'],
      start: '2000-01-01', end: null, resolution_m: null, license: 'public-domain',
      access: { kind: 'rest', url: 'https://eonet.gsfc.nasa.gov/api/v3/events', requires_auth: null, notes: 'GET /api/v3/events?status=open&category=wildfires&bbox=; no key (verified 200).' },
    }),
    cur({
      source: 'gebco', local: 'bathymetry-grid', title: 'GEBCO Global Bathymetry and Topography Grid (15 arc-second)',
      description: 'GEBCO global terrain model for ocean and land: seafloor depth and land elevation on a 15 arc-second grid (about 450 m), compiled from multibeam surveys, satellite gravity and SRTM; the reference global bathymetry.',
      providers: ['GEBCO / Nippon Foundation'], themes: ['ocean', 'elevation'],
      keywords: ['gebco', 'bathymetry', 'seafloor', 'ocean depth', 'topobathy', 'elevation', 'global grid'],
      variables: [{ name: 'elevation', unit: 'm' }],
      start: null, end: null, resolution_m: 463, license: 'public-domain',
      access: { kind: 'rest', url: 'https://www.gebco.net/data-products/gridded-bathymetry-data', requires_auth: null, notes: 'Download page (200): global NetCDF/GeoTIFF/ESRI ASCII grids, tiled downloads and a WMS; no key. Also in Earth Engine community catalogs.' },
    }),

    // --- Precipitation -------------------------------------------------------
    cur({
      source: 'chc', local: 'chirps-v2', title: 'CHIRPS v2 Rainfall (daily, 0.05 degree)',
      description: 'Climate Hazards Group InfraRed Precipitation with Station data: quasi-global daily, pentadal and monthly rainfall from 1981 to near present, blending satellite infrared with rain gauges; widely used for drought and food-security monitoring.',
      providers: ['UC Santa Barbara Climate Hazards Center'], themes: ['precipitation', 'climate', 'hazards'],
      keywords: ['chirps', 'rainfall', 'precipitation', 'drought', 'daily', 'pentad', 'monthly', 'gauge', 'infrared'],
      bbox: [-180, -50, 180, 50], global: false,
      variables: [{ name: 'precip', unit: 'mm/day' }],
      start: '1981-01-01', end: null, resolution_m: 5566, license: 'public-domain',
      access: { kind: 'cog', url: 'https://data.chc.ucsb.edu/products/CHIRPS-2.0/', requires_auth: null, notes: 'Static GeoTIFF/COG files over HTTPS, no key (e.g. global_daily/cogs/ answered 200). Coverage 50S-50N.' },
    }),
  ]
}
