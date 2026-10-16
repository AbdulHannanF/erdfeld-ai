'use client'

import { useMapReadout, scaleDenominator } from '@/store/useMapReadout'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { HealthDot } from '@/components/shell/HealthDot'

const lat = (v: number) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? 'N' : 'S'}`
const lng = (v: number) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? 'E' : 'W'}`

/** The 28px status bar: service state, the cursor's coordinates, zoom, the map scale and the export
 *  CRS (which opens the CRS dialog). All values come from the map itself. The scale is approximate
 *  (it assumes a 96 dpi screen) and says so. */
export default function StatusBar() {
  const cursor = useMapReadout((s) => s.cursor)
  const zoom = useMapReadout((s) => s.zoom)
  const center = useMapReadout((s) => s.center)
  const showCoordinates = useStore((s) => s.settings.showCoordinates)
  const showZoom = useStore((s) => s.settings.showZoomLevel)
  const isLoading = useStore((s) => s.isLoading)
  const stage = useStore((s) => s.analysisStage)
  const exportCrs = useUi((s) => s.exportCrs)
  const openDialog = useUi((s) => s.openDialog)
  const at = cursor ?? center
  const message = isLoading ? `Working · ${stage.replace(/_/g, ' ')}` : 'Open data · sources shown with every result'

  return (
    <footer aria-label="Map status" className="flex h-7 items-center justify-between gap-2.5 whitespace-nowrap bg-sidebar px-2.5 font-mono text-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex items-center gap-1.5" role="status" aria-live="polite"><HealthDot className="size-auto" /><span className="truncate max-md:hidden" data-testid="status-message">{message}</span></span>
        {showCoordinates && at && <span className="max-md:hidden" data-testid="cursor-coords" title={cursor ? 'Cursor position' : 'Map centre'}>{lat(at.lat)} · {lng(at.lng)}</span>}
        {showZoom && zoom != null && <span>Zoom <span data-testid="map-zoom" className="text-foreground">{zoom.toFixed(1)}</span></span>}
      </div>
      <div className="flex items-center gap-3">
        {zoom != null && center && <span className="max-md:hidden" title="Approximate: assumes a 96 dpi screen">Scale ≈ 1:{scaleDenominator(center.lat, zoom).toLocaleString('en-US')}</span>}
        <button type="button" onClick={() => openDialog('crs')} aria-label={`Output CRS for vector export: ${exportCrs}. Change`} title="Output CRS for vector export" className="rounded px-1 text-secondary-foreground hover:bg-hover hover:text-foreground" data-testid="crs-button">
          {exportCrs}
        </button>
      </div>
    </footer>
  )
}
