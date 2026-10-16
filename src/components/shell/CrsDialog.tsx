'use client'

import { useState } from 'react'
import { Info } from 'lucide-react'
import { Callout, WbDialog } from '@/components/shell/WbDialog'
import { BTN, BTN_PRIMARY, FIELD, OVERLINE } from '@/components/shell/ui'
import { COMMON_CRS, crsLabel, parseEpsg, utmEpsgFor } from '@/lib/export-crs'
import { SUPPORTED_EPSG_NOTE } from '@/lib/vector-io'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'

/** The output CRS for vector export. The map displays in Web Mercator whatever is chosen here;
 *  what this sets is the CRS the Download action writes (GeoJSON, shapefile, CSV), reprojected with
 *  proj4 from the WGS 84 the layers are held in. Only codes that can be reprojected exactly are
 *  accepted. */
export default function CrsDialog() {
  const open = useUi((s) => s.dialog) === 'crs'
  const closeDialog = useUi((s) => s.closeDialog)
  const exportCrs = useUi((s) => s.exportCrs)
  const setExportCrs = useUi((s) => s.setExportCrs)
  const center = useStore((s) => s.aoi?.center)
  const [choice, setChoice] = useState(exportCrs)
  const [custom, setCustom] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Opening the dialog starts from the CRS in effect (adjusting state while rendering).
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setChoice(exportCrs)
      setCustom('')
      setError(null)
    }
  }

  const utm = center ? utmEpsgFor(center.lng, center.lat) : null
  const options = [
    ...COMMON_CRS.map((c) => ({ code: `EPSG:${c.epsg}`, label: crsLabel(c.epsg) })),
    ...(utm ? [{ code: `EPSG:${utm}`, label: `${crsLabel(utm)} (zone of your area)` }] : []),
  ]
  const inList = options.some((o) => o.code === choice)

  const apply = () => {
    const raw = choice === 'custom' ? custom : choice
    const epsg = parseEpsg(raw)
    if (epsg == null) return setError(`That code cannot be used exactly. ${SUPPORTED_EPSG_NOTE}.`)
    setExportCrs(`EPSG:${epsg}`)
    closeDialog()
  }

  return (
    <WbDialog
      open={open}
      onClose={closeDialog}
      testId="crs-dialog"
      kicker="EXPORT SETTINGS"
      title="Coordinate reference system"
      description="Choose the coordinate reference system that vector exports are written in."
      foot={
        <>
          <button type="button" className={BTN} onClick={closeDialog}>Cancel</button>
          <button type="button" className={BTN_PRIMARY} onClick={apply} data-testid="crs-apply">Apply CRS</button>
        </>
      }
    >
      <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
        The CRS vector layers are written in when you download them. The map itself always displays in Web Mercator and reprojects on the fly.
      </p>
      <div className="grid gap-1.5">
        <label htmlFor="crs-select" className={OVERLINE}>Output CRS</label>
        <select id="crs-select" className={FIELD} value={inList ? choice : 'custom'} onChange={(e) => { setChoice(e.target.value); setError(null) }}>
          {options.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
          <option value="custom">Another EPSG code…</option>
        </select>
      </div>
      {(!inList || choice === 'custom') && (
        <div className="grid gap-1.5">
          <label htmlFor="crs-custom" className={OVERLINE}>EPSG code</label>
          <input id="crs-custom" className={FIELD} value={custom} onChange={(e) => { setCustom(e.target.value); setError(null) }} placeholder="e.g. 32643 or EPSG:25832" inputMode="numeric" />
        </div>
      )}
      {error && <Callout tone="bad" icon={<Info />}>{error}</Callout>}
      <Callout icon={<Info />}>
        KML is always WGS 84. GeoJSON in another CRS carries the legacy <code>crs</code> member that QGIS and GDAL read. Shapefiles get a matching .prj. {SUPPORTED_EPSG_NOTE}.
      </Callout>
    </WbDialog>
  )
}
