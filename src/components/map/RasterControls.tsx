'use client'

import { useStore, type MapLayer } from '@/store/useStore'
import {
  RASTER_COLORMAPS,
  colormapGradientCss,
  isValidStretch,
  rewriteTileUrl,
  type RasterDescriptor,
} from '@/lib/raster-style'

// ---------------------------------------------------------------------------
// RasterControls
// ---------------------------------------------------------------------------
// Colormap picker + min/max stretch inputs for any titiler XYZ raster layer that
// carries a `raster` descriptor. Edits rewrite the tile URL's `colormap_name` /
// `rescale` params client-side (MapPanel swaps the source tiles) and update the
// descriptor so the legend follows — no agent round trip.
// ---------------------------------------------------------------------------

/** True when a layer's styling can be edited client-side. */
export function isRestylable(layer: MapLayer): boolean {
  return !!layer.raster && layer.raster.kind !== 'categorical' && !layer.imageBase64
    && !!layer.tileUrl && /\{z\}/.test(layer.tileUrl)
}

const inputCls = 'field field-sm w-16 font-mono tabular-nums'

export default function RasterControls({ layer }: { layer: MapLayer }) {
  const setStyle = useStore((s) => s.setLayerRasterStyle)
  const raster = layer.raster
  if (!raster || !layer.tileUrl || !isRestylable(layer)) return null

  const apply = (change: { colormap?: string; rescale?: [number, number][] }) => {
    const next: RasterDescriptor = {
      ...raster,
      ...(change.colormap ? { colormap: change.colormap } : {}),
      ...(change.rescale ? { rescale: change.rescale, stretch: 'fixed' as const } : {}),
    }
    setStyle(layer.id, rewriteTileUrl(layer.tileUrl!, change), next)
  }

  const setBound = (band: number, which: 0 | 1, text: string) => {
    const pairs = (raster.rescale ?? []).map((p) => [...p] as [number, number])
    const cur = pairs[band]
    if (!cur || text.trim() === '') return
    const candidate: [number, number] = which === 0 ? [Number(text), cur[1]] : [cur[0], Number(text)]
    if (!isValidStretch(candidate[0], candidate[1])) return
    pairs[band] = candidate
    apply({ rescale: pairs })
  }

  const colormaps = raster.colormap && !(RASTER_COLORMAPS as readonly string[]).includes(raster.colormap)
    ? [raster.colormap, ...RASTER_COLORMAPS]
    : [...RASTER_COLORMAPS]

  return (
    <div className="flex flex-col gap-1 pl-7 pr-1 pt-1">
      {raster.kind === 'continuous' && (
        <div className="flex items-center gap-1.5">
          <div
            className="h-2 w-8 shrink-0 rounded-sm border border-border"
            style={{ background: colormapGradientCss(raster.colormap) ?? 'transparent' }}
            aria-hidden
          />
          <select
            value={raster.colormap ?? ''}
            onChange={(e) => apply({ colormap: e.target.value })}
            aria-label="Colormap"
            className="field field-sm min-w-0 flex-1"
          >
            {colormaps.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      )}
      {(raster.rescale ?? []).map((pair, i) => (
        <div key={`${i}-${pair[0]}-${pair[1]}`} className="flex items-center gap-1 text-caption text-muted-foreground">
          <span className="w-7 shrink-0 font-mono">{raster.kind === 'rgb' ? (raster.bands?.[i] ?? `b${i + 1}`) : 'min'}</span>
          <input
            type="number"
            step="any"
            defaultValue={pair[0]}
            aria-label={`Stretch minimum${raster.kind === 'rgb' ? ` ${raster.bands?.[i] ?? i + 1}` : ''}`}
            className={inputCls}
            onBlur={(e) => setBound(i, 0, e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
          />
          <span>max</span>
          <input
            type="number"
            step="any"
            defaultValue={pair[1]}
            aria-label={`Stretch maximum${raster.kind === 'rgb' ? ` ${raster.bands?.[i] ?? i + 1}` : ''}`}
            className={inputCls}
            onBlur={(e) => setBound(i, 1, e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
          />
        </div>
      ))}
    </div>
  )
}
