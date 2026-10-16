/**
 * Imperative MapLibre layer code: no JSX, no React. MapPanel owns the map instance and the
 * lifecycle; everything that adds, updates, styles or removes a source or layer on it lives here,
 * so the component is about wiring and this file is about what gets drawn.
 */

import type * as maplibregl from '@/lib/maplibre'
import type { AOI, MapLayer } from '@/store/useStore'
import { aoiSignature } from '@/lib/aoi'
import { colormapStops, worldMinusAoi } from '@/lib/raster-style'
import { NO_DATA_COLOR, vectorStylePaint } from '@/lib/vector-style'
import { AOI_COLOR, CATEGORICAL_PALETTE } from '@/lib/categorical-palette'
import { MAP_ATMOSPHERE, MAP_FALLBACK_BACKGROUND, MAP_HALO, MAP_HILLSHADE, MAP_OUTSIDE_AOI_MASK, MAP_SELECTION_HALO } from '@/lib/map-colors'

/** Offline-safe basemap used when the configured style JSON can't be loaded,
 *  so the draw tools (added on `load`) still work. */
export const FALLBACK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'fallback-bg', type: 'background', paint: { 'background-color': MAP_FALLBACK_BACKGROUND } }],
}
export const STYLE_LOAD_TIMEOUT_MS = 8000
/** Five stops of viridis for the DEM heatmap. */
const HEATMAP_RAMP = colormapStops('viridis') as string[]

const AOI_SOURCE_ID = 'aoi-highlight'
export const AOI_FILL_ID = 'aoi-fill'
const AOI_LINE_ID = 'aoi-line'
const AOI_CASING_ID = 'aoi-casing'

// ---------------------------------------------------------------------------
// Terrain / projection / sky (P2.2)
// ---------------------------------------------------------------------------
// Free, no-auth global DEM tiles (Terrarium-encoded SRTM/ASTER mosaic).
const TERRAIN_SOURCE_ID = 'terrain-dem'
const TERRAIN_DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
const HILLSHADE_LAYER_ID = 'hillshade-relief'

function ensureTerrainSource(map: maplibregl.Map) {
  if (map.getSource(TERRAIN_SOURCE_ID)) return
  map.addSource(TERRAIN_SOURCE_ID, {
    type: 'raster-dem',
    tiles: [TERRAIN_DEM_URL],
    encoding: 'terrarium',
    tileSize: 256,
    maxzoom: 15,
    // Subtle attribution for the free DEM mosaic
    attribution:
      '<a href="https://registry.opendata.aws/terrain-tiles/" target="_blank">AWS Terrain Tiles</a>',
  } as any)
}

/**
 * Insert the hillshade BENEATH data layers so analysis rasters and extrusions
 * read on top of the relief. Falls back to `beforeAoiId` when no data layers
 * are present, and to top-of-stack otherwise.
 */
function ensureHillshadeLayer(map: maplibregl.Map, beforeAoiId?: string, tone: 'dark' | 'light' = 'dark') {
  if (map.getLayer(HILLSHADE_LAYER_ID)) return
  ensureTerrainSource(map)

  // Find the first user-data layer id (anything we added via addMapLayer is prefixed
  // with `layer-`); fall back to the AOI fill id, or top-of-stack.
  let before: string | undefined
  try {
    const layers = (map.getStyle()?.layers ?? []) as Array<{ id: string }>
    const firstData = layers.find((l) => l.id.startsWith('layer-'))?.id
    before = firstData
      ?? (beforeAoiId && map.getLayer(beforeAoiId) ? beforeAoiId : undefined)
  } catch {
    before = beforeAoiId && map.getLayer(beforeAoiId) ? beforeAoiId : undefined
  }

  map.addLayer(
    {
      id: HILLSHADE_LAYER_ID,
      type: 'hillshade',
      source: TERRAIN_SOURCE_ID,
      paint: {
        // Gentle relief, never overpowering: the workbench design's warm highlight on dark bases,
        // a neutral grey on light ones.
        'hillshade-shadow-color': tone === 'dark' ? MAP_HILLSHADE.darkShadow : MAP_HILLSHADE.lightShadow,
        'hillshade-highlight-color': tone === 'dark' ? MAP_HILLSHADE.darkHighlight : MAP_HILLSHADE.lightHighlight,
        'hillshade-accent-color': tone === 'dark' ? MAP_HILLSHADE.darkAccent : MAP_HILLSHADE.lightAccent,
        'hillshade-exaggeration': tone === 'dark' ? 0.2 : 0.3,
      },
    } as any,
    before,
  )
}

/**
 * Terrain relief and 3D terrain share one elevation source. `relief` draws the hillshade; `enabled`
 * lifts the map into 3D with `exaggeration`. Either keeps the source; with neither it is removed.
 */
export function applyTerrain(
  map: maplibregl.Map,
  enabled: boolean,
  exaggeration: number,
  beforeLayerId?: string,
  relief = false,
  tone: 'dark' | 'light' = 'dark',
) {
  if (!enabled && !relief) {
    try { map.setTerrain(null) } catch {}
    try { if (map.getLayer(HILLSHADE_LAYER_ID)) map.removeLayer(HILLSHADE_LAYER_ID) } catch {}
    try { if (map.getSource(TERRAIN_SOURCE_ID)) map.removeSource(TERRAIN_SOURCE_ID) } catch {}
    return
  }
  ensureTerrainSource(map)
  if (relief) ensureHillshadeLayer(map, beforeLayerId, tone)
  else {
    try { if (map.getLayer(HILLSHADE_LAYER_ID)) map.removeLayer(HILLSHADE_LAYER_ID) } catch {}
  }
  try {
    map.setTerrain(enabled ? { source: TERRAIN_SOURCE_ID, exaggeration } : null)
  } catch {
    // setTerrain may transiently fail mid-style-load; the useEffect will re-run.
  }
}

export function applyProjection(map: maplibregl.Map, projection: 'mercator' | 'globe') {
  try {
    map.setProjection({ type: projection })
  } catch {
    // Older webgl contexts may reject globe — silently fall back.
  }
}

export function applySky(map: maplibregl.Map, enabled: boolean) {
  try {
    if (enabled) {
      // Subtle dark-theme atmosphere. atmosphere-blend reads best on globe.
      map.setSky({
        'sky-color': MAP_ATMOSPHERE.sky,
        'horizon-color': MAP_ATMOSPHERE.horizon,
        'fog-color': MAP_ATMOSPHERE.fog,
        'fog-ground-blend': 0.45,
        'horizon-fog-blend': 0.7,
        'sky-horizon-blend': 0.6,
        'atmosphere-blend': 0.85,
      })
    } else {
      // Reset to defaults (transparent-ish — works well over flat mercator).
      map.setSky({ 'atmosphere-blend': 0 })
    }
  } catch {
    // setSky is best-effort; never crash the map.
  }
}

export function ensureAOILayers(map: maplibregl.Map) {
  if (map.getSource(AOI_SOURCE_ID)) return

  map.addSource(AOI_SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  })

  map.addLayer({
    id: AOI_FILL_ID,
    type: 'fill',
    source: AOI_SOURCE_ID,
    paint: {
      'fill-color': AOI_COLOR,
      'fill-opacity': 0.13,
    },
  })

  // The design's area outline: a dark casing under a dashed green line, readable on any basemap.
  map.addLayer({
    id: AOI_CASING_ID,
    type: 'line',
    source: AOI_SOURCE_ID,
    paint: { 'line-color': '#101b16', 'line-width': 4, 'line-opacity': 0.75 },
  })

  map.addLayer({
    id: AOI_LINE_ID,
    type: 'line',
    source: AOI_SOURCE_ID,
    paint: {
      'line-color': '#82d3a4',
      'line-width': 2,
      'line-opacity': 1,
      'line-dasharray': [1.5, 1],
    },
  })
}

export function syncAOIHighlight(map: maplibregl.Map, aoi: AOI | null) {
  const source = map.getSource(AOI_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
  if (!source) return

  if (aoi?.geometry) {
    const feature: GeoJSON.Feature = {
      type: 'Feature',
      properties: {},
      geometry: aoi.geometry,
    }
    source.setData({ type: 'FeatureCollection', features: [feature] })
  } else {
    source.setData({ type: 'FeatureCollection', features: [] })
  }
}

/**
 * Add a data layer to the map with correct geometry-aware rendering.
 * Pass `beforeLayerId` to insert the layer BENEATH a specific existing layer —
 * used to keep AOI highlight layers always on top of analysis data layers.
 */
// Toggle to true (or use a `?debug` query flag) to surface verbose addMapLayer logs.
const DEBUG_AGENT = false

/** True when the user prefers reduced motion — used to skip camera animations. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Tilt the camera + set a soft directional light so 3D extrusions read as a skyline.
 * Only tilts when the camera is currently flat (pitch === 0) — never overrides a view
 * the user has already chosen.
 */
function activate3DCameraIfFlat(map: maplibregl.Map) {
  if (map.getPitch() > 1) return

  try {
    map.setLight({ anchor: 'viewport', position: [1.2, 90, 40], intensity: 0.4 })
  } catch {
    // setLight is best-effort; some style specs reject it
  }

  const camera = { pitch: 55, bearing: -20 } as const
  if (prefersReducedMotion()) {
    map.setPitch(camera.pitch)
    map.setBearing(camera.bearing)
  } else {
    map.easeTo({ ...camera, duration: 800, essential: true })
  }
}

/** Paint colours for a GeoJSON layer's fill / line / circle: the data-driven expression
 *  when the layer has a `vectorStyle` that fits its features, else the per-feature
 *  `color` property with the layer colour as fallback. */
function vectorPaintExprs(layer: MapLayer): { fill: any; line: any; point: any } {
  const styled = vectorStylePaint(layer.vectorStyle, layer.geojson)
  if (styled) return { fill: styled.expression, line: styled.expression, point: styled.expression }
  return {
    fill: ['coalesce', ['get', 'fill'], ['get', 'color'], layer.color ?? CATEGORICAL_PALETTE[0]],
    line: ['coalesce', ['get', 'color'], layer.color ?? CATEGORICAL_PALETTE[4]],
    point: ['coalesce', ['get', 'color'], layer.color ?? CATEGORICAL_PALETTE[1]],
  }
}

export function addMapLayer(map: maplibregl.Map, layer: MapLayer, beforeLayerId?: string) {
  if (DEBUG_AGENT) console.log('addMapLayer called:', layer.id, layer.type, layer.geojson?.features?.length)
  const sourceId = `layer-${layer.id}`

  // Skip if already present
  if (map.getSource(sourceId)) return

  // Validate beforeLayerId exists, else fall back to adding at top
  const before = beforeLayerId && map.getLayer(beforeLayerId) ? beforeLayerId : undefined

  if (layer.type === 'raster' && layer.imageBase64 && layer.bounds) {
    // Server-generated PNG raster (NDVI, DEM, etc.) — no tile seams, immediate render
    const [west, south, east, north] = layer.bounds
    map.addSource(sourceId, {
      type: 'image',
      url: `data:image/png;base64,${layer.imageBase64}`,
      coordinates: [
        [west, north],   // top-left
        [east, north],   // top-right
        [east, south],   // bottom-right
        [west, south],   // bottom-left
      ],
    } as any)
    map.addLayer({
      id: `layer-${layer.id}`,
      type: 'raster',
      source: sourceId,
      layout: { visibility: layer.visible ? 'visible' : 'none' },
      paint: { 'raster-opacity': layer.opacity },
    }, before)
  } else if (layer.type === 'raster' && layer.tileUrl && /\{z\}/.test(layer.tileUrl)) {
    // XYZ tile template (NDVI / spectral / DEM cop-dem / thermal / surface water).
    // Always constrain to the AOI bounds so the layer doesn't paint the whole
    // satellite scene across the globe ("another map on top"). The bounds clip
    // tile loading to the drawn AOI's rectangle.
    const source: any = { type: 'raster', tiles: [layer.tileUrl], tileSize: 256 }
    if (layer.bounds) source.bounds = layer.bounds // [w,s,e,n]
    map.addSource(sourceId, source)
    map.addLayer({
      id: `layer-${layer.id}`,
      type: 'raster',
      source: sourceId,
      layout: { visibility: layer.visible ? 'visible' : 'none' },
      paint: { 'raster-opacity': layer.opacity },
    }, before)
  } else if (layer.type === 'raster' && layer.tileUrl && layer.bounds) {
    // Single georeferenced image overlay (e.g. Sentinel-2 TCI thumbnail) — no {z}.
    const [minLng, minLat, maxLng, maxLat] = layer.bounds
    map.addSource(sourceId, {
      type: 'image',
      url: layer.tileUrl,
      coordinates: [
        [minLng, maxLat],
        [maxLng, maxLat],
        [maxLng, minLat],
        [minLng, minLat],
      ],
    } as any)
    map.addLayer({
      id: `layer-${layer.id}`,
      type: 'raster',
      source: sourceId,
      layout: { visibility: layer.visible ? 'visible' : 'none' },
      paint: { 'raster-opacity': layer.opacity },
    }, before)
  } else if (layer.type === 'raster' && layer.tileUrl) {
    map.addSource(sourceId, { type: 'raster', tiles: [layer.tileUrl], tileSize: 256 })
    map.addLayer({
      id: `layer-${layer.id}`,
      type: 'raster',
      source: sourceId,
      layout: { visibility: layer.visible ? 'visible' : 'none' },
      paint: { 'raster-opacity': layer.opacity },
    }, before)
  } else if (layer.type === 'heatmap' && layer.geojson) {
    // DEM heatmap: each point carries an `intensity` property in 0..1
    map.addSource(sourceId, { type: 'geojson', data: layer.geojson })
    const weightProp = layer.intensityProperty || 'intensity'
    map.addLayer({
      id: `layer-${layer.id}`,
      type: 'heatmap',
      source: sourceId,
      layout: { visibility: layer.visible ? 'visible' : 'none' },
      paint: {
        'heatmap-weight': ['coalesce', ['get', weightProp], 0.5] as any,
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1, 15, 3] as any,
        // viridis, transparent at zero density: a perceptual ramp, not brand or category colours
        'heatmap-color': [
          'interpolate', ['linear'], ['heatmap-density'],
          0, `${HEATMAP_RAMP[0]}00`,
          0.25, HEATMAP_RAMP[1],
          0.5, HEATMAP_RAMP[2],
          0.75, HEATMAP_RAMP[3],
          1, HEATMAP_RAMP[4],
        ] as any,
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 8, 12, 40, 18, 80] as any,
        'heatmap-opacity': layer.opacity * 0.9,
      },
    }, before)
  } else if (layer.type === 'geojson' && layer.render === 'extrusion' && layer.geojson) {
    // Fill-extrusion render: lift building footprints into a real 3D skyline.
    // Heights come from a per-feature property (default 'height'). Type color is kept
    // dominant; vertical gradient + directional light provide depth and skyline readability.
    map.addSource(sourceId, { type: 'geojson', data: layer.geojson })

    const heightProp = layer.heightProperty ?? 'height'
    const vis = layer.visible ? 'visible' : 'none'
    const fillExpr = ['coalesce', ['get', 'fill'], ['get', 'color'], NO_DATA_COLOR] as any
    const strokeExpr = ['coalesce', ['get', 'stroke'], ['get', 'color'], NO_DATA_COLOR] as any

    // Thin footprint outline beneath the extrusion — readable when pitch is low or 0.
    map.addLayer({
      id: `layer-${layer.id}-footprint`,
      type: 'line',
      source: sourceId,
      filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false] as any,
      layout: { visibility: vis },
      paint: { 'line-color': strokeExpr, 'line-width': 0.6, 'line-opacity': layer.opacity * 0.55 },
    }, before)

    map.addLayer({
      id: `layer-${layer.id}-extrusion`,
      type: 'fill-extrusion',
      source: sourceId,
      filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false] as any,
      layout: { visibility: vis },
      paint: {
        'fill-extrusion-color': fillExpr,
        'fill-extrusion-height': ['coalesce', ['get', heightProp], 8] as any,
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': Math.min(0.95, layer.opacity + 0.15),
        'fill-extrusion-vertical-gradient': true,
      },
    }, before)

    activate3DCameraIfFlat(map)
  } else if (layer.type === 'geojson' && layer.geojson) {
    // generateId: each feature's id = its index, which chart marks carry as `_fid`.
    map.addSource(sourceId, { type: 'geojson', data: layer.geojson, generateId: true })

    const features = layer.geojson.features ?? []
    const hasPolygons = features.some(f =>
      f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon')
    const hasLines = features.some(f =>
      f.geometry?.type === 'LineString' || f.geometry?.type === 'MultiLineString')
    const hasPoints = features.some(f =>
      f.geometry?.type === 'Point' || f.geometry?.type === 'MultiPoint')
    const vis = layer.visible ? 'visible' : 'none'

    // Use feature-level color property; fall back to a single layer color
    const { fill: fillExpr, line: lineExpr, point: ptExpr } = vectorPaintExprs(layer)

    if (hasPolygons) {
      // Filled polygon layer
      map.addLayer({
        id: `layer-${layer.id}-fill`,
        type: 'fill',
        source: sourceId,
        filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false] as any,
        layout: { visibility: vis },
        paint: { 'fill-color': fillExpr, 'fill-opacity': dimmed(layer.opacity * 0.75, 0.06) },
      }, before)
      // Polygon stroke
      map.addLayer({
        id: `layer-${layer.id}-stroke`,
        type: 'line',
        source: sourceId,
        filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false] as any,
        layout: { visibility: vis },
        paint: { 'line-color': lineExpr, 'line-width': 1.5, 'line-opacity': dimmed(layer.opacity * 0.8, 0.12) },
      }, before)
    }

    if (hasLines) {
      map.addLayer({
        id: `layer-${layer.id}-line`,
        type: 'line',
        source: sourceId,
        filter: ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false] as any,
        layout: { visibility: vis, 'line-cap': 'round', 'line-join': 'round' } as any,
        paint: { 'line-color': lineExpr, 'line-width': 2.5, 'line-opacity': dimmed(layer.opacity, 0.12) },
      }, before)
    }

    if (hasPoints || (!hasPolygons && !hasLines)) {
      map.addLayer({
        id: `layer-${layer.id}`,
        type: 'circle',
        source: sourceId,
        ...(hasPoints ? { filter: ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false] as any } : {}),
        layout: { visibility: vis },
        paint: {
          'circle-radius': 6,
          'circle-color': ptExpr,
          'circle-stroke-width': 2,
          'circle-stroke-color': MAP_HALO,
          'circle-opacity': dimmed(layer.opacity, 0.12),
        },
      }, before)
    }
  }
  // '3dtiles' type is not natively supported in MapLibre GL JS
}

export function removeMapLayer(map: maplibregl.Map, layerId: string) {
  const sourceId = `layer-${layerId}`
  // Remove all possible sub-layers created by addMapLayer
  const variants = [
    `layer-${layerId}`,
    `layer-${layerId}-fill`,
    `layer-${layerId}-stroke`,
    `layer-${layerId}-line`,
    `layer-${layerId}-extrusion`,
    `layer-${layerId}-footprint`,
  ]
  try {
    for (const v of variants) {
      if (map.getLayer(v)) map.removeLayer(v)
    }
    if (map.getSource(sourceId)) map.removeSource(sourceId)
  } catch {
    // Ignore errors during cleanup
  }
}

const HALO_PREFIX = 'hl-'
const FOOTPRINT_SOURCE_PREFIX = 'hl-evidence-footprint-'
let footprintSources: string[] = []

/** Remove every selection halo layer this module drew for one group (feature or evidence). */
function clearHalos(map: maplibregl.Map, group: string) {
  const prefix = `${HALO_PREFIX}${group}-`
  for (const l of (map.getStyle()?.layers ?? []) as Array<{ id: string }>) {
    if (l.id.startsWith(prefix)) map.removeLayer(l.id)
  }
}

/** A selection marker that reads on any basemap and any layer colour: a dark halo under a white
 *  outline. Lines and polygon edges get two stacked line layers, points two stacked circles.
 *  `where` narrows the source to the selected feature(s); null selects the whole source. */
function drawHalo(map: maplibregl.Map, group: string, sourceId: string, where: any[] | null) {
  const before = map.getLayer(AOI_FILL_ID) ? AOI_FILL_ID : undefined
  const only = (geom: string[]) => {
    const g = ['match', ['geometry-type'], geom, true, false]
    return (where ? ['all', where, g] : g) as any
  }
  const lineGeom = ['Polygon', 'MultiPolygon', 'LineString', 'MultiLineString']
  const pointGeom = ['Point', 'MultiPoint']
  const id = (name: string) => `${HALO_PREFIX}${group}-${name}`
  map.addLayer({
    id: id('line-halo'), type: 'line', source: sourceId, filter: only(lineGeom),
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': MAP_SELECTION_HALO, 'line-width': 7, 'line-opacity': 0.85 },
  }, before)
  map.addLayer({
    id: id('line'), type: 'line', source: sourceId, filter: only(lineGeom),
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': MAP_HALO, 'line-width': 3, 'line-opacity': 1 },
  }, before)
  map.addLayer({
    id: id('point-halo'), type: 'circle', source: sourceId, filter: only(pointGeom),
    paint: { 'circle-radius': 12, 'circle-color': MAP_SELECTION_HALO, 'circle-opacity': 0.85 },
  }, before)
  map.addLayer({
    id: id('point'), type: 'circle', source: sourceId, filter: only(pointGeom),
    paint: { 'circle-radius': 8, 'circle-color': MAP_SELECTION_HALO, 'circle-opacity': 0, 'circle-stroke-color': MAP_HALO, 'circle-stroke-width': 3 },
  }, before)
}

/** Outline the feature selected from a chart, a table row or the map. A filter on the data source
 *  matches the feature's generated id; cleared when nothing is selected. */
export function syncHighlight(map: maplibregl.Map, highlight: { layerId: string; fid: number } | null, layers: MapLayer[]) {
  if (!map.isStyleLoaded()) return
  clearHalos(map, 'feature')
  const sourceId = highlight ? `layer-${highlight.layerId}` : ''
  if (!highlight || !map.getSource(sourceId) || !layers.some((l) => l.id === highlight.layerId && l.visible)) return
  drawHalo(map, 'feature', sourceId, ['==', ['id'], highlight.fid])
}

/** Mark the layers a clicked citation points at. GeoJSON layers get the halo on every feature;
 *  a raster has no features, so its footprint is outlined instead. */
export function syncEvidenceFocus(map: maplibregl.Map, resultId: string | null, layers: MapLayer[]) {
  if (!map.isStyleLoaded()) return
  clearHalos(map, 'evidence')
  for (const id of footprintSources) if (map.getSource(id)) map.removeSource(id)
  footprintSources = []
  if (!resultId) return
  let n = 0
  for (const l of layers) {
    if (!l.visible || l.resultId !== resultId) continue
    const sourceId = `layer-${l.id}`
    if (l.type === 'geojson' && l.render !== 'extrusion' && map.getSource(sourceId)) {
      drawHalo(map, 'evidence', sourceId, null)
    } else if (l.bounds) {
      const [w, s, e, nn] = l.bounds
      const src = `${FOOTPRINT_SOURCE_PREFIX}${n++}`
      footprintSources.push(src)
      map.addSource(src, {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, nn], [w, nn], [w, s]]] } },
      })
      drawHalo(map, 'evidence', src, null)
    }
  }
}

/** Combined bounds of the layers one result produced, or null when none has any. */
export function resultBounds(resultId: string, layers: MapLayer[]): [number, number, number, number] | null {
  let out: [number, number, number, number] | null = null
  for (const l of layers) {
    if (l.resultId !== resultId) continue
    const b = layerBounds(l)
    if (!b) continue
    out = out ? [Math.min(out[0], b[0]), Math.min(out[1], b[1]), Math.max(out[2], b[2]), Math.max(out[3], b[3])] : [...b]
  }
  return out
}

/** A layer's extent: its stated bounds, else the extent of its features. */
export function layerBounds(layer: MapLayer): [number, number, number, number] | null {
  return layer.bounds ?? geojsonBounds(layer.geojson)
}

/** The extent of one geometry: [west, south, east, north], null when it has no coordinates. */
export function geometryBounds(geometry: GeoJSON.Geometry | null | undefined): [number, number, number, number] | null {
  if (!geometry) return null
  return geojsonBounds({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry }] })
}

function geojsonBounds(fc: GeoJSON.FeatureCollection | undefined): [number, number, number, number] | null {
  if (!fc) return null
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1])
    } else c.forEach(visit)
  }
  for (const f of fc.features ?? []) visit((f.geometry as { coordinates?: unknown } | null)?.coordinates)
  return Number.isFinite(w) ? [w, s, e, n] : null
}

/** Show only the chosen classes of a categorical `vectorStyle` (null clears the filter). */
/** A paint opacity that drops to `dim` for a feature whose `dim` feature-state is on. The class
 *  filter sets that state, so switching a class changes opacity only (nothing is re-tiled or
 *  re-filtered) and the dimmed features stay visible as context. */
export function dimmed(opacity: number, dim: number): any {
  return ['case', ['boolean', ['feature-state', 'dim'], false], Math.min(opacity, dim), opacity]
}

export function applyClassFilter(map: maplibregl.Map, layer: MapLayer, selected: Array<string | number> | null) {
  const prop = layer.vectorStyle?.property
  const source = `layer-${layer.id}`
  if (!prop || !layer.geojson || !map.getSource(source)) return
  const keep = selected && selected.length > 0 ? new Set(selected.map(String)) : null
  layer.geojson.features.forEach((f, id) => {
    const v = f.properties?.[prop]
    map.setFeatureState({ source, id }, { dim: !!keep && !keep.has(String(v)) })
  })
}

export function updateMapLayer(map: maplibregl.Map, layer: MapLayer, prev?: MapLayer) {
  const sourceId = `layer-${layer.id}`
  const variants = [
    `layer-${layer.id}`,
    `layer-${layer.id}-fill`,
    `layer-${layer.id}-stroke`,
    `layer-${layer.id}-line`,
    `layer-${layer.id}-extrusion`,
    `layer-${layer.id}-footprint`,
  ]

  const anyExists = variants.some(v => !!map.getLayer(v))
  if (!anyExists) return

  if (prev && prev.visible !== layer.visible) {
    const vis = layer.visible ? 'visible' : 'none'
    for (const v of variants) {
      if (map.getLayer(v)) map.setLayoutProperty(v, 'visibility', vis)
    }
  }

  if (prev && prev.opacity !== layer.opacity) {
    for (const v of variants) {
      const gl = map.getLayer(v)
      if (!gl) continue
      const t = (gl as any).type
      if (t === 'raster') map.setPaintProperty(v, 'raster-opacity', layer.opacity)
      else if (t === 'circle') map.setPaintProperty(v, 'circle-opacity', dimmed(layer.opacity, 0.12))
      else if (t === 'fill') map.setPaintProperty(v, 'fill-opacity', dimmed(layer.opacity * 0.75, 0.06))
      else if (t === 'line') {
        // The footprint line uses a dimmer opacity multiplier than standard lines.
        const isFootprint = v.endsWith('-footprint')
        map.setPaintProperty(v, 'line-opacity', isFootprint ? layer.opacity * 0.55 : dimmed(layer.opacity, 0.12))
      }
      else if (t === 'heatmap') map.setPaintProperty(v, 'heatmap-opacity', layer.opacity * 0.9)
      else if (t === 'fill-extrusion') map.setPaintProperty(v, 'fill-extrusion-opacity', Math.min(0.95, layer.opacity + 0.15))
    }
  }

  if (layer.type === 'geojson' && layer.geojson && prev && layer.geojson !== prev.geojson) {
    const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined
    if (source) source.setData(layer.geojson)
  }

  // Data-driven vector style changed (style_layer, or the LayerPanel pickers): repaint in place.
  if (layer.type === 'geojson' && layer.render !== 'extrusion' && prev && (layer.vectorStyle !== prev.vectorStyle || layer.geojson !== prev.geojson)) {
    const { fill, line, point } = vectorPaintExprs(layer)
    const paint: Record<string, ['fill-color' | 'line-color' | 'circle-color', any]> = {
      [`layer-${layer.id}-fill`]: ['fill-color', fill],
      [`layer-${layer.id}-stroke`]: ['line-color', line],
      [`layer-${layer.id}-line`]: ['line-color', line],
      [`layer-${layer.id}`]: ['circle-color', point],
    }
    for (const [id, [prop, expr]] of Object.entries(paint)) {
      if (map.getLayer(id)) map.setPaintProperty(id, prop, expr)
    }
  }

  // Raster tile-source URL swap (P2.3 timeline scrubbing). Use MapLibre's native
  // setTiles so the layer doesn't add/remove (avoids WebGL flicker). Applies to any
  // XYZ tile-template source (with or without bounds); setTiles only swaps the URL.
  if (
    layer.type === 'raster' &&
    !layer.imageBase64 &&
    layer.tileUrl &&
    /\{z\}/.test(layer.tileUrl) &&
    prev && prev.tileUrl !== layer.tileUrl
  ) {
    const source = map.getSource(sourceId) as
      | (maplibregl.RasterTileSource & { setTiles?: (tiles: string[]) => void })
      | undefined
    if (source && typeof source.setTiles === 'function') {
      try { source.setTiles([layer.tileUrl]) } catch {
        // Fall through to remove+re-add path below.
      }
    } else {
      // Older runtime: swap by removing + re-adding the layer in place.
      removeMapLayer(map, layer.id)
      addMapLayer(map, layer, AOI_FILL_ID)
    }
  }
}

const AOI_MASK_PREFIX = 'aoimask-'

/**
 * AOI mask for raster layers flagged `aoiMask`: a world-minus-AOI fill slotted directly
 * ABOVE the raster (and below any later data layer), so tile pixels outside the drawn
 * polygon are covered. Tiles are rectangular; this is what makes the raster read as
 * clipped to the polygon. Idempotent — diffs against what is on the map, so it is safe
 * to call after any layer / AOI / basemap change.
 */
export function syncAoiMasks(map: maplibregl.Map, layers: MapLayer[], aoi: AOI | null) {
  if (!map.isStyleLoaded()) return
  const hole = worldMinusAoi(aoi?.geometry as any)
  const sig = aoi ? aoiSignature(aoi) : ''
  const want = new Map<string, MapLayer>()
  for (const l of layers) {
    // A layer computed for a previous AOI must not be masked by the current one.
    if (l.aoiMask && hole && l.type === 'raster' && (!l.aoiKey || l.aoiKey === sig) && map.getLayer(`layer-${l.id}`)) {
      want.set(`${AOI_MASK_PREFIX}${l.id}`, l)
    }
  }
  const styleLayers = (map.getStyle()?.layers ?? []) as Array<{ id: string }>
  for (const sl of styleLayers) {
    if (sl.id.startsWith(AOI_MASK_PREFIX) && !want.has(sl.id)) {
      map.removeLayer(sl.id)
      if (map.getSource(sl.id)) map.removeSource(sl.id)
    }
  }
  for (const [maskId, l] of want) {
    const data: GeoJSON.Feature = { type: 'Feature', properties: {}, geometry: hole! }
    const existing = map.getSource(maskId) as maplibregl.GeoJSONSource | undefined
    if (existing) existing.setData(data)
    else {
      map.addSource(maskId, { type: 'geojson', data })
      const ids = styleLayers.map((x) => x.id)
      const next = ids[ids.indexOf(`layer-${l.id}`) + 1]
      map.addLayer({
        id: maskId,
        type: 'fill',
        source: maskId,
        layout: { visibility: l.visible ? 'visible' : 'none' },
        paint: { 'fill-color': MAP_OUTSIDE_AOI_MASK, 'fill-opacity': 0.92 },
      }, next && map.getLayer(next) ? next : undefined)
    }
    map.setLayoutProperty(maskId, 'visibility', l.visible ? 'visible' : 'none')
  }
}
