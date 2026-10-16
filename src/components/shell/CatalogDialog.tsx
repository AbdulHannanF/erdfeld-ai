'use client'

import { useEffect, useRef, useState } from 'react'
import { Database, Loader2, Play, Search, Sparkles, TriangleAlert } from 'lucide-react'
import { Callout, WbDialog } from '@/components/shell/WbDialog'
import { BTN, BTN_PRIMARY, FIELD, OVERLINE, PILL } from '@/components/shell/ui'
import { useAgentWS } from '@/hooks/useAgentWS'
import { useRunOperation } from '@/hooks/useRunOperation'
import { catalogSize, searchCatalog, type CatalogAnswer, type CatalogRow } from '@/lib/catalog-actions'
import { THEMES } from '@/app/api/agent/lib/registry/types'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { cn } from '@/lib/utils'

const COVERAGE: Record<string, { label: string; cls: string }> = {
  global: { label: 'Global', cls: 'text-success' },
  covers: { label: 'Covers the area', cls: 'text-success' },
  partial: { label: 'Partly covers the area', cls: 'text-warning' },
  unknown: { label: 'Extent not stated', cls: 'text-muted-foreground' },
}

const years = (t: CatalogRow['temporal']) => (t.start ? `${t.start.slice(0, 4)} to ${t.end ? t.end.slice(0, 4) : 'present'}` : 'dates not stated')

function bboxOf(geometry: GeoJSON.Geometry | undefined): [number, number, number, number] | undefined {
  if (!geometry || geometry.type !== 'Polygon') return undefined
  const ring = geometry.coordinates[0] ?? []
  if (ring.length < 3) return undefined
  const xs = ring.map((p) => p[0])
  const ys = ring.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/** The Data catalog: a search over the offline registry of public geospatial datasets, the index
 *  `find_dataset` ranks against. A hit can be read over the drawn area (`use_dataset` on the batch
 *  queue) or handed to the assistant. A hit the app cannot read says why instead of pretending. */
export default function CatalogDialog() {
  const open = useUi((s) => s.dialog) === 'catalog'
  const closeDialog = useUi((s) => s.closeDialog)
  const setDockTab = useUi((s) => s.setDockTab)
  const setInspectorTab = useUi((s) => s.setInspectorTab)
  const aoi = useStore((s) => s.aoi)
  const { run, submitting } = useRunOperation()
  const { sendQuery } = useAgentWS()
  const [query, setQuery] = useState('')
  const [theme, setTheme] = useState('')
  const [answer, setAnswer] = useState<CatalogAnswer | null>(null)
  const [size, setSize] = useState<{ total: number; generatedAt: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    if (!open || size) return
    catalogSize().then(setSize, () => setError('The dataset registry could not be read.'))
  }, [open, size])

  useEffect(() => {
    if (!open) return
    if (!query.trim()) {
      seq.current++
      return
    }
    const mine = ++seq.current
    const t = window.setTimeout(() => {
      setBusy(true)
      searchCatalog({ query, theme: theme || undefined, aoi: bboxOf(aoi?.geometry), limit: 12 })
        .then((a) => {
          if (mine !== seq.current) return
          setAnswer(a)
          setError(null)
        })
        .catch(() => {
          if (mine === seq.current) setError('The search failed. This is a fault, not an empty result: try again.')
        })
        .finally(() => {
          if (mine === seq.current) setBusy(false)
        })
    }, 280)
    return () => window.clearTimeout(t)
  }, [open, query, theme, aoi])

  const answerShown = query.trim() ? answer : null

  const read = async (row: CatalogRow) => {
    const id = await run('use_dataset', { dataset_id: row.id }, `Read ${row.title}`.slice(0, 80))
    if (id) {
      setDockTab('jobs')
      closeDialog()
    }
  }
  const ask = (row: CatalogRow) => {
    closeDialog()
    setInspectorTab('assistant')
    sendQuery(`Use the dataset ${row.id} (${row.title}) over this area and tell me what it shows.`)
  }

  return (
    <WbDialog
      open={open}
      onClose={closeDialog}
      wide
      testId="catalog-dialog"
      kicker="DATA CATALOG"
      title="Find open data"
      description="Search the offline registry of public geospatial datasets."
    >
      <div className="flex gap-2 max-sm:flex-col">
        <label className="relative flex min-w-0 flex-1 items-center">
          <span className="sr-only">Search datasets</span>
          <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden />
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="soil moisture, 30 m DEM, SAR backscatter, population…"
            className={cn(FIELD, 'h-9 pl-8')}
            data-testid="catalog-search"
          />
        </label>
        <label className="sr-only" htmlFor="catalog-theme">Theme</label>
        <select id="catalog-theme" value={theme} onChange={(e) => setTheme(e.target.value)} className={cn(FIELD, 'h-9 w-44 max-sm:w-full')}>
          <option value="">All themes</option>
          {THEMES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      <p className={cn(OVERLINE, 'flex items-center gap-1.5')} aria-live="polite">
        <Database className="size-3.5" aria-hidden />
        {size ? `${size.total.toLocaleString('en-US')} datasets · offline snapshot ${size.generatedAt.slice(0, 10)}` : 'Reading the registry'}
        {answerShown && ` · ${answerShown.afterFilters.toLocaleString('en-US')} match${answerShown.afterFilters === 1 ? '' : 'es'}${aoi ? ', coverage stated against your area' : ''}`}
        {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
      </p>

      {error && query.trim() && <Callout tone="bad" icon={<TriangleAlert />}>{error}</Callout>}
      {!query.trim() && (
        <Callout icon={<Search />}>
          Type what you need in plain words. The registry is searched offline and instantly; nothing is fetched until you read a dataset.
          {!aoi && ' Draw an area to see whether each dataset covers it.'}
        </Callout>
      )}
      {answerShown && answerShown.rows.length === 0 && !error && (
        <Callout tone="warn" icon={<Search />}>
          No dataset matches{theme ? ` in ${theme}` : ''}. This is an empty result, not a failure.
          {answerShown.unknownTerms.length > 0 && ` The registry has nothing for: ${answerShown.unknownTerms.join(', ')}.`}
        </Callout>
      )}

      <ul className="grid gap-2" data-testid="catalog-results">
        {answerShown?.rows.map((r) => {
          const cov = COVERAGE[r.coverage] ?? COVERAGE.unknown
          const needsKey = r.access.requiresAuth && r.authAvailable === false
          return (
            <li key={r.id} className="grid gap-1.5 rounded-md border border-border bg-sunk p-2.5" data-testid="catalog-row">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[0.875rem] font-medium leading-snug text-foreground">{r.title}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground" title={r.id}>{r.id}</p>
                </div>
                <span className={cn('shrink-0 text-xs font-medium', cov.cls)}>{cov.label}</span>
              </div>
              <p className="line-clamp-2 text-[0.8125rem] leading-snug text-muted-foreground">{r.description}</p>
              <div className="flex flex-wrap items-center gap-1">
                {r.themes.slice(0, 4).map((t) => <span key={t} className={PILL}>{t}</span>)}
                <span className={PILL}>{r.resolutionM != null ? `${r.resolutionM} m` : 'resolution not stated'}</span>
                <span className={PILL}>{years(r.temporal)}</span>
                <span className={PILL}>{r.license}</span>
                <span className={PILL}>{r.access.kind}</span>
                {needsKey && <span className={cn(PILL, 'border-warning/50 text-warning')}>needs {r.access.requiresAuth} credentials</span>}
              </div>
              <div className="mt-0.5 flex flex-wrap justify-end gap-1.5">
                <button type="button" className={BTN} onClick={() => ask(r)} disabled={!aoi} title={aoi ? undefined : 'Draw an area first'}>
                  <Sparkles className="size-3.5" aria-hidden />Ask Erdfeld
                </button>
                <button type="button" className={BTN_PRIMARY} onClick={() => read(r)} disabled={!aoi || submitting} title={aoi ? 'Read this dataset over the drawn area' : 'Draw an area first'}>
                  <Play className="size-3.5" aria-hidden />Read over area
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      {answerShown && answerShown.rows.length > 0 && answerShown.matched > answerShown.rows.length && (
        <p className="text-xs text-muted-foreground">Showing the best {answerShown.rows.length} of {answerShown.afterFilters.toLocaleString('en-US')}. Narrow the search or pick a theme to see others.</p>
      )}
    </WbDialog>
  )
}
