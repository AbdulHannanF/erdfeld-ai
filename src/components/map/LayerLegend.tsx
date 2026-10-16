'use client'

import { RGB_CHANNEL_SWATCH } from '@/lib/map-colors'
import { useStore, type LayerPalette, type MapLayer } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { useMemo } from 'react'
import { colormapGradientCss, formatStretchValue, type RasterDescriptor } from '@/lib/raster-style'
import { legendItems, resolveVectorStyle } from '@/lib/vector-style'
import { ValidationNotice } from '@/components/evidence/ValidationBadge'

// ---------------------------------------------------------------------------
// LayerLegend
// ---------------------------------------------------------------------------
// Reads `layer.palette` (set by P2.3 server-side tools) and renders either a
// gradient colorbar with min/max + unit, or a discrete class swatch list.
// Pure presentation — no map interaction.
// ---------------------------------------------------------------------------

/** Format a number for the legend axis. Keeps small/large ranges readable. */
function formatValue(v: number, unit?: string): string {
  const abs = Math.abs(v)
  let s: string
  if (abs >= 1000) s = v.toFixed(0)
  else if (abs >= 10) s = v.toFixed(1)
  else if (abs >= 1) s = v.toFixed(2)
  else s = v.toFixed(2)
  return unit ? `${s} ${unit}` : s
}

/** Build a CSS `linear-gradient(...)` string from gradient stops, mapped to [min,max]. */
function buildGradient(palette: Extract<LayerPalette, { kind: 'gradient' }>): string {
  const { stops, min, max } = palette
  if (stops.length === 0) return 'transparent'
  if (stops.length === 1) return stops[0].color
  const range = max - min || 1
  const sorted = [...stops].sort((a, b) => a.value - b.value)
  const segments = sorted.map((s) => {
    const pct = Math.max(0, Math.min(100, ((s.value - min) / range) * 100))
    return `${s.color} ${pct.toFixed(1)}%`
  })
  return `linear-gradient(to right, ${segments.join(', ')})`
}

interface LayerLegendProps {
  layer: MapLayer
  /** When provided, shown as a small caption above the legend (e.g. active scene date). */
  caption?: string
  /** No indent: the legend sits in the map overlay, not under a layer row. */
  flush?: boolean
}

/** Indent that lines a legend up under a layer row's name; none in the map overlay. */
const inset = (flush?: boolean) => (flush ? '' : 'mt-1.5 pl-7 pr-1 pb-0.5')

const SENSOR_LABELS: Record<string, string> = {
  'sentinel-2-l2a': 'Sentinel-2 L2A',
  'landsat-c2-l2': 'Landsat C2 L2',
}
const RGB_SWATCH = RGB_CHANNEL_SWATCH

/** Legend for a layer carrying a generic raster descriptor: colorbar (real min/max +
 *  units), RGB band list, or class swatches — plus the acquisition metadata. */
function RasterLegend({ layer, raster, caption, flush }: { layer: MapLayer; raster: RasterDescriptor; caption?: string; flush?: boolean }) {
  const range = raster.rescale?.[0]
  const gradient = raster.kind === 'continuous' ? colormapGradientCss(raster.colormap) : null
  const sensor = raster.sensor ? SENSOR_LABELS[raster.sensor] ?? raster.sensor : null
  const acquired = [sensor, raster.datetime].filter(Boolean).join(' · ')
  const what = raster.expression
    ? `Expression ${raster.expression}`
    : raster.bands?.length ? `Bands ${raster.bands.join(', ')}` : null
  const stretchNote = raster.stretch === 'fixed' ? 'fixed stretch' : raster.stretch === 'minmax' ? 'AOI min–max stretch' : 'AOI p2–p98 stretch'

  return (
    <div className={inset(flush)}>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-muted-foreground text-label">
          {raster.units ?? layer.name}
        </span>
        {caption && <span className="text-data text-muted-foreground">{caption}</span>}
      </div>

      {raster.kind === 'continuous' && range && (
        <>
          {gradient && (
            <div className="h-1.5 w-full rounded-sm border border-border" style={{ background: gradient }} aria-hidden />
          )}
          <div className="mt-0.5 flex justify-between text-data text-muted-foreground tabular-nums">
            <span>{formatStretchValue(range[0])}</span>
            <span className="text-muted-foreground">{formatStretchValue((range[0] + range[1]) / 2)}</span>
            <span>{formatStretchValue(range[1])}</span>
          </div>
        </>
      )}

      {raster.kind === 'rgb' && (
        <div className="flex flex-col gap-0.5">
          {(raster.bands ?? []).map((b, i) => (
            <div key={`${b}-${i}`} className="flex items-center gap-1 text-caption text-muted-foreground">
              <span className="h-2 w-2 rounded-sm border border-border" style={{ background: RGB_SWATCH[i] }} aria-hidden />
              <span className="font-mono">{b}</span>
              {raster.rescale?.[i] && (
                <span className="text-muted-foreground font-mono tabular-nums">
                  {formatStretchValue(raster.rescale[i][0])}–{formatStretchValue(raster.rescale[i][1])}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {raster.kind === 'categorical' && raster.classes && (
        <div className="flex flex-wrap gap-x-2 gap-y-1">
          {raster.classes.map((c) => (
            <div key={c.value} className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm border border-border" style={{ background: c.color }} aria-hidden />
              <span className="text-caption text-muted-foreground">{c.label}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-1 flex flex-col gap-0.5 text-caption text-muted-foreground">
        {acquired && <span>{acquired}</span>}
        {raster.sceneId && <span className="font-mono truncate" title={raster.sceneId}>{raster.sceneId}</span>}
        {what && <span className="font-mono break-all">{what}</span>}
        {raster.kind !== 'categorical' && <span>{stretchNote}</span>}
      </div>
    </div>
  )
}

/** Class legend for a data-driven vector style: one swatch per class, derived from the
 *  same resolution the map paints with (graduated ranges, or the mapped values). */
function VectorLegend({ layer, caption, flush }: { layer: MapLayer; caption?: string; flush?: boolean }) {
  const style = layer.vectorStyle!
  const shown = useUi((s) => s.classFilter[layer.id])
  const { items, values } = useMemo(() => {
    const r = resolveVectorStyle(style, layer.geojson)
    return r.ok
      ? { items: legendItems(r.value), values: r.value.classes.map((c) => String(c.value)) }
      : { items: [], values: [] as string[] }
  }, [style, layer.geojson])
  if (items.length === 0) return null
  // A class filter dims the classes that are hidden on the map, so the legend matches what is drawn.
  const hidden = (i: number) => !!shown && style.kind === 'categorical' && !shown.map(String).includes(values[i] ?? '\u0000')

  return (
    <div className={inset(flush)} data-testid="vector-legend">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-muted-foreground text-label">{style.property}</span>
        {caption && <span className="text-data text-muted-foreground">{caption}</span>}
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-1">
        {items.map((c, i) => (
          <div key={`${c.label}-${i}`} className={`inline-flex items-center gap-1 ${hidden(i) ? "opacity-40" : ""}`}>
            <span className="h-2 w-2 rounded-sm border border-border" style={{ background: c.color }} aria-hidden />
            <span className="text-caption text-muted-foreground tabular-nums">{c.label}</span>
          </div>
        ))}
      </div>
      <div className="mt-1 text-caption text-muted-foreground">
        {style.kind === 'graduated' ? `${style.method === 'equal' ? 'equal-interval' : 'quantile'} classes` : 'by value'}
      </div>
    </div>
  )
}

function LegendBody({ layer, caption, flush }: LayerLegendProps) {
  if (layer.vectorStyle) return <VectorLegend layer={layer} caption={caption} flush={flush} />
  if (layer.raster) return <RasterLegend layer={layer} raster={layer.raster} caption={caption} flush={flush} />
  const palette = layer.palette
  if (!palette) return null

  const heading = palette.label ?? layer.name

  if (palette.kind === 'gradient') {
    const gradient = buildGradient(palette)
    return (
      <div className={inset(flush)}>
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-muted-foreground text-label">
            {heading}
          </span>
          {caption && (
            <span className="text-data text-muted-foreground">{caption}</span>
          )}
        </div>
        <div
          className="h-1.5 w-full rounded-sm border border-border"
          style={{ background: gradient }}
          aria-hidden
        />
        <div className="mt-0.5 flex justify-between text-data text-muted-foreground tabular-nums">
          <span>{formatValue(palette.min, palette.unit)}</span>
          {palette.stops.length > 2 && (
            <span className="text-muted-foreground">
              {formatValue((palette.min + palette.max) / 2, palette.unit)}
            </span>
          )}
          <span>{formatValue(palette.max, palette.unit)}</span>
        </div>
      </div>
    )
  }

  // Classes palette — swatch + label list
  return (
    <div className={inset(flush)}>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-muted-foreground text-label">
          {heading}
        </span>
        {caption && (
          <span className="text-data text-muted-foreground">{caption}</span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-1">
        {palette.classes.map((c, i) => (
          <div key={`${c.label}-${i}`} className="inline-flex items-center gap-1">
            <span
              className="h-2 w-2 rounded-sm border border-border"
              style={{ background: c.color }}
              aria-hidden
            />
            <span className="text-caption text-muted-foreground">{c.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** A layer's legend, preceded by the failing validation checks when its result was flagged. */
export default function LayerLegend({ layer, caption, flush }: LayerLegendProps) {
  return (
    <>
      {layer.verdict && (
        <div className={flush ? "" : "pl-7 pr-1"}>
          <ValidationNotice verdict={layer.verdict} />
        </div>
      )}
      <LegendBody layer={layer} caption={caption} flush={flush} />
    </>
  )
}

/** Convenience helper for callers that want to derive the per-frame caption
 *  (date + cloud %) for the temporal NDVI layer. */
export function useTemporalLegendCaption(layerId: string): string | undefined {
  const frames = useStore((s) => s.temporalFrames)
  const activeIndex = useStore((s) => s.activeFrameIndex)
  if (layerId !== 'ndvi-temporal' || frames.length === 0) return undefined
  const f = frames[activeIndex]
  if (!f) return undefined
  return typeof f.cloud === 'number'
    ? `${f.date} · cloud ${f.cloud.toFixed(0)}%`
    : f.date
}
