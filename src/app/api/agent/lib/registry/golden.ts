/** "Golden" datasets: the well-documented, widely used, key-free-where-possible
 *  products an analyst would reach for first. Search gives them a rank boost
 *  (x1.3, and x1.2 more when the query's theme is one listed here), so a generic
 *  question ("land cover", "dem") surfaces them ahead of the 400th regional variant.
 *
 *  Ids may be a primary id or any alternate id of a merged entry. A unit test
 *  fails when an id no longer resolves against the snapshot, so the list cannot
 *  silently rot after a re-harvest.
 */

import type { Theme } from './types'

export const GOLDEN: Record<string, Theme[]> = {
  // optical
  'planetary-computer:sentinel-2-l2a': ['optical', 'vegetation', 'agriculture', 'land-cover', 'water', 'urban', 'forest', 'fire'],
  'planetary-computer:landsat-c2-l2': ['optical', 'temperature', 'vegetation', 'land-cover', 'water'],
  'planetary-computer:hls2-s30': ['optical', 'vegetation', 'agriculture'],
  'planetary-computer:naip': ['optical', 'agriculture', 'urban'],
  // sar
  'planetary-computer:sentinel-1-rtc': ['sar', 'water', 'hazards', 'forest'],
  'planetary-computer:sentinel-1-grd': ['sar', 'water', 'hazards'],
  'planetary-computer:alos-palsar-mosaic': ['sar', 'forest'],
  'gee:OPERA/RTC/L2_V1/S1': ['sar'],
  'cmr:ASF/OPERA_L2_RTC-S1_V1_1': ['sar'],
  // elevation
  'planetary-computer:cop-dem-glo-30': ['elevation'],
  'planetary-computer:cop-dem-glo-90': ['elevation'],
  'planetary-computer:nasadem': ['elevation'],
  'gee:USGS/SRTMGL1_003': ['elevation'],
  'planetary-computer:alos-dem': ['elevation'],
  'gee:MERIT/DEM/v1_0_3': ['elevation', 'hydrology'],
  'cmr:LPCLOUD/ASTGTM_003': ['elevation'],
  'planetary-computer:3dep-seamless': ['elevation'],
  'gebco:bathymetry-grid': ['elevation', 'ocean'],
  // lidar
  'usgs-3dep:lidar-ept': ['lidar', 'elevation'],
  'planetary-computer:3dep-lidar-copc': ['lidar'],
  'planetary-computer:3dep-lidar-hag': ['lidar', 'forest'],
  'cmr:LPCLOUD/GEDI02_A_003': ['lidar', 'forest', 'elevation'],
  'cmr:LPCLOUD/GEDI02_B_003': ['lidar', 'forest', 'vegetation'],
  'cmr:NSIDC_CPRD/ATL08_007': ['lidar', 'forest', 'elevation'],
  'meta-wri:canopy-height': ['lidar', 'forest', 'vegetation'],
  // land cover / agriculture
  'planetary-computer:esa-worldcover': ['land-cover', 'urban', 'forest', 'agriculture'],
  'gee:GOOGLE/DYNAMICWORLD/V1': ['land-cover', 'urban', 'water'],
  'planetary-computer:io-lulc-annual-v02': ['land-cover'],
  'planetary-computer:usda-cdl': ['agriculture', 'land-cover'],
  'gee:ESA/WorldCereal/2021/MARKERS/v100': ['agriculture'],
  // forest
  'hansen:global-forest-change': ['forest'],
  'gfw:umd_tree_cover_loss': ['forest'],
  'gfw:gfw_integrated_alerts': ['forest'],
  'gee:ESA/CCI/Above_Ground_Biomass/V6_0': ['forest', 'vegetation'],
  // water / hydrology / hazards
  'planetary-computer:jrc-gsw': ['water', 'hydrology', 'hazards'],
  'eodc:GFM': ['water', 'hazards', 'sar'],
  'open-meteo:flood': ['hydrology', 'hazards', 'water'],
  'gee:WWF/HydroSHEDS/03VFDEM': ['hydrology', 'elevation'],
  'planetary-computer:deltares-floods': ['hazards', 'water'],
  // climate / weather / precipitation / temperature
  'planetary-computer:era5-pds': ['climate', 'weather', 'temperature', 'precipitation'],
  'arco-era5:pressure-levels': ['climate', 'weather', 'temperature'],
  'open-meteo:era5-archive': ['climate', 'weather', 'temperature', 'precipitation'],
  'open-meteo:forecast': ['weather', 'temperature', 'precipitation'],
  'open-meteo:climate': ['climate', 'temperature', 'precipitation'],
  'gee:ECMWF/ERA5_LAND/HOURLY': ['climate', 'temperature', 'soil', 'hydrology'],
  'planetary-computer:terraclimate': ['climate', 'temperature', 'precipitation', 'hydrology'],
  'gee:WORLDCLIM/V1/BIO': ['climate', 'temperature', 'precipitation'],
  'planetary-computer:nasa-nex-gddp-cmip6': ['climate', 'temperature', 'precipitation'],
  'chc:chirps-v2': ['precipitation', 'climate', 'hazards'],
  'gee:UCSB-CHG/CHIRPS/DAILY': ['precipitation'],
  'cmr:GES_DISC/GPM_3IMERGDF_07': ['precipitation'],
  'cmr:LPCLOUD/MOD11A1_061': ['temperature'],
  'nasa-power:daily-point': ['climate', 'weather', 'agriculture'],
  // soil
  'isric:soilgrids': ['soil', 'agriculture'],
  'isric:soilgrids-bulk': ['soil'],
  'planetary-computer:gnatsgo-rasters': ['soil', 'agriculture'],
  'cmr:NSIDC_CPRD/SPL3SMP_E_006': ['soil', 'hydrology'],
  'gee:NASA/SMAP/SPL3SMP_E/006': ['soil', 'hydrology'],
  // population / urban / buildings
  'worldpop:population': ['population'],
  'gee:JRC/GHSL/P2023A/GHS_POP': ['population', 'urban'],
  'kontur:population': ['population', 'urban'],
  'gee:JRC/GHSL/P2023A/GHS_BUILT_S': ['urban', 'buildings'],
  'gee:JRC/GHSL/P2023A/GHS_SMOD_V2-0': ['urban', 'population'],
  'overture:buildings': ['buildings', 'urban'],
  'planetary-computer:ms-buildings': ['buildings'],
  'google-open-buildings:v3': ['buildings'],
  'overture:transportation': ['infrastructure'],
  'overture:places': ['infrastructure'],
  'overture:divisions': ['boundaries'],
  'overture:base': ['land-cover', 'infrastructure', 'water'],
  'osm:overpass': ['infrastructure', 'buildings'],
  // nightlights
  'gee:NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG': ['nightlights'],
  'cmr:LAADS/VNP46A2_2': ['nightlights'],
  'nasa-gibs:viirs-black-marble': ['nightlights'],
  // MODIS and friends
  'planetary-computer:modis-13A1-061': ['vegetation'],
  'planetary-computer:modis-10A1-061': ['snow-ice'],
  'planetary-computer:modis-64A1-061': ['fire'],
  'planetary-computer:modis-14A1-061': ['fire'],
  'planetary-computer:mtbs': ['fire'],
  'planetary-computer:modis-09A1-061': ['optical'],
  // fire / air quality
  'nasa-firms:active-fires': ['fire', 'hazards'],
  'open-meteo:air-quality': ['air-quality'],
  'gee:COPERNICUS/S5P/OFFL/L3_NO2': ['air-quality'],
  'gee:ECMWF/CAMS/NRT': ['air-quality'],
  'planetary-computer:sentinel-5p-l2-netcdf': ['air-quality'],
  // ocean / snow / ice
  'planetary-computer:noaa-cdr-sea-surface-temperature-whoi': ['ocean', 'temperature'],
  'open-meteo:marine': ['ocean', 'weather'],
  'cmr:OB_CLOUD/MODISA_L2_OC_2022.0': ['ocean'],
  // biodiversity / boundaries / embeddings / geology / hazards
  'gee:WCMC/WDPA/current/polygons': ['biodiversity', 'boundaries'],
  'planetary-computer:io-biodiversity': ['biodiversity'],
  'gee:FAO/GAUL/2025/level1': ['boundaries'],
  'gee:WM/geoLab/geoBoundaries/600/ADM1': ['boundaries'],
  'gee:GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL': ['embeddings'],
  'usgs-earthquakes:fdsn-catalog': ['geology', 'hazards'],
  'nasa-eonet:events': ['hazards', 'fire'],
}
