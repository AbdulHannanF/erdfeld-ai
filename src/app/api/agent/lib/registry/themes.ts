/** Rule-based theme assignment for registry entries.
 *
 *  Two tiers of evidence:
 *  - `strong` terms are decisive when found in the title, keywords or collection id.
 *  - `weak` terms only count in the description, and only when two distinct terms
 *    (strong or weak) of the same theme appear — one stray word ("water" in a
 *    sentence about a sensor) must not tag a dataset.
 *
 *  Matching is whole-word (a trailing plural `s` is tolerated), so "dem" never
 *  matches "demand". Entries from catalogs that declare their own categories
 *  (Earth Engine's `gee:categories`, GCMD keywords on CMR) also pass through
 *  `CATEGORY_THEMES`.
 */

import type { Theme } from './types'
import { THEMES } from './types'

interface ThemeRule {
  strong: string[]
  weak?: string[]
}

export const THEME_RULES: Record<Theme, ThemeRule> = {
  elevation: {
    strong: [
      'dem', 'dsm', 'dtm', 'elevation', 'srtm', 'nasadem', 'copernicus dem', 'cop-dem', 'glo-30', 'glo-90',
      'aster gdem', 'aster-gdem', 'gdem', 'alos world 3d', 'aw3d', 'aw3d30', 'topography', 'topographic', 'terrain',
      'digital elevation', 'digital surface model', 'digital terrain model', 'bathymetry', 'gebco', 'merit dem', 'fabdem',
      'tandem-x', 'tandemx', 'tdx', 'slope', 'hillshade', 'height above ground',
    ],
    weak: ['altitude', 'relief', 'geoid', 'contour', 'meters above sea level'],
  },
  lidar: {
    strong: [
      'lidar', 'point cloud', 'point-cloud', 'copc', '3dep', 'canopy height', 'canopy-height', 'gedi', 'icesat',
      'icesat-2', 'atl08', 'atl03', 'laser altimetry', 'waveform', 'entwine', 'laz', 'height above ground', 'chm',
    ],
    weak: ['airborne laser', 'laser scanning', 'terrestrial laser', 'uav lidar', 'canopy structure'],
  },
  sar: {
    strong: [
      'sar', 'sentinel-1', 'sentinel1', 'alos-palsar', 'alos palsar', 'palsar', 'backscatter', 'radar', 'insar',
      'interferometric', 'interferogram', 'rtc', 'sigma0', 'gamma0', 'nisar', 'uavsar', 'radarsat', 'terrasar',
      'cosmo-skymed', 'synthetic aperture', 'iceye', 'capella', 'umbra', 'tandem-x', 'cband', 'l-band sar',
    ],
    weak: ['polarization', 'polarisation', 'vv', 'vh', 'microwave'],
  },
  optical: {
    strong: [
      'sentinel-2', 'sentinel2', 'landsat', 'surface reflectance', 'multispectral', 'hyperspectral', 'imagery', 'naip',
      'aerial imagery', 'orthophoto', 'ortho', 'harmonized landsat', 'hls', 'planetscope', 'rapideye',
      'worldview', 'top of atmosphere', 'true color', 'rgb', 'reflectance', 'optical', 'sentinel-2-l2a', ],
    weak: ['nir', 'swir', 'red edge', 'visible', 'spectral bands', 'cloud cover'],
  },
  'land-cover': {
    strong: [
      'land cover', 'landcover', 'land use', 'land-use', 'lulc', 'worldcover', 'dynamic world', 'corine', 'clc',
      'nlcd', 'cropland data layer', 'globcover', 'cci land cover', 'glc', 'esri land cover', 'io-lulc', 'land-cover',
      'land cover classification', 'mcd12q1', 'cgls-lc100', 'copernicus global land cover', 'cglc', 'globeland30',
      'fromgc', 'glad land cover', 'esa cci lc', 'impervious', 'built-up', 'built up', 'ghsl', 'land cover change',
    ],
    weak: ['land cover', 'classification map', 'class map', 'thematic map'],
  },
  vegetation: {
    strong: [
      'ndvi', 'evi', 'vegetation', 'vegetation index', 'lai', 'leaf area index', 'fapar', 'fcover', 'gpp',
      'gross primary', 'primary productivity', 'biomass', 'savi', 'phenology', 'greenness', 'chlorophyll',
      'canopy', 'fractional cover', 'tree cover', 'above-ground biomass', 'agb', 'vegetation continuous fields',
      'vcf', 'solar-induced fluorescence', 'sif', 'evapotranspiration', 'dry matter productivity', 'dmp',
    ],
    weak: ['plant', 'photosynthesis', 'leaf', 'green-up'],
  },
  forest: {
    strong: [
      'forest', 'forests', 'deforestation', 'tree cover', 'tree canopy', 'tree loss', 'forest loss', 'hansen',
      'global forest change', 'gfc', 'glad', 'radd', 'forest cover', 'afforestation', 'reforestation', 'mangrove',
      'mangroves', 'logging', 'timber', 'primary forest', 'peat', 'peatland', 'tropical forest', 'treecover',
      'canopy height', 'forest height', 'woody', 'carbon flux', 'forest carbon', 'above-ground biomass',
    ],
    weak: ['woodland', 'trees', 'canopy', 'silvicultur', 'forestry'],
  },
  agriculture: {
    strong: [
      'crop', 'crops', 'cropland', 'agriculture', 'agricultural', 'agri', 'cdl', 'cropland data layer', 'irrigation',
      'irrigated', 'crop type', 'crop yield', 'yield', 'harvest', 'farm', 'farmland', 'field boundaries', 'smallholder',
      'pasture', 'rangeland', 'livestock', 'food security', 'growing season', 'fasal', 'gaez', 'mirca', 'crop mask',
      'agland', 'aafc', 'cultivated',
    ],
    weak: ['farming', 'planting', 'sowing', 'drought monitoring'],
  },
  soil: {
    strong: [
      'soil', 'soils', 'soilgrids', 'soil moisture', 'soil organic carbon', 'soc', 'soil texture', 'soil ph', 'clay',
      'sand content', 'cation exchange', 'bulk density', 'pedology', 'ssurgo', 'gssurgo', 'smap', 'smos', 'topsoil',
      'soil carbon', 'soil temperature', 'hwsd', 'harmonized world soil', 'soil type', 'land degradation',
      'soil erosion', 'erosion',
    ],
    weak: ['regolith', 'loam', 'nitrogen content', 'subsoil'],
  },
  climate: {
    strong: [
      'climate', 'cmip', 'cmip5', 'cmip6', 'nex-gddp', 'nex-gddp-cmip6', 'era5', 'era5-land', 'reanalysis', 'merra',
      'merra-2', 'jra-55', 'ncep', 'cordex', 'projection', 'climatology', 'worldclim', 'chelsa', 'terraclimate',
      'daymet', 'gridmet', 'climate change', 'downscaled', 'bioclim', 'normals', 'climate normals', 'global warming',
      'greenhouse', 'carbon dioxide', 'co2', 'methane', 'ch4', 'ghg', 'anomaly', 'berkeley earth', 'ncei',
      'aridity', 'koppen', 'köppen', 'oco-2', 'oco-3', 'gosat',
    ],
    weak: ['long-term', 'decadal', 'atmospheric reanalysis', 'radiation budget', 'ceres'],
  },
  weather: {
    strong: [
      'weather', 'forecast', 'forecasts', 'nowcast', 'gfs', 'ecmwf', 'ifs', 'hrrr', 'wind', 'humidity',
      'radar reflectivity', 'nexrad', 'mrms', 'storm', 'cyclone', 'hurricane', 'typhoon',
      'lightning', 'glm', 'goes', 'himawari', 'meteorology', 'surface pressure', 'dew point', 'geopotential', 'open-meteo', 'wind speed', ],
    weak: ['atmosphere', 'synoptic', 'gridded surface', 'atmospheric', 'meteorological'],
  },
  precipitation: {
    strong: [
      'precipitation', 'rainfall', 'rain', 'chirps', 'chirp', 'gpm', 'imerg', 'trmm', 'gsmap', 'persiann', 'cmorph',
      'mswep', 'mrms', 'snowfall', 'precip', 'qpe', 'pdir', 'tamsat', 'cpc', 'gpcp', 'gpcc', 'era5 precipitation',
      'total precipitation', 'drought', 'spi', 'spei', 'pdsi',
    ],
    weak: ['monsoon', 'rain gauge', 'wet days'],
  },
  temperature: {
    strong: [
      'temperature', 'land surface temperature', 'lst', 'sea surface temperature', 'sst', 'brightness temperature',
      'thermal', 'heat island', 'tmax', 'tmin', 'air temperature', '2m temperature', 'skin temperature',
      'surface temperature', 'ghrsst', 'mur sst', 'oisst', 'warming', 'thermal infrared', 'tir', 'ecostress',
      'lst_day', 'lst_night', 'tasmax', 'tasmin',
    ],
    weak: ['kelvin', 'celsius', 'infrared emission'],
  },
  water: {
    strong: [
      'surface water', 'water occurrence', 'jrc global surface water', 'jrc-gsw', 'gsw', 'flood', 'flooding',
      'inundation', 'lake', 'lakes', 'river', 'rivers', 'wetland', 'wetlands', 'reservoir', 'water body', 'waterbody',
      'water bodies', 'ndwi', 'mndwi', 'swot', 'water extent', 'water quality', 'turbidity', 'gfm', 'global flood monitoring',
      'dswe', 'water mask', 'coastline', 'shoreline', 'groundwater', 'grace', 'gldas', 'water level', 'water storage',
      'hydroweb', 'aqueduct', 'water stress', 'irrigation water', 'hydrography',
    ],
    weak: ['wet', 'aquatic', 'lakes and rivers', 'water mask', 'streamflow', 'water'],
  },
  hydrology: {
    strong: [
      'hydrology', 'hydrological', 'hydrography', 'watershed', 'catchment', 'basin', 'basins', 'hydrosheds', 'hydrobasins',
      'hydrolakes', 'hydrorivers', 'streamflow', 'discharge', 'runoff', 'river network', 'flow accumulation',
      'flow direction', 'drainage', 'glofas', 'nwm', 'national water model', 'evapotranspiration', 'groundwater',
      'soil moisture', 'water balance', 'hydro', 'merit hydro', 'gauge', 'gauges', 'streamgage', 'usgs water',
      'floodplain', 'flood hazard', 'flood risk', 'river discharge', 'grdc', 'grace', 'terrestrial water storage',
    ],
    weak: ['stream', 'rivers', 'hydrologic', 'precipitation runoff'],
  },
  'snow-ice': {
    strong: [
      'snow', 'snow cover', 'snow depth', 'swe', 'snow water equivalent', 'glacier', 'glaciers', 'ice', 'sea ice',
      'ice sheet', 'cryosphere', 'permafrost', 'snowpack', 'nsidc', 'ice thickness', 'randolph glacier',
      'rgi', 'icesat', 'snodas', 'sea-ice', 'iceberg', 'ice extent', 'ice concentration', 'frozen', 'freeze', 'thaw',
      'ndsi', 'modis snow', 'mod10', 'myd10', ],
    weak: ['glacial', 'polar', 'frozen ground', 'snowmelt'],
  },
  ocean: {
    strong: [
      'ocean', 'oceans', 'sea', 'marine', 'sea surface', 'sst', 'chlorophyll-a', 'ocean color', 'ocean colour',
      'bathymetry', 'sea level', 'sea surface height', 'altimetry', 'wave height', 'waves', 'tide', 'tides', 'salinity',
      'currents', 'ocean current', 'coral', 'coral reef', 'seagrass', 'coastal', 'shelf', 'swot', 'ghrsst', 'oceancolor', 'obpg', 'marine heatwave', 'phytoplankton', 'gebco', 'vessel', 'shipping',
      'fishing', 'global fishing watch', 'copernicus marine', 'cmems', 'hycom', ],
    weak: ['maritime', 'oceanic', 'subsurface', 'thermocline'],
  },
  'air-quality': {
    strong: [
      'air quality', 'air-quality', 'pm2.5', 'pm25', 'pm10', 'no2', 'nitrogen dioxide', 'ozone', 'o3', 'so2', 'sulfur dioxide',
      'sulphur dioxide', 'carbon monoxide', 'aerosol', 'aerosol optical depth', 'aod', 'tropomi', 'sentinel-5p',
      'sentinel 5p', 'cams', 'openaq', 'aqi', 'pollution', 'pollutant', 'particulate', 'formaldehyde', 'hcho',
      'emissions', 'ozone monitoring instrument', 'omi', 'maiac', 'tempo', 'mopitt', 'atmospheric composition',
      'atmospheric chemistry', 'trace gas', 'smoke', 'dust', 'methane',
    ],
    weak: ['atmospheric', 'column density', 'tropospheric'],
  },
  fire: {
    strong: [
      'fire', 'fires', 'wildfire', 'wildfires', 'burn', 'burned', 'burnt', 'burned area', 'burn scar', 'burn severity',
      'active fire', 'hotspot', 'hotspots', 'firms', 'viirs fire', 'modis fire', 'mod14', 'mcd64', 'mcd64a1', 'vnp14',
      'fire radiative power', 'frp', 'dnbr', 'nbr', 'mtbs', 'fire danger', 'fire weather', 'fire perimeter', 'fire perimeters',
      'effis', 'gwis', 'firecci', 'fire_cci', 'fire cci', 'landfire', 'fuel', 'fuels',
    ],
    weak: ['burning', 'combustion', 'smoke plume'],
  },
  population: {
    strong: [
      'population', 'populations', 'worldpop', 'ghs-pop', 'ghs pop', 'ghsl pop', 'gpw', 'gridded population', 'landscan',
      'kontur', 'census', 'demographic', 'demographics', 'human settlement', 'settlement', 'settlements',
      'population density', 'population count', 'people', 'inhabitants', 'sedac', 'hrsl', 'high resolution settlement',
      'humdata', 'hdx', 'age and sex', 'poverty', 'wealth', 'gdp', 'socioeconomic', 'socio-economic', 'human development',
      'night-time', 'gridded population of the world',
    ],
    weak: ['inhabited', 'households', 'urbanization', 'migration'],
  },
  urban: {
    strong: [
      'urban', 'city', 'cities', 'built-up', 'built up', 'built environment', 'ghsl', 'global human settlement',
      'impervious', 'imperviousness', 'urban extent', 'urban area', 'settlement', 'urbanization', 'urban heat',
      'urban growth', 'local climate zone', 'lcz', 'urban footprint', 'wsf', 'world settlement footprint',
      'built-up area', 'built surface', 'urban morphology', 'sprawl', 'metropolitan', 'smod', 'degree of urbanisation',
      'human settlement layer',
    ],
    weak: ['town', 'municipal', 'suburban', 'neighborhood', 'neighbourhood'],
  },
  buildings: {
    strong: [
      'building', 'buildings', 'building footprint', 'building footprints', 'open buildings', 'building height',
      'microsoft buildings', 'ms buildings', 'overture buildings', 'footprints', 'rooftop', 'roof', 'building heights',
      'ghs-built', 'ghs built', 'ghs-bu', 'building density', '3d buildings',
      'osm buildings', 'google-microsoft-osm',
    ],
    weak: ['dwelling', 'houses', 'residential'],
  },
  infrastructure: {
    strong: [
      'infrastructure', 'road', 'roads', 'road network', 'transportation', 'transport', 'railway', 'railways', 'rail',
      'airport', 'airports', 'ports', 'power plant', 'power plants', 'power grid', 'electricity', 'energy', 'pipeline', 'pipelines', 'bridge', 'bridges', 'overture', 'overpass', 'openstreetmap', 'osm', 'points of interest',
      'poi', 'facilities', 'schools', 'hospitals', 'health facilities', 'telecom', 'cell tower', 'mobile coverage',
      'connectivity', 'segments', 'connectors', 'highway', 'highways', 'street', 'streets', 'solar farm', 'wind farm',
      'mining', 'mines', 'oil and gas', 'dams', 'global dam watch', 'grand', 'transmission lines',
    ],
    weak: ['routing', 'network analysis', 'land use planning'],
  },
  nightlights: {
    strong: [
      'nightlights', 'night lights', 'night-time lights', 'nighttime lights', 'night time lights', 'nighttime light',
      'night-time light', 'viirs dnb', 'dnb', 'day/night band', 'day-night band', 'dmsp', 'dmsp-ols', 'vnl',
      'black marble', 'vnp46', 'vnp46a1', 'vnp46a2', 'vnp46a3', 'vnp46a4', 'vj146', 'noaa-20 dnb', 'light pollution',
      'artificial light', 'nightlight', 'nighttime radiance', 'harmonized nighttime',
    ],
    weak: ['electrification', 'illumination'],
  },
  geology: {
    strong: [
      'geology', 'geologic', 'geological', 'lithology', 'rock', 'bedrock', 'mineral', 'minerals', 'mineralogy',
      'earthquake', 'seismic', 'fault', 'faults', 'tectonic', 'gravity', 'magnetic', 'magnetics', 'aeromagnetic',
      'volcano', 'volcanoes', 'volcanic', 'geophysics', 'geophysical', 'surficial geology', 'mineral resources',
      'geochemistry', 'emit', 'lithologic', 'geoid', 'crust', 'mantle', 'subsurface', 'karst', 'landslide', 'landslides',
      'insar', 'subsidence', 'deformation', 'ground motion', 'displacement', 'usgs geologic', 'rock type',
    ],
    weak: ['sediment', 'stratigraphy', 'outcrop'],
  },
  biodiversity: {
    strong: [
      'biodiversity', 'species', 'habitat', 'habitats', 'protected area', 'protected areas', 'wdpa', 'iucn', 'key biodiversity',
      'kba', 'ecosystem', 'ecosystems', 'ecoregion', 'ecoregions', 'biome', 'biomes', 'wildlife', 'conservation',
      'endemic', 'intactness', 'gbif', 'occurrence', 'range map', 'bird', 'birds', 'ebird', 'mammals', 'amphibians',
      'marine protected', 'natura 2000', 'biodiversity hotspots', 'rewilding', 'tropical wet', 'terrestrial ecoregions',
      'global ecosystem', 'ecosystem map', 'mangrove', 'coral', 'bioclim', 'phenology', 'animal movement', 'movebank',
    ],
    weak: ['flora', 'fauna', 'ecological', 'taxa'],
  },
  hazards: {
    strong: [
      'hazard', 'hazards', 'disaster', 'disasters', 'flood', 'floods', 'earthquake', 'earthquakes', 'landslide',
      'landslides', 'tsunami', 'volcano', 'drought', 'cyclone', 'hurricane', 'typhoon', 'storm surge', 'wildfire',
      'risk', 'vulnerability', 'exposure', 'emergency', 'damage', 'damage assessment', 'eonet', 'gdacs', 'reliefweb',
      'natural hazard', 'heatwave', 'heat wave', 'avalanche', 'sinkhole', 'subsidence', 'insar', 'glof', 'tornado',
      'lightning', 'oil spill', 'tailings', 'conflict', 'ucdp', 'acled', 'humanitarian', 'rapid mapping', 'copernicus ems',
    ],
    weak: ['catastrophe', 'hazardous', 'preparedness'],
  },
  boundaries: {
    strong: [
      'boundaries', 'boundary', 'administrative', 'admin', 'adm0', 'adm1', 'adm2', 'gadm', 'divisions', 'division',
      'country borders', 'borders', 'geoboundaries', 'natural earth', 'countries', 'provinces',
      'districts', 'municipalities', 'census tracts', 'tiger', 'nuts', 'postal codes', 'eez', 'exclusive economic zone',
      'maritime boundaries', 'cadastre', 'cadastral', 'parcels', 'parcel', 'land ownership', 'indigenous territories',
      'indigenous lands', 'concessions', 'localities', 'gazetteer', 'admin boundaries', 'overture divisions',
    ],
    weak: ['jurisdiction', 'territory', 'territories'],
  },
  embeddings: {
    strong: [
      'embedding', 'embeddings', 'alphaearth', 'alpha earth', 'satellite embedding', 'satellite embeddings', 
      'prithvi', 'geofm', 'foundation model', 'foundation models', 'tessera', 'major tom', 'major-tom', 'ssl4eo', 'dinov2',
      'vector embeddings', 'learned features', 'latent', 'google satellite embedding', 'galileo', 'presto', 'satlas',
      'terramind', 'copernicus-fm', 'croma', 'dofa', 'remoteclip', 'geoclip',
    ],
    weak: ['self-supervised', 'pretrained', 'deep learning features', 'feature vectors'],
  },
}

/** Earth Engine `gee:categories` and similar catalog-declared categories. */
export const CATEGORY_THEMES: Record<string, Theme[]> = {
  'elevation-topography': ['elevation'],
  'topography': ['elevation'],
  'imagery': ['optical'],
  'landsat': ['optical'],
  'sentinel': ['optical'],
  'satellite-imagery': ['optical'],
  'landcover': ['land-cover'],
  'landuse-landcover': ['land-cover'],
  'forest-biomass': ['forest', 'vegetation'],
  'vegetation-indices': ['vegetation'],
  'vegetation': ['vegetation'],
  'agriculture': ['agriculture'],
  'crop': ['agriculture'],
  'soil': ['soil'],
  'climate': ['climate'],
  'climate-and-weather': ['climate', 'weather'],
  'climate-and-weather-data': ['climate', 'weather'],
  'weather': ['weather'],
  'precipitation': ['precipitation'],
  'temperature': ['temperature'],
  'surface-temperature': ['temperature'],
  'water': ['water'],
  'surface-water': ['water'],
  'hydrology': ['hydrology'],
  'cryosphere': ['snow-ice'],
  'ocean': ['ocean'],
  'oceans': ['ocean'],
  'air-quality': ['air-quality'],
  'fire': ['fire'],
  'fire-and-burned-area': ['fire'],
  'population': ['population'],
  'demographics': ['population'],
  'night-lights': ['nightlights'],
  'urban': ['urban'],
  'geophysical': ['geology'],
  'geology': ['geology'],
  'biodiversity': ['biodiversity'],
  'disasters': ['hazards'],
  'hazards': ['hazards'],
  'boundaries': ['boundaries'],
  'infrastructure': ['infrastructure'],
  'sar': ['sar'],
  'radar': ['sar'],
  'lidar': ['lidar'],
  'embeddings': ['embeddings'],
}

/** GCMD science keywords (CMR collections carry these as `keywords`). */
export const GCMD_THEMES: Array<[RegExp, Theme[]]> = [
  [/\bsoils?\b|soil moisture/i, ['soil']],
  [/\bsnow\/ice\b|cryosphere|sea ice|glacier|snow cover|ice sheet/i, ['snow-ice']],
  [/\boceans?\b|sea surface|ocean color|ocean temperature|salinity|sea level/i, ['ocean']],
  [/air quality|aerosols?|trace gas|ozone|nitrogen dioxide|carbon monoxide|atmospheric chemistry/i, ['air-quality']],
  [/\bprecipitation\b|rainfall/i, ['precipitation']],
  [/vegetation|biomass|leaf area|photosynthesis|primary production|chlorophyll/i, ['vegetation']],
  [/\bforest|canopy|tree cover/i, ['forest']],
  [/land surface temperature|sea surface temperature|air temperature|surface temperature|brightness temperature/i, ['temperature']],
  [/fire|burned area|biomass burning/i, ['fire']],
  [/population|human settlements|settlements|socioeconomic|demographic/i, ['population']],
  [/night.?time lights|nighttime|city lights|night lights/i, ['nightlights']],
  [/land cover|land use|lulc/i, ['land-cover']],
  [/terrain elevation|topography|digital elevation|bathymetry/i, ['elevation']],
  [/agricultur|crop|irrigation|yield/i, ['agriculture']],
  [/surface water|inundation|flood|wetland|lake|river/i, ['water']],
  [/hydrology|runoff|streamflow|evapotranspiration|groundwater|water balance|terrestrial water storage/i, ['hydrology']],
  [/urban|impervious|built-up/i, ['urban']],
  [/radar|\bsar\b|backscatter|synthetic aperture/i, ['sar']],
  [/lidar|laser altim|waveform|point cloud/i, ['lidar']],
  [/geolog|seismic|earthquake|volcan|gravity|magnetic|tectonic|geophysic/i, ['geology']],
  [/biodiversity|species|habitat|ecosystem/i, ['biodiversity']],
  [/natural hazard|disaster|drought|cyclone|hurricane|landslide|tsunami/i, ['hazards']],
  [/climate|reanalysis|radiation budget|greenhouse|carbon dioxide|methane/i, ['climate']],
  [/weather|clouds?\b|wind|humidity|atmospheric pressure|lightning/i, ['weather']],
  [/boundaries|administrative/i, ['boundaries']],
  [/infrastructure|roads|transport/i, ['infrastructure']],
  [/reflectance|multispectral|hyperspectral|imagery/i, ['optical']],
]

// ---------------------------------------------------------------------------

const REGEX_CACHE = new Map<string, RegExp>()

function termRegex(term: string): RegExp {
  let re = REGEX_CACHE.get(term)
  if (!re) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s_-]+/g, '[\\s_-]*')
    re = new RegExp(`(?<![a-z0-9])${esc}s?(?![a-z0-9])`, 'i')
    REGEX_CACHE.set(term, re)
  }
  return re
}

const COMPILED = new Map<Theme, { strong: RegExp[]; weak: RegExp[] }>()

/** Regexes per theme, one per DISTINCT pattern ("air quality" and "air-quality" are the same pattern). */
function compiledRules(theme: Theme): { strong: RegExp[]; weak: RegExp[] } {
  let c = COMPILED.get(theme)
  if (!c) {
    const uniq = (terms: string[] = []) => {
      const seen = new Set<string>()
      const out: RegExp[] = []
      for (const t of terms) {
        const re = termRegex(t)
        if (!seen.has(re.source)) { seen.add(re.source); out.push(re) }
      }
      return out
    }
    c = { strong: uniq(THEME_RULES[theme].strong), weak: uniq(THEME_RULES[theme].weak) }
    COMPILED.set(theme, c)
  }
  return c
}

export interface ThemeInput {
  id?: string
  title?: string
  keywords?: string[]
  description?: string
  /** Pre-declared categories (Earth Engine) or GCMD keywords (CMR). */
  categories?: string[]
}

/**
 * Assign themes. Pure and deterministic; returns at most `max` themes ordered by
 * evidence, in the controlled vocabulary order for ties.
 */
export function assignThemes(input: ThemeInput, max = 5): Theme[] {
  const strongText = [input.id ?? '', input.title ?? '', (input.keywords ?? []).join(' ; ')].join(' ; ')
  const desc = (input.description ?? '').slice(0, 1500)
  const scores = new Map<Theme, number>()
  const add = (t: Theme, n: number) => scores.set(t, (scores.get(t) ?? 0) + n)

  for (const theme of THEMES) {
    const { strong, weak } = compiledRules(theme)
    let strongHits = 0
    let descHits = 0
    for (const re of strong) {
      if (re.test(strongText)) strongHits++
      else if (desc && re.test(desc)) descHits++
    }
    for (const re of weak) {
      if (desc && re.test(desc)) descHits++
    }
    if (strongHits > 0) add(theme, 3 + strongHits * 1.5 + descHits * 0.3)
    else if (descHits >= 2) add(theme, descHits * 1.2)
  }

  for (const cat of input.categories ?? []) {
    const key = cat.toLowerCase().trim()
    const direct = CATEGORY_THEMES[key]
    if (direct) for (const t of direct) add(t, 4)
    for (const [re, themes] of GCMD_THEMES) {
      if (re.test(cat)) for (const t of themes) add(t, 1.5)
    }
  }

  // Only the CMR/GCMD path should be generous with weak evidence; a theme
  // supported solely by GCMD keywords needs at least two keyword hits.
  return [...scores.entries()]
    .filter(([, s]) => s >= 2.4)
    .sort((a, b) => b[1] - a[1] || THEMES.indexOf(a[0]) - THEMES.indexOf(b[0]))
    .slice(0, max)
    .map(([t]) => t)
}
