'use client'

import { DRAWN_SHAPE_COLOR } from '@/lib/map-colors'
import { useState, useCallback, useEffect, useRef } from 'react'
import * as maplibregl from '@/lib/maplibre'
import {
  PenTool, X, Circle, Square, Route, FileUp,
  Trash2, Layers, MapPin,
} from 'lucide-react'
import { useStore, type AOI, type MapLayer } from '@/store/useStore'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate circle polygon from center + radius in km */
function generateCirclePolygon(
  center: { lng: number; lat: number },
  radiusKm: number,
  segments = 64,
): GeoJSON.Polygon {
  const R = 6371
  const coords: number[][] = []
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * 2 * Math.PI
    const dLat = (radiusKm * Math.cos(angle)) / R
    const dLng =
      (radiusKm * Math.sin(angle)) /
      (R * Math.cos((center.lat * Math.PI) / 180))
    coords.push([
      center.lng + (dLng * 180) / Math.PI,
      center.lat + (dLat * 180) / Math.PI,
    ])
  }
  return { type: 'Polygon', coordinates: [coords] }
}

/** Generate rectangle polygon from bounds */
function generateRectanglePolygon(
  north: number,
  south: number,
  east: number,
  west: number,
): GeoJSON.Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [west, north],
        [east, north],
        [east, south],
        [west, south],
        [west, north],
      ],
    ],
  }
}

/** Compute centroid of polygon */
function computeCentroid(geometry: GeoJSON.Polygon): { lng: number; lat: number } {
  const coords = geometry.coordinates[0]
  const sumLng = coords.reduce((s, c) => s + c[0], 0)
  const sumLat = coords.reduce((s, c) => s + c[1], 0)
  return { lng: sumLng / coords.length, lat: sumLat / coords.length }
}

/** Parse coordinate pairs from text input */
function parseCoordinatePairs(text: string): [number, number][] {
  const pairs: [number, number][] = []

  // Try JSON format first: [[lng, lat], [lng, lat], ...]
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (Array.isArray(item) && item.length >= 2) {
          const lng = Number(item[0])
          const lat = Number(item[1])
          if (!isNaN(lng) && !isNaN(lat)) {
            pairs.push([lng, lat])
          }
        }
      }
      if (pairs.length > 0) return pairs
    }
  } catch {
    // Not JSON, try other formats
  }

  // Try "lat, lng" or "lat lng" per line
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  for (const line of lines) {
    // Try various separators
    const parts = line.split(/[,\s\t]+/).map((s) => s.trim()).filter(Boolean)
    if (parts.length >= 2) {
      const lat = Number(parts[0])
      const lng = Number(parts[1])
      if (!isNaN(lng) && !isNaN(lat)) {
        pairs.push([lng, lat])
      }
    }
  }

  return pairs
}

/** Parse GeoJSON from text */
function parseGeoJSON(text: string): GeoJSON.FeatureCollection | null {
  try {
    const parsed = JSON.parse(text)
    if (parsed.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
      return parsed as GeoJSON.FeatureCollection
    }
    if (parsed.type === 'Feature' && parsed.geometry) {
      return {
        type: 'FeatureCollection',
        features: [parsed as GeoJSON.Feature],
      }
    }
    if (parsed.type && parsed.coordinates) {
      // Raw geometry
      return {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: {}, geometry: parsed as GeoJSON.Geometry },
        ],
      }
    }
  } catch {
    // Not valid JSON
  }
  return null
}

// ---------------------------------------------------------------------------
// Map layer constants for drawn shapes
// ---------------------------------------------------------------------------

const DRAWN_SHAPES_SOURCE_ID = 'drawn-shapes-source'
const DRAWN_SHAPES_FILL_ID = 'drawn-shapes-fill'
const DRAWN_SHAPES_LINE_ID = 'drawn-shapes-line'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface MapDrawingPanelProps {
  map: maplibregl.Map | null
  drawingPanelRef?: React.MutableRefObject<(() => void) | null>
}

interface DrawnShape {
  id: string
  name: string
  type: 'circle' | 'rectangle' | 'line' | 'import'
  geometry: GeoJSON.Geometry
  addedAsAoi: boolean
  addedAsLayer: boolean
}

export default function MapDrawingPanel({ map, drawingPanelRef }: MapDrawingPanelProps) {
  const setAoi = useStore((s) => s.setAoi)
  const addLayer = useStore((s) => s.addLayer)

  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState('import')
  const [drawnShapes, setDrawnShapes] = useState<DrawnShape[]>([])

  // Import tab state
  const [importText, setImportText] = useState('')
  const [importType, setImportType] = useState<'coordinates' | 'geojson'>('coordinates')

  // Circle tab state
  const [circleLat, setCircleLat] = useState('')
  const [circleLng, setCircleLng] = useState('')
  const [circleRadius, setCircleRadius] = useState('1')

  // Rectangle tab state
  const [rectNorth, setRectNorth] = useState('')
  const [rectSouth, setRectSouth] = useState('')
  const [rectEast, setRectEast] = useState('')
  const [rectWest, setRectWest] = useState('')

  // Line tab state
  const [linePoints, setLinePoints] = useState('')
  const [lineClose, setLineClose] = useState(false)

  // Add-as mode
  const [addAs, setAddAs] = useState<'aoi' | 'layer'>('layer')

  // Ref for the GeoJSON source data
  const drawnShapesDataRef = useRef<GeoJSON.FeatureCollection>({
    type: 'FeatureCollection',
    features: [],
  })

  // ---- Expose open via ref for toolbar integration ----
  useEffect(() => {
    if (drawingPanelRef) {
      drawingPanelRef.current = () => setOpen(true)
    }
  }, [drawingPanelRef])

  // ---- Sync drawn shapes to map ----
  const syncDrawnShapesToMap = useCallback(() => {
    if (!map) return
    // Guard: map style must be fully loaded before modifying sources/layers
    if (!map.isStyleLoaded()) return

    // Ensure source exists
    if (!map.getSource(DRAWN_SHAPES_SOURCE_ID)) {
      map.addSource(DRAWN_SHAPES_SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })

      map.addLayer({
        id: DRAWN_SHAPES_FILL_ID,
        type: 'fill',
        source: DRAWN_SHAPES_SOURCE_ID,
        paint: {
          'fill-color': DRAWN_SHAPE_COLOR,
          'fill-opacity': 0.15,
        },
      })

      map.addLayer({
        id: DRAWN_SHAPES_LINE_ID,
        type: 'line',
        source: DRAWN_SHAPES_SOURCE_ID,
        paint: {
          'line-color': DRAWN_SHAPE_COLOR,
          'line-width': 2,
          'line-opacity': 0.8,
          'line-dasharray': [4, 2],
        },
      })
    }

    // Build features from drawn shapes
    const features: GeoJSON.Feature[] = drawnShapes
      .filter((s) => !s.addedAsLayer) // Only show non-layer shapes on map preview
      .map((shape) => ({
        type: 'Feature' as const,
        properties: {
          name: shape.name,
          shapeType: shape.type,
        },
        geometry: shape.geometry,
      }))

    drawnShapesDataRef.current = {
      type: 'FeatureCollection',
      features,
    }

    const source = map.getSource(DRAWN_SHAPES_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
    if (source) {
      source.setData(drawnShapesDataRef.current)
    }
  }, [map, drawnShapes])

  useEffect(() => {
    syncDrawnShapesToMap()
    // Retry when style finishes loading (in case map.isStyleLoaded() was false)
    if (map && !map.isStyleLoaded()) {
      map.once('style.load', syncDrawnShapesToMap)
      return () => { map.off('style.load', syncDrawnShapesToMap) }
    }
  }, [syncDrawnShapesToMap, map])

  // ---- Cleanup on unmount ----
  useEffect(() => {
    return () => {
      if (!map) return
      try {
        if (map.getLayer(DRAWN_SHAPES_LINE_ID)) map.removeLayer(DRAWN_SHAPES_LINE_ID)
        if (map.getLayer(DRAWN_SHAPES_FILL_ID)) map.removeLayer(DRAWN_SHAPES_FILL_ID)
        if (map.getSource(DRAWN_SHAPES_SOURCE_ID)) map.removeSource(DRAWN_SHAPES_SOURCE_ID)
      } catch { /* ignore */ }
    }
  }, [map])

  // ---- Add shape to drawn shapes ----
  const addShape = useCallback(
    (shape: Omit<DrawnShape, 'id'>) => {
      const id = `drawn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      const newShape: DrawnShape = { ...shape, id }

      if (addAs === 'aoi') {
        // Set as AOI
        if (shape.geometry.type === 'Polygon') {
          const poly = shape.geometry as GeoJSON.Polygon
          const center = computeCentroid(poly)
          let radiusKm: number | undefined
          if (shape.type === 'circle') {
            radiusKm = parseFloat(circleRadius) || undefined
          }
          const aoi: AOI = {
            type: shape.type === 'circle' ? 'Circle' : shape.type === 'rectangle' ? 'Rectangle' : 'Polygon',
            geometry: shape.geometry,
            center,
            radiusKm,
          }
          setAoi(aoi)
          toast.success('Shape set as AOI', { description: shape.name })
        } else {
          toast.error('Only polygon shapes can be set as AOI')
          return
        }
        newShape.addedAsAoi = true
      } else {
        // Add as layer
        const geojson: GeoJSON.FeatureCollection = {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { name: shape.name, color: DRAWN_SHAPE_COLOR },
              geometry: shape.geometry,
            },
          ],
        }

        addLayer({
          id,
          name: shape.name,
          type: 'geojson',
          geojson,
          visible: true,
          opacity: 1,
          color: DRAWN_SHAPE_COLOR,
        })
        newShape.addedAsLayer = true
        toast.success('Shape added as layer', { description: shape.name })
      }

      setDrawnShapes((prev) => [...prev, newShape])

      // Fit map to shape
      if (map) {
        try {
          const bounds = new maplibregl.LngLatBounds()
          const geometry = shape.geometry
          if (geometry.type === 'Polygon') {
            ;(geometry as GeoJSON.Polygon).coordinates[0]?.forEach((c) =>
              bounds.extend(c as [number, number]),
            )
          } else if (geometry.type === 'LineString') {
            ;(geometry as GeoJSON.LineString).coordinates.forEach((c) =>
              bounds.extend(c as [number, number]),
            )
          } else if (geometry.type === 'Point') {
            const coords = (geometry as GeoJSON.Point).coordinates
            bounds.extend([coords[0], coords[1]] as [number, number])
          }
          if (!bounds.isEmpty()) {
            map.fitBounds(bounds, { padding: 60, duration: 1000 })
          }
        } catch { /* ignore */ }
      }
    },
    [addAs, setAoi, addLayer, map, circleRadius],
  )

  // ---- Clear all drawn shapes ----
  const clearAllShapes = useCallback(() => {
    setDrawnShapes([])
    toast.success('All drawn shapes cleared')
  }, [])

  // ---- Remove single shape ----
  const removeShape = useCallback(
    (id: string) => {
      setDrawnShapes((prev) => prev.filter((s) => s.id !== id))
      // If it was added as a layer, remove from store
      const shape = drawnShapes.find((s) => s.id === id)
      if (shape?.addedAsLayer) {
        const { removeLayer } = useStore.getState()
        removeLayer(id)
      }
    },
    [drawnShapes],
  )

  // ---- Import Coordinates Handler ----
  const handleImport = useCallback(() => {
    if (!importText.trim()) {
      toast.error('No input provided')
      return
    }

    if (importType === 'geojson') {
      const geojson = parseGeoJSON(importText)
      if (!geojson) {
        toast.error('Invalid GeoJSON', { description: 'Paste valid GeoJSON FeatureCollection, Feature, or Geometry' })
        return
      }

      for (const feature of geojson.features) {
        if (!feature.geometry) continue
        addShape({
          name: `Imported ${feature.geometry.type}`,
          type: 'import',
          geometry: feature.geometry,
          addedAsAoi: false,
          addedAsLayer: false,
        })
      }
      setImportText('')
    } else {
      // Parse coordinate pairs
      const pairs = parseCoordinatePairs(importText)
      if (pairs.length === 0) {
        toast.error('No valid coordinates found', { description: 'Use "lat, lng" per line or JSON [[lng, lat], ...]' })
        return
      }

      if (pairs.length === 1) {
        // Single point
        addShape({
          name: `Point (${pairs[0][1].toFixed(4)}, ${pairs[0][0].toFixed(4)})`,
          type: 'import',
          geometry: { type: 'Point', coordinates: pairs[0] },
          addedAsAoi: false,
          addedAsLayer: false,
        })
      } else {
        // Create a polygon or line from points
        const lineGeometry: GeoJSON.LineString = {
          type: 'LineString',
          coordinates: pairs,
        }
        addShape({
          name: `Line (${pairs.length} points)`,
          type: 'line',
          geometry: lineGeometry,
          addedAsAoi: false,
          addedAsLayer: false,
        })
      }
      setImportText('')
    }
  }, [importText, importType, addShape])

  // ---- Circle Handler ----
  const handleDrawCircle = useCallback(() => {
    const lat = parseFloat(circleLat)
    const lng = parseFloat(circleLng)
    const radius = parseFloat(circleRadius)

    if (isNaN(lat) || isNaN(lng)) {
      toast.error('Invalid coordinates', { description: 'Enter valid latitude and longitude' })
      return
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      toast.error('Coordinates out of range', { description: 'Lat: -90 to 90, Lng: -180 to 180' })
      return
    }
    if (isNaN(radius) || radius <= 0) {
      toast.error('Invalid radius', { description: 'Enter a positive number in kilometers' })
      return
    }

    const center = { lng, lat }
    const geometry = generateCirclePolygon(center, radius)

    addShape({
      name: `Circle (${lat.toFixed(4)}, ${lng.toFixed(4)}) r=${radius}km`,
      type: 'circle',
      geometry,
      addedAsAoi: false,
      addedAsLayer: false,
    })

    // Clear inputs
    setCircleLat('')
    setCircleLng('')
    setCircleRadius('1')
  }, [circleLat, circleLng, circleRadius, addShape])

  // ---- Rectangle Handler ----
  const handleDrawRectangle = useCallback(() => {
    const n = parseFloat(rectNorth)
    const s = parseFloat(rectSouth)
    const e = parseFloat(rectEast)
    const w = parseFloat(rectWest)

    if ([n, s, e, w].some(isNaN)) {
      toast.error('Invalid bounds', { description: 'Enter valid N/S/E/W values' })
      return
    }
    if (n <= s) {
      toast.error('North must be greater than South')
      return
    }
    if (n < -90 || n > 90 || s < -90 || s > 90) {
      toast.error('Latitude out of range', { description: 'Must be -90 to 90' })
      return
    }
    if (e < -180 || e > 180 || w < -180 || w > 180) {
      toast.error('Longitude out of range', { description: 'Must be -180 to 180' })
      return
    }

    const geometry = generateRectanglePolygon(n, s, e, w)

    addShape({
      name: `Rectangle (${n.toFixed(2)}°N, ${s.toFixed(2)}°S, ${e.toFixed(2)}°E, ${w.toFixed(2)}°W)`,
      type: 'rectangle',
      geometry,
      addedAsAoi: false,
      addedAsLayer: false,
    })

    setRectNorth('')
    setRectSouth('')
    setRectEast('')
    setRectWest('')
  }, [rectNorth, rectSouth, rectEast, rectWest, addShape])

  // ---- Line Handler ----
  const handleDrawLine = useCallback(() => {
    const pairs = parseCoordinatePairs(linePoints)
    if (pairs.length < 2) {
      toast.error('Need at least 2 points', { description: 'Enter coordinates as "lat, lng" per line' })
      return
    }

    if (lineClose && pairs.length >= 3) {
      // Close the line into a polygon
      const closedCoords = [...pairs, pairs[0]]
      const geometry: GeoJSON.Polygon = {
        type: 'Polygon',
        coordinates: [closedCoords],
      }
      addShape({
        name: `Polygon (${pairs.length} vertices)`,
        type: 'import',
        geometry,
        addedAsAoi: false,
        addedAsLayer: false,
      })
    } else {
      const geometry: GeoJSON.LineString = {
        type: 'LineString',
        coordinates: pairs,
      }
      addShape({
        name: `Line (${pairs.length} points)`,
        type: 'line',
        geometry,
        addedAsAoi: false,
        addedAsLayer: false,
      })
    }

    setLinePoints('')
  }, [linePoints, lineClose, addShape])

  const handleClose = useCallback(() => {
    setOpen(false)
  }, [])

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        className="w-[25rem] sm:max-w-[25rem] bg-card/95 border-l border-border text-foreground p-0"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <PenTool className="h-5 w-5 text-brand-text" />
            <SheetTitle>Drawing Panel</SheetTitle>
          </div>
          <button
            onClick={handleClose}
            className="btn btn-ghost btn-icon-sm"
            title="Close"
          >
            <X />
          </button>
        </div>

        {/* Add-as selector */}
        <div className="px-4 pt-3 pb-2">
          <div className="flex items-center justify-between">
            <span className="text-caption text-muted-foreground">Add shapes as:</span>
            <Select value={addAs} onValueChange={(v) => setAddAs(v as 'aoi' | 'layer')}>
              <SelectTrigger className="w-[8.75rem] h-7 text-caption bg-muted/80 border-border text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-muted border-border">
                <SelectItem value="layer" className="text-foreground text-caption focus:bg-brand-500/20 focus:text-brand-text">
                  <div className="flex items-center gap-1.5">
                    <Layers className="h-3 w-3" />
                    Map Layer
                  </div>
                </SelectItem>
                <SelectItem value="aoi" className="text-foreground text-caption focus:bg-brand-500/20 focus:text-brand-text">
                  <div className="flex items-center gap-1.5">
                    <MapPin className="h-3 w-3" />
                    AOI (Area of Interest)
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
          <div className="px-4">
            <TabsList className="w-full bg-muted/80 border border-border">
              <TabsTrigger value="import" className="flex-1 text-caption data-[state=active]:bg-primary/20 data-[state=active]:text-brand-text">
                <FileUp className="h-3 w-3 mr-1" />
                Import
              </TabsTrigger>
              <TabsTrigger value="circle" className="flex-1 text-caption data-[state=active]:bg-primary/20 data-[state=active]:text-brand-text">
                <Circle className="h-3 w-3 mr-1" />
                Circle
              </TabsTrigger>
              <TabsTrigger value="rectangle" className="flex-1 text-caption data-[state=active]:bg-primary/20 data-[state=active]:text-brand-text">
                <Square className="h-3 w-3 mr-1" />
                Rect
              </TabsTrigger>
              <TabsTrigger value="line" className="flex-1 text-caption data-[state=active]:bg-primary/20 data-[state=active]:text-brand-text">
                <Route className="h-3 w-3 mr-1" />
                Line
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Import Tab */}
          <TabsContent value="import" className="px-4 py-4 flex-1 overflow-y-auto scrollbar-thin">
            <div className="space-y-4">
              {/* Import type toggle */}
              <div className="flex gap-2">
                <Button
                  variant={importType === 'coordinates' ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setImportType('coordinates')}
                  className="flex-1"
                >
                  Coordinates
                </Button>
                <Button
                  variant={importType === 'geojson' ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setImportType('geojson')}
                  className="flex-1"
                >
                  GeoJSON
                </Button>
              </div>

              {/* Text input */}
              <div className="space-y-2">
                <Label className="text-caption-strong text-muted-foreground">
                  {importType === 'coordinates'
                    ? 'Paste coordinates (lat, lng per line)'
                    : 'Paste GeoJSON'}
                </Label>
                <Textarea
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder={
                    importType === 'coordinates'
                      ? '48.8566, 2.3522\n51.5074, -0.1278\n40.7128, -74.0060'
                      : '{"type":"FeatureCollection","features":[...]}'
                  }
                  className="bg-muted/80 border-border text-foreground placeholder:text-muted-foreground focus-visible:ring-primary/40 focus-visible:border-primary/40 min-h-[10rem] text-data"
                />
              </div>

              {/* Import button */}
              <Button
                onClick={handleImport}
                disabled={!importText.trim()}
                className="w-full"
              >
                <FileUp className="h-4 w-4 mr-2" />
                Import & Draw
              </Button>

              {/* Help text */}
              <div className="rounded-lg bg-foreground/[0.03] border border-border p-3 space-y-1.5">
                <p className="text-muted-foreground text-label">Supported Formats</p>
                {importType === 'coordinates' ? (
                  <ul className="text-caption text-muted-foreground space-y-1">
                    <li>&#8226; One &quot;lat, lng&quot; pair per line</li>
                    <li>&#8226; Multiple pairs create a line/polyline</li>
                    <li>&#8226; JSON: [[lng, lat], [lng, lat]]</li>
                    <li>&#8226; Single point creates a marker</li>
                  </ul>
                ) : (
                  <ul className="text-caption text-muted-foreground space-y-1">
                    <li>&#8226; FeatureCollection</li>
                    <li>&#8226; Single Feature</li>
                    <li>&#8226; Raw Geometry object</li>
                  </ul>
                )}
              </div>
            </div>
          </TabsContent>

          {/* Circle Tab */}
          <TabsContent value="circle" className="px-4 py-4 flex-1 overflow-y-auto scrollbar-thin">
            <div className="space-y-4">
              {/* Center coordinates */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-caption-strong text-muted-foreground">Latitude</Label>
                  <Input
                    type="number"
                    step="any"
                    min={-90}
                    max={90}
                    value={circleLat}
                    onChange={(e) => setCircleLat(e.target.value)}
                    className="bg-muted/80 border-border text-foreground placeholder:text-muted-foreground focus-visible:ring-primary/40 focus-visible:border-primary/40"
                    placeholder="48.8566"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-caption-strong text-muted-foreground">Longitude</Label>
                  <Input
                    type="number"
                    step="any"
                    min={-180}
                    max={180}
                    value={circleLng}
                    onChange={(e) => setCircleLng(e.target.value)}
                    className="bg-muted/80 border-border text-foreground placeholder:text-muted-foreground focus-visible:ring-primary/40 focus-visible:border-primary/40"
                    placeholder="2.3522"
                  />
                </div>
              </div>

              {/* Radius */}
              <div className="space-y-1.5">
                <Label className="text-caption-strong text-muted-foreground">Radius (kilometers)</Label>
                <Input
                  type="number"
                  step="any"
                  min={0.001}
                  value={circleRadius}
                  onChange={(e) => setCircleRadius(e.target.value)}
                  className="bg-muted/80 border-border text-foreground placeholder:text-muted-foreground focus-visible:ring-primary/40 focus-visible:border-primary/40"
                  placeholder="1"
                />
              </div>

              {/* Draw button */}
              <Button
                onClick={handleDrawCircle}
                disabled={!circleLat || !circleLng || !circleRadius}
                className="w-full"
              >
                <Circle className="h-4 w-4 mr-2" />
                Draw Circle
              </Button>

              {/* Presets */}
              <div className="rounded-lg bg-foreground/[0.03] border border-border p-3 space-y-2">
                <p className="text-muted-foreground text-label">Quick Presets</p>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { name: 'Paris', lat: '48.8566', lng: '2.3522', r: '5' },
                    { name: 'London', lat: '51.5074', lng: '-0.1278', r: '10' },
                    { name: 'New York', lat: '40.7128', lng: '-74.006', r: '15' },
                    { name: 'Tokyo', lat: '35.6762', lng: '139.6503', r: '20' },
                  ].map((preset) => (
                    <button
                      key={preset.name}
                      onClick={() => {
                        setCircleLat(preset.lat)
                        setCircleLng(preset.lng)
                        setCircleRadius(preset.r)
                      }}
                      className="chip"
                    >
                      {preset.name} ({preset.r}km)
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </TabsContent>

          {/* Rectangle Tab */}
          <TabsContent value="rectangle" className="px-4 py-4 flex-1 overflow-y-auto scrollbar-thin">
            <div className="space-y-4">
              {/* Bounds inputs */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-caption-strong text-muted-foreground">North (max lat)</Label>
                  <Input
                    type="number"
                    step="any"
                    min={-90}
                    max={90}
                    value={rectNorth}
                    onChange={(e) => setRectNorth(e.target.value)}
                    className="bg-muted/80 border-border text-foreground placeholder:text-muted-foreground focus-visible:ring-primary/40 focus-visible:border-primary/40"
                    placeholder="49.0"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-caption-strong text-muted-foreground">South (min lat)</Label>
                  <Input
                    type="number"
                    step="any"
                    min={-90}
                    max={90}
                    value={rectSouth}
                    onChange={(e) => setRectSouth(e.target.value)}
                    className="bg-muted/80 border-border text-foreground placeholder:text-muted-foreground focus-visible:ring-primary/40 focus-visible:border-primary/40"
                    placeholder="48.7"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-caption-strong text-muted-foreground">East (max lng)</Label>
                  <Input
                    type="number"
                    step="any"
                    min={-180}
                    max={180}
                    value={rectEast}
                    onChange={(e) => setRectEast(e.target.value)}
                    className="bg-muted/80 border-border text-foreground placeholder:text-muted-foreground focus-visible:ring-primary/40 focus-visible:border-primary/40"
                    placeholder="2.5"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-caption-strong text-muted-foreground">West (min lng)</Label>
                  <Input
                    type="number"
                    step="any"
                    min={-180}
                    max={180}
                    value={rectWest}
                    onChange={(e) => setRectWest(e.target.value)}
                    className="bg-muted/80 border-border text-foreground placeholder:text-muted-foreground focus-visible:ring-primary/40 focus-visible:border-primary/40"
                    placeholder="2.1"
                  />
                </div>
              </div>

              {/* Draw button */}
              <Button
                onClick={handleDrawRectangle}
                disabled={!rectNorth || !rectSouth || !rectEast || !rectWest}
                className="w-full"
              >
                <Square className="h-4 w-4 mr-2" />
                Draw Rectangle
              </Button>

              {/* Presets */}
              <div className="rounded-lg bg-foreground/[0.03] border border-border p-3 space-y-2">
                <p className="text-muted-foreground text-label">Quick Presets</p>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { name: 'Paris', n: '48.95', s: '48.75', e: '2.45', w: '2.15' },
                    { name: 'London', n: '51.65', s: '51.35', e: '0.15', w: '-0.45' },
                    { name: 'Manhattan', n: '40.82', s: '40.70', e: '-73.93', w: '-74.02' },
                    { name: 'Dubai', n: '25.30', s: '25.10', e: '55.40', w: '55.15' },
                  ].map((preset) => (
                    <button
                      key={preset.name}
                      onClick={() => {
                        setRectNorth(preset.n)
                        setRectSouth(preset.s)
                        setRectEast(preset.e)
                        setRectWest(preset.w)
                      }}
                      className="chip"
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </TabsContent>

          {/* Line Tab */}
          <TabsContent value="line" className="px-4 py-4 flex-1 overflow-y-auto scrollbar-thin">
            <div className="space-y-4">
              {/* Points input */}
              <div className="space-y-2">
                <Label className="text-caption-strong text-muted-foreground">
                  Coordinate pairs (lat, lng per line)
                </Label>
                <Textarea
                  value={linePoints}
                  onChange={(e) => setLinePoints(e.target.value)}
                  placeholder={'48.8566, 2.3522\n48.8648, 2.3514\n48.8721, 2.3497'}
                  className="bg-muted/80 border-border text-foreground placeholder:text-muted-foreground focus-visible:ring-primary/40 focus-visible:border-primary/40 min-h-[8.75rem] text-data"
                />
              </div>

              {/* Close polygon toggle */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setLineClose(!lineClose)}
                  aria-pressed={lineClose}
                  className="chip"
                >
                  <Square aria-hidden />
                  Close as polygon
                </button>
              </div>

              {/* Draw button */}
              <Button
                onClick={handleDrawLine}
                disabled={!linePoints.trim()}
                className="w-full"
              >
                <Route className="h-4 w-4 mr-2" />
                {lineClose ? 'Draw Polygon' : 'Draw Line'}
              </Button>

              {/* Presets */}
              <div className="rounded-lg bg-foreground/[0.03] border border-border p-3 space-y-2">
                <p className="text-muted-foreground text-label">Quick Presets</p>
                <div className="grid grid-cols-1 gap-2">
                  {[
                    {
                      name: 'Seine River (Paris)',
                      points: '48.8500, 2.2850\n48.8540, 2.3050\n48.8560, 2.3250\n48.8620, 2.3450\n48.8690, 2.3550\n48.8770, 2.3650',
                    },
                    {
                      name: 'Central Park (NYC)',
                      points: '40.7970, -73.9630\n40.7850, -73.9600\n40.7720, -73.9660\n40.7640, -73.9730',
                    },
                  ].map((preset) => (
                    <button
                      key={preset.name}
                      onClick={() => setLinePoints(preset.points)}
                      className="chip"
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        {/* Drawn shapes list */}
        {drawnShapes.length > 0 && (
          <div className="border-t border-border px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-caption-strong text-muted-foreground">
                Drawn Shapes ({drawnShapes.length})
              </span>
              <button
                onClick={clearAllShapes}
                className="btn btn-ghost btn-sm"
              >
                <Trash2 />
                Clear All
              </button>
            </div>
            <div className="space-y-1.5 max-h-40 overflow-y-auto scrollbar-thin">
              {drawnShapes.map((shape) => (
                <div
                  key={shape.id}
                  className="flex items-center justify-between px-2.5 py-1.5 rounded-md bg-foreground/[0.03] border border-border group"
                >
                  <div className="flex items-center gap-2">
                    {shape.type === 'circle' && <Circle className="h-3 w-3 text-brand-text" />}
                    {shape.type === 'rectangle' && <Square className="h-3 w-3 text-brand-text" />}
                    {shape.type === 'line' && <Route className="h-3 w-3 text-brand-text" />}
                    {shape.type === 'import' && <FileUp className="h-3 w-3 text-brand-text" />}
                    <span className="text-caption text-muted-foreground truncate max-w-[12.5rem]">{shape.name}</span>
                    {shape.addedAsAoi && (
                      <Badge variant="accent">
                        AOI
                      </Badge>
                    )}
                    {shape.addedAsLayer && (
                      <Badge variant="info">
                        Layer
                      </Badge>
                    )}
                  </div>
                  <button
                    onClick={() => removeShape(shape.id)}
                    className="btn btn-ghost btn-icon-sm opacity-0 group-hover:opacity-100"
                  >
                    <X />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
