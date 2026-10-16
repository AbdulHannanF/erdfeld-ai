'use client'

import { useState } from 'react'
import { Download, Crop } from 'lucide-react'
import { toast } from 'sonner'
import { useStore, type MapLayer } from '@/store/useStore'
import { classifyAoiSize } from '@/lib/aoi-guard'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { ExportFormat } from '@/lib/vector-io'

// ---------------------------------------------------------------------------
// User vector data in and out. The heavy parsers (shpjs, jszip, proj4) are loaded on
// first use so they stay out of the initial bundle.
// ---------------------------------------------------------------------------

const loadIo = () => import('@/lib/vector-io')

/** Import files as vector layers. Reports dropped features and caveats instead of hiding them. */
export async function importVectorFiles(
  files: File[],
  onLayer?: (bounds: [number, number, number, number]) => void,
): Promise<void> {
  const io = await loadIo()
  for (const file of files) {
    try {
      const buf = await file.arrayBuffer()
      let result
      try {
        result = await io.importVectorFile(file.name, buf)
      } catch (e) {
        // CSV with x/y columns: ask for the EPSG code instead of guessing a projection.
        if (e instanceof io.VectorImportError && e.code === 'needs-epsg') {
          const answer = window.prompt(
            `${file.name}: the coordinate columns are x/y. Which EPSG code are they in? (${io.SUPPORTED_EPSG_NOTE})`,
            '32643',
          )
          const epsg = answer ? Number(answer.replace(/^epsg:/i, '').trim()) : NaN
          if (!Number.isInteger(epsg)) {
            toast.error(`${file.name} not imported`, { description: 'No EPSG code given — coordinates were not guessed.' })
            continue
          }
          result = await io.importVectorFile(file.name, buf, { epsg })
        } else throw e
      }
      const baseName = file.name.replace(/\.(geojson|json|zip|kml|kmz|gpx|csv|tsv|txt)$/i, '') || 'upload'
      const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      useStore.getState().addLayer({
        id,
        name: baseName,
        type: 'geojson',
        geojson: result.fc,
        visible: true,
        opacity: 1,
        // Addressable by the agent (style_layer / make_chart read its feature rows via the manifest).
        resultId: id,
        tool: 'user_upload',
        provenance: { source: file.name, method: `user upload (${result.format}, ${result.crs})`, clip: 'none' },
        tier: 'user-upload',
        tierLabel: 'Your uploaded file',
        resolutionM: null,
      })
      const n = result.keptCount
      const lines = [`${n} feature${n === 1 ? '' : 's'}`, ...result.warnings]
      const hasCaveat = result.warnings.length > 0
      const opts = { description: lines.join(' · '), duration: hasCaveat ? 10000 : 4000 }
      if (hasCaveat) toast.warning(`${baseName} added with caveats`, opts)
      else toast.success(`${baseName} added`, opts)
      onLayer?.(io.collectionBounds(result.fc))
    } catch (e) {
      toast.error(`${file.name} not imported`, { description: (e as Error).message })
    }
  }
}

function download(data: Uint8Array | string, filename: string, mime: string) {
  const blob = new Blob([data as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const FORMATS: Array<{ id: ExportFormat; label: string }> = [
  { id: 'geojson', label: 'GeoJSON' },
  { id: 'shapefile', label: 'Shapefile (zip)' },
  { id: 'kml', label: 'KML' },
  { id: 'csv', label: 'CSV (centroids)' },
]

/** Row actions for a vector layer: use as AOI + download menu. */
export default function VectorLayerActions({ layer }: { layer: MapLayer }) {
  const setAoi = useStore((s) => s.setAoi)
  const [open, setOpen] = useState(false)
  const fc = layer.geojson
  if (layer.type !== 'geojson' || !fc?.features?.length) return null
  const hasPolygons = fc.features.some((f) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon')

  const useAsAoi = async () => {
    try {
      const io = await loadIo()
      const c = io.aoiFromCollection(fc)
      const guard = classifyAoiSize(c.areaKm2)
      if (guard.shouldRefuse) {
        toast.error('Area too large to use as AOI', { description: `${Math.round(c.areaKm2).toLocaleString('en-US')} km². ${guard.warning ?? ''}` })
        return
      }
      setAoi({ type: 'Polygon', geometry: c.geometry, center: { lng: c.centerLonLat[0], lat: c.centerLonLat[1] } })
      const detail = [c.note ?? c.method, `${c.areaKm2 < 1 ? c.areaKm2.toFixed(3) : c.areaKm2.toFixed(1)} km²`, guard.warning].filter(Boolean).join(' · ')
      if (guard.tier === 'large') toast.warning(`${layer.name} set as AOI`, { description: detail, duration: 8000 })
      else toast.success(`${layer.name} set as AOI`, { description: detail })
    } catch (e) {
      toast.error('Cannot use as AOI', { description: (e as Error).message })
    }
  }

  const doExport = async (format: ExportFormat) => {
    setOpen(false)
    try {
      const io = await loadIo()
      const r = await io.exportVector(fc, format, layer.name)
      download(r.data, r.filename, r.mime)
      if (r.warnings.length) toast.warning(`${r.filename} exported with caveats`, { description: r.warnings.join(' · ') })
    } catch (e) {
      toast.error('Export failed', { description: (e as Error).message })
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 pl-7" data-testid="vector-layer-actions">
      {hasPolygons && (
        <button
          onClick={useAsAoi}
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-foreground/5 px-1.5 py-0.5 text-xs text-foreground transition-colors hover:bg-foreground/10"
          aria-label={`Use ${layer.name} as AOI`}
        >
          <Crop className="size-2.5" />
          Use as AOI
        </button>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-foreground/5 px-1.5 py-0.5 text-xs text-foreground transition-colors hover:bg-foreground/10"
            aria-label={`Download ${layer.name}`}
          >
            <Download className="size-2.5" />
            Download
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-40 border-border bg-card p-1 text-foreground">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              onClick={() => doExport(f.id)}
              className="block w-full rounded px-2 py-1 text-left text-xs text-foreground hover:bg-foreground/10"
            >
              {f.label}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  )
}
