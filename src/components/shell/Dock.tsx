'use client'

import { ChevronDown, ChevronUp, Layers, Maximize2, Minimize2 } from 'lucide-react'
import EvidenceTab from '@/components/evidence/EvidenceTab'
import { ActivityLists } from '@/components/shell/ActivityDialog'
import AttributesTab from '@/components/shell/AttributesTab'
import ConsoleTab from '@/components/shell/ConsoleTab'
import JobsTab from '@/components/shell/JobsTab'
import { ICON_BTN } from '@/components/shell/ui'
import { attributeSources } from '@/components/map/attributes'
import { useJobs } from '@/store/useJobs'
import { useStore } from '@/store/useStore'
import { useUi, type DockTab } from '@/store/useUi'
import { cn } from '@/lib/utils'

const TABS: Array<{ id: DockTab; label: string }> = [
  { id: 'attributes', label: 'Attributes' },
  { id: 'results', label: 'Analysis results' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'history', label: 'History' },
  { id: 'console', label: 'SQL / expressions' },
]

function Count({ n }: { n: number }) {
  return <span className="badge">{n}</span>
}

/** The dock's tab strip. Counts are real: features in the active vector layer, results of the
 *  run, batches still running. `compact` is the phone's version inside the sheet. */
export function DockTabs({ compact = false }: { compact?: boolean }) {
  const tab = useUi((s) => s.dockTab)
  const setTab = useUi((s) => s.setDockTab)
  const setCollapsed = useUi((s) => s.setDockCollapsed)
  const layers = useStore((s) => s.layers)
  const aoi = useStore((s) => s.aoi)
  const results = useStore((s) => Object.keys(s.toolResults).length)
  const active = useJobs((s) => s.batches.filter((b) => b.state === 'active').length)
  const sources = attributeSources(layers, aoi)
  const first = sources.find((s) => s.kind === 'layer') ?? sources[0]

  const count = (id: DockTab) => (id === 'attributes' && first ? first.features.length : id === 'results' ? results : id === 'jobs' ? active : null)

  return (
    <div
      role="tablist"
      aria-label="Workspace dock tabs"
      className={cn('flex h-full items-stretch gap-[0.1875rem] overflow-x-auto', compact && 'h-10 shrink-0 border-b border-border px-2')}
    >
      {TABS.map((t) => {
        const selected = tab === t.id
        const n = count(t.id)
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`dock-tab-${t.id}`}
            aria-selected={selected}
            aria-controls="dock-body"
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              setTab(t.id)
              setCollapsed(false)
            }}
            onKeyDown={(e) => {
              const i = TABS.findIndex((x) => x.id === t.id)
              const next = e.key === 'ArrowRight' ? TABS[(i + 1) % TABS.length] : e.key === 'ArrowLeft' ? TABS[(i - 1 + TABS.length) % TABS.length] : null
              if (next) {
                e.preventDefault()
                setTab(next.id)
                document.getElementById(`dock-tab-${next.id}`)?.focus()
              }
            }}
            className="tab"
          >
            {t.label}
            {n != null && <Count n={n} />}
          </button>
        )
      })}
    </div>
  )
}

/** The active dock panel. */
export function DockBody() {
  const tab = useUi((s) => s.dockTab)
  return (
    <div id="dock-body" role="tabpanel" aria-labelledby={`dock-tab-${tab}`} tabIndex={-1} className="@container min-h-0 flex-1 overflow-auto px-2.5 py-2">
      {tab === 'attributes' && <AttributesTab />}
      {tab === 'results' && <EvidenceTab />}
      {tab === 'jobs' && <JobsTab />}
      {tab === 'history' && (
        <div className="grid gap-3 @2xl:grid-cols-2">
          <ActivityLists />
        </div>
      )}
      {tab === 'console' && <ConsoleTab />}
    </div>
  )
}

/** The workspace dock under the map: tabs for Attributes, Analysis results, Jobs, History and
 *  SQL / expressions, expandable. Its row height is set by the shell. */
export default function WorkspaceDock() {
  const expanded = useUi((s) => s.dockExpanded)
  const setExpanded = useUi((s) => s.setDockExpanded)
  const collapsed = useUi((s) => s.dockCollapsed)
  const setCollapsed = useUi((s) => s.setDockCollapsed)
  return (
    <section aria-label="Data and processing dock" data-testid="data-dock" data-collapsed={collapsed} className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-card [grid-column:1] [grid-row:2]">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border px-2.5">
        <div className="flex items-center gap-1.5 whitespace-nowrap text-label text-ink-2 max-[900px]:hidden">
          <Layers className="size-3.5 text-muted-foreground" aria-hidden />Workspace dock
        </div>
        <div className="min-w-0 flex-1 self-stretch"><DockTabs /></div>
        <button
          type="button"
          className={ICON_BTN}
          onClick={() => setCollapsed(!collapsed)}
          aria-pressed={collapsed}
          aria-label={collapsed ? 'Open the data dock' : 'Collapse the data dock'}
          title={collapsed ? 'Open the dock' : 'Collapse the dock to its tabs'}
          data-testid="dock-collapse"
        >
          {collapsed ? <ChevronUp className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
        </button>
        <button
          type="button"
          className={ICON_BTN}
          onClick={() => setExpanded(!expanded)}
          aria-pressed={expanded}
          aria-label={expanded ? 'Shrink the data dock' : 'Expand the data dock'}
          title={expanded ? 'Shrink the dock' : 'Expand the dock'}
          data-testid="dock-expand"
        >
          {expanded ? <Minimize2 className="size-3.5" aria-hidden /> : <Maximize2 className="size-3.5" aria-hidden />}
        </button>
      </div>
      {!collapsed && <DockBody />}
    </section>
  )
}
