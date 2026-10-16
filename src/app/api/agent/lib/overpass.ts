/** OSM tag resolution + Overpass client with multi-mirror failover + cache. */

import { cachedFetchJson } from './cache'
import type { GeomHint, OsmEntry } from './types'

/** Default cartographic colors per feature class (used when an OSM_TAG_MAP entry omits color). */
export const FALLBACK_COLOR: Record<GeomHint, string> = {
  Polygon: '#3b82f6',
  LineString: '#06b6d4',
  Point: '#f59e0b',
}

export const OSM_TAG_MAP: Record<string, OsmEntry> = {
  // ---- Point features --------------------------------------------------
  manhole:        { tags: ['"man_made"="manhole"'], geom: 'Point', color: '#f59e0b', label: 'Manholes' },
  fire_hydrant:   { tags: ['"emergency"="fire_hydrant"'], geom: 'Point', color: '#ef4444', label: 'Fire Hydrants' },
  tower:          { tags: ['"man_made"="tower"', '"power"="tower"'], geom: 'Point', color: '#a855f7', label: 'Towers' },
  power_pole:     { tags: ['"power"="pole"'], geom: 'Point', color: '#a855f7', label: 'Power Poles' },
  bus_stop:       { tags: ['"highway"="bus_stop"', '"public_transport"="platform"'], geom: 'Point', color: '#f59e0b', label: 'Bus Stops' },
  well:           { tags: ['"man_made"="water_well"'], geom: 'Point', color: '#0ea5e9', label: 'Wells' },
  atm:            { tags: ['"amenity"="atm"'], geom: 'Point', color: '#f59e0b', label: 'ATMs' },

  // ---- Linear features -------------------------------------------------
  water_channel:  { tags: ['"waterway"="ditch"', '"waterway"="channel"', '"waterway"="drain"'], geom: 'LineString', color: '#0ea5e9', label: 'Water Channels' },
  river:          { tags: ['"waterway"="river"', '"waterway"="riverbank"'], geom: 'LineString', color: '#0284c7', label: 'Rivers' },
  stream:         { tags: ['"waterway"="stream"'], geom: 'LineString', color: '#38bdf8', label: 'Streams' },
  canal:          { tags: ['"waterway"="canal"'], geom: 'LineString', color: '#0ea5e9', label: 'Canals' },
  waterway:       { tags: ['"waterway"'], geom: 'LineString', color: '#0ea5e9', label: 'Waterways' },
  road:           { tags: ['"highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|service)$"'], geom: 'LineString', color: '#6b7280', label: 'Roads' },
  highway:        { tags: ['"highway"~"^(motorway|trunk|primary)$"'], geom: 'LineString', color: '#52525b', label: 'Highways' },
  path:           { tags: ['"highway"~"^(path|track|footway|cycleway)$"'], geom: 'LineString', color: '#d97706', label: 'Paths' },
  track:          { tags: ['"highway"="track"'], geom: 'LineString', color: '#d97706', label: 'Tracks' },
  pipeline:       { tags: ['"man_made"="pipeline"'], geom: 'LineString', color: '#a16207', label: 'Pipelines' },
  railway:        { tags: ['"railway"~"^(rail|light_rail|subway|tram|narrow_gauge)$"'], geom: 'LineString', color: '#525252', label: 'Railways' },
  power_line:     { tags: ['"power"="line"', '"power"="minor_line"'], geom: 'LineString', color: '#a855f7', label: 'Power Lines' },

  // ---- Water bodies (Polygon) -----------------------------------------
  lake:           { tags: ['"natural"="water"', '"water"~"^(lake|pond|reservoir|lagoon|oxbow|basin)$"'], geom: 'Polygon', color: '#0284c7', label: 'Lakes' },
  water:          { tags: ['"natural"="water"'], geom: 'Polygon', color: '#0284c7', label: 'Water Bodies' },
  water_body:     { tags: ['"natural"="water"'], geom: 'Polygon', color: '#0284c7', label: 'Water Bodies' },
  pond:           { tags: ['"natural"="water"', '"water"="pond"'], geom: 'Polygon', color: '#0ea5e9', label: 'Ponds' },
  lagoon:         { tags: ['"natural"="water"', '"water"="lagoon"'], geom: 'Polygon', color: '#0ea5e9', label: 'Lagoons' },
  reservoir:      { tags: ['"landuse"="reservoir"', '"water"="reservoir"', '"natural"="water"'], geom: 'Polygon', color: '#0284c7', label: 'Reservoirs' },
  bay:            { tags: ['"natural"="bay"'], geom: 'Polygon', color: '#0284c7', label: 'Bays' },
  wetland:        { tags: ['"natural"="wetland"'], geom: 'Polygon', color: '#14b8a6', label: 'Wetlands' },
  marsh:          { tags: ['"natural"="wetland"', '"wetland"~"^(marsh|swamp|bog)$"'], geom: 'Polygon', color: '#14b8a6', label: 'Marshes' },
  swamp:          { tags: ['"natural"="wetland"', '"wetland"="swamp"'], geom: 'Polygon', color: '#0d9488', label: 'Swamps' },
  swimming_pool:  { tags: ['"leisure"="swimming_pool"'], geom: 'Polygon', color: '#06b6d4', label: 'Swimming Pools' },

  // ---- Vegetation (Polygon) -------------------------------------------
  forest:         { tags: ['"landuse"="forest"', '"natural"="wood"'], geom: 'Polygon', color: '#15803d', label: 'Forests' },
  wood:           { tags: ['"natural"="wood"'], geom: 'Polygon', color: '#166534', label: 'Woodland' },
  tree:           { tags: ['"natural"="tree"', '"natural"="wood"'], geom: 'Polygon', color: '#16a34a', label: 'Trees / Tree Cover' },
  scrub:          { tags: ['"natural"="scrub"'], geom: 'Polygon', color: '#84cc16', label: 'Scrub' },
  grassland:      { tags: ['"natural"="grassland"', '"landuse"="meadow"'], geom: 'Polygon', color: '#84cc16', label: 'Grassland' },
  meadow:         { tags: ['"landuse"="meadow"'], geom: 'Polygon', color: '#a3e635', label: 'Meadows' },
  grass:          { tags: ['"landuse"="grass"', '"natural"="grassland"'], geom: 'Polygon', color: '#a3e635', label: 'Grass' },

  // ---- Agriculture (Polygon) ------------------------------------------
  farm:           { tags: ['"landuse"="farmland"', '"landuse"="farmyard"'], geom: 'Polygon', color: '#ca8a04', label: 'Farms' },
  farmland:       { tags: ['"landuse"="farmland"'], geom: 'Polygon', color: '#ca8a04', label: 'Farmland' },
  orchard:        { tags: ['"landuse"="orchard"'], geom: 'Polygon', color: '#84cc16', label: 'Orchards' },
  vineyard:       { tags: ['"landuse"="vineyard"'], geom: 'Polygon', color: '#a16207', label: 'Vineyards' },
  crop:           { tags: ['"landuse"~"^(farmland|orchard|vineyard|meadow)$"'], geom: 'Polygon', color: '#ca8a04', label: 'Cropland' },
  vegetation:     { tags: ['"landuse"~"^(forest|orchard|meadow|grass|vineyard)$"', '"natural"~"^(wood|scrub|grassland)$"'], geom: 'Polygon', color: '#22c55e', label: 'Vegetation' },

  // ---- Recreation (Polygon) -------------------------------------------
  park:           { tags: ['"leisure"="park"', '"leisure"="garden"'], geom: 'Polygon', color: '#22c55e', label: 'Parks' },
  garden:         { tags: ['"leisure"="garden"'], geom: 'Polygon', color: '#16a34a', label: 'Gardens' },
  playground:     { tags: ['"leisure"="playground"'], geom: 'Polygon', color: '#84cc16', label: 'Playgrounds' },
  pitch:          { tags: ['"leisure"="pitch"'], geom: 'Polygon', color: '#65a30d', label: 'Sports Pitches' },
  golf_course:    { tags: ['"leisure"="golf_course"'], geom: 'Polygon', color: '#65a30d', label: 'Golf Courses' },

  // ---- Built environment (Polygon) ------------------------------------
  building:       { tags: ['"building"'], geom: 'Polygon', color: '#9ca3af', label: 'Buildings' },
  house:          { tags: ['"building"~"^(house|residential|detached|apartments|terrace|bungalow)$"'], geom: 'Polygon', color: '#71717a', label: 'Houses' },
  residential:    { tags: ['"landuse"="residential"'], geom: 'Polygon', color: '#a8a29e', label: 'Residential Areas' },
  commercial:     { tags: ['"landuse"="commercial"'], geom: 'Polygon', color: '#fbbf24', label: 'Commercial Areas' },
  industrial:     { tags: ['"landuse"="industrial"'], geom: 'Polygon', color: '#a16207', label: 'Industrial Areas' },
  retail:         { tags: ['"landuse"="retail"'], geom: 'Polygon', color: '#f59e0b', label: 'Retail Areas' },
  construction:   { tags: ['"landuse"="construction"'], geom: 'Polygon', color: '#fbbf24', label: 'Construction Sites' },
  parking:        { tags: ['"amenity"="parking"'], geom: 'Polygon', color: '#737373', label: 'Parking Lots' },
  quarry:         { tags: ['"landuse"="quarry"'], geom: 'Polygon', color: '#a16207', label: 'Quarries' },
  landfill:       { tags: ['"landuse"="landfill"'], geom: 'Polygon', color: '#a16207', label: 'Landfills' },
  cemetery:       { tags: ['"landuse"="cemetery"', '"amenity"="grave_yard"'], geom: 'Polygon', color: '#52525b', label: 'Cemeteries' },

  // ---- Specific buildings (Polygon) -----------------------------------
  hospital:       { tags: ['"amenity"="hospital"', '"building"="hospital"'], geom: 'Polygon', color: '#ef4444', label: 'Hospitals' },
  school:         { tags: ['"amenity"="school"', '"building"="school"'], geom: 'Polygon', color: '#f59e0b', label: 'Schools' },
  university:     { tags: ['"amenity"="university"', '"amenity"="college"'], geom: 'Polygon', color: '#f59e0b', label: 'Universities' },
  mosque:         { tags: ['"amenity"="place_of_worship"', '"religion"="muslim"'], geom: 'Polygon', color: '#10b981', label: 'Mosques' },
  church:         { tags: ['"amenity"="place_of_worship"', '"religion"="christian"'], geom: 'Polygon', color: '#a855f7', label: 'Churches' },
  temple:         { tags: ['"amenity"="place_of_worship"', '"religion"~"^(hindu|buddhist|sikh|jain)$"'], geom: 'Polygon', color: '#f97316', label: 'Temples' },
  shop:           { tags: ['"shop"', '"building"="retail"'], geom: 'Polygon', color: '#f59e0b', label: 'Shops' },
  market:         { tags: ['"amenity"="marketplace"'], geom: 'Polygon', color: '#f59e0b', label: 'Markets' },

  // ---- Energy & infrastructure (Polygon) ------------------------------
  solar_panel:    { tags: ['"power"="generator"', '"generator:source"="solar"', '"power"="plant"'], geom: 'Polygon', color: '#fbbf24', label: 'Solar Installations' },
  wind_turbine:   { tags: ['"power"="generator"', '"generator:source"="wind"'], geom: 'Polygon', color: '#a855f7', label: 'Wind Turbines' },
  dam:            { tags: ['"waterway"="dam"', '"man_made"="dyke"'], geom: 'Polygon', color: '#71717a', label: 'Dams' },
  bridge:         { tags: ['"bridge"="yes"', '"man_made"="bridge"'], geom: 'Polygon', color: '#a8a29e', label: 'Bridges' },
  airport:        { tags: ['"aeroway"="aerodrome"', '"aeroway"="terminal"'], geom: 'Polygon', color: '#fbbf24', label: 'Airports' },
  runway:         { tags: ['"aeroway"="runway"'], geom: 'Polygon', color: '#52525b', label: 'Runways' },

  // ---- Bare ground (Polygon) ------------------------------------------
  beach:          { tags: ['"natural"="beach"'], geom: 'Polygon', color: '#fcd34d', label: 'Beaches' },
  sand:           { tags: ['"natural"="sand"', '"surface"="sand"'], geom: 'Polygon', color: '#fcd34d', label: 'Sand' },
  cliff:          { tags: ['"natural"="cliff"', '"natural"="rock"'], geom: 'Polygon', color: '#78716c', label: 'Cliffs' },
  bare_rock:      { tags: ['"natural"="bare_rock"', '"natural"="rock"'], geom: 'Polygon', color: '#78716c', label: 'Bare Rock' },
  glacier:        { tags: ['"natural"="glacier"'], geom: 'Polygon', color: '#e0f2fe', label: 'Glaciers' },

  // ---- Catch-all (Polygon) --------------------------------------------
  landuse:        { tags: ['"landuse"'], geom: 'Polygon', color: '#94a3b8', label: 'Land Use' },
}

/** User-facing synonyms → canonical OSM_TAG_MAP key. */
export const OSM_SYNONYMS: Record<string, string> = {
  // water
  lakes: 'lake', ponds: 'pond', lagoons: 'lagoon', reservoirs: 'reservoir',
  waterbody: 'water_body', waterbodies: 'water_body', 'water bodies': 'water_body',
  pool: 'swimming_pool', pools: 'swimming_pool', swimming_pools: 'swimming_pool',
  marshes: 'marsh', swamps: 'swamp', wetlands: 'wetland', bays: 'bay',
  rivers: 'river', streams: 'stream', canals: 'canal',
  ditches: 'water_channel', drains: 'water_channel', water_channels: 'water_channel',
  // built
  houses: 'house', homes: 'house', residences: 'house', residential_area: 'residential',
  buildings: 'building', structures: 'building',
  mosques: 'mosque', masjid: 'mosque', masjids: 'mosque',
  churches: 'church', temples: 'temple',
  hospitals: 'hospital', clinics: 'hospital', clinic: 'hospital',
  schools: 'school', universities: 'university', colleges: 'university', college: 'university',
  shops: 'shop', stores: 'shop', store: 'shop', supermarket: 'shop',
  markets: 'market', bazaar: 'market', bazaars: 'market',
  parking_lots: 'parking', parkinglot: 'parking', carpark: 'parking',
  factories: 'industrial', factory: 'industrial', warehouse: 'industrial', industry: 'industrial',
  // vegetation
  forests: 'forest', woods: 'wood', woodland: 'wood', woodlands: 'wood',
  trees: 'tree', vegetation_cover: 'vegetation', greenery: 'vegetation', green: 'vegetation',
  meadows: 'meadow', grasses: 'grass', grassy: 'grass',
  parks: 'park', gardens: 'garden', playgrounds: 'playground', pitches: 'pitch',
  // agriculture
  farms: 'farm', farmlands: 'farmland', farmyards: 'farmyard',
  orchards: 'orchard', vineyards: 'vineyard', crops: 'crop', cropland: 'crop',
  // infrastructure
  roads: 'road', highways: 'highway', motorway: 'highway', motorways: 'highway',
  paths: 'path', tracks: 'track', railways: 'railway', railroad: 'railway', railroads: 'railway',
  pipelines: 'pipeline', powerlines: 'power_line', power_lines: 'power_line',
  bridges: 'bridge', dams: 'dam', airports: 'airport', runways: 'runway',
  towers: 'tower', poles: 'power_pole', power_poles: 'power_pole',
  manholes: 'manhole', wells: 'well', hydrants: 'fire_hydrant', fire_hydrants: 'fire_hydrant',
  // bare ground
  beaches: 'beach', sands: 'sand', cliffs: 'cliff', glaciers: 'glacier',
  // misc
  cemeteries: 'cemetery', graveyard: 'cemetery', graveyards: 'cemetery',
  quarries: 'quarry', landfills: 'landfill',
  solar: 'solar_panel', solar_panels: 'solar_panel', solar_farm: 'solar_panel',
  wind_turbines: 'wind_turbine', wind_farm: 'wind_turbine', windmills: 'wind_turbine',
}

/** Strip a trailing plural 's' or 'es' if it would yield a known key. */
export function normalizePlural(token: string): string {
  if (token.endsWith('ies') && token.length > 3) return token.slice(0, -3) + 'y'
  if (token.endsWith('es') && token.length > 2) {
    const stem = token.slice(0, -2)
    if (OSM_TAG_MAP[stem] || OSM_SYNONYMS[stem]) return stem
  }
  if (token.endsWith('s') && token.length > 1) {
    const stem = token.slice(0, -1)
    if (OSM_TAG_MAP[stem] || OSM_SYNONYMS[stem]) return stem
  }
  return token
}

/** Make free text safe inside an Overpass QL `"name"~"…"` regex literal:
 *  escape regex metacharacters, backslashes and quotes, strip control chars,
 *  and cap the length so user/LLM text can't break out of the filter. */
export function escapeOverpassRegex(text: string): string {
  return String(text)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 80)
    .replace(/[\\^$.*+?()[\]{}|"\/]/g, '\\$&')
}

export function resolveOsmTags(query: string): OsmEntry {
  let lower = query.toLowerCase().trim().replace(/[?!.,]+$/, '')
  if (OSM_TAG_MAP[lower] || OSM_SYNONYMS[lower]) {
    // direct hit
  } else {
    const tokens = lower.split(/\s+/).map(normalizePlural)
    for (const tok of tokens.sort((a, b) => b.length - a.length)) {
      if (OSM_TAG_MAP[tok]) { lower = tok; break }
      if (OSM_SYNONYMS[tok]) { lower = OSM_SYNONYMS[tok]; break }
    }
  }

  if (OSM_SYNONYMS[lower]) lower = OSM_SYNONYMS[lower]
  lower = normalizePlural(lower)
  if (OSM_SYNONYMS[lower]) lower = OSM_SYNONYMS[lower]

  if (OSM_TAG_MAP[lower]) return OSM_TAG_MAP[lower]
  for (const [key, val] of Object.entries(OSM_TAG_MAP)) {
    if (lower.includes(key) || key.includes(lower)) return val
  }
  for (const [key, val] of Object.entries(OSM_TAG_MAP)) {
    if (key.split('_').some((w) => lower.includes(w))) return val
  }

  const nameRegex = escapeOverpassRegex(query)
  const linearKw = ['road', 'path', 'track', 'river', 'stream', 'canal', 'line', 'route', 'way', 'pipeline', 'ditch', 'fence', 'wall', 'rail']
  const pointKw = ['hydrant', 'manhole', 'well', 'pole', 'sign', 'lamp', 'bench', 'bin']
  if (linearKw.some((w) => lower.includes(w))) return { tags: [`"name"~"${nameRegex}",i`], geom: 'LineString', color: '#06b6d4' }
  if (pointKw.some((w) => lower.includes(w))) return { tags: [`"name"~"${nameRegex}",i`], geom: 'Point', color: '#f59e0b' }
  return { tags: [`"name"~"${nameRegex}",i`], geom: 'Polygon', color: '#3b82f6' }
}

/** Split a bbox `[w, s, e, n]` into its four equal quadrants, ordered
 *  NW, NE, SW, SE. Used by the `query_osm` progressive quadtree (P5.2) to
 *  subdivide an AOI that saturates the Overpass feature cap. */
export function splitBbox(
  bbox: [number, number, number, number],
): [number, number, number, number][] {
  const [w, s, e, n] = bbox
  const mLng = (w + e) / 2
  const mLat = (s + n) / 2
  return [
    [w, mLat, mLng, n], // NW
    [mLng, mLat, e, n], // NE
    [w, s, mLng, mLat], // SW
    [mLng, s, e, mLat], // SE
  ]
}

/** Merge groups of Overpass elements, deduping by `(type, id)`. Overpass
 *  returns the same way/relation in adjacent quadrants when a feature straddles
 *  a quadtree boundary, so the dedupe is required (P5.2). First occurrence wins. */
export function mergeOsmResults(groups: any[][]): any[] {
  const seen = new Set<string>()
  const out: any[] = []
  for (const group of groups) {
    for (const el of group) {
      const key = `${el?.type}/${el?.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(el)
    }
  }
  return out
}

/** Call Overpass with a User-Agent + mirror fallback for resilience.
 *  Cached for 5 minutes by query string. */
export async function callOverpass(ql: string, timeoutMs: number = 30000): Promise<any> {
  return cachedFetchJson(`overpass:${ql}`, { source: 'overpass' }, () => callOverpassRaw(ql, timeoutMs))
}

async function callOverpassRaw(ql: string, timeoutMs: number): Promise<any> {
  // Audit 2026-06-10: OVERPASS_ENDPOINT (documented in .env.example and wired in
  // docker-compose for self-hosting) was probed by /api/health but ignored here —
  // a self-hosted Overpass never received tool traffic. It now leads the mirror
  // list; the public mirrors remain as fallbacks.
  const endpoints = [
    ...(process.env.OVERPASS_ENDPOINT ? [process.env.OVERPASS_ENDPOINT] : []),
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter',
  ]
  let lastError = ''
  for (const endpoint of endpoints) {
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'GeoAgent/1.0 (geospatial AI analysis)',
          Accept: 'application/json',
        },
        body: `data=${encodeURIComponent(ql)}`,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (resp.ok) {
        return await resp.json()
      }
      lastError = `${endpoint} → HTTP ${resp.status}`
      if (resp.status !== 429 && resp.status !== 504 && resp.status !== 502 && resp.status !== 503 && resp.status !== 406) {
        throw new Error(lastError)
      }
    } catch (err: any) {
      lastError = `${endpoint} → ${err.message ?? 'fetch failed'}`
    }
  }
  throw new Error(`All Overpass mirrors failed. Last error: ${lastError}`)
}

/** Darken a hex color by a factor (0–1). Used for stroke vs fill contrast. */
export function darken(hex: string, factor: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const k = Math.max(0, 1 - factor)
  const toHex = (n: number) => Math.round(n * k).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/** Map a user-facing feature name to a real run_cv_detector model name. */
export function mapFeatureToCvModel(query: string): string {
  const q = query.toLowerCase().trim()
  if (/\b(lake|pond|water|reservoir|lagoon|bay|swimming|pool|wetland|marsh|swamp)\b/.test(q)) return 'water_channel'
  if (/\b(road|street|path|track|highway|lane)\b/.test(q)) return 'road_damage'
  if (/\b(solar|panel|pv)\b/.test(q)) return 'solar_panel'
  if (/\b(manhole|cover|drain_cover)\b/.test(q)) return 'manhole'
  if (/\b(roof|tile|shingle|material)\b/.test(q)) return 'roof_material'
  if (/\b(channel|ditch|drain|canal)\b/.test(q)) return 'water_channel'
  return 'informal_struct'
}
