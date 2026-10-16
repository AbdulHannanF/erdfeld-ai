/** OSM tools: query_osm, query_3d_tiles (digitize_features lives in tools/index.ts so it can recurse). */

import { isCvEnabled } from '../engine/flags'
import { parseBuildingHeight, buildingTypeColor } from '../lib/buildings'
import { genId } from '../lib/geometry'
import { callOverpass, darken, mapFeatureToCvModel, mergeOsmResults, resolveOsmTags, splitBbox } from '../lib/overpass'
import type { ClassesPalette, GeomHint, ToolCtx, ToolOutput } from '../lib/types'

/** Honest single-request feature cap (also the `qt` limit in the QL). When a
 *  quadrant returns this many elements it is assumed truncated and is split. */
const OSM_FEATURE_CAP = 5000
/** Recursion ceiling for the progressive quadtree (P5.2). At depth 4 the
 *  theoretical capacity is far beyond any realistic AOI; in practice dense
 *  cities resolve at depth 1–2. */
const MAX_QUADTREE_DEPTH = 4
/** Quadrants fetched in parallel per wave — kind to the public Overpass mirrors. */
const QUADTREE_CONCURRENCY = 4

/** Overpass bbox filter wants `(south,west,north,east)`; our bbox is `[w,s,e,n]`. */
function bboxToOverpass(bbox: [number, number, number, number]): string {
  return `${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]}`
}

/** Build the Overpass QL for one bbox + geometry hint (shared by every quadrant). */
function buildOsmQl(tags: string[], geom: GeomHint, opBbox: string): string {
  const head = `[out:json][timeout:30][maxsize:536870912]`
  if (geom === 'Point') {
    return `${head};\n(\n${tags.map(t => `  node[${t}](${opBbox});\n  way[${t}](${opBbox});`).join('\n')}\n);\nout center qt ${OSM_FEATURE_CAP};`
  }
  if (geom === 'LineString') {
    return `${head};\n(\n${tags.map(t => `  way[${t}](${opBbox});`).join('\n')}\n);\nout geom qt ${OSM_FEATURE_CAP};`
  }
  return `${head};\n(\n${tags.map(t => `  way[${t}](${opBbox});\n  relation[${t}][type=multipolygon](${opBbox});`).join('\n')}\n);\nout geom qt ${OSM_FEATURE_CAP};`
}

interface QuadNode { bbox: [number, number, number, number]; depth: number }
export interface QuadtreeResult {
  elements: any[]
  totalRequests: number
  leafQuadrants: number
  maxDepth: number
  truncated: boolean
  failedQuadrants: number
}

/** Fetch one quadrant's elements from Overpass (default fetcher). */
async function overpassFetcher(bbox: [number, number, number, number], tags: string[], geom: GeomHint): Promise<any[]> {
  const data = await callOverpass(buildOsmQl(tags, geom, bboxToOverpass(bbox)), 35000)
  return (data.elements || []) as any[]
}

/** Fetch all features for `bbox`, recursively splitting any quadrant that
 *  saturates the cap into four sub-quadrants (bounded to `MAX_QUADTREE_DEPTH`),
 *  then merging + deduping. The root fetch failing throws (so the caller can
 *  return the existing friendly "all mirrors down" message); deeper-quadrant
 *  failures are tolerated and reported as partial coverage.
 *
 *  `fetcher` is injectable purely for unit testing the recursion/dedupe/progress
 *  without hitting the network; production uses `overpassFetcher`. */
export async function fetchOsmQuadtree(
  rootBbox: [number, number, number, number],
  tags: string[],
  geom: GeomHint,
  emit: ToolCtx['emit'],
  fetcher: (bbox: [number, number, number, number]) => Promise<any[]> = (b) => overpassFetcher(b, tags, geom),
): Promise<QuadtreeResult> {
  const collected: any[][] = []
  let totalRequests = 0
  let leafQuadrants = 0
  let maxDepth = 0
  let truncated = false
  let failedQuadrants = 0

  let queue: QuadNode[] = [{ bbox: rootBbox, depth: 0 }]
  while (queue.length > 0) {
    const wave = queue
    queue = []
    if (wave[0].depth > 0) {
      emit?.('token', { type: 'token', content: `Querying Overpass: depth ${wave[0].depth}, ${wave.length} quadrant${wave.length > 1 ? 's' : ''}…\n` })
    }
    const fetched: Array<{ node: QuadNode; elements: any[]; failed: boolean }> = []
    for (let i = 0; i < wave.length; i += QUADTREE_CONCURRENCY) {
      const batch = wave.slice(i, i + QUADTREE_CONCURRENCY)
      const batchRes = await Promise.all(batch.map(async (node) => {
        try {
          const elements = await fetcher(node.bbox)
          return { node, elements, failed: false }
        } catch (err) {
          if (node.depth === 0) throw err // root failure → caller's friendly handler
          return { node, elements: [] as any[], failed: true }
        }
      }))
      fetched.push(...batchRes)
    }
    totalRequests += wave.length
    for (const { node, elements, failed } of fetched) {
      maxDepth = Math.max(maxDepth, node.depth)
      if (failed) { failedQuadrants++; continue }
      if (elements.length >= OSM_FEATURE_CAP && node.depth < MAX_QUADTREE_DEPTH) {
        for (const child of splitBbox(node.bbox)) queue.push({ bbox: child, depth: node.depth + 1 })
      } else {
        if (elements.length >= OSM_FEATURE_CAP) truncated = true // saturated at the depth ceiling
        collected.push(elements)
        leafQuadrants++
      }
    }
  }

  return { elements: mergeOsmResults(collected), totalRequests, leafQuadrants, maxDepth, truncated, failedQuadrants }
}

/** Building-type color key — kept in sync with `buildingTypeColor`. */
const BUILDING_TYPE_PALETTE: ClassesPalette = {
  kind: 'classes',
  label: 'Building type',
  classes: [
    { color: '#3b82f6', label: 'Residential' },
    { color: '#f59e0b', label: 'Commercial / retail' },
    { color: '#6b7280', label: 'Industrial' },
    { color: '#a855f7', label: 'Religious' },
    { color: '#22c55e', label: 'Education' },
    { color: '#ef4444', label: 'Medical' },
    { color: '#eab308', label: 'Tower / utility' },
    { color: '#94a3b8', label: 'Other / unknown' },
  ],
}

/** An empty OSM answer suggests digitizing from imagery only when the (parked) CV pipeline is on. */
function cvFallback(query: string): Pick<ToolOutput, 'cv_fallback_recommended' | 'suggested_cv_model'> {
  return isCvEnabled() ? { cv_fallback_recommended: true, suggested_cv_model: mapFeatureToCvModel(query) } : {}
}

export async function queryOsm(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const { bbox, areaKm2, emit } = ctx
  const [minLng, minLat, maxLng, maxLat] = bbox
  const query = args.query || 'building'
  const entry = resolveOsmTags(query)
  const { tags, geom, color: col, label } = entry

  let qt: QuadtreeResult
  try {
    qt = await fetchOsmQuadtree(bbox, tags, geom, emit)
  } catch (err: any) {
    return { summary: `OpenStreetMap query failed for "${query}": ${err.message}. All Overpass mirrors may be temporarily unavailable — try again in 30 seconds.`, failed: true }
  }
  const elements: any[] = qt.elements
  const usedQuadtree = qt.totalRequests > 1
  const methodLine = usedQuadtree
    ? `Overpass recursive quadtree — ${qt.leafQuadrants} leaf quadrant${qt.leafQuadrants !== 1 ? 's' : ''}, ${qt.totalRequests} requests, max depth ${qt.maxDepth}${qt.truncated ? ' (still saturated at depth limit — some areas truncated)' : ''}${qt.failedQuadrants ? `; ${qt.failedQuadrants} quadrant fetch(es) failed` : ''}`
    : `Overpass single bbox query (qt ${OSM_FEATURE_CAP} cap)`
  const provenance = { source: 'OpenStreetMap (Overpass)', method: methodLine, clip: 'bbox' as const }
  const confidence = (qt.truncated || qt.failedQuadrants > 0) ? 'medium' as const : 'high' as const

  if (elements.length === 0) {
    return {
      summary: `OpenStreetMap (Overpass API) returned 0 results for "${query}" in bbox [${minLng.toFixed(4)}, ${minLat.toFixed(4)}, ${maxLng.toFixed(4)}, ${maxLat.toFixed(4)}] (tags tried: ${tags.join(', ')}).\n\nThis area may not have "${query}" mapped in OSM yet.${isCvEnabled() ? ' The agent can fall back to satellite analysis to digitize features from imagery.' : ''}`,
      // The query completed and found nothing mapped: a citable zero (not a failed read, which is flagged elsewhere).
      summary_data: { feature_count: 0, feature_type: query, area_km2: Number(areaKm2.toFixed(1)) },
      ...cvFallback(query),
      sources: [provenance.source],
    }
  }
  const features: any[] = []
  const stroke = darken(col, 0.25)
  for (const elem of elements) {
    const baseProps = { ...elem.tags, osm_id: elem.id, color: col, stroke }

    if (geom === 'Point') {
      if (elem.type === 'node' && elem.lat != null && elem.lon != null) {
        features.push({ type: 'Feature', properties: baseProps, geometry: { type: 'Point', coordinates: [elem.lon, elem.lat] } })
      } else if (elem.center?.lon != null && elem.center?.lat != null) {
        features.push({ type: 'Feature', properties: baseProps, geometry: { type: 'Point', coordinates: [elem.center.lon, elem.center.lat] } })
      }
      continue
    }

    if (geom === 'LineString' && elem.type === 'way' && Array.isArray(elem.geometry)) {
      features.push({
        type: 'Feature',
        properties: baseProps,
        geometry: { type: 'LineString', coordinates: elem.geometry.map((p: any) => [p.lon, p.lat]) },
      })
      continue
    }

    if (geom === 'Polygon' && elem.type === 'way' && Array.isArray(elem.geometry)) {
      const coords = elem.geometry.map((p: any) => [p.lon, p.lat])
      if (coords.length >= 3) {
        if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) {
          coords.push(coords[0])
        }
        features.push({
          type: 'Feature',
          properties: { ...baseProps, fill: col },
          geometry: { type: 'Polygon', coordinates: [coords] },
        })
      }
      continue
    }

    if (geom === 'Polygon' && elem.type === 'relation' && Array.isArray(elem.members)) {
      const outerRings: number[][][] = []
      const innerRings: number[][][] = []
      for (const m of elem.members) {
        if (!Array.isArray(m.geometry) || m.geometry.length < 3) continue
        const ring = m.geometry.map((p: any) => [p.lon, p.lat])
        if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push(ring[0])
        ;(m.role === 'inner' ? innerRings : outerRings).push(ring)
      }
      if (outerRings.length === 0) continue
      if (outerRings.length === 1) {
        features.push({
          type: 'Feature',
          properties: { ...baseProps, fill: col },
          geometry: { type: 'Polygon', coordinates: [outerRings[0], ...innerRings] },
        })
      } else {
        features.push({
          type: 'Feature',
          properties: { ...baseProps, fill: col },
          geometry: { type: 'MultiPolygon', coordinates: outerRings.map((o) => [o, ...innerRings]) },
        })
      }
    }
  }

  if (features.length === 0) {
    return {
      summary: `OpenStreetMap returned ${elements.length} elements for "${query}" but none had usable geometry (expected ${geom}).${isCvEnabled() ? ' The agent should try CV fallback on satellite imagery.' : ''}`,
      ...cvFallback(query),
      sources: [provenance.source],
    }
  }

  const labelStr = label ?? query
  const quadtreeLine = usedQuadtree
    ? `\n**Coverage:** recursive quadtree — ${qt.leafQuadrants} leaf quadrant${qt.leafQuadrants !== 1 ? 's' : ''}, ${qt.totalRequests} Overpass requests (max depth ${qt.maxDepth})${qt.truncated ? ' — some dense areas still truncated at the depth limit; draw a smaller AOI for a complete census' : ''}${qt.failedQuadrants ? ` — ${qt.failedQuadrants} quadrant(s) failed to fetch (partial coverage)` : ''}`
    : ''
  return {
    summary: `OpenStreetMap digitization: found **${features.length} ${labelStr}** in the AOI (${areaKm2.toFixed(1)} km²).\n\n**Tags matched:** ${tags.join(', ')}\n**Geometry:** ${geom}${geom === 'Polygon' ? ' (incl. multipolygon relations)' : ''}\n**Render color:** ${col}\n**Source:** real OSM via Overpass API${quadtreeLine}`,
    summary_data: {
      feature_count: features.length,
      feature_type: labelStr,
      geometry: geom,
      area_km2: Number(areaKm2.toFixed(1)),
      ...(usedQuadtree ? { quadrants: qt.leafQuadrants, overpass_requests: qt.totalRequests } : {}),
    },
    layer: {
      id: `osm-${genId()}`,
      name: `OSM: ${labelStr} (${features.length})`,
      type: 'geojson',
      geojson: { type: 'FeatureCollection', features },
      provenance,
      confidence,
    },
  }
}

export async function query3dTiles(ctx: ToolCtx): Promise<ToolOutput> {
  const { bbox, areaKm2, emit } = ctx
  const [minLng, minLat, maxLng, maxLat] = bbox
  emit?.('token', { type: 'token', content: 'Querying OpenStreetMap for building footprints with height data...\n' })
  const opBbox3d = `${minLat},${minLng},${maxLat},${maxLng}`
  const ql3d = `[out:json][timeout:30][maxsize:536870912];\n(\n  way[building](${opBbox3d});\n  way["building:part"](${opBbox3d});\n  relation[building][type=multipolygon](${opBbox3d});\n);\nout geom qt 2000;`

  let osmData3d: any
  try {
    osmData3d = await callOverpass(ql3d, 35000)
  } catch (err: any) {
    return { summary: `OpenStreetMap building query failed: ${err.message}. Overpass mirrors may be temporarily unavailable — try again.`, failed: true }
  }

  const elements3d: any[] = osmData3d.elements || []
  if (elements3d.length === 0) {
    return {
      summary: `OpenStreetMap returned 0 buildings in this ${areaKm2.toFixed(1)} km² area.\n\nThis area may not have buildings mapped in OSM yet. Try a smaller AOI over a settled area.`,
    }
  }

  const features3d: any[] = []
  let totalH = 0, maxH = 0, explicitCount = 0

  for (const elem of elements3d) {
    let coords: number[][] = []
    if (elem.type === 'way' && Array.isArray(elem.geometry)) {
      coords = elem.geometry.map((p: any) => [p.lon, p.lat])
    } else if (elem.type === 'relation' && Array.isArray(elem.members)) {
      const outer = elem.members.find((m: any) => m.role === 'outer' && Array.isArray(m.geometry))
      if (outer) coords = outer.geometry.map((p: any) => [p.lon, p.lat])
    }
    if (coords.length < 3) continue
    if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) coords.push(coords[0])

    const tags = elem.tags || {}
    const { height, source } = parseBuildingHeight(tags)
    const color = buildingTypeColor(tags)
    if (source === 'explicit') explicitCount++
    totalH += height
    if (height > maxH) maxH = height

    features3d.push({
      type: 'Feature',
      properties: { ...tags, osm_id: elem.id, height, height_source: source, color, fill: color, stroke: darken(color, 0.25) },
      geometry: { type: 'Polygon', coordinates: [coords] },
    })
  }

  if (features3d.length === 0) {
    return { summary: `Overpass returned ${elements3d.length} elements but none had valid building geometry.` }
  }

  const meanH = totalH / features3d.length
  const explicitPct = Math.round((explicitCount / features3d.length) * 100)
  const top5 = [...features3d]
    .sort((a, b) => b.properties.height - a.properties.height)
    .slice(0, 5)
    .map((f) => {
      const label = f.properties.name || f.properties['addr:street'] || `OSM #${f.properties.osm_id}`
      return `  - ${label}: ${f.properties.height.toFixed(0)} m (${f.properties.building || 'building'})`
    }).join('\n')

  const summary3d = [
    `**3D Buildings** — ${features3d.length.toLocaleString()} footprints (${areaKm2.toFixed(1)} km²)`,
    '',
    `**Height statistics:**`,
    `- Mean: ${meanH.toFixed(1)} m | Max: ${maxH.toFixed(0)} m`,
    `- Explicit height tags: ${explicitPct}% | Estimated: ${100 - explicitPct}%`,
    '',
    `**Tallest buildings:**`,
    top5,
    '',
    `**Color key:** Blue = residential | Amber = commercial | Gray = industrial | Purple = religious | Green = education | Red = medical | Yellow = towers`,
    `**Source:** OpenStreetMap via Overpass API | Heights: \`height\` tag → \`building:levels × 3.5 m\` → type defaults`,
  ].join('\n')

  return {
    summary: summary3d,
    summary_data: {
      building_count: features3d.length,
      mean_height_m: Number(meanH.toFixed(1)),
      max_height_m: Math.round(maxH),
      explicit_height_pct: explicitPct,
      area_km2: Number(areaKm2.toFixed(1)),
    },
    layer: {
      id: `buildings-3d-${genId()}`,
      name: `Buildings with Heights (${features3d.length})`,
      type: 'geojson' as const,
      geojson: { type: 'FeatureCollection', features: features3d },
      render: 'extrusion' as const,
      heightProperty: 'height',
      provenance: {
        source: 'OpenStreetMap (Overpass)',
        method: `building footprint + height tag → levels×3.5m → type default (explicit ${explicitPct}%)`,
        clip: 'bbox',
      },
      confidence: explicitPct >= 60 ? 'high' as const : explicitPct >= 20 ? 'medium' as const : 'low' as const,
      palette: BUILDING_TYPE_PALETTE,
    },
  }
}
