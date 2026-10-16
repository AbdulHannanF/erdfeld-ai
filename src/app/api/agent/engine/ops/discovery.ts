/** Dataset discovery and reading. */

import { z } from 'zod'

import { findDataset, useDataset as readDataset } from '../../tools/discovery'
import { fail } from '../validate'
import { HOUR, defineOperation, type AnyOperation } from '../operation'

export const discoveryOps: AnyOperation[] = [
  defineOperation({
    name: 'find_dataset',
    label: 'Searching the dataset registry...',
    version: '1.0.0',
    description: 'Search the offline dataset registry: about 16,000 public geospatial datasets from Microsoft Planetary Computer, Google Earth Engine, NASA CMR (cloud-hosted collections), Copernicus Data Space, Element 84, EODC, Global Forest Watch, OpenTopography lidar surveys, plus curated APIs (Overture Maps, OpenStreetMap, Open-Meteo, SoilGrids, WorldPop, FIRMS, GIBS, USGS 3DEP lidar, ARCO-ERA5, building footprints). Instant and key-free. Ranks by relevance to your plain-words request and keeps only datasets whose declared extent covers the AOI (global ones always pass). Returns the top 5-8 with id, themes, resolution, temporal range, coverage verdict, licence, access kind and whether credentials are needed. Falls back to a live STAC catalog search only when the registry has no good hit, and returns nothing rather than a weak guess. Use when the user asks for data no existing tool measures (biomass, soil moisture, burned area, lidar, SAR, DEMs, population, night lights, air quality, climate reanalysis...). Follow up with use_dataset({dataset_id}) to read a hit; its line says what the read will do or what is missing.',
    params: z.object({
      query: z.string().describe('What kind of data, in plain words: "soil moisture", "deforestation alerts", "30 m DEM", "SAR backscatter", "population density".'),
      themes: z.array(z.string()).optional().describe('Optional hard filter, any of: elevation, lidar, sar, optical, land-cover, vegetation, forest, agriculture, soil, climate, weather, precipitation, temperature, water, hydrology, snow-ice, ocean, air-quality, fire, population, urban, buildings, infrastructure, nightlights, geology, biodiversity, hazards, boundaries, embeddings.'),
      max_resolution_m: z.number().optional().describe('Optional: only datasets at least this fine (metres). Datasets with unstated resolution still pass.'),
      start: z.string().optional().describe('Optional start of the period of interest (YYYY or YYYY-MM-DD).'),
      end: z.string().optional().describe('Optional end of the period of interest (YYYY or YYYY-MM-DD).'),
      license: z.string().optional().describe('Optional comma-separated licence ids, or "open" for any open licence (CC-BY, CC0, ODbL, public domain...).'),
      live: z.boolean().optional().describe('Skip the registry and search live STAC catalogs instead (slow; for brand-new collections).'),
      breadth: z.boolean().optional().describe('Live fallback only: also query the STAC Index registry beyond the three main catalogs (default true).'),
    }),
    output: 'table',
    cost: { typicalSeconds: 1 },
    cacheTtl: { liveMs: HOUR },
    limitations: [
      'Searches an offline snapshot of about 16,000 public datasets; its coverage verdict uses each dataset\'s declared extent, which is not proof of data over the AOI.',
      'A hit marked not readable cannot be computed on in this app; it is a pointer, not data.',
    ],
    confidence: 'relevance ranking only; it says nothing about data quality.',
    run: (ctx, args) => findDataset(ctx, args),
  }),
  defineOperation({
    name: 'use_dataset',
    label: 'Reading discovered dataset over the AOI...',
    version: '1.0.0',
    description: 'Read a dataset found by find_dataset over the drawn AOI: real statistics plus a map layer, through one path for every access kind. Pass the exact `dataset_id` that find_dataset printed. Cloud-optimised rasters (any STAC API) are searched over the AOI/time, the item closest to `date` is chosen (clearest scene for optical), signed if the host needs it, and statistics are computed with the AOI polygon as a cutline (never a bbox); Sentinel-1 / PALSAR SAR is converted to dB, DEMs report metres (add hillshade), categorical data reports class names the collection declares, USGS 3DEP lidar gives surface/terrain/height rasters (point clouds return metadata only). Also reads Earth Engine assets (when credentials exist), Overture Maps buildings/places/roads as a vector layer, and routes curated REST sources (Open-Meteo, SoilGrids, WorldPop, FIRMS, night lights) to their dedicated tools. When a dataset cannot be read it says exactly why (missing NASA Earthdata/Copernicus/OpenTopography/Earth Engine credential, needs the Python Zarr service or openEO account, outside coverage, no items over the AOI): relay that, never substitute numbers. The older `catalog` + `collection` form still works for STAC collections.',
    params: z.object({
      dataset_id: z.string().optional().describe('Registry id exactly as returned by find_dataset, e.g. "planetary-computer:sentinel-1-rtc", "overture:buildings".'),
      variable: z.string().optional().describe('Optional band / asset / variable: "vv", "vh", "NDVI", "occurrence", "building height". Omit for the primary data asset (the answer names the others).'),
      date: z.string().optional().describe('Optional target date (YYYY-MM-DD): the acquisition closest to it is used.'),
      start: z.string().optional().describe('Optional start of a period (YYYY or YYYY-MM-DD).'),
      end: z.string().optional().describe('Optional end of a period (YYYY or YYYY-MM-DD).'),
      render: z.boolean().optional().describe('Add a map layer (default true).'),
      hillshade: z.boolean().optional().describe('DEMs: also add a hillshade layer.'),
      collection: z.string().optional().describe('Legacy: STAC collection id (use with catalog) when no dataset_id is available.'),
      catalog: z.string().optional().describe('Legacy: catalog id ("planetary-computer", "element84", "landsatlook") or a STAC API root URL. Defaults to planetary-computer.'),
      datetime: z.string().optional().describe('Legacy: RFC-3339 instant or interval to restrict the item search.'),
      categorical: z.boolean().optional().describe('Legacy: force categorical (class-count) statistics.'),
    }),
    output: 'mixed',
    cost: { typicalSeconds: 10 },
    // Not cached: may read a user upload, which must never be served to another user.
    limitations: [
      'A discovered dataset is not vetted like a wired tool: units and conventions are the publisher\'s.',
      'Missing credentials, a Zarr store or an openEO back end make a dataset unreadable; the tool says exactly why and never substitutes numbers.',
      '"No items over this AOI" means the dataset has no data here, not that the value is zero.',
    ],
    confidence: 'as stated by the data source and the access route used; the output carries its licence and caveats.',
    staticChecks: (_ctx, args) =>
      args.dataset_id || args.collection
        ? []
        : [fail('static', 'dataset_ref', 'use_dataset needs a `dataset_id` from find_dataset (or, legacy, a STAC `collection`).')],
    run: (ctx, args) => readDataset(ctx, args),
  }),
]
