'use client'

import { useMemo, useState } from 'react'
import { Loader2, Play, Table2, X, ZoomIn } from 'lucide-react'
import { attributeSources, columnsOf, featuresBounds, rowsFor } from '@/components/map/attributes'
import { BTN, BTN_PRIMARY, FIELD, OVERLINE } from '@/components/shell/ui'
import { useRunOperation } from '@/hooks/useRunOperation'
import { COLORMAPS, SENSOR_BANDS, checkBandExpression, type Sensor } from '@/lib/band-math'
import { ExpressionError, filterRows, type FilterResult } from '@/lib/expression'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { cn } from '@/lib/utils'

type Mode = 'filter' | 'band'

const EXAMPLES = ['confidence > 0.8', "class IN ('crop', 'grass')", 'area_km2 BETWEEN 0.1 AND 2', "lower(name) LIKE '%field%'", '$area > 0.5']

/** SQL / expressions: a real expression over the active layer's features (a small parser, no
 *  `eval`), and band math for Sentinel-2 and Landsat scenes, run on the queue as `render_raster`. */
export default function ConsoleTab() {
  const [mode, setMode] = useState<Mode>('filter')
  return (
    <div data-testid="console-tab" className="grid gap-2">
      <div className="flex items-center gap-2" role="group" aria-label="Expression type">
        {(['filter', 'band'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            className="chip"
          >
            {m === 'filter' ? 'Attribute filter' : 'Band math'}
          </button>
        ))}
      </div>
      {mode === 'filter' ? <FilterConsole /> : <BandConsole />}
    </div>
  )
}

function FilterConsole() {
  const layers = useStore((s) => s.layers)
  const aoi = useStore((s) => s.aoi)
  const setFitBoundsTarget = useStore((s) => s.setFitBoundsTarget)
  const setDockTab = useUi((s) => s.setDockTab)
  const setSelection = useUi((s) => s.setAttrSelection)
  const sources = useMemo(() => attributeSources(layers, aoi), [layers, aoi])
  const [pick, setPick] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [result, setResult] = useState<{ source: string; expr: string; res: FilterResult } | null>(null)
  const [error, setError] = useState<ExpressionError | Error | null>(null)
  const source = sources.find((s) => s.id === pick) ?? sources.find((s) => s.kind === 'layer') ?? sources[0]
  const fields = useMemo(() => columnsOf(source?.features ?? [], 24).columns, [source])

  if (!source) {
    return (
      <p className="text-body text-muted-foreground" data-testid="console-empty">
        <strong className="text-foreground">erdfeld ›</strong> Draw an area or run an analysis that returns vector features, then filter them here with an expression.
      </p>
    )
  }

  const run = () => {
    try {
      const res = filterRows(text, rowsFor(source.features))
      setResult({ source: source.id, expr: text.trim(), res })
      setError(null)
    } catch (e) {
      setResult(null)
      setError(e as Error)
    }
  }
  const show = () => {
    if (!result) return
    setSelection({ layerId: result.source, indices: result.res.matches, expression: result.expr })
    setDockTab('attributes')
  }
  const zoom = () => {
    if (!result) return
    const b = featuresBounds(result.res.matches.map((i) => source.features[i]))
    if (b) setFitBoundsTarget(b)
  }
  const fresh = result && result.source === source.id

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2 text-data text-muted-foreground">
        <span>Layer</span>
        <label htmlFor="console-layer" className="sr-only">Layer</label>
        <select id="console-layer" value={source.id} onChange={(e) => { setPick(e.target.value); setResult(null); setError(null) }} className={cn(FIELD, 'field-sm w-auto max-w-[15rem]')}>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.features.length})</option>)}
        </select>
      </div>
      <div className="flex items-start gap-2">
        <span className="mt-1.5 whitespace-nowrap font-mono text-caption-strong text-foreground" aria-hidden>erdfeld ›</span>
        <label htmlFor="console-expr" className="sr-only">Expression</label>
        <textarea
          id="console-expr"
          rows={2}
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              run()
            }
          }}
          placeholder="confidence > 0.8 AND class = 'crop'"
          className={cn(FIELD, 'font-mono')}
          aria-describedby="console-help"
          data-testid="console-expr"
        />
        <button type="button" className={BTN_PRIMARY} onClick={run} data-testid="console-run" title="Run (Ctrl+Enter)">
          <Play aria-hidden />Select
        </button>
      </div>
      <p id="console-help" className="text-caption text-muted-foreground">
        Fields: {fields.length ? fields.map((f) => (
          <button key={f} type="button" className="chip mr-1 font-mono" onClick={() => setText((t) => `${t}${t && !/\s$/.test(t) ? ' ' : ''}${/[^A-Za-z0-9_]/.test(f) ? `"${f}"` : f}`)}>{f}</button>
        )) : 'none'}. Operators = != &lt; &gt; AND OR NOT LIKE IN BETWEEN IS NULL; $area, $length, $x, $y; abs, round, lower, upper, length, coalesce. Ctrl+Enter runs it.
      </p>
      {text === '' && <p className="text-caption text-muted-foreground">Try: {EXAMPLES.map((e) => <button key={e} type="button" className="chip mr-1.5 font-mono" onClick={() => setText(e)}>{e}</button>)}</p>}

      {error && (
        <p className="rounded-sm border border-danger/40 bg-danger/10 px-2 py-1.5 text-body text-foreground" role="alert" data-testid="console-error">
          {error.message}
          {error instanceof ExpressionError && <span className="ml-1 text-data text-muted-foreground">at character {error.position + 1}</span>}
        </p>
      )}
      {fresh && result && (
        <div className="grid gap-1.5" role="status" data-testid="console-result">
          <p className="text-body text-foreground">
            <strong>{result.res.matches.length}</strong> of {source.features.length} features selected
            {result.res.unknown > 0 && <span className="text-muted-foreground"> · {result.res.unknown} could not be evaluated (a field is missing on them), so they are not selected</span>}
          </p>
          {result.res.missingFields.length > 0 && (
            <p className="rounded-sm border border-warning/40 bg-warning/10 px-2 py-1 text-caption text-foreground">No feature has the field {result.res.missingFields.map((f) => `"${f}"`).join(', ')}. Check the spelling against the field list.</p>
          )}
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className={BTN} onClick={show} disabled={result.res.matches.length === 0}><Table2 aria-hidden />Show in table</button>
            <button type="button" className={BTN} onClick={zoom} disabled={result.res.matches.length === 0 || source.kind === 'aoi'}><ZoomIn aria-hidden />Zoom to selection</button>
            <button type="button" className={BTN} onClick={() => { setResult(null); setSelection(null) }}><X aria-hidden />Clear</button>
          </div>
        </div>
      )}
    </div>
  )
}

function BandConsole() {
  const aoi = useStore((s) => s.aoi)
  const { run, submitting } = useRunOperation()
  const setDockTab = useUi((s) => s.setDockTab)
  const [sensor, setSensor] = useState<Sensor>('sentinel-2-l2a')
  const [expr, setExpr] = useState('')
  const [date, setDate] = useState('')
  const [cmap, setCmap] = useState('')
  const [touched, setTouched] = useState(false)
  const check = useMemo(() => checkBandExpression(sensor, expr), [sensor, expr])

  const submit = async () => {
    setTouched(true)
    if (!check.ok || !aoi) return
    const args: Record<string, unknown> = { sensor, expression: expr.trim() }
    if (date) args.date = date
    if (cmap) args.colormap = cmap
    const id = await run('render_raster', args, `Band math ${expr.trim()}`.slice(0, 60))
    if (id) setDockTab('jobs')
  }

  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5 text-caption text-muted-foreground max-sm:grid-cols-1">
        <label htmlFor="band-sensor" className={OVERLINE}>Sensor</label>
        <select id="band-sensor" value={sensor} onChange={(e) => setSensor(e.target.value as Sensor)} className={cn(FIELD, 'field-sm')}>
          <option value="sentinel-2-l2a">Sentinel-2 L2A · 10 m</option>
          <option value="landsat-c2-l2">Landsat Collection 2 · 30 m</option>
        </select>
        <label htmlFor="band-expr" className={OVERLINE}>Expression</label>
        <input id="band-expr" value={expr} onChange={(e) => setExpr(e.target.value)} spellCheck={false} placeholder={sensor === 'sentinel-2-l2a' ? '(B08-B04)/(B08+B04)' : '(nir08-red)/(nir08+red)'} className={cn(FIELD, 'h-7 text-data')} aria-invalid={touched && !check.ok} data-testid="band-expr" />
        <label htmlFor="band-date" className={OVERLINE}>Date</label>
        <input id="band-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className={cn(FIELD, 'field-sm')} />
        <label htmlFor="band-cmap" className={OVERLINE}>Colormap</label>
        <select id="band-cmap" value={cmap} onChange={(e) => setCmap(e.target.value)} className={cn(FIELD, 'field-sm')}>
          <option value="">viridis (default)</option>
          {COLORMAPS.filter((c) => c !== 'viridis').map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <p className="text-caption text-muted-foreground">Bands: {SENSOR_BANDS[sensor].join(', ')}. Evaluated on surface reflectance for the clearest scene within three days of the date (or the last 90 days), masked to your area.</p>
      {touched && !check.ok && <p className="rounded-sm border border-danger/40 bg-danger/10 px-2 py-1.5 text-body text-foreground" role="alert">{check.error}</p>}
      <div className="flex items-center gap-2">
        <button type="button" className={BTN_PRIMARY} onClick={submit} disabled={submitting || !aoi} title={aoi ? undefined : 'Draw an area first'} data-testid="band-run">
          {submitting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}Render on the map
        </button>
        {!aoi && <span className="text-caption text-warning">Draw an area first.</span>}
      </div>
    </div>
  )
}
