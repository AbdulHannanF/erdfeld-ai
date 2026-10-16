'use client'

import { Compass, Database, Globe2, Image as ImageIcon, Leaf, Loader2, Map as MapIcon, Mountain, Shield, Upload } from 'lucide-react'
import { Callout, WbDialog } from '@/components/shell/WbDialog'
import { BTN } from '@/components/shell/ui'
import { useQuickLayer } from '@/hooks/useQuickLayer'
import { QUICK_LAYERS, type QuickLayerId } from '@/lib/quick-layers'
import { requestMapAction } from '@/lib/ui-events'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { cn } from '@/lib/utils'

const QUICK: Record<QuickLayerId, { icon: typeof Leaf; detail: string }> = {
  true_colour: { icon: ImageIcon, detail: 'Sentinel-2 · 10 m · no model call' },
  ndvi: { icon: Leaf, detail: 'Vegetation vigour · no model call' },
  elevation: { icon: Mountain, detail: 'Copernicus DEM · no model call' },
}

const option = 'option-card'

/** Add data: every way data enters the workspace that the app really has. Vector files are read in
 *  the browser, the catalog searches the offline registry, OSM and the quick layers run on the drawn
 *  area. Sources the app cannot read (databases, WMS) are not listed. */
export default function AddDataDialog() {
  const open = useUi((s) => s.dialog) === 'add-data'
  const closeDialog = useUi((s) => s.closeDialog)
  const openDialog = useUi((s) => s.openDialog)
  const aoi = useStore((s) => s.aoi)
  const isLoading = useStore((s) => s.isLoading)
  const { run, running } = useQuickLayer()
  const needsArea = !aoi?.geometry || isLoading || running !== null

  const go = (fn: () => void) => () => {
    closeDialog()
    // let the dialog release focus and scroll lock before the next surface opens
    window.setTimeout(fn, 60)
  }

  return (
    <WbDialog
      open={open}
      onClose={closeDialog}
      testId="add-data-dialog"
      kicker="DATA SOURCES"
      title="Add data to the workspace"
      description="Import a file, search open datasets, or add a layer for the drawn area."
      foot={<button type="button" className={BTN} onClick={closeDialog}>Close</button>}
    >
      <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
        <button type="button" className={option} onClick={go(() => requestMapAction('import'))} data-testid="add-vector">
          <Upload className="size-4 shrink-0 text-brand-text" aria-hidden />
          <span>Vector file<small className="mt-0.5 block text-data text-muted-foreground">GeoJSON · Shapefile zip · KML/KMZ · GPX · CSV</small></span>
        </button>
        <button type="button" className={option} onClick={go(() => openDialog('catalog'))}>
          <Database className="size-4 shrink-0 text-brand-text" aria-hidden />
          <span>Data catalog<small className="mt-0.5 block text-data text-muted-foreground">Search open datasets offline</small></span>
        </button>
        <button type="button" className={option} onClick={go(() => openDialog('tool', 'query_osm'))} disabled={!aoi?.geometry} title={aoi ? undefined : 'Draw an area first'}>
          <MapIcon className="size-4 shrink-0 text-brand-text" aria-hidden />
          <span>OpenStreetMap<small className="mt-0.5 block text-data text-muted-foreground">Roads, buildings, features</small></span>
        </button>
        <button type="button" className={option} onClick={go(() => requestMapAction('coordinates'))}>
          <Compass className="size-4 shrink-0 text-brand-text" aria-hidden />
          <span>Coordinates<small className="mt-0.5 block text-data text-muted-foreground">Jump to or enter a place</small></span>
        </button>
      </div>

      <p className="text-muted-foreground text-label">Quick layers for the drawn area</p>
      <div className="grid grid-cols-3 gap-2 max-sm:grid-cols-1">
        {(Object.keys(QUICK) as QuickLayerId[]).map((id) => {
          const { icon: Icon, detail } = QUICK[id]
          return (
            <button
              key={id}
              type="button"
              className={cn(option, 'items-start')}
              disabled={needsArea}
              title={aoi ? undefined : 'Draw an area first'}
              onClick={() => {
                closeDialog()
                void run(id)
              }}
            >
              {running === id ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden /> : <Icon className="mt-0.5 size-4 shrink-0 text-brand-text" aria-hidden />}
              <span>{QUICK_LAYERS[id].label}<small className="mt-0.5 block text-caption text-muted-foreground">{detail}</small></span>
            </button>
          )
        })}
      </div>
      {!aoi && (
        <Callout icon={<Globe2 />}>
          Draw an area on the map to enable OpenStreetMap and the quick layers.
        </Callout>
      )}
      <Callout icon={<Shield />}>Vector files are read in this browser and are not uploaded. Layers from the catalog, OpenStreetMap and quick layers are fetched for the drawn area only.</Callout>
    </WbDialog>
  )
}
