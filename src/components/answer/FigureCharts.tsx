'use client'

/** Charts of the figures the run produced. Every one draws REAL tool output from the store, or is
 *  absent: nothing is synthesised to fill a tab. A chart is offered when the run produced the
 *  figure it needs (a stats key), not because of which tool made it, so a new operation that
 *  returns the same figures gets its chart without a UI change.
 *    Land cover   -> `land_cover` (measured fractions)
 *    Elevation    -> `elevation_profile` (W to E cross-section)
 *    Detections   -> per-class stats from CV layers' real detection features
 *    Distribution -> `distribution` (index histogram bins)
 *    Time series  -> `ndvi_by_date`
 *    Variogram    -> `semivariogram` (bins and model fit)
 *  All of them go through the one Vega-Lite path (VegaChart). */

import { useMemo, useState } from 'react'
import { useStore } from '@/store/useStore'
import VegaChart from '@/components/answer/VegaChart'
import { barSpec, histogramSpec, lineSpec, variogramSpec } from '@/lib/chart-spec'
import { detectionStats } from '@/lib/detection-stats'
import { Segmented } from '@/components/shell/Segmented'

type LabeledPoint = { label: string; value: number }
type AnySd = Record<string, unknown>

/** The most recent result whose figures include `key` (result ids are minted per run, so the last
 *  matching entry is the latest). */
function latestWith(toolResults: Record<string, { summaryData?: AnySd }>, key: string): AnySd | null {
  let found: AnySd | null = null
  for (const r of Object.values(toolResults)) {
    if (r.summaryData && Array.isArray(r.summaryData[key])) found = r.summaryData
  }
  return found
}

function asLabeledArray(v: unknown): LabeledPoint[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  if (!v.every((p) => p && typeof p.label === 'string' && typeof p.value === 'number')) return null
  return v as LabeledPoint[]
}

const asNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function Facts({ items }: { items: Array<[string, string | null]> }) {
  return (
    <dl className="mt-1 flex flex-wrap gap-x-5 gap-y-0.5 px-1 text-xs text-muted-foreground">
      {items.filter(([, v]) => v != null).map(([k, v]) => (
        <div key={k} className="flex gap-1"><dt>{k}</dt><dd className="tabular-nums text-foreground">{v}</dd></div>
      ))}
    </dl>
  )
}

function Figure({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <figure className="rounded-lg border border-border bg-muted/40 p-2.5">
      <figcaption className="mb-1 flex items-baseline justify-between gap-2 px-1">
        <span className="text-[0.8125rem] font-medium text-foreground">{title}</span>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </figcaption>
      {children}
    </figure>
  )
}

export default function FigureCharts() {
  const layers = useStore((s) => s.layers)
  const toolResults = useStore((s) => s.toolResults)
  const [active, setActive] = useState<string | null>(null)

  const landCover = useMemo(() => {
    const sd = latestWith(toolResults, 'land_cover')
    return sd ? asLabeledArray(sd.land_cover) : null
  }, [toolResults])
  const demSd = useMemo(() => latestWith(toolResults, 'elevation_profile'), [toolResults])
  const demProfile = demSd ? asLabeledArray(demSd.elevation_profile) : null
  const detections = useMemo(() => detectionStats(layers), [layers])
  const variogramSd = useMemo(() => latestWith(toolResults, 'semivariogram'), [toolResults])
  const histogramSd = useMemo(() => latestWith(toolResults, 'distribution'), [toolResults])
  const timeSeries = useMemo(() => {
    const sd = latestWith(toolResults, 'ndvi_by_date')
    return sd ? asLabeledArray(sd.ndvi_by_date) : null
  }, [toolResults])

  const landSpec = useMemo(() => (landCover ? barSpec(landCover, { yTitle: '% of area' }) : null), [landCover])
  const demSpec = useMemo(
    () => (demProfile ? lineSpec(demProfile.map((p) => ({ label: `${p.label}km`, value: p.value })), { yTitle: 'Elevation (m)', area: true }) : null),
    [demProfile],
  )
  const detSpec = useMemo(
    () => ({
      data: { values: detections },
      mark: { type: 'bar', cornerRadiusEnd: 3 },
      encoding: {
        x: { field: 'label', type: 'nominal', sort: null, axis: { title: null } },
        y: { field: 'confidence', type: 'quantitative', scale: { domain: [0, 100] }, axis: { title: 'Mean confidence %' } },
        color: { field: 'label', type: 'nominal', legend: null },
        tooltip: [
          { field: 'label', title: 'Class' },
          { field: 'confidence', type: 'quantitative', title: 'Mean confidence %' },
          { field: 'count', type: 'quantitative', title: 'Detections' },
        ],
      },
    }),
    [detections],
  )
  const bins = histogramSd ? asLabeledArray(histogramSd.distribution) : null
  const modal = histogramSd ? asNum(histogramSd.modal_value) : null
  const histSpec = useMemo(
    () => (bins && histogramSd ? histogramSpec(bins.map((b) => ({ bin: Number(b.label), pixels: b.value })), { xTitle: String(histogramSd.index ?? 'Index'), modal }) : null),
    [bins, modal, histogramSd],
  )
  const tsSpec = useMemo(() => (timeSeries ? lineSpec(timeSeries, { yTitle: 'mean NDVI' }) : null), [timeSeries])
  const vBins = variogramSd ? asLabeledArray(variogramSd.semivariogram) : null
  const vSpec = useMemo(
    () => (vBins && variogramSd ? variogramSpec(vBins.map((b) => ({ lag: Number(b.label), gamma: b.value })), { sill: asNum(variogramSd.sill), range: asNum(variogramSd.range_m) }) : null),
    [vBins, variogramSd],
  )

  const tabs: Array<{ id: string; label: string }> = []
  if (landSpec) tabs.push({ id: 'landcover', label: 'Land cover' })
  if (demSpec) tabs.push({ id: 'elevation', label: 'Elevation' })
  if (detections.length > 0) tabs.push({ id: 'detection', label: 'Detections' })
  if (histSpec) tabs.push({ id: 'histogram', label: 'Distribution' })
  if (tsSpec && timeSeries && timeSeries.length >= 2) tabs.push({ id: 'timeseries', label: 'Time series' })
  if (vSpec) tabs.push({ id: 'variogram', label: 'Variogram' })
  if (tabs.length === 0) return null
  const current = tabs.some((t) => t.id === active) ? active! : tabs[0].id

  const delta = timeSeries && timeSeries.length >= 2 ? timeSeries[timeSeries.length - 1].value - timeSeries[0].value : null

  return (
    <section aria-label="Charts of the figures" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Charts</h3>
        {tabs.length > 1 && <Segmented size="sm" label="Chart" value={current} onChange={setActive} options={tabs.map((t) => ({ value: t.id, label: t.label }))} className="max-w-full flex-wrap" />}
      </div>

      {current === 'landcover' && landSpec && (
        <Figure title="Land cover" note="measured fractions, % of area"><VegaChart spec={landSpec} height={170} /></Figure>
      )}
      {current === 'elevation' && demSpec && demSd && (
        <Figure title="Elevation profile" note={`west to east${demSd.terrain_class ? ` · ${String(demSd.terrain_class)}` : ''}`}>
          <VegaChart spec={demSpec} height={150} />
          <Facts items={[
            ['Min', asNum(demSd.min_elevation_m) != null ? `${asNum(demSd.min_elevation_m)} m` : null],
            ['Mean', asNum(demSd.mean_elevation_m) != null ? `${asNum(demSd.mean_elevation_m)} m` : null],
            ['Max', asNum(demSd.max_elevation_m) != null ? `${asNum(demSd.max_elevation_m)} m` : null],
            ['Relief', asNum(demSd.relief_m) != null ? `${asNum(demSd.relief_m)} m` : null],
          ]} />
        </Figure>
      )}
      {current === 'detection' && detections.length > 0 && (
        <Figure title="Detections" note="model scores, not ground truth">
          <VegaChart spec={detSpec} height={160} />
          <Facts items={[['Detections on the map', String(detections.reduce((a, d) => a + d.count, 0))]]} />
        </Figure>
      )}
      {current === 'histogram' && histSpec && histogramSd && (
        <Figure title={`${String(histogramSd.index ?? 'Index')} distribution`} note="clear pixels per bin">
          <VegaChart spec={histSpec} height={160} />
          <Facts items={[
            ['Clear pixels', asNum(histogramSd.count) != null ? asNum(histogramSd.count)!.toLocaleString('en-US') : null],
            ['Range', asNum(histogramSd.min) != null && asNum(histogramSd.max) != null ? `${asNum(histogramSd.min)!.toFixed(2)} to ${asNum(histogramSd.max)!.toFixed(2)}` : null],
            ['Scene', histogramSd.scene_date ? String(histogramSd.scene_date) : null],
          ]} />
        </Figure>
      )}
      {current === 'timeseries' && tsSpec && timeSeries && (
        <Figure title="NDVI over time" note="polygon-clipped, cloud-masked means">
          <VegaChart spec={tsSpec} height={160} />
          <Facts items={[
            ['Acquisitions', String(timeSeries.length)],
            ['Change', delta != null ? `${delta >= 0 ? '+' : ''}${delta.toFixed(3)}` : null],
          ]} />
        </Figure>
      )}
      {current === 'variogram' && vSpec && variogramSd && (
        <Figure title="Semivariogram" note="semivariance against lag, spherical fit">
          <VegaChart spec={vSpec} height={160} />
          <Facts items={[
            ['Nugget', asNum(variogramSd.nugget) != null ? asNum(variogramSd.nugget)!.toPrecision(3) : null],
            ['Sill', asNum(variogramSd.sill) != null ? asNum(variogramSd.sill)!.toPrecision(3) : null],
            ['Range', asNum(variogramSd.range_m) != null ? `${asNum(variogramSd.range_m)} m` : null],
          ]} />
        </Figure>
      )}
    </section>
  )
}
