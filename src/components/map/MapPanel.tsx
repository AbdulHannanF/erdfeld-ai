'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import * as maplibregl from '@/lib/maplibre'
import { MaplibreTerradrawControl } from '@watergis/maplibre-gl-terradraw'
import 'maplibre-gl/dist/maplibre-gl.css'
import '@watergis/maplibre-gl-terradraw/dist/maplibre-gl-terradraw.css'
import { useStore, type AOI, type MapLayer, type GeoPoint } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { useMapReadout } from '@/store/useMapReadout'
import { BASEMAP_GROUND, getStyleValue, initialBasemapStyleId, initialWorldZoom, worldFitZoom, type BasemapStyleId } from '@/components/map/basemaps'
import {
  AOI_FILL_ID,
  FALLBACK_STYLE,
  STYLE_LOAD_TIMEOUT_MS,
  addMapLayer,
  applyClassFilter,
  applyProjection,
  applySky,
  applyTerrain,
  ensureAOILayers,
  geometryBounds,
  layerBounds,
  prefersReducedMotion,
  removeMapLayer,
  resultBounds,
  syncAOIHighlight,
  syncAoiMasks,
  syncEvidenceFocus,
  syncHighlight,
  updateMapLayer,
} from '@/components/map/layers'
import MapScreenshot from '@/components/map/MapScreenshot'
import CoordinateInputDialog from '@/components/map/CoordinateInputDialog'
import MapCompareView from '@/components/map/MapCompareView'
import MapDrawingPanel from '@/components/map/MapDrawingPanel'
import MapChrome from '@/components/map/MapChrome'
import LocationDetails from '@/components/map/LocationDetails'
import { ScenesChip } from '@/components/map/ScenesChip'
import { Upload } from 'lucide-react'
import { importVectorFiles } from '@/components/map/VectorIO'
import { IMPORT_ACCEPT } from '@/lib/vector-io'
import { toast } from 'sonner'
import { polygonCentroid, haversineM } from '@/lib/geo-ops'
import { decideTileFailure } from '@/lib/tile-failure'
import { onMapAction } from '@/lib/ui-events'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// Polygon centroid / Haversine distance are provided by the shared pure module
// `@/lib/geo-ops` (consolidated from the previously duplicated copies here, in
// the former spatial/measurement panels). These run on a discrete draw-finish
// event, not per-frame, so they stay in-thread.

/** Feature properties come from data we do not control (OSM names, uploads): escape them before
 *  they go into popup HTML. */
/** Hillshade tone for a basemap: warm on the dark ones and imagery, neutral grey on the light ones. */
function reliefTone(style: string): 'dark' | 'light' {
  return style === 'light' || style === 'voyager' || style === 'streets' ? 'light' : 'dark'
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

/** Convert a TerraDraw feature into our AOI type */
function featureToAOI(feature: Record<string, unknown>): AOI {
  const props = (feature.properties ?? {}) as Record<string, unknown>
  const mode = String(props.mode ?? 'polygon')
  const geometry = feature.geometry as GeoJSON.Geometry

  let type: AOI['type']
  switch (mode) {
    case 'rectangle':
      type = 'Rectangle'
      break
    case 'circle':
      type = 'Circle'
      break
    case 'freehand':
      type = 'Freehand'
      break
    default:
      type = 'Polygon'
  }

  const center: GeoPoint | undefined =
    geometry.type === 'Polygon'
      ? polygonCentroid(geometry as GeoJSON.Polygon)
      : undefined

  const aoi: AOI = { type, geometry, center }

  // For circles compute the radius from center to first vertex
  if (type === 'Circle' && geometry.type === 'Polygon' && center) {
    const coords = (geometry as GeoJSON.Polygon).coordinates[0]
    if (coords.length > 1) {
      aoi.radiusKm =
        haversineM(center.lng, center.lat, coords[0][0], coords[0][1]) / 1000
    }
  }

  return aoi
}

// ---------------------------------------------------------------------------
// Map layer helpers
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MapPanel() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const drawControlRef = useRef<MaplibreTerradrawControl | null>(null)
  const aoiFeatureIdRef = useRef<string | number | null>(null)
  const prevLayersRef = useRef<MapLayer[]>([])
  const mapReadyRef = useRef(false)
  // State twin of mapReadyRef, so effects that need the map (a pending fit) re-run once it loads.
  const [mapLoaded, setMapLoaded] = useState(false)
  const currentStyleRef = useRef<string>('dark')
  const popupRef = useRef<maplibregl.Popup | null>(null)
  // Prevents feature-deleted events fired by TerraDraw.stop() during a style
  // transition from clearing the AOI out of the store.
  const isStyleChangingRef = useRef(false)
  // Saves the AOI before a style switch so it can be restored if stop() wipes it.
  const aoiBeforeStyleChangeRef = useRef<import('@/store/useStore').AOI | null>(null)
  // Prevents duplicate event listener registration across style switches.
  const drawListenersSetupRef = useRef(false)
  // Layers whose class filter is applied on the map, so a cleared filter is reset once.
  const filteredRef = useRef(new Set<string>())
  // TerraDraw instances that already report finished shapes, and the function that attaches the
  // listener (the instance may only exist once the first tool is chosen).
  const finishAttached = useRef(new WeakSet<object>())
  const attachFinishRef = useRef<((td: any) => void) | null>(null)

  const [mapInstance, setMapInstance] = useState<maplibregl.Map | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const geojsonInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)
  const mapView = useUi((s) => s.mapView)
  const setMapView = useUi((s) => s.setMapView)
  // Cursor/zoom readout throttling. A setState on every raw mousemove re-renders
  // this whole panel at pointer frequency and makes TerraDraw polygon drawing
  // stutter, so updates are coalesced to one per animation frame — and skipped
  // entirely while the coordinate readout is hidden. Refs (not state) because the
  // map handlers are registered once on load.
  const showCoordinatesRef = useRef(true)
  const pendingCursorRef = useRef<{ lng: number; lat: number } | null>(null)
  const cursorRafRef = useRef<number | null>(null)
  const zoomRafRef = useRef<number | null>(null)

  // Refs for toolbar-triggered actions
  const screenshotRef = useRef<(() => void) | null>(null)
  const coordinateInputRef = useRef<(() => void) | null>(null)
  const drawingPanelRef = useRef<(() => void) | null>(null)

  // Store selectors
  const aoi = useStore((s) => s.aoi)
  const setAoi = useStore((s) => s.setAoi)
  const layers = useStore((s) => s.layers)
  const mapStyle = useStore((s) => s.mapStyle)
  const relief = useUi((s) => s.relief)
  const flyToTarget = useStore((s) => s.flyToTarget)
  const setFlyToTarget = useStore((s) => s.setFlyToTarget)
  const zoomToFeature = useStore((s) => s.zoomToFeature)
  const setZoomToFeature = useStore((s) => s.setZoomToFeature)
  const addLayer = useStore((s) => s.addLayer)
  const isMapFullscreen = useStore((s) => s.isMapFullscreen)
  const setMapFullscreen = useStore((s) => s.setMapFullscreen)
  const activeDrawMode = useStore((s) => s.activeDrawMode)
  const setActiveDrawMode = useStore((s) => s.setActiveDrawMode)
  const showCoordinates = useStore((s) => s.settings.showCoordinates)
  const fitBoundsTarget = useStore((s) => s.fitBoundsTarget)
  const setFitBoundsTarget = useStore((s) => s.setFitBoundsTarget)
  const terrainEnabled = useStore((s) => s.terrainEnabled)
  const terrainExaggeration = useStore((s) => s.terrainExaggeration)
  const projection = useStore((s) => s.projection)
  const skyEnabled = useStore((s) => s.skyEnabled)

  // ---- Initialize map --------------------------------------------------
  useEffect(() => {
    if (!mapContainer.current) return
    // Prevent double-init in React StrictMode
    if (mapRef.current) return

    const initialStyleId = initialBasemapStyleId()
    // One copy of the world fills the map at the lowest zoom, whatever the screen: a 4K map is
    // wider than the world is at zoom 2, and would repeat it. The plain ground colour shows until
    // the basemap's tiles arrive.
    const box = mapContainer.current
    box.style.backgroundColor = BASEMAP_GROUND[initialStyleId]
    const map = new maplibregl.Map({
      container: box,
      style: getStyleValue(initialStyleId) as string | maplibregl.StyleSpecification,
      center: [10, 30],
      zoom: initialWorldZoom(box.clientWidth, box.clientHeight),
      minZoom: worldFitZoom(box.clientWidth, box.clientHeight),
      renderWorldCopies: false,
      attributionControl: false,
      // Keep the WebGL drawing buffer so map.getCanvas().toDataURL() returns
      // rendered pixels (used by MapScreenshot and the P3.7 PDF report).
      canvasContextAttributes: { preserveDrawingBuffer: true },
    })

    // The map pane changes size (window, dock, inspector): keep the minimum zoom in step.
    map.on('resize', () => {
      const c = map.getContainer()
      map.setMinZoom(worldFitZoom(c.clientWidth, c.clientHeight))
    })

    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
    map.addControl(new maplibregl.ScaleControl({ maxWidth: Math.round(7.5 * parseFloat(getComputedStyle(document.documentElement).fontSize)), unit: 'metric' }), 'bottom-right')

    mapRef.current = map
    setMapInstance(map)

    // Sync store mapStyle to the actual loaded style so the style-change effect
    // doesn't immediately re-apply the style on first render
    currentStyleRef.current = initialStyleId
    useStore.getState().setMapStyle(initialStyleId)

    // P3.7: expose a canvas snapshot getter for the PDF report builder.
    useStore.getState().setMapSnapshotProvider(() => {
      try {
        return map.getCanvas().toDataURL('image/png')
      } catch {
        return null
      }
    })

    // P7.3 — flag a layer whose raster tiles 4xx-fail (e.g. an expired Planetary
    // Computer SAS URL, DATA-013) so LayerPanel can show an "expired" pill + refresh.
    // Sources added by addMapLayer are named `layer-<id>`; transient 5xx are ignored.
    // Q-10: if the basemap style itself fails (error or timeout) before first load,
    // swap in an inline style so `load` fires and the draw control is still added.
    let usedFallbackStyle = false
    const fallBackToInlineStyle = () => {
      if (usedFallbackStyle || mapReadyRef.current) return
      usedFallbackStyle = true
      toast.warning('Basemap unavailable', {
        description: 'Could not load the map style. Using a plain background; drawing still works.',
      })
      map.setStyle(FALLBACK_STYLE, { validate: false })
    }
    const styleTimeout = setTimeout(fallBackToInlineStyle, STYLE_LOAD_TIMEOUT_MS)

    // Tile URLs are no longer probed server-side before a layer is sent (Q-15), so this handler is
    // where a broken URL surfaces. A 4xx means the URL itself is bad or expired: flag at once. A
    // 5xx or a network error can be transient, so flag only when a source keeps failing.
    const tileFailures = new Map<string, number>()
    map.on('error', (e: maplibregl.ErrorEvent & { sourceId?: string }) => {
      if (!e?.sourceId && !mapReadyRef.current && !map.isStyleLoaded()) fallBackToInlineStyle()
      const sourceId = e?.sourceId
      if (!sourceId || !sourceId.startsWith('layer-')) return
      if (decideTileFailure(tileFailures, sourceId, (e?.error as { status?: number } | undefined)?.status)) {
        useStore.getState().setLayerExpired(sourceId.slice('layer-'.length), true)
      }
    })

    // Ready as soon as the style is parsed, not on `load`: `load` also waits for every initial
    // tile, and a slow tile host (low-zoom vector tiles are ~360 KB each) would otherwise trip the
    // style timeout above and replace a working basemap with the blank fallback.
    map.once('style.load', () => {
      mapReadyRef.current = true
      setMapLoaded(true)
      clearTimeout(styleTimeout)

      // 1. TerraDraw drawing control (added first so its GL layers sit below data layers)
      // Full digitization capabilities: polygon, rectangle, circle, freehand, linestring, point, select, delete
      const drawControl = new MaplibreTerradrawControl({
        modes: ['polygon', 'rectangle', 'circle', 'freehand', 'linestring', 'point', 'select', 'delete'],
        open: true,
      })

      drawControlRef.current = drawControl
      map.addControl(drawControl, 'bottom-left')

      // Listen for completed drawings via TerraDraw instance.
      // 'finish' must be re-registered each time the control is re-added to the map
      // because MaplibreTerradrawControl may create a new TerraDraw instance on each onAdd().
      const attachFinish = (terraDraw: NonNullable<ReturnType<MaplibreTerradrawControl['getTerraDrawInstance']>>) => {
        if (finishAttached.current.has(terraDraw)) return
        finishAttached.current.add(terraDraw)
        terraDraw.on('finish', (id: string | number) => {
          aoiFeatureIdRef.current = id
          const result = drawControlRef.current?.getFeatures()
          if (result && result.features && result.features.length > 0) {
            const feature = (result.features as unknown as Record<string, unknown>[]).find(
              (f) => f.id === id,
            )
            if (feature) {
              const props = (feature.properties ?? {}) as Record<string, unknown>
              const mode = String(props.mode ?? 'polygon')
              // Only polygon-type features (polygon, rectangle, circle, freehand) become AOI
              if (['polygon', 'rectangle', 'circle', 'freehand'].includes(mode)) {
                const aoiData = featureToAOI(feature)
                setAoi(aoiData)
              }
            }
          }
          // Return to static mode after completing a drawing
          useStore.getState().setActiveDrawMode(null)
        })
      }
      attachFinishRef.current = attachFinish
      const terraDraw = drawControl.getTerraDrawInstance()
      if (terraDraw) attachFinish(terraDraw)

      // 'feature-deleted' is on the persistent control object — register once only so
      // we don't accumulate duplicate handlers across style switches.
      if (!drawListenersSetupRef.current) {
        drawControl.on('feature-deleted', (event: { deletedIds?: (string | number)[] }) => {
          // Ignore deletion events fired by TerraDraw.stop() during a style switch
          if (isStyleChangingRef.current) return
          if (
            aoiFeatureIdRef.current &&
            event.deletedIds?.includes(aoiFeatureIdRef.current)
          ) {
            aoiFeatureIdRef.current = null
            setAoi(null)
          }
        })
        drawListenersSetupRef.current = true
      }

      // 2. AOI highlight layers — added before data layers so we can use beforeId
      //    to slot data layers underneath, keeping AOI always on top
      ensureAOILayers(map)
      syncAOIHighlight(map, useStore.getState().aoi)

      // 3. Pre-existing data layers — inserted BEFORE aoi-fill so AOI renders on top
      const storeLayers = useStore.getState().layers
      for (const layer of storeLayers) {
        addMapLayer(map, layer, AOI_FILL_ID)
      }
      prevLayersRef.current = [...storeLayers]

      // 4. Restore terrain / projection / sky from store (e.g. persisted toggle state).
      const s = useStore.getState()
      applyProjection(map, s.projection)
      applyTerrain(map, s.terrainEnabled, s.terrainExaggeration, AOI_FILL_ID, useUi.getState().relief, reliefTone(s.mapStyle))
      applySky(map, s.skyEnabled || s.projection === 'globe')
      syncAoiMasks(map, s.layers, s.aoi)
    })

    // Track cursor position — rAF-coalesced, skipped while the readout is hidden
    map.on('mousemove', (e: maplibregl.MapMouseEvent) => {
      if (!showCoordinatesRef.current) return
      pendingCursorRef.current = { lng: e.lngLat.lng, lat: e.lngLat.lat }
      if (cursorRafRef.current != null) return
      cursorRafRef.current = requestAnimationFrame(() => {
        cursorRafRef.current = null
        if (pendingCursorRef.current) useMapReadout.getState().setCursor(pendingCursorRef.current)
      })
    })

    // Track zoom level — rAF-coalesced (zoom fires continuously during animations)
    const publishView = () => {
      const c = map.getCenter()
      useMapReadout.getState().setView({ zoom: map.getZoom(), center: { lat: c.lat, lng: c.lng }, bearing: map.getBearing() })
    }
    map.on('move', () => {
      if (zoomRafRef.current != null) return
      zoomRafRef.current = requestAnimationFrame(() => {
        zoomRafRef.current = null
        publishView()
      })
    })
    publishView()

    // P4.3 — "Ask Erdfeld AI about this point" affordance. Sets the clicked-point
    // focus in the store; the chat composer shows a chip and the next query is
    // clipped to that point. The drawn AOI is never touched.
    const ASK_BTN_ID = 'erdfeld-ask-point-btn'
    const askButtonHTML = `
      <button id="${ASK_BTN_ID}" style="margin-top:0.5rem;width:100%;display:flex;align-items:center;justify-content:center;gap:0.3125rem;font-size:0.75rem;font-weight:600;color:var(--primary-foreground);background:var(--primary);border:none;border-radius:0.375rem;padding:0.375rem 0.5rem;cursor:pointer;">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
        Ask Erdfeld AI about this point
      </button>`

    const openAskPopup = (coords: maplibregl.LngLat, innerHTML: string) => {
      if (popupRef.current) popupRef.current.remove()
      const popup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: true,
        maxWidth: '17.5rem',
        offset: 8,
        className: 'map-popup',
      })
        .setLngLat(coords)
        .setHTML(innerHTML)
        .addTo(map)
      popupRef.current = popup
      // Wire the Ask button (DOM exists only after addTo).
      const btn = popup.getElement()?.querySelector(`#${ASK_BTN_ID}`)
      btn?.addEventListener('click', () => {
        useStore.getState().setPointFocus({ lat: coords.lat, lng: coords.lng })
        popup.remove()
        toast.success('Point selected', {
          description: `Now ask a question about ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`,
        })
      })
    }

    // Feature click popup for GeoJSON layers
    map.on('click', (e: maplibregl.MapMouseEvent) => {
      // Query all our data layers by ID prefix — handles Point circles, Polygon fills, and Line layers.
      // Filtering by geometry-type alone would miss polygon and line features added by addMapLayer.
      const allLayerIds = (map.getStyle()?.layers ?? []).map((l: any) => l.id as string)
      const dataLayerIds = allLayerIds.filter((id) => id.startsWith('layer-'))
      const features = dataLayerIds.length > 0
        ? map.queryRenderedFeatures(e.point, { layers: dataLayerIds })
        : []
      const coords = e.lngLat

      // Link map -> chart: remember which feature was clicked (generated id = feature index).
      const hit = features.find((f) => typeof f.id === 'number' && f.source.startsWith('layer-'))
      useStore.getState().setHighlight(hit ? { layerId: hit.source.slice('layer-'.length), fid: hit.id as number } : null)
      // A click on the map ends the "this is what the citation points at" marking.
      useUi.getState().clearEvidenceFocus()

      if (features.length > 0) {
        const feature = features[0]
        const props = feature.properties || {}

        // Build popup HTML
        const rows = Object.entries(props)
          .filter(([key]) => key !== 'color' && key !== 'id')
          .map(([key, value]) => {
            const displayKey = key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
            let displayValue = String(value)
            let valueColor = 'text-muted-foreground'

            if (key === 'confidence') {
              const conf = parseFloat(String(value))
              if (conf > 0.8) valueColor = 'text-brand-text'
              else if (conf > 0.6) valueColor = 'text-warning'
              else valueColor = 'text-danger'
            }

            return `<div class="flex justify-between gap-4 py-0.5">
              <span class="text-xs text-muted-foreground">${esc(displayKey)}</span>
              <span class="text-xs font-medium ${valueColor}">${esc(displayValue)}</span>
            </div>`
          })
          .join('')

        // A classified polygon with an area (a delineated field) gets the compact card; the full
        // property list is in the attribute table and the selected-feature card.
        const compact = typeof props.area_ha === 'number' && typeof props.color === 'string'
        const compactHTML = compact
          ? `<div style="min-width:10.625rem;max-width:16.25rem;font-family:inherit;">
              <div style="display:flex;align-items:center;gap:0.5rem;font:600 0.8125rem var(--font-heading),sans-serif;color:var(--popover-foreground);">
                <i style="width:0.5625rem;height:0.5625rem;border-radius:0.125rem;background:${esc(String(props.color))};display:inline-block;"></i>${esc(String(props.name || 'Feature'))}
              </div>
              <p style="margin:0.125rem 0 0;font-size:0.75rem;color:var(--muted-foreground);">${Number(props.area_ha).toFixed(2)} ha${typeof props.confidence === 'number' ? ` · confidence ${props.confidence.toFixed(2)}` : ''}</p>
              ${askButtonHTML}
            </div>`
          : ''
        const popupHTML = compactHTML || `
          <div style="min-width:10rem;max-width:16.25rem;font-family:inherit;">
            <div style="font-size:0.75rem;font-weight:600;color:var(--popover-foreground);margin-bottom:0.375rem;border-bottom:1px solid var(--border);padding-bottom:0.25rem;">
              ${esc(String(props.name || props.type || "Feature"))}
            </div>
            ${rows}
            <div style="font-size:0.75rem;color:var(--muted-foreground);margin-top:0.375rem;border-top:1px solid var(--border);padding-top:0.25rem;">
              ${coords.lng.toFixed(5)}, ${coords.lat.toFixed(5)}
            </div>
            ${askButtonHTML}
          </div>
        `
        openAskPopup(coords, popupHTML)
      } else if (e.originalEvent.shiftKey) {
        // Bare-point variant: Shift+click anywhere with no feature underneath.
        const popupHTML = `
          <div style="min-width:10rem;max-width:15rem;font-family:inherit;">
            <div style="font-size:0.75rem;font-weight:600;color:var(--popover-foreground);margin-bottom:0.25rem;">Point</div>
            <div style="font-size:0.75rem;color:var(--muted-foreground);font-variant-numeric:tabular-nums;">
              ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}
            </div>
            ${askButtonHTML}
          </div>
        `
        openAskPopup(coords, popupHTML)
      }
    })

    // Right-click anywhere → bare-point "Ask Erdfeld AI" popup (alternative to Shift+click).
    map.on('contextmenu', (e: maplibregl.MapMouseEvent) => {
      const coords = e.lngLat
      const popupHTML = `
        <div style="min-width:10rem;max-width:15rem;font-family:inherit;">
          <div style="font-size:0.75rem;font-weight:600;color:var(--popover-foreground);margin-bottom:0.25rem;">Point</div>
          <div style="font-size:0.75rem;color:var(--muted-foreground);font-variant-numeric:tabular-nums;">
            ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}
          </div>
          ${askButtonHTML}
        </div>
      `
      openAskPopup(coords, popupHTML)
    })

    // Change cursor to pointer when hovering over points
    // (maplibre 6 types `mouseenter`/`mouseleave` as layer-delegated only, so track the
    // pointer with mousemove/mouseout instead.)
    map.on('mousemove', (e) => {
      const features = map.queryRenderedFeatures(e.point)
      const hasPoints = features.some(
        (f) => f.layer.type === 'circle' && f.source.startsWith('layer-')
      )
      map.getCanvas().style.cursor = hasPoints ? 'pointer' : ''
    })

    map.on('mouseout', () => {
      map.getCanvas().style.cursor = ''
    })

    return () => {
      clearTimeout(styleTimeout)
      if (popupRef.current) {
        popupRef.current.remove()
        popupRef.current = null
      }
      if (cursorRafRef.current != null) cancelAnimationFrame(cursorRafRef.current)
      if (zoomRafRef.current != null) cancelAnimationFrame(zoomRafRef.current)
      useStore.getState().setMapSnapshotProvider(null)
      map.remove()
      mapRef.current = null
      drawControlRef.current = null
      mapReadyRef.current = false
      drawListenersSetupRef.current = false
    }
  }, [])

  // Keep the mousemove handler's visibility gate in sync with the setting
  // (the readout itself is gated by `showCoordinates` at render time).
  useEffect(() => {
    showCoordinatesRef.current = showCoordinates
  }, [showCoordinates])


  // ---- Handle map style changes -------------------------------------------
  const restoreLayersAfterStyleChange = useCallback(() => {
    const map = mapRef.current
    // NOTE: We intentionally do NOT check map.isStyleLoaded() here.
    // The `style.load` event fires when the style specification has been parsed
    // but before all source tiles have loaded. isStyleLoaded() returns false at
    // that point because source data is still loading — but adding controls and
    // layers is perfectly valid during `style.load`. The old isStyleLoaded()
    // guard caused restoreLayersAfterStyleChange to silently return early, which
    // removed the TerraDraw control and never re-added it.
    if (!map) return

    // -----------------------------------------------------------------------
    // IMPORTANT: Create a BRAND NEW MaplibreTerradrawControl after style change.
    //
    // The previous control's onRemove() destroys the internal TerraDraw instance
    // (this.terradraw = void 0) and clears modeButtons/map refs. Re-adding the
    // same control object triggers onAdd(), which creates a new TerraDraw instance
    // and DOM, BUT the old 'feature-deleted' listener registered on the control
    // object may not fire correctly because the internal event system is rebuilt.
    // Using a fresh control avoids all these issues.
    // -----------------------------------------------------------------------
    // Create a fresh control with full digitization modes
    const newDrawControl = new MaplibreTerradrawControl({
      modes: ['polygon', 'rectangle', 'circle', 'freehand', 'linestring', 'point', 'select', 'delete'],
      open: true,
    })

    // Update the ref so all other code uses the new control
    drawControlRef.current = newDrawControl

    // Add the new control to the map
    map.addControl(newDrawControl, 'bottom-left')

    // Register 'finish' handler on the new TerraDraw instance
    // Only polygon/rectangle/circle/freehand become AOI; points/lines are just drawn features
    const terraDraw = newDrawControl.getTerraDrawInstance()
    if (terraDraw) {
      terraDraw.on('finish', (id: string | number) => {
        aoiFeatureIdRef.current = id
        const result = newDrawControl.getFeatures()
        const features = result?.features as unknown as Record<string, unknown>[] | undefined
        if (features && features.length > 0) {
          const feature = features.find((f) => f.id === id)
          if (feature) {
            const props = (feature.properties ?? {}) as Record<string, unknown>
            const mode = String(props.mode ?? 'polygon')
            // Only polygon-type features (polygon, rectangle, circle, freehand) become AOI
            if (['polygon', 'rectangle', 'circle', 'freehand'].includes(mode)) {
              const aoiData = featureToAOI(feature)
              setAoi(aoiData)
            }
          }
        }
        useStore.getState().setActiveDrawMode(null)
      })
    }

    // Register 'feature-deleted' handler on the new control
    newDrawControl.on('feature-deleted', (event: { deletedIds?: (string | number)[] }) => {
      // Ignore deletion events fired by TerraDraw.stop() during a style switch
      if (isStyleChangingRef.current) return
      if (
        aoiFeatureIdRef.current &&
        event.deletedIds?.includes(aoiFeatureIdRef.current)
      ) {
        aoiFeatureIdRef.current = null
        setAoi(null)
      }
    })

    // Restore the AOI that was saved before the style switch. TerraDraw.stop() may
    // have fired feature-deleted events that cleared it from the store regardless of
    // whether the guard flag caught them.
    const savedAoi = aoiBeforeStyleChangeRef.current
    aoiBeforeStyleChangeRef.current = null
    if (savedAoi) {
      setAoi(savedAoi)
    }

    // AOI highlight layers — added first so data layers can be slotted below via beforeId
    ensureAOILayers(map)
    syncAOIHighlight(map, savedAoi ?? useStore.getState().aoi)

    // Data layers are re-inserted after the 'idle' event so that the new base style
    // tiles are fully rendered before we overlay data. This prevents a flicker where
    // the old style briefly covers the new satellite/streets tiles and the data layers.
    isStyleChangingRef.current = false
    map.once('idle', () => {
      const storeLayers = useStore.getState().layers
      for (const layer of storeLayers) {
        addMapLayer(map, layer, AOI_FILL_ID)
      }
      prevLayersRef.current = storeLayers.map((l) => ({ ...l }))

      // setStyle dropped every filter along with the layers: apply the chosen classes again.
      filteredRef.current.clear()
      const chosen = useUi.getState().classFilter
      for (const l of storeLayers) {
        if (!chosen[l.id]) continue
        applyClassFilter(map, l, chosen[l.id])
        filteredRef.current.add(l.id)
      }

      // setStyle wipes terrain / sky / projection. Re-apply from store so toggles survive.
      const s = useStore.getState()
      applyProjection(map, s.projection)
      applyTerrain(map, s.terrainEnabled, s.terrainExaggeration, AOI_FILL_ID, useUi.getState().relief, reliefTone(s.mapStyle))
      applySky(map, s.skyEnabled || s.projection === 'globe')
    })

    // If there's an active draw mode from the store, apply it to the new TerraDraw
    const currentDrawMode = useStore.getState().activeDrawMode
    if (currentDrawMode && terraDraw) {
      try {
        terraDraw.setMode(currentDrawMode)
      } catch {
        // Mode may not be available yet
      }
    }
  }, [setAoi])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return

    // Skip if style hasn't actually changed (e.g. initial mount)
    if (currentStyleRef.current === mapStyle) return

    const newStyleValue = getStyleValue(mapStyle) as string | maplibregl.StyleSpecification

    // Snapshot the current AOI so it can be unconditionally restored after the
    // style loads — TerraDraw.stop() may fire feature-deleted events that clear it.
    aoiBeforeStyleChangeRef.current = useStore.getState().aoi

    // Block feature-deleted callbacks so that TerraDraw.stop() below does not
    // clear the AOI from the store. The flag is cleared in restoreLayersAfterStyleChange.
    isStyleChangingRef.current = true

    // Stop and remove TerraDraw BEFORE calling setStyle so its requestAnimationFrame
    // loop cannot fire during the style transition and call setData on sources that
    // are being torn down by the style reload.
    const drawControl = drawControlRef.current
    if (drawControl) {
      const existingTd = drawControl.getTerraDrawInstance()
      if (existingTd) {
        try { existingTd.stop() } catch {}
      }
      try { map.removeControl(drawControl) } catch {}
    }

    const onStyleLoad = () => {
      restoreLayersAfterStyleChange()
    }

    map.once('style.load', onStyleLoad)
    currentStyleRef.current = mapStyle
    map.getContainer().style.backgroundColor = BASEMAP_GROUND[mapStyle as BasemapStyleId] ?? BASEMAP_GROUND.dark
    map.setStyle(newStyleValue, { validate: false })

    return () => {
      map.off('style.load', onStyleLoad)
    }
  }, [mapStyle, mapLoaded, restoreLayersAfterStyleChange])

  // ---- Sync AOI highlight layer ----------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return
    syncAOIHighlight(map, aoi)
  }, [aoi])

  // ---- Terrain / projection / sky (P2.2) -------------------------------
  // Each toggle is independent. They all re-apply on style.load via
  // restoreLayersAfterStyleChange, so a basemap switch can't drop them.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return
    // A basemap switch reloads the style and re-applies this in restoreLayersAfterStyleChange.
    applyTerrain(map, terrainEnabled, terrainExaggeration, AOI_FILL_ID, relief, reliefTone(useStore.getState().mapStyle))
  }, [terrainEnabled, terrainExaggeration, relief])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return
    applyProjection(map, projection)
    // Globe reads much better with the atmosphere on; pair them.
    applySky(map, skyEnabled || projection === 'globe')
  }, [projection, skyEnabled])

  // ---- Sync data layers ------------------------------------------------
  const syncLayers = useCallback(() => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return
    if (!map.isStyleLoaded()) {
      // eslint-disable-next-line react-hooks/immutability -- intentional self-recursive retry: re-run this same callback once the map style finishes loading
      map.once('idle', () => syncLayers())
      return
    }

    const prevLayers = prevLayersRef.current
    const currentIds = new Set(layers.map((l) => l.id))
    const prevIds = new Set(prevLayers.map((l) => l.id))

    // Remove layers that no longer exist in the store
    for (const prev of prevLayers) {
      if (!currentIds.has(prev.id)) {
        removeMapLayer(map, prev.id)
      }
    }

    // Add new layers and update existing ones
    for (const layer of layers) {
      if (!prevIds.has(layer.id)) {
        // Insert below the AOI fill so the AOI highlight always stays on top
        addMapLayer(map, layer, AOI_FILL_ID)
      } else {
        const prev = prevLayers.find((l) => l.id === layer.id)
        updateMapLayer(map, layer, prev)
      }
    }

    prevLayersRef.current = layers.map((l) => ({ ...l }))
  }, [layers])

  useEffect(() => {
    syncLayers()
  }, [syncLayers])

  // ---- Highlight the feature selected via chart <-> map link ------------
  const highlight = useStore((s) => s.highlight)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return
    if (!map.isStyleLoaded()) {
      const retry = () => syncHighlight(map, highlight, layers)
      map.once('idle', retry)
      return () => { map.off('idle', retry) }
    }
    syncHighlight(map, highlight, layers)
  }, [highlight, layers])

  // ---- AOI masks for raster layers flagged `aoiMask` --------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return
    if (!map.isStyleLoaded()) {
      const retry = () => syncAoiMasks(map, layers, aoi)
      map.once('idle', retry)
      return () => { map.off('idle', retry) }
    }
    syncAoiMasks(map, layers, aoi)
  }, [layers, aoi])

  // ---- Clearing the area also clears the shape TerraDraw is still holding ---
  useEffect(() => {
    if (aoi) return
    const id = aoiFeatureIdRef.current
    const td = drawControlRef.current?.getTerraDrawInstance()
    if (id == null || !td) return
    aoiFeatureIdRef.current = null
    try { td.removeFeatures([id]) } catch { /* the shape is already gone */ }
  }, [aoi])

  // ---- Class filter: show only the classes chosen in the sidebar -----------
  const classFilter = useUi((s) => s.classFilter)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return
    const apply = () => {
      for (const l of layers) {
        if (l.type !== 'geojson' || l.render === 'extrusion') continue
        const want = classFilter[l.id] ?? null
        if (!want && !filteredRef.current.has(l.id)) continue
        applyClassFilter(map, l, want)
        if (want) filteredRef.current.add(l.id)
        else filteredRef.current.delete(l.id)
      }
    }
    if (!map.isStyleLoaded()) {
      map.once('idle', apply)
      return () => { map.off('idle', apply) }
    }
    apply()
  }, [classFilter, layers])

  // ---- A clicked citation: show the layers of that result, mark them, fit them ----
  const evidenceFocus = useUi((s) => s.evidenceFocus)
  const focusResultId = evidenceFocus?.resultId ?? null
  const focusNonce = evidenceFocus?.nonce ?? 0
  useEffect(() => {
    const map = mapRef.current
    if (!focusResultId || !map || !mapReadyRef.current) return
    const { layers: current, toggleLayerVisibility, setFitBoundsTarget: fit } = useStore.getState()
    for (const l of current) if (l.resultId === focusResultId && !l.visible) toggleLayerVisibility(l.id)
    const b = resultBounds(focusResultId, current)
    if (b) fit(b)
  }, [focusNonce, focusResultId, mapLoaded])
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return
    const apply = () => syncEvidenceFocus(map, focusResultId, layers)
    if (!map.isStyleLoaded()) {
      map.once('idle', apply)
      return () => { map.off('idle', apply) }
    }
    apply()
  }, [focusResultId, focusNonce, layers])

  // ---- Requests from the sidebar and the command palette ----------------------
  useEffect(
    () =>
      onMapAction((action) => {
        if (action === 'screenshot') screenshotRef.current?.()
        else if (action === 'coordinates') coordinateInputRef.current?.()
        else if (action === 'drawing-panel') drawingPanelRef.current?.()
        else if (action === 'import') geojsonInputRef.current?.click()
      }),
    [],
  )

  // ---- Apply the drawing tool chosen in the sidebar (or the phone's draw button) ----
  // The TerraDraw control creates and starts its instance from its own buttons, which are hidden
  // behind the sidebar tools. So a chosen tool presses the matching hidden button, and the mode is
  // set directly if that did not take.
  useEffect(() => {
    const ctl = drawControlRef.current
    const map = mapRef.current
    if (!ctl || !map) return
    /** True once TerraDraw is in the wanted mode. */
    const apply = (): boolean => {
      try {
        if (!activeDrawMode) {
          const td = ctl.getTerraDrawInstance()
          if (td?.enabled) td.setMode('static')
          return true
        }
        const current = ctl.getTerraDrawInstance()
        if (current?.enabled && current.getMode() === activeDrawMode) return true
        const btn = map.getContainer().querySelector<HTMLButtonElement>(`.maplibregl-terradraw-add-${activeDrawMode}-button, .maplibregl-terradraw-${activeDrawMode}-button`)
        if (btn && !btn.classList.contains('active')) btn.click()
        const td = ctl.getTerraDrawInstance()
        if (!td) return false
        attachFinishRef.current?.(td)
        if (!td.enabled) td.start()
        if (td.getMode() !== activeDrawMode) td.setMode(activeDrawMode)
        return td.getMode() === activeDrawMode
      } catch {
        return false
      }
    }
    // A tool chosen while the map is still settling is retried once the map is idle.
    if (apply()) return
    const retry = () => {
      apply()
    }
    map.once('idle', retry)
    return () => {
      map.off('idle', retry)
    }
    // mapLoaded: a tool chosen while the map is still loading is applied once the control exists
  }, [activeDrawMode, mapLoaded])

  // ---- Handle flyToTarget from geocoding search ------------------------
  useEffect(() => {
    if (!flyToTarget) return
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return

    map.flyTo({
      center: [flyToTarget.lng, flyToTarget.lat],
      zoom: flyToTarget.zoom,
      duration: prefersReducedMotion() ? 0 : 2000,
      essential: true,
    })

    // Reset target after executing
    setFlyToTarget(null)
  }, [flyToTarget, setFlyToTarget])

  // ---- Handle fitBoundsTarget from agent zoom_to events ------------------
  useEffect(() => {
    if (!fitBoundsTarget) return
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return

    const [west, south, east, north] = fitBoundsTarget
    // The map pane stops where the panel starts, so only a little room is needed. On a phone the
    // bottom sheet covers the lower part of the map, so the fit leaves that part clear.
    const { clientWidth: w, clientHeight: h } = map.getContainer()
    const phone = w < 768
    const pad = Math.min(60, w * 0.08)
    const padding = { top: Math.min(80, h * 0.15), bottom: phone ? h * 0.42 : Math.min(80, h * 0.15), left: pad, right: pad }
    try {
      map.fitBounds([[west, south], [east, north]], {
        padding,
        duration: prefersReducedMotion() ? 0 : 1500,
        essential: true,
      })
    } catch {
      // Bounds may be degenerate for very small areas
    }
    setFitBoundsTarget(null)
  }, [fitBoundsTarget, setFitBoundsTarget, mapLoaded])

  // ---- A saved area is shown when the map is ready --------------------
  // The area restored from the last visit is on a map that starts at world zoom: go to it once.
  // (Areas drawn later are already in view, so they are not fitted.)
  useEffect(() => {
    if (!mapLoaded) return
    const { aoi: saved, layers: present, fitBoundsTarget: pending } = useStore.getState()
    const box = geometryBounds(saved?.geometry)
    if (box && present.length === 0 && !pending) setFitBoundsTarget(box)
  }, [mapLoaded, setFitBoundsTarget])

  // ---- Fit the map to what a run produced ------------------------------
  // When layers arrive (an agent run, a tool run, a restored project) the map goes to them, or to
  // the area when they carry no extent. A `zoom_to` event of the run takes precedence (it sets the
  // fit target itself), and layers that were already on the map are not fitted again.
  const seenLayerIds = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!mapLoaded) return
    const seen = (seenLayerIds.current ??= new Set())
    const fresh = layers.filter((l) => !seen.has(l.id))
    for (const l of fresh) seen.add(l.id)
    if (fresh.length === 0 || useStore.getState().fitBoundsTarget) return
    const boxes = fresh.flatMap((l) => (l.visible ? [layerBounds(l)] : [])).filter((b): b is [number, number, number, number] => !!b)
    const box = boxes.length
      ? ([Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))] as [number, number, number, number])
      : geometryBounds(aoi?.geometry)
    if (box) setFitBoundsTarget(box)
  }, [layers, mapLoaded, aoi, setFitBoundsTarget])

  // ---- Handle zoomToFeature from data table ----------------------------
  useEffect(() => {
    if (!zoomToFeature) return
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return

    const { layerId, featureIndex } = zoomToFeature
    const layer = useStore.getState().layers.find((l) => l.id === layerId)
    if (!layer || layer.type !== 'geojson' || !layer.geojson?.features) {
      setZoomToFeature(null)
      return
    }

    const feature = layer.geojson.features[featureIndex]
    if (!feature?.geometry) {
      setZoomToFeature(null)
      return
    }

    let targetLng: number | null = null
    let targetLat: number | null = null

    if (feature.geometry.type === 'Point') {
      const coords = (feature.geometry as GeoJSON.Point).coordinates
      targetLng = coords[0]
      targetLat = coords[1]
    } else if (
      feature.geometry.type === 'Polygon' ||
      feature.geometry.type === 'MultiPolygon'
    ) {
      const polyCoords =
        feature.geometry.type === 'Polygon'
          ? (feature.geometry as GeoJSON.Polygon).coordinates[0]
          : (feature.geometry as GeoJSON.MultiPolygon).coordinates[0][0]
      if (polyCoords && polyCoords.length > 0) {
        targetLng = polyCoords.reduce((s: number, c: number[]) => s + c[0], 0) / polyCoords.length
        targetLat = polyCoords.reduce((s: number, c: number[]) => s + c[1], 0) / polyCoords.length
      }
    } else if (feature.geometry.type === 'LineString') {
      const coords = (feature.geometry as GeoJSON.LineString).coordinates
      if (coords.length > 0) {
        targetLng = coords.reduce((s: number, c: number[]) => s + c[0], 0) / coords.length
        targetLat = coords.reduce((s: number, c: number[]) => s + c[1], 0) / coords.length
      }
    }

    if (targetLng !== null && targetLat !== null) {
      map.flyTo({
        center: [targetLng, targetLat],
        zoom: Math.max(map.getZoom(), 14),
        duration: prefersReducedMotion() ? 0 : 1500,
        essential: true,
      })
    }

    // Reset target after executing
    setZoomToFeature(null)
  }, [zoomToFeature, setZoomToFeature])

  // ---- Drag & Drop GeoJSON handlers --------------------------------------
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current += 1
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current -= 1
    if (dragCounterRef.current === 0) {
      setIsDragOver(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const importFiles = useCallback((files: File[]) => {
    void importVectorFiles(files, (b) => {
      const map = mapRef.current
      if (!map) return
      try {
        map.fitBounds(
          [
            [b[0], b[1]],
            [b[2], b[3]],
          ],
          { padding: 60, duration: prefersReducedMotion() ? 0 : 1500, maxZoom: 17 },
        )
      } catch {
        // ignore bounds errors
      }
    })
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)
      dragCounterRef.current = 0

      const files = Array.from(e.dataTransfer.files)
      if (files.length === 0) return
      importFiles(files)
    },
    [importFiles],
  )

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files) return
      importFiles(Array.from(files))
      // Reset input so same file can be selected again
      e.target.value = ''
    },
    [importFiles],
  )


  // ---- Render ----------------------------------------------------------
  // Everything that floats over the map is MapChrome (search, basemap, tool rail, controls, AOI card,
  // time navigation). Here: the legend and scenes chip, which sit above the AOI card, and the
  // drop zone. On a phone the bottom sheet covers the lower edge, so the bottom slots sit above
  // `--sheet-h` (set by the shell from the sheet's snap point).
  return (
    <div
      className="@container relative h-full w-full [container-type:size]"
      data-map-container
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* h-full, not inset-0: maplibre-gl.css is unlayered and sets .maplibregl-map to position: relative */}
      <div ref={mapContainer} className="h-full w-full" role="application" aria-label="Map. Use the tool rail to draw an area." />

      <MapChrome map={mapInstance} />

      <MapScreenshot map={mapInstance} screenshotRef={screenshotRef} />
      <CoordinateInputDialog coordinateInputRef={coordinateInputRef} />
      <MapCompareView mainMap={mapInstance} isActive={mapView === 'compare'} onToggle={() => setMapView('map')} />
      <MapDrawingPanel map={mapInstance} drawingPanelRef={drawingPanelRef} />
      <LocationDetails map={mapInstance} />
      <input ref={geojsonInputRef} type="file" accept={IMPORT_ACCEPT} multiple className="hidden" onChange={handleFileInput} aria-label="Import a vector file" tabIndex={-1} />

      <div className="pointer-events-none absolute bottom-[5.25rem] left-[4.5rem] [@container(max-height:35rem)]:left-[8.75rem] z-10 flex max-w-[calc(100%-6rem)] flex-col items-start gap-2 max-md:in-data-[sheet=half]:hidden max-md:in-data-[sheet=full]:hidden max-md:bottom-[calc(var(--sheet-h,4.75rem)+4.375rem)] max-md:left-2.5">
        <ScenesChip />
      </div>

      {/* Drag & drop overlay */}
      <div
        className={`absolute inset-0 z-40 flex items-center justify-center bg-scrim transition-opacity duration-200 ${
          isDragOver ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
        }`}
        aria-hidden={!isDragOver}
      >
        <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-brand-400 bg-popover px-12 py-10 text-center">
          <Upload className="size-10 text-brand-text" aria-hidden />
          <span className="font-heading text-lg font-medium text-foreground">Drop a vector file to add it to the map</span>
          <span className="text-sm text-muted-foreground">GeoJSON, zipped Shapefile, KML/KMZ, GPX, CSV</span>
        </div>
      </div>
    </div>
  )
}
