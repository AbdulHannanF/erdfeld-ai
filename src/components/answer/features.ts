import type { MapLayer } from '@/store/useStore'

/** One map feature as a table row. Pure helpers for the in-panel feature list: no JSX. */
export interface FlatFeature {
  layerId: string
  layerName: string
  /** Index in the layer's GeoJSON; also the generated feature id the map highlights by. */
  featureIndex: number
  name: string
  type: string
  confidence: number | null
  lng: number | null
  lat: number | null
  coordinates: string
  properties: Record<string, unknown>
}

/** Extract a flat feature list from GeoJSON layers */
export function extractFeatures(layers: MapLayer[]): FlatFeature[] {
  const features: FlatFeature[] = []

  for (const layer of layers) {
    if (layer.type !== 'geojson' || !layer.geojson?.features) continue

    layer.geojson.features.forEach((feature, index) => {
      const props = (feature.properties ?? {}) as Record<string, unknown>

      // Name extraction
      const name =
        String(props.name ?? props.label ?? props.title ?? props.NAME ?? '') ||
        `Feature ${index + 1}`

      // Type extraction
      const type =
        String(
          props.type ??
            props.class ??
            props.category ??
            props.object_type ??
            props.feature_type ??
            ''
        ) || 'Unknown'

      // Confidence extraction
      const rawConf = props.confidence ?? props.score ?? props.probability ?? null
      const confidence =
        rawConf !== null ? parseFloat(String(rawConf)) : null

      // Coordinates
      let lng: number | null = null
      let lat: number | null = null

      if (feature.geometry) {
        if (feature.geometry.type === 'Point') {
          const coords = (feature.geometry as GeoJSON.Point).coordinates
          lng = coords[0]
          lat = coords[1]
        } else if (
          feature.geometry.type === 'Polygon' ||
          feature.geometry.type === 'MultiPolygon'
        ) {
          // Centroid approximation for polygons
          const polyCoords =
            feature.geometry.type === 'Polygon'
              ? (feature.geometry as GeoJSON.Polygon).coordinates[0]
              : (feature.geometry as GeoJSON.MultiPolygon).coordinates[0][0]
          if (polyCoords && polyCoords.length > 0) {
            lng =
              (polyCoords as number[][]).reduce((s: number, c: number[]) => s + c[0], 0) /
              polyCoords.length
            lat =
              (polyCoords as number[][]).reduce((s: number, c: number[]) => s + c[1], 0) /
              polyCoords.length
          }
        } else if (feature.geometry.type === 'LineString') {
          const coords = (feature.geometry as GeoJSON.LineString).coordinates as number[][]
          if (coords.length > 0) {
            lng = coords.reduce((s: number, c: number[]) => s + c[0], 0) / coords.length
            lat = coords.reduce((s: number, c: number[]) => s + c[1], 0) / coords.length
          }
        }
      }

      const coordinates =
        lng !== null && lat !== null
          ? `${lng.toFixed(5)}, ${lat.toFixed(5)}`
          : 'N/A'

      features.push({
        layerId: layer.id,
        layerName: layer.name,
        featureIndex: index,
        name,
        type,
        confidence:
          confidence !== null && !isNaN(confidence) ? confidence : null,
        lng,
        lat,
        coordinates,
        properties: props,
      })
    })
  }

  return features
}

/** Export features as CSV */
export function exportCSV(features: FlatFeature[]) {
  const headers = ['Layer', 'Name', 'Type', 'Confidence', 'Longitude', 'Latitude']
  const rows = features.map((f) => [
    f.layerName,
    f.name,
    f.type,
    f.confidence !== null ? f.confidence.toFixed(3) : '',
    f.lng !== null ? f.lng.toString() : '',
    f.lat !== null ? f.lat.toString() : '',
  ])

  const escape = (val: string) =>
    val.includes(',') || val.includes('"') || val.includes('\n')
      ? `"${val.replace(/"/g, '""')}"`
      : val

  const csv = [
    headers.map(escape).join(','),
    ...rows.map((row) => row.map(escape).join(',')),
  ].join('\n')

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `erdfeld-features-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}
