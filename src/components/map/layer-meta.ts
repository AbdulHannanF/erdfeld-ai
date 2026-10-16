import type { MapLayer } from '@/store/useStore'
import { colormapStops } from '@/lib/raster-style'
import { legendItems, resolveVectorStyle } from '@/lib/vector-style'

/** "Sentinel-2 L2A · 2026-10-08 · 10 m": where a layer's data came from, as one line. Parts the
 *  layer does not carry are left out, never guessed. */
export function layerSourceLine(layer: MapLayer): string {
  const parts: string[] = []
  const source = layer.provenance?.source ?? layer.raster?.sensor
  if (source) parts.push(source)
  const date = layer.provenance?.date ?? layer.raster?.datetime
  if (date) parts.push(String(date).slice(0, 10))
  if (layer.resolutionM != null) parts.push(`${layer.resolutionM} m`)
  return parts.join(' · ')
}

/** A few colours that show what a layer's legend holds: class colours, or a ramp sampled at
 *  its ends and middle. Empty when the layer has no legend. */
export function layerSwatches(layer: MapLayer, max = 5): string[] {
  if (layer.vectorStyle) {
    const r = resolveVectorStyle(layer.vectorStyle, layer.geojson)
    if (r.ok) return legendItems(r.value).map((i) => i.color).slice(0, max)
  }
  const palette = layer.palette
  if (palette?.kind === 'classes') return palette.classes.map((c) => c.color).slice(0, max)
  if (palette?.kind === 'gradient') return spread(palette.stops.map((s) => s.color), max)
  const raster = layer.raster
  if (raster?.kind === 'categorical' && raster.classes) return raster.classes.map((c) => c.color).slice(0, max)
  if (raster?.kind === 'continuous') return spread(colormapStops(raster.colormap) ?? [], max)
  return []
}

function spread(colors: string[], n: number): string[] {
  if (colors.length <= n) return colors
  return Array.from({ length: n }, (_, i) => colors[Math.round((i * (colors.length - 1)) / (n - 1))])
}
