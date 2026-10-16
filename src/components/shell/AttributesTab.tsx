'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Download, X } from 'lucide-react'
import { toast } from 'sonner'
import { AOI_SOURCE_ID, attributeSources, cellText, columnsOf, geometryLabel } from '@/components/map/attributes'
import { FIELD, OVERLINE } from '@/components/shell/ui'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { cn } from '@/lib/utils'

const MAX_ROWS = 500

function csvOf(columns: string[], rows: Array<{ f: GeoJSON.Feature; i: number }>): string {
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const lines = [['fid', ...columns.filter((c) => c !== 'fid'), 'geometry'].map(cell).join(',')]
  for (const { f, i } of rows) {
    const p = (f.properties ?? {}) as Record<string, unknown>
    lines.push([String(p.fid ?? i + 1), ...columns.filter((c) => c !== 'fid').map((c) => cellText(p[c])), geometryLabel(f)].map(cell).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

/** The attribute table of a layer: every feature with its attributes, a filter box, sortable
 *  columns, and a row that zooms to its feature. The drawn area is a source too (one row, from its
 *  own geometry). Rows picked by an expression in the SQL tab are shown here. */
export default function AttributesTab() {
  const layers = useStore((s) => s.layers)
  const aoi = useStore((s) => s.aoi)
  const setZoomToFeature = useStore((s) => s.setZoomToFeature)
  const setSelectedFeatureIndex = useStore((s) => s.setSelectedFeatureIndex)
  const selection = useUi((s) => s.attrSelection)
  const setSelection = useUi((s) => s.setAttrSelection)
  const sources = useMemo(() => attributeSources(layers, aoi), [layers, aoi])
  const [pick, setPick] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null)
  const [onlySelected, setOnlySelected] = useState(true)

  // Follow the newest vector layer unless the person chose one; fall back to the area.
  const source = sources.find((s) => s.id === pick) ?? sources.find((s) => s.kind === 'layer') ?? sources[0]
  useEffect(() => {
    setFilter('')
    setSort(null)
  }, [source?.id])

  const { columns, hidden } = useMemo(() => columnsOf(source?.features ?? []), [source])
  const rows = useMemo(() => {
    if (!source) return []
    let r = source.features.map((f, i) => ({ f, i }))
    if (selection && selection.layerId === source.id && onlySelected) {
      const keep = new Set(selection.indices)
      r = r.filter((x) => keep.has(x.i))
    }
    const q = filter.trim().toLowerCase()
    if (q) r = r.filter(({ f }) => Object.values(f.properties ?? {}).some((v) => cellText(v).toLowerCase().includes(q)) || geometryLabel(f).toLowerCase().includes(q))
    if (sort) {
      r = [...r].sort((a, b) => {
        const x = (a.f.properties ?? {})[sort.col] as unknown
        const y = (b.f.properties ?? {})[sort.col] as unknown
        if (x == null) return 1
        if (y == null) return -1
        return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sort.dir
      })
    }
    return r
  }, [source, selection, onlySelected, filter, sort])

  if (!source) {
    return (
      <div className="grid min-h-[4.75rem] place-items-center text-center text-[0.8125rem] text-muted-foreground" data-testid="attributes-empty">
        <div>
          <strong className="mb-1 block text-[0.875rem] font-medium text-foreground">Nothing to tabulate yet</strong>
          Draw an area, or run an analysis that returns vector features, and its attributes appear here.
        </div>
      </div>
    )
  }

  const selectionHere = selection && selection.layerId === source.id ? selection : null
  const shown = rows.slice(0, MAX_ROWS)
  const zoomTo = (i: number) => {
    if (source.kind === 'aoi') return
    setZoomToFeature({ layerId: source.id, featureIndex: i })
    setSelectedFeatureIndex(i)
  }
  const th = (col: string) => (
    <th key={col} scope="col" className="h-7 whitespace-nowrap border-b border-input px-2 text-left font-mono text-xs font-normal text-muted-foreground" aria-sort={sort?.col === col ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => setSort(sort?.col === col ? (sort.dir === 1 ? { col, dir: -1 } : null) : { col, dir: 1 })}>
        {col}
        {sort?.col === col && (sort.dir === 1 ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />)}
      </button>
    </th>
  )

  return (
    <div data-testid="attribute-table">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 font-mono text-xs text-muted-foreground">
        <span>Layer</span>
        {sources.length > 1 ? (
          <>
            <label htmlFor="attr-layer" className="sr-only">Layer</label>
            <select id="attr-layer" value={source.id} onChange={(e) => setPick(e.target.value)} className={cn(FIELD, 'h-7 w-auto max-w-[13.75rem] font-sans text-xs')}>
              {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </>
        ) : (
          <strong className="font-medium text-foreground">{source.name}</strong>
        )}
        <span>·</span>
        <span>{source.features.length} {source.features.length === 1 ? 'feature' : 'features'}</span>
        {rows.length !== source.features.length && <span>· {rows.length} shown</span>}
        <span className="ml-auto flex items-center gap-1.5">
          {source.kind === 'layer' && (
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1 rounded border border-input bg-secondary px-2 font-sans text-xs text-secondary-foreground hover:bg-hover"
              onClick={() => {
                const blob = new Blob([csvOf(columns, rows)], { type: 'text/csv' })
                const a = document.createElement('a')
                a.href = URL.createObjectURL(blob)
                a.download = `${source.name.replace(/[^A-Za-z0-9_-]+/g, '_') || 'layer'}-attributes.csv`
                a.click()
                URL.revokeObjectURL(a.href)
                toast.success(`Exported ${rows.length} rows as CSV`)
              }}
            >
              <Download className="size-3" aria-hidden />CSV
            </button>
          )}
          <label htmlFor="attr-filter" className="sr-only">Filter attributes</label>
          <input id="attr-filter" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter attributes…" className={cn(FIELD, 'h-7 w-40 font-sans text-xs')} data-testid="attr-filter" />
        </span>
      </div>

      {selectionHere && (
        <div className="mb-1.5 flex flex-wrap items-center gap-2 rounded border border-border bg-accent px-2 py-1 text-xs text-accent-foreground" role="status">
          <span className="min-w-0 truncate">Selected by <code className="font-mono">{selectionHere.expression}</code> · {selectionHere.indices.length} of {source.features.length}</span>
          <label className="inline-flex items-center gap-1"><input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} />Only these</label>
          <button type="button" className="ml-auto inline-flex items-center gap-1 hover:underline" onClick={() => setSelection(null)}><X className="size-3" aria-hidden />Clear</button>
        </div>
      )}

      <div className="w-full overflow-x-auto">
        <table className="w-full border-collapse whitespace-nowrap">
          <thead>
            <tr>
              {th('fid')}
              {columns.filter((c) => c !== 'fid').map(th)}
              <th scope="col" className="h-7 border-b border-input px-2 text-left font-mono text-xs font-normal text-muted-foreground">geometry</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ f, i }) => {
              const p = (f.properties ?? {}) as Record<string, unknown>
              return (
                <tr
                  key={i}
                  onClick={() => zoomTo(i)}
                  className={cn('border-b border-border hover:bg-hover', source.kind === 'layer' && 'cursor-pointer')}
                  data-testid="attribute-row"
                >
                  <td className="h-7 px-2 font-mono text-[0.8125rem] text-foreground">{String(p.fid ?? (source.id === AOI_SOURCE_ID ? 'AOI-001' : i + 1))}</td>
                  {columns.filter((c) => c !== 'fid').map((c) => (
                    <td key={c} className="h-7 max-w-[17.5rem] truncate px-2 text-[0.8125rem] text-secondary-foreground" title={cellText(p[c])}>{cellText(p[c]) || <span className="text-muted-foreground">·</span>}</td>
                  ))}
                  <td className="h-7 px-2"><span className="rounded border border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{geometryLabel(f)}</span></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className={cn(OVERLINE, 'mt-1.5 normal-case tracking-normal')}>
        {rows.length > MAX_ROWS && `Showing the first ${MAX_ROWS} of ${rows.length} rows. `}
        {hidden > 0 && `${hidden} more field${hidden === 1 ? '' : 's'} not shown. `}
        {rows.length === 0 && 'No row matches the filter. '}
        {source.kind === 'aoi' ? 'The area row describes the boundary only. Analysis values appear after a real run.' : 'Click a row to zoom to its feature.'}
      </p>
    </div>
  )
}
