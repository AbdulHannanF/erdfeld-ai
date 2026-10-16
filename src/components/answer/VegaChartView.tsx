'use client'

import { useEffect, useRef, useState } from 'react'
import embed, { type Result } from 'vega-embed'
import { useTheme } from 'next-themes'
import { useStore } from '@/store/useStore'
import { FID_FIELD, HIGHLIGHT_PARAM, specHasFid, withHighlight } from '@/lib/chart-spec'
import { CATEGORICAL_PALETTE } from '@/lib/vector-style'

// ---------------------------------------------------------------------------
// VegaChartView
// ---------------------------------------------------------------------------
// Renders any Vega-Lite spec (agent-authored via `make_chart`, or built by the client
// from stored figures). Loaded lazily through VegaChart.tsx so vega stays out of the
// initial bundle. Themed to the app's dark / light mode, fluid width, and — when the
// spec's rows carry `_fid` and a `layerId` is given — linked to the map: clicking a mark
// selects that feature, and a selected feature dims the other marks.
// ---------------------------------------------------------------------------

const DEFAULT_HEIGHT = 180

/** The UI scale (root font size over 16px): a chart's pixel sizes follow it like the rest of the interface. */
function useUiScale(): number {
  const read = () => (typeof window === 'undefined' ? 1 : parseFloat(getComputedStyle(document.documentElement).fontSize) / 16 || 1)
  const [scale, setScale] = useState(read)
  useEffect(() => {
    const on = () => setScale(read())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return scale
}

/** Chart colours come from the theme tokens (resolved by the caller, since Vega cannot read CSS
 *  variables); grid lines are the text colour at low opacity. */
function themeConfig({ text, title, scale }: { text: string; title: string; scale: number }) {
  const fs = 12 * scale
  const grid = text
  return {
    background: null,
    font: 'system-ui, -apple-system, sans-serif',
    view: { stroke: null },
    range: { category: CATEGORICAL_PALETTE, ramp: { scheme: 'viridis' } },
    mark: { color: CATEGORICAL_PALETTE[0] },
    axis: { labelColor: text, titleColor: text, domainColor: grid, tickColor: grid, gridColor: grid, domainOpacity: 0.4, tickOpacity: 0.4, gridOpacity: 0.2, labelFontSize: fs, titleFontSize: fs },
    legend: { labelColor: text, titleColor: text, labelFontSize: fs, titleFontSize: fs },
    title: { color: title, fontSize: fs, fontWeight: 600 },
    header: { labelColor: text, titleColor: text },
  }
}

/** Fit the spec to its container: fluid width for unit / layered specs (concat, facet and
 *  repeat cannot use `container` width), a default height, and the map-link params. */
function prepareSpec(spec: Record<string, any>, linked: boolean): Record<string, any> {
  let next = linked ? withHighlight(spec) : { ...spec }
  const compound = ['hconcat', 'vconcat', 'concat', 'facet', 'repeat'].some((k) => k in next)
  if (!compound) next.width = 'container'
  if (next.height === undefined || next.height === 'container') next.height = DEFAULT_HEIGHT
  next.autosize = { type: 'fit', contains: 'padding' }
  delete next.$schema
  return next
}

export default function VegaChartView({
  spec,
  layerId,
  height,
  className,
  onPointClick,
}: {
  spec: Record<string, any>
  /** Map layer whose features the rows came from; enables the click link. */
  layerId?: string
  height?: number
  className?: string
  /** Called with the data row of a clicked mark (the timeline jumps to that scene). */
  onPointClick?: (datum: Record<string, unknown>) => void
}) {
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme !== 'light'
  const scale = useUiScale()
  const hostRef = useRef<HTMLDivElement>(null)
  const resultRef = useRef<Result | null>(null)
  const clickRef = useRef(onPointClick)
  useEffect(() => { clickRef.current = onPointClick }, [onPointClick])
  const clickable = !!onPointClick
  const [error, setError] = useState<string | null>(null)
  const linked = !!layerId && specHasFid(spec)
  const highlight = useStore((s) => s.highlight)
  const fid = linked && highlight?.layerId === layerId ? highlight.fid : null

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let observer: ResizeObserver | undefined
    const prepared = prepareSpec(spec, linked)
    if (height) prepared.height = height
    if (typeof prepared.height === 'number') prepared.height = Math.round(prepared.height * scale)
    const draw = () => {
    const css = getComputedStyle(host)
    const token = (name: string) => css.getPropertyValue(name).trim()
    embed(host, prepared as any, {
      mode: 'vega-lite',
      // Evaluate expressions with vega-interpreter instead of `new Function`, so the CSP needs no 'unsafe-eval'.
      ast: true,
      actions: false,
      renderer: 'svg',
      config: themeConfig({ text: token('--muted-foreground'), title: token('--foreground'), scale }) as any,
      tooltip: { theme: dark ? 'dark' : 'light' },
    })
      .then((result) => {
        if (cancelled) { result.finalize(); return }
        resultRef.current = result
        setError(null)
        if (clickable) {
          result.view.addEventListener('click', (_e, item) => {
            const datum = (item as any)?.datum
            if (datum && typeof datum === 'object') clickRef.current?.(datum as Record<string, unknown>)
          })
          host.style.cursor = 'pointer'
        }
        if (linked) {
          result.view.addEventListener('click', (_e, item) => {
            const id = (item as any)?.datum?.[FID_FIELD]
            useStore.getState().setHighlight(typeof id === 'number' && layerId ? { layerId, fid: id } : null)
          })
        }
        const current = useStore.getState().highlight
        if (linked && current?.layerId === layerId) result.view.signal(HIGHLIGHT_PARAM, current.fid).runAsync()
        // Re-measure when the panel is resized (width: 'container' only listens to the window).
        observer = new ResizeObserver(() => { result.view.resize().runAsync() })
        observer.observe(host)
      })
      .catch((err) => { if (!cancelled) setError(err?.message ?? 'The chart could not be drawn.') })
    }
    // next-themes flips the .dark class in a parent effect, after this one: read the tokens next tick
    const timer = setTimeout(draw, 0)
    return () => {
      clearTimeout(timer)
      cancelled = true
      observer?.disconnect()
      resultRef.current?.finalize()
      resultRef.current = null
    }
  }, [spec, dark, linked, layerId, height, scale, clickable])

  // Map -> chart: reflect the selected feature in the (already drawn) view.
  useEffect(() => {
    if (linked) resultRef.current?.view.signal(HIGHLIGHT_PARAM, fid).runAsync()
  }, [fid, linked])

  if (error) return <div className="px-2 py-3 text-caption text-warning">Chart error: {error}</div>
  return <div ref={hostRef} className={`vega-host w-full min-w-0 ${className ?? ''}`} role="img" aria-label={String(spec?.title?.text ?? spec?.title ?? 'Chart')} />
}
