'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, type MapLayer } from '@/store/useStore'
import { classRows } from '@/components/map/class-filter'

interface Series {
  dates: string[]
  values: Array<number | null>
}

/** The per-feature series a layer carries: `profile_dates` with `profile_values` (arrays), or the
 *  `ndvi_profile` text ("03-27: 0.41 · 04-14: 0.62"). Null when the feature has neither. */
export function seriesOf(props: Record<string, unknown>): Series | null {
  const d = props.profile_dates
  const v = props.profile_values
  if (Array.isArray(d) && Array.isArray(v) && d.length === v.length && d.length > 1) {
    return { dates: d.map(String), values: v.map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : null)) }
  }
  const text = props.ndvi_profile
  if (typeof text === 'string') {
    const pts = text.split('·').map((p) => p.trim().split(':')).filter((p) => p.length === 2)
    if (pts.length > 1) {
      return {
        dates: pts.map((p) => p[0].trim()),
        values: pts.map((p) => {
          const n = parseFloat(p[1])
          return Number.isFinite(n) ? n : null
        }),
      }
    }
  }
  return null
}

const HEIGHT = 124
const PAD = { l: 30, r: 8, t: 8, b: 22 }

function SeriesChart({ series, color, label }: { series: Series; color: string; label: string }) {
  const ref = useRef<SVGSVGElement>(null)
  const [w, setW] = useState(340)
  useEffect(() => {
    const el = ref.current?.parentElement
    if (!el) return
    const measure = () => setW(Math.max(200, Math.round(el.clientWidth)))
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])
  const known = series.values.filter((v): v is number => v != null)
  const top = Math.max(0.9, ...known.map((v) => Math.ceil(v * 10) / 10))
  const x = (i: number) => PAD.l + (i * (w - PAD.l - PAD.r)) / Math.max(1, series.dates.length - 1)
  const y = (v: number) => PAD.t + (1 - v / top) * (HEIGHT - PAD.t - PAD.b)
  const pts = series.values.map((v, i) => (v == null ? null : ([x(i), y(v)] as const)))
  // a gap (null) breaks the line instead of being bridged
  const runs: Array<Array<readonly [number, number]>> = []
  let run: Array<readonly [number, number]> = []
  for (const p of pts) {
    if (p) run.push(p)
    else if (run.length) {
      runs.push(run)
      run = []
    }
  }
  if (run.length) runs.push(run)
  const every = Math.ceil(series.dates.length / Math.max(1, Math.floor((w - PAD.l) / 52)))

  return (
    <svg ref={ref} viewBox={`0 0 ${w} ${HEIGHT}`} width="100%" height={HEIGHT} role="img" aria-label={label} className="block">
      <g className="text-border">
        {[0.2, 0.5, 0.8]
          .filter((g) => g <= top)
          .map((g) => (
            <g key={g}>
              <line x1={PAD.l} x2={w - 4} y1={y(g)} y2={y(g)} stroke="currentColor" />
              <text x={2} y={y(g) + 4} fontSize={12} fill="var(--muted-foreground)">{g.toFixed(1)}</text>
            </g>
          ))}
      </g>
      {series.dates.map((d, i) =>
        i % every === 0 ? (
          <text key={`${d}-${i}`} x={x(i)} y={HEIGHT - 5} textAnchor="middle" fontSize={12} fill="var(--muted-foreground)">{d}</text>
        ) : null,
      )}
      {runs.map((r, i) => (
        <polyline key={i} points={r.map((p) => p.join(',')).join(' ')} fill="none" stroke={color} strokeWidth={2.2} strokeLinejoin="round" />
      ))}
      {pts.map((p, i) => (p ? <circle key={i} cx={p[0]} cy={p[1]} r={3} fill="var(--card)" stroke={color} strokeWidth={2} /> : null))}
    </svg>
  )
}

function featureOf(layers: MapLayer[], highlight: { layerId: string; fid: number } | null) {
  if (!highlight) return null
  const layer = layers.find((l) => l.id === highlight.layerId)
  const feature = layer?.geojson?.features[highlight.fid]
  return layer && feature ? { layer, feature } : null
}

const when = (s: string) => {
  const d = new Date(s.trim())
  return Number.isNaN(d.getTime()) ? s.trim() : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

const EYEBROW = 'text-muted-foreground text-label'

/** The feature last clicked on the map: its class, area, peaks and confidence, and the series it
 *  carries drawn as a line. Everything shown is read from that feature's own properties; a
 *  property it does not have is left out. */
export default function FieldInspector() {
  const layers = useStore((s) => s.layers)
  const highlight = useStore((s) => s.highlight)
  const hasVector = useMemo(
    () => layers.some((l) => l.visible && l.type === 'geojson' && l.geojson?.features.some((f) => f.geometry?.type.includes('Polygon'))),
    [layers],
  )
  const picked = useMemo(() => featureOf(layers, highlight), [layers, highlight])
  if (!hasVector) return null

  const props = (picked?.feature.properties ?? {}) as Record<string, unknown>
  const classProp = picked?.layer.vectorStyle?.property
  const row = picked && classProp ? classRows(picked.layer)?.find((r) => String(r.value) === String(props[classProp])) : null
  const color = row?.color ?? (typeof props.color === 'string' ? props.color : 'var(--teal)')
  const title = row?.label ?? (typeof props.name === 'string' ? props.name : 'Feature')
  const area = typeof props.area_ha === 'number' ? `${props.area_ha.toFixed(2)} ha` : null
  const conf = typeof props.confidence === 'number' ? props.confidence.toFixed(2) : null
  const peaks = typeof props.peak_dates === 'string' && props.peak_dates ? props.peak_dates.split(',').map(when).join(' · ') : null
  const series = picked ? seriesOf(props) : null
  const id = props.field_id ?? props.id

  return (
    <section className="grid gap-3 rounded-lg border border-border p-4" aria-label="Selected feature" data-testid="inspector">
      <header className="flex items-baseline justify-between">
        {picked ? (
          <>
            <h4 className="flex items-center gap-2 font-heading text-body-strong">
              <i className="size-2.5 rounded-sm" style={{ background: color }} aria-hidden />
              {title}
            </h4>
            {id != null && <span className={EYEBROW}>feature {String(id)}</span>}
          </>
        ) : (
          <>
            <span className={EYEBROW}>Selected feature</span>
            <span className={EYEBROW}>click the map</span>
          </>
        )}
      </header>
      {!picked ? (
        <p className="text-body text-muted-foreground">Select a feature on the map to see its details.</p>
      ) : (
        <>
          {(area || peaks || conf) && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-caption text-muted-foreground">
              {area && <span>Area<b className="block text-body-strong text-foreground">{area}</b></span>}
              {peaks && <span>Peaks<b className="block text-body-strong text-foreground">{peaks}</b></span>}
              {conf && <span>Confidence<b className="block text-body-strong text-foreground">{conf}</b></span>}
            </div>
          )}
          {series ? (
            <SeriesChart series={series} color={color} label={`${title}: value by date`} />
          ) : (
            <p className="text-body text-muted-foreground">This feature carries no time series.</p>
          )}
        </>
      )}
    </section>
  )
}
