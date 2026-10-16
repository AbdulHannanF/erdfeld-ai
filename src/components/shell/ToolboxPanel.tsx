'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Image as ImageIcon, Info, Leaf, Loader2, Mountain, RotateCw, Search, ShieldCheck } from 'lucide-react'
import { OVERLINE, PILL } from '@/components/shell/ui'
import { OPEN_VERIFY_CLAIM } from '@/components/evidence/VerifyClaimDialog'
import { useQuickLayer } from '@/hooks/useQuickLayer'
import { groupOperations, humanName, loadOperations, oneLine, type OperationInfo } from '@/lib/operations-client'
import { QUICK_LAYERS, QUICK_LAYER_IDS, type QuickLayerId } from '@/lib/quick-layers'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { cn } from '@/lib/utils'

const QUICK_META: Record<QuickLayerId, { icon: typeof Leaf; detail: string }> = {
  true_colour: { icon: ImageIcon, detail: 'Sentinel-2 · 10 m · no model call' },
  ndvi: { icon: Leaf, detail: 'Vegetation vigour · no model call' },
  elevation: { icon: Mountain, detail: 'Copernicus DEM · no model call' },
}

const OUTPUTS = ['all', 'raster', 'vector', 'table'] as const
type OutputFilter = (typeof OUTPUTS)[number]

const row =
  'grid min-h-[2.75rem] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-sm border-0 border-t border-border bg-transparent px-1.5 py-1.5 text-left transition-colors first:border-t-0 hover:bg-hover disabled:opacity-50 disabled:hover:bg-transparent'

/** A collapsible group. Closed groups are not rendered at all, so nothing hidden can be tabbed to or
 *  covered; the button carries aria-expanded. */
function Group({ id, label, count, icon, defaultOpen, forceOpen, children }: { id: string; label: string; count: number; icon?: React.ReactNode; defaultOpen: boolean; forceOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  const shown = open || !!forceOpen
  return (
    <section className="rounded-md border border-border bg-sunk" data-testid={`group-${id}`}>
      <h3>
        <button type="button" aria-expanded={shown} onClick={() => setOpen(!shown)} className="flex min-h-[2.125rem] w-full items-center gap-2 px-2 text-left">
          {icon}
          <span className="flex-1 text-body-strong text-foreground">{label}</span>
          <span className="text-data text-muted-foreground">{count}</span>
          <ChevronDown className={cn('size-3 text-muted-foreground transition-transform', shown && 'rotate-180')} aria-hidden />
        </button>
      </h3>
      {shown && <div className="grid px-1.5 pb-1.5">{children}</div>}
    </section>
  )
}

/** The Processing toolbox: the operation registry (`GET /api/operations`), searchable and grouped
 *  by domain. Choosing a tool opens its dialog; the registry is the source of truth, so a new
 *  operation appears here with no change to this file. */
export default function ToolboxPanel() {
  const openDialog = useUi((s) => s.openDialog)
  const aoi = useStore((s) => s.aoi)
  const isLoading = useStore((s) => s.isLoading)
  const { run, running } = useQuickLayer()
  const [ops, setOps] = useState<OperationInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [output, setOutput] = useState<OutputFilter>('all')
  const search = useRef<HTMLInputElement>(null)

  const load = () => {
    setError(null)
    loadOperations().then(setOps, (e: Error) => setError(e.message))
  }
  useEffect(() => {
    let live = true
    loadOperations().then(
      (o) => live && setOps(o),
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [])
  useEffect(() => {
    const focus = () => search.current?.focus()
    window.addEventListener('focus-toolbox-search', focus)
    return () => window.removeEventListener('focus-toolbox-search', focus)
  }, [])

  const groups = useMemo(() => {
    const filtered = (ops ?? []).filter((o) => output === 'all' || (output === 'table' ? o.output === 'table' : o.output === output || (output === 'raster' && o.output === 'mixed')))
    return groupOperations(filtered, query)
  }, [ops, query, output])
  const total = groups.reduce((n, g) => n + g.ops.length, 0)
  const searching = query.trim() !== '' || output !== 'all'
  const quickDisabled = !aoi?.geometry || running !== null || isLoading

  return (
    <section aria-label="Processing toolbox" data-testid="toolbox" className="grid content-start gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className={OVERLINE}>Processing</p>
          <h2 className="mt-1 font-heading text-panel text-foreground">Toolbox</h2>
        </div>
        <span className="badge badge-accent" data-testid="toolbox-count" aria-live="polite">
          {ops ? `${groups.length} ${groups.length === 1 ? 'domain' : 'domains'} · ${total} tools` : 'loading'}
        </span>
      </div>

      <label className="field gap-2 text-muted-foreground focus-within:border-ring">
        <Search className="size-3.5 shrink-0" aria-hidden />
        <span className="sr-only">Search operations</span>
        <input
          ref={search}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search algorithms…"
          className="w-full min-w-0 border-0 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground"
          data-testid="toolbox-search"
        />
      </label>

      <div className="flex items-center justify-between gap-2 text-label text-muted-foreground">
        <span>Output</span>
        <div className="flex gap-[0.1875rem]" role="group" aria-label="Filter by output">
          {OUTPUTS.map((o) => (
            <button
              key={o}
              type="button"
              aria-pressed={output === o}
              onClick={() => setOutput(o)}
              className="chip capitalize"
            >
              {o}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2 rounded-md border border-border bg-sunk px-2 py-1.5 text-body leading-snug text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
        <span>These are the operations Erdfeld can run, as the registry lists them. A run is queued over the drawn area, its sources and checks are recorded in the evidence ledger.</span>
      </div>

      {error && (
        <div className="grid gap-1.5 rounded-md border border-danger/40 bg-danger/10 p-2.5 text-body text-foreground" role="alert">
          <p>The operation registry could not be read: {error}</p>
          <button type="button" onClick={load} className="btn btn-secondary btn-sm w-fit"><RotateCw aria-hidden />Try again</button>
        </div>
      )}
      {!ops && !error && <p className="inline-flex items-center gap-2 text-body text-muted-foreground" role="status"><Loader2 className="size-3.5 animate-spin" aria-hidden />Reading the operation registry</p>}

      {!searching && (
        <Group id="quick" label="Quick layers and claims" count={QUICK_LAYER_IDS.length + 1} defaultOpen icon={<span className="grid size-[1.1875rem] place-items-center rounded-sm border border-border text-muted-foreground"><ImageIcon className="size-3" aria-hidden /></span>}>
            {QUICK_LAYER_IDS.map((id) => {
              const { icon: Icon, detail } = QUICK_META[id]
              return (
                <button key={id} type="button" className={row} disabled={quickDisabled} title={aoi ? undefined : 'Draw an area first'} onClick={() => run(id)} data-testid={`quick-layer-${id}`}>
                  <span className="min-w-0">
                    <span className="block truncate text-body-strong text-foreground">{QUICK_LAYERS[id].label}</span>
                    <span className="mt-0.5 block truncate text-caption text-muted-foreground">{detail}</span>
                  </span>
                  {running === id ? <Loader2 className="size-3.5 animate-spin text-brand-text" aria-hidden /> : <Icon className="size-3.5 text-muted-foreground" aria-hidden />}
                </button>
              )
            })}
            <button type="button" className={row} onClick={() => window.dispatchEvent(new CustomEvent(OPEN_VERIFY_CLAIM))} data-testid="verify-claim" title="Check a statement about the drawn area, such as not cleared since a date">
              <span className="min-w-0">
                <span className="block truncate text-body-strong text-foreground">Verify a claim</span>
                <span className="mt-0.5 block truncate text-caption text-muted-foreground">Supported, contradicted or unknown</span>
              </span>
              <ShieldCheck className="size-3.5 text-brand-text" aria-hidden />
            </button>
        </Group>
      )}

      {ops && groups.length === 0 && (
        <p className="rounded-md border border-dashed border-input p-3 text-body text-muted-foreground" data-testid="toolbox-empty">No operation matches &ldquo;{query}&rdquo;. This is an empty result: the registry has {ops.length} operations.</p>
      )}

      {groups.map((g, i) => (
        <Group key={g.id} id={g.id} label={g.label} count={g.ops.length} defaultOpen={i < 2} forceOpen={searching}>
          {g.ops.map((o) => (
            <button key={o.name} type="button" className={row} onClick={() => openDialog('tool', o.name)} data-testid={`tool-${o.name}`} title={o.description}>
              <span className="min-w-0">
                <span className="block truncate text-body-strong text-foreground">{humanName(o.name)}</span>
                <span className="mt-0.5 block truncate text-caption text-muted-foreground">{oneLine(o.description)}</span>
              </span>
              <span className={cn(PILL, 'bg-accent text-accent-foreground')}>{o.output}</span>
            </button>
          ))}
        </Group>
      ))}
    </section>
  )
}
