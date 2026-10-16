'use client'

import { useMemo } from 'react'
import { useStore, type MapLayer } from '@/store/useStore'
import { RASTER_COLORMAPS, colormapGradientCss } from '@/lib/raster-style'
import {
  DEFAULT_CLASSES,
  DEFAULT_GRADUATED_COLORMAP,
  MAX_CLASSES,
  MIN_CLASSES,
  featureProperties,
  type VectorStyle,
} from '@/lib/vector-style'

// ---------------------------------------------------------------------------
// VectorControls
// ---------------------------------------------------------------------------
// "Colour by" picker for a vector layer: property (numeric / text feature properties),
// kind, colormap and class count. Edits write `layer.vectorStyle`; MapPanel repaints and
// the legend follows — no agent round trip.
// ---------------------------------------------------------------------------

const selectCls =
  'min-w-0 flex-1 rounded border border-border bg-card px-1 py-0.5 text-xs text-foreground focus:outline-none'

export default function VectorControls({ layer }: { layer: MapLayer }) {
  const setStyle = useStore((s) => s.setLayerVectorStyle)
  const props = useMemo(
    () => (layer.type === 'geojson' && layer.render !== 'extrusion' ? featureProperties(layer.geojson) : []),
    [layer.type, layer.render, layer.geojson],
  )
  if (props.length === 0) return null

  const style = layer.vectorStyle
  const info = props.find((p) => p.name === style?.property)

  const apply = (change: Partial<VectorStyle>) => {
    if (!style) return
    setStyle(layer.id, { ...style, ...change })
  }

  const pickProperty = (name: string) => {
    if (!name) { setStyle(layer.id, undefined); return }
    const type = props.find((p) => p.name === name)?.type
    const kind = type === 'number' ? 'graduated' : 'categorical'
    // Property changed: keep the ramp, drop class edits that belonged to the old property.
    setStyle(layer.id, { property: name, kind, colormap: style?.colormap, method: style?.method, numClasses: style?.numClasses })
  }

  const colormap = style?.colormap ?? DEFAULT_GRADUATED_COLORMAP
  return (
    <div className="flex flex-col gap-1 pl-7 pr-1 pt-1" data-testid="vector-controls">
      <div className="flex items-center gap-1.5">
        <span className="w-9 shrink-0 text-xs text-muted-foreground">Colour by</span>
        <select value={style?.property ?? ''} onChange={(e) => pickProperty(e.target.value)} aria-label="Colour by property" className={selectCls}>
          <option value="">Default colour</option>
          {props.map((p) => (
            <option key={p.name} value={p.name}>{p.name} ({p.type === 'number' ? '#' : 'abc'})</option>
          ))}
        </select>
      </div>
      {style && (
        <>
          <div className="flex items-center gap-1.5">
            <span className="w-9 shrink-0 text-xs text-muted-foreground">Type</span>
            <select
              value={style.kind}
              onChange={(e) => apply({ kind: e.target.value as VectorStyle['kind'] })}
              aria-label="Style type"
              className={selectCls}
            >
              {info?.type === 'number' && <option value="graduated">Graduated</option>}
              <option value="categorical">Categorical</option>
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <div
              className="h-2 w-9 shrink-0 rounded-sm border border-border"
              style={{ background: colormapGradientCss(style.colormap ?? (style.kind === 'graduated' ? colormap : undefined)) ?? 'transparent' }}
              aria-hidden
            />
            <select
              value={style.colormap ?? ''}
              onChange={(e) => apply({ colormap: e.target.value || undefined })}
              aria-label="Colormap"
              className={selectCls}
            >
              {style.kind === 'categorical' && <option value="">Qualitative</option>}
              {style.kind === 'graduated' && !style.colormap && <option value="">{DEFAULT_GRADUATED_COLORMAP}</option>}
              {RASTER_COLORMAPS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          {style.kind === 'graduated' && (
            <div className="flex items-center gap-1.5">
              <span className="w-9 shrink-0 text-xs text-muted-foreground">Classes</span>
              <select
                value={style.numClasses ?? DEFAULT_CLASSES}
                onChange={(e) => apply({ numClasses: Number(e.target.value), breaks: undefined })}
                aria-label="Number of classes"
                className={selectCls}
              >
                {Array.from({ length: MAX_CLASSES - MIN_CLASSES + 1 }, (_, i) => MIN_CLASSES + i).map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <select
                value={style.method ?? 'quantile'}
                onChange={(e) => apply({ method: e.target.value as VectorStyle['method'], breaks: undefined })}
                aria-label="Class method"
                className={selectCls}
              >
                <option value="quantile">Quantile</option>
                <option value="equal">Equal</option>
              </select>
            </div>
          )}
        </>
      )}
    </div>
  )
}
