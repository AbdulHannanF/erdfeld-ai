/** Query expansion for domain vocabulary.
 *
 *  People ask for "deforestation", catalogs say "tree cover loss" or "Hansen".
 *  Each rule fires when ANY phrase in `when` occurs in the query (whole words,
 *  plurals tolerated) and adds the `add` phrases as lower-weight query terms, so
 *  the user's own words still dominate the ranking.
 */

export interface SynonymRule {
  when: string[]
  add: string[]
}

export const SYNONYM_RULES: SynonymRule[] = [
  // --- soil / moisture
  { when: ['soil moisture', 'soil wetness', 'root zone moisture', 'surface moisture'], add: ['smap', 'smos', 'esa cci soil moisture', 'soil moisture active passive', 'sm', 'gldas', 'era5-land', 'volumetric soil water'] },
  { when: ['soil', 'soil property', 'soil properties', 'soil texture', 'soil carbon', 'soil organic carbon', 'clay content', 'soil ph'], add: ['soilgrids', 'isric', 'soil organic carbon', 'clay sand silt', 'hwsd', 'gssurgo'] },
  // --- forest / canopy
  { when: ['deforestation', 'forest loss', 'tree cover loss', 'forest clearing', 'clear cutting', 'illegal logging', 'tree loss'], add: ['forest loss', 'tree cover loss', 'hansen global forest change', 'glad', 'radd', 'gfw', 'integrated alerts'] },
  { when: ['forest cover', 'tree cover', 'forest extent', 'tree canopy cover'], add: ['hansen', 'tree cover', 'vcf', 'vegetation continuous fields', 'forest', 'canopy cover', 'worldcover'] },
  { when: ['canopy height', 'tree height', 'vegetation height', 'forest height', 'canopy top height'], add: ['gedi', 'meta canopy height', 'chm', '3dep height above ground', 'icesat-2 atl08', 'lidar', 'forest structure'] },
  { when: ['biomass', 'above ground biomass', 'carbon stock', 'forest carbon'], add: ['agb', 'gedi l4b', 'esa cci biomass', 'biomass', 'carbon', 'vegetation'] },
  { when: ['mangrove', 'mangroves'], add: ['global mangrove watch', 'mangrove', 'coastal', 'tidal'] },
  // --- population / urban / buildings
  { when: ['population', 'people', 'inhabitants', 'demographics', 'how many people'], add: ['worldpop', 'ghsl', 'ghs-pop', 'kontur', 'gridded population', 'population density', 'gpw', 'landscan'] },
  { when: ['urban', 'city', 'cities', 'urbanization', 'urban growth', 'urban expansion', 'built up', 'built-up', 'settlement'], add: ['ghsl', 'global human settlement', 'built-up surface', 'impervious', 'world settlement footprint', 'urban extent', 'worldcover'] },
  { when: ['building', 'buildings', 'building footprint', 'building footprints', 'rooftops'], add: ['overture buildings', 'microsoft building footprints', 'google open buildings', 'ghs-built', 'osm buildings', 'footprints'] },
  { when: ['roads', 'road network', 'streets', 'highways', 'road'], add: ['overture transportation', 'openstreetmap', 'osm', 'overpass', 'road network', 'segments'] },
  { when: ['points of interest', 'poi', 'pois', 'hospitals', 'schools', 'amenities', 'shops'], add: ['overture places', 'openstreetmap', 'osm', 'overpass', 'places'] },
  // --- elevation / terrain
  { when: ['elevation', 'altitude', 'height above sea level', 'terrain', 'topography', 'dem', 'digital elevation model', 'srtm', 'slope', 'hillshade'], add: ['nasadem', 'copernicus dem', 'cop-dem-glo-30', 'srtm', 'dem', 'alos world 3d', 'aster gdem', 'fabdem', 'digital elevation'] },
  { when: ['digital surface model', 'dsm'], add: ['copernicus dem glo-30', 'alos world 3d', 'aw3d30', 'tandem-x', 'dsm'] },
  { when: ['digital terrain model', 'dtm', 'bare earth', 'bare-earth'], add: ['fabdem', 'merit dem', 'lidar', '3dep', 'dtm', 'opentopography'] },
  { when: ['lidar', 'point cloud', 'point clouds', 'laser scanning'], add: ['3dep lidar', 'entwine point tiles', 'ept', 'opentopography', 'point cloud', 'copc', 'gedi', 'icesat-2'] },
  { when: ['bathymetry', 'seafloor', 'sea floor', 'ocean depth', 'water depth'], add: ['gebco', 'bathymetry', 'ocean', 'elevation'] },
  // --- SAR / radar / floods / deformation
  { when: ['sar', 'synthetic aperture radar', 'radar backscatter', 'backscatter', 'radar imagery', 'all weather imaging', 'cloud penetrating', 'through clouds', 'see through cloud', 'sees through cloud', 'in cloudy conditions'], add: ['sentinel-1', 'sentinel-1 rtc', 'alos palsar', 'backscatter', 'sar', 'nisar', 'radar'] },
  { when: ['l band', 'l-band'], add: ['alos palsar', 'palsar-2', 'nisar', 'l-band sar', 'sar'] },
  { when: ['c band', 'c-band'], add: ['sentinel-1', 'radarsat', 'c-band sar', 'sar'] },
  { when: ['x band', 'x-band'], add: ['terrasar-x', 'tandem-x', 'cosmo-skymed', 'x-band sar', 'sar'] },
  { when: ['p band', 'p-band'], add: ['biomass mission', 'airmoss', 'p-band sar', 'sar'] },
  { when: ['flood', 'floods', 'flooding', 'inundation', 'flood extent', 'flood mapping'], add: ['sentinel-1', 'jrc global surface water', 'gfm global flood monitoring', 'surface water', 'water occurrence', 'glofas', 'inundation', 'sar'] },
  { when: ['subsidence', 'land subsidence', 'ground deformation', 'ground motion', 'sinking', 'uplift', 'insar', 'interferometric', 'interferometry', 'interferogram'], add: ['insar', 'sentinel-1 slc', 'single look complex', 'slc', 'interferogram', 'interferometric', 'sar', 'displacement', 'deformation', 'unwrapped', 'gunw', 'aria'] },
  { when: ['landslide', 'landslides', 'slope failure'], add: ['landslide', 'sentinel-1', 'slope', 'elevation', 'hazard', 'insar'] },
  // --- water
  { when: ['surface water', 'water bodies', 'lakes', 'reservoirs', 'water extent', 'water mask', 'water occurrence', 'rivers'], add: ['jrc global surface water', 'jrc-gsw', 'water occurrence', 'surface water', 'hydrolakes', 'swot', 'dynamic world'] },
  { when: ['drought', 'dry spell', 'water stress', 'aridity'], add: ['spei', 'chirps', 'soil moisture', 'evapotranspiration', 'ndvi', 'drought', 'terraclimate', 'pdsi', 'vegetation health'] },
  { when: ['evapotranspiration', 'evaporation', 'et'], add: ['modis mod16', 'evapotranspiration', 'pml', 'ssebop', 'terraclimate', 'etc', 'openet'] },
  { when: ['groundwater', 'water storage', 'aquifer', 'terrestrial water storage'], add: ['grace', 'gldas', 'groundwater', 'water storage', 'grace-fo'] },
  { when: ['river discharge', 'streamflow', 'river flow', 'runoff'], add: ['glofas', 'river discharge', 'streamflow', 'hydrology', 'nwm', 'runoff', 'era5-land'] },
  // --- climate / weather
  { when: ['quantitative precipitation estimate', 'quantitative precipitation estimates', 'qpe', 'radar precipitation', 'weather radar', 'radar rainfall', 'radar-based precipitation'], add: ['mrms', 'qpe', 'multi-radar multi-sensor', 'nexrad', 'noaa mrms qpe', 'radar precipitation'] },
  { when: ['rainfall', 'rain', 'precipitation', 'precip', 'monsoon'], add: ['chirps', 'imerg', 'gpm', 'era5', 'precipitation', 'rainfall', 'gsmap', 'persiann'] },
  { when: ['temperature', 'air temperature', 'heat', 'heatwave', 'heat wave', 'warming'], add: ['era5', 'era5-land', 'terraclimate', 'modis lst', 'temperature', 'chirts', 'daymet', 'worldclim'] },
  { when: ['land surface temperature', 'lst', 'urban heat island', 'surface heat', 'thermal'], add: ['modis lst', 'mod11', 'landsat collection 2 level-2 surface temperature', 'ecostress', 'viirs lst', 'thermal'] },
  { when: ['sea surface temperature', 'sst'], add: ['ghrsst', 'oisst', 'mur sst', 'sea surface temperature', 'ocean', 'sst'] },
  { when: ['climate', 'climatology', 'climate normals', 'reanalysis', 'historical weather'], add: ['era5', 'era5-land', 'worldclim', 'terraclimate', 'chelsa', 'reanalysis', 'climate'] },
  { when: ['climate projection', 'climate projections', 'future climate', 'climate change scenarios', 'cmip6', 'downscaled climate'], add: ['nex-gddp-cmip6', 'cmip6', 'downscaled', 'projections', 'climate change', 'open-meteo climate'] },
  { when: ['weather', 'weather forecast', 'forecast', 'wind', 'wind speed'], add: ['open-meteo', 'gfs', 'ecmwf', 'icon', 'forecast', 'era5', 'wind'] },
  { when: ['solar', 'solar radiation', 'solar irradiance', 'insolation', 'sunshine'], add: ['solar radiation', 'era5', 'nasa power', 'ceres', 'shortwave radiation', 'irradiance'] },
  // --- cryosphere / ocean
  { when: ['snow', 'snow cover', 'snowpack', 'snow depth', 'snow water equivalent', 'swe'], add: ['modis snow cover', 'mod10a1', 'snodas', 'ndsi', 'snow', 'swe', 'viirs snow', 'nsidc'] },
  { when: ['glacier', 'glaciers', 'ice sheet', 'ice sheets', 'permafrost', 'ice cap'], add: ['randolph glacier inventory', 'rgi', 'glims', 'global land ice measurements from space', 'icesat-2', 'nsidc', 'glacier', 'ice', 'cryosphere'] },
  { when: ['sea ice', 'arctic ice', 'ice concentration', 'ice extent'], add: ['nsidc', 'sea ice', 'passive microwave', 'amsr2', 'ice concentration', 'cryosphere'] },
  { when: ['chlorophyll', 'ocean color', 'ocean colour', 'phytoplankton', 'algal bloom', 'algae', 'water quality', 'turbidity'], add: ['ocean color', 'chlorophyll-a', 'modis aqua', 'viirs ocean color', 'olci', 'sentinel-3', 'obpg', 'pace'] },
  { when: ['sea level', 'sea level rise', 'ocean height', 'altimetry'], add: ['sea surface height', 'altimetry', 'swot', 'sea level', 'ssh', 'ocean'] },
  { when: ['waves', 'wave height', 'swell', 'tides', 'ocean currents'], add: ['marine', 'wave height', 'open-meteo marine', 'ocean', 'swell'] },
  { when: ['coral', 'coral reef', 'coral reefs', 'bleaching'], add: ['coral', 'reef', 'allen coral atlas', 'sea surface temperature', 'marine', 'ocean'] },
  // --- air quality / emissions
  { when: ['air quality', 'air pollution', 'pollution', 'smog', 'pm2.5', 'pm25', 'particulate matter', 'aqi'], add: ['cams', 'pm2.5', 'sentinel-5p', 'tropomi', 'open-meteo air quality', 'aerosol optical depth', 'openaq', 'no2'] },
  { when: ['no2', 'nitrogen dioxide', 'so2', 'sulfur dioxide', 'carbon monoxide', 'ozone', 'formaldehyde', 'trace gas', 'trace gases'], add: ['sentinel-5p', 'tropomi', 'omi', 'cams', 'air quality', 'atmospheric composition'] },
  { when: ['aerosol', 'aerosols', 'aod', 'dust', 'smoke', 'haze'], add: ['aerosol optical depth', 'maiac', 'mcd19a2', 'cams', 'modis', 'viirs aerosol', 'aod'] },
  { when: ['methane', 'ch4', 'co2', 'carbon dioxide', 'greenhouse gas', 'greenhouse gases', 'emissions'], add: ['tropomi methane', 'oco-2', 'oco-3', 'gosat', 'greenhouse gas', 'carbon', 'emissions', 'cams'] },
  // --- fire
  { when: ['fire', 'fires', 'wildfire', 'wildfires', 'active fire', 'hotspot', 'hotspots', 'burning'], add: ['firms', 'viirs active fire', 'modis fire', 'mod14', 'fire', 'active fire', 'thermal anomalies', 'wildfire'] },
  { when: ['burned area', 'burn scar', 'burn scars', 'burnt area', 'fire damage', 'burn severity', 'fire scar'], add: ['mcd64a1', 'burned area', 'firecci', 'mtbs', 'dnbr', 'sentinel-2', 'fire', 'burn'] },
  // --- nightlights
  { when: ['bright+night', 'brightness+night', 'light+night', 'lit+night', 'city lights', 'night lights', 'nightlights', 'night-time lights', 'nighttime lights', 'night time lights', 'light pollution', 'artificial light', 'electrification'], add: ['viirs dnb', 'black marble', 'vnp46', 'nighttime lights', 'night lights', 'dmsp-ols', 'vnl', 'radiance'] },
  // --- land cover / agri / vegetation
  { when: ['land cover', 'landcover', 'land use', 'land use land cover', 'lulc', 'land classification'], add: ['esa worldcover', 'dynamic world', 'land cover', 'io-lulc', 'esri land cover', 'corine', 'nlcd', 'copernicus global land cover', 'globeland30'] },
  { when: ['crop type', 'crop types', 'cropland', 'agriculture', 'farmland', 'farming', 'crop map', 'crop mapping', 'what crops'], add: ['cropland data layer', 'usda cdl', 'worldcereal', 'crop', 'cropland', 'agriculture', 'worldcover', 'copernicus land cover', 'glad cropland'] },
  { when: ['crop yield', 'yield', 'harvest', 'food security'], add: ['mapspam', 'gaez', 'yield', 'crop production', 'mirca', 'agriculture'] },
  { when: ['irrigation', 'irrigated', 'irrigated area'], add: ['irrigation', 'irrigated area', 'gfsad', 'lgrip30', 'agriculture', 'cropland', 'water'] },
  { when: ['ndvi', 'vegetation index', 'greenness', 'vegetation health', 'vegetation', 'plant health', 'evi', 'vegetation monitoring'], add: ['modis vegetation indices', 'mod13', 'ndvi', 'evi', 'sentinel-2', 'landsat', 'lai', 'fapar', 'vegetation indices'] },
  { when: ['leaf area index', 'lai', 'fapar', 'fcover', 'photosynthesis', 'gpp', 'gross primary productivity', 'primary production', 'npp', 'productivity'], add: ['mod15', 'mod17', 'gross primary productivity', 'lai', 'fapar', 'copernicus global land service', 'gpp', 'npp', 'vegetation'] },
  { when: ['phenology', 'greenup', 'green-up', 'growing season', 'seasonality'], add: ['phenology', 'mcd12q2', 'vegetation', 'ndvi', 'season'] },
  // --- imagery
  { when: ['satellite imagery', 'imagery', 'optical imagery', 'true color', 'multispectral'], add: ['sentinel-2', 'landsat', 'naip', 'surface reflectance', 'sentinel-2-l2a', 'optical'] },
  { when: ['high resolution imagery', 'aerial imagery', 'aerial photos', 'orthophoto', 'orthophotos', 'sub-meter', 'submeter'], add: ['naip', 'aerial imagery', 'orthophoto', 'vhr', 'high resolution', 'planet', 'maxar'] },
  { when: ['sentinel-2', 'sentinel 2', 'sentinel2', 's2'], add: ['sentinel-2-l2a', 'msi', 'surface reflectance', 'esa'] },
  { when: ['sentinel-1', 'sentinel 1', 'sentinel1', 's1'], add: ['sentinel-1', 'grd', 'rtc', 'slc', 'sar'] },
  { when: ['landsat'], add: ['landsat collection 2', 'landsat-c2-l2', 'surface reflectance', 'usgs'] },
  { when: ['modis'], add: ['modis', 'terra', 'aqua', 'mod09', 'mcd43'] },
  { when: ['harmonized landsat sentinel', 'hls'], add: ['hls', 'harmonized landsat sentinel-2', 'hlss30', 'hlsl30'] },
  { when: ['embedding', 'embeddings', 'foundation model', 'learned features'], add: ['alphaearth', 'satellite embedding', 'embeddings', 'clay', 'prithvi', 'foundation model'] },
  { when: ['boundaries', 'administrative boundaries', 'admin boundaries', 'country borders', 'provinces', 'districts', 'counties'], add: ['gadm', 'geoboundaries', 'overture divisions', 'admin', 'boundaries', 'natural earth', 'fao gaul'] },
  // --- hazards, biodiversity, geology
  { when: ['earthquake', 'earthquakes', 'seismic', 'tectonic', 'faults'], add: ['usgs earthquake', 'seismic', 'earthquake', 'fault', 'geology', 'insar'] },
  { when: ['volcano', 'volcanoes', 'volcanic', 'eruption'], add: ['volcano', 'volcanic', 'smithsonian', 'sentinel-1', 'sentinel-5p so2', 'thermal anomalies'] },
  { when: ['geology', 'lithology', 'rock type', 'bedrock', 'minerals'], add: ['geology', 'lithology', 'glim', 'emit', 'mineral', 'usgs geologic'] },
  { when: ['biodiversity', 'species', 'habitat', 'protected areas', 'ecosystems', 'ecoregions'], add: ['biodiversity', 'wdpa', 'protected planet', 'iucn', 'ecoregions', 'habitat', 'gbif', 'intactness'] },
  { when: ['disaster', 'disasters', 'natural hazards', 'hazard', 'hazards', 'emergency'], add: ['eonet', 'hazard', 'copernicus ems', 'gdacs', 'flood', 'fire', 'earthquake'] },
]
