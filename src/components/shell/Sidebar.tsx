'use client'

import { Database, FileText, FolderOpen, History, Layers, MapPin, Settings, SlidersHorizontal, X } from 'lucide-react'
import { BrandMark } from '@/components/shell/BrandMark'
import NotificationPanel from '@/components/shell/NotificationPanel'
import ProjectsPanel from '@/components/shell/ProjectsPanel'
import { ThemeToggle } from '@/components/shell/ThemeToggle'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { cn } from '@/lib/utils'

/**
 * The workbench navigation: the Erdfeld lockup, the workspace switcher, six destinations and the
 * open-data note. 208px as designed; below 1100px it is a 62px icon rail (the same buttons, labels
 * hidden but still their accessible names); below 768px it is a drawer over the map.
 */

// the .nav-item row from globals.css; the icon rail (below 1100px) and the drawer (below 768px) only change its alignment
const item = 'nav-item max-[1100px]:justify-center max-[1100px]:px-0 max-md:justify-start max-md:px-2.5'

function NavLabel({ children }: { children: React.ReactNode }) {
  return <span className="min-w-0 truncate max-[1100px]:sr-only max-md:not-sr-only">{children}</span>
}

export function Sidebar() {
  const drawerOpen = useUi((s) => s.drawerOpen)
  const setDrawerOpen = useUi((s) => s.setDrawerOpen)
  const openDialog = useUi((s) => s.openDialog)
  const showInspector = useUi((s) => s.showInspector)
  const setSettingsPanelOpen = useStore((s) => s.setSettingsPanelOpen)
  const projectName = useStore((s) => s.projectName)
  const previewName = useStore((s) => s.previewMeta?.name)
  const appVersion = useStore((s) => s.appVersion)

  const act = (fn: () => void) => () => {
    setDrawerOpen(false)
    fn()
  }

  return (
    <>
      {drawerOpen && (
        <button type="button" aria-label="Close the navigation" className="fixed inset-0 z-30 bg-scrim md:hidden" onClick={() => setDrawerOpen(false)} />
      )}
      <aside
        aria-label="Workspace navigation"
        data-open={drawerOpen}
        className={cn(
          'flex min-h-0 min-w-0 flex-col bg-sidebar px-[0.8125rem] pb-3 pt-[1.1875rem] max-[1100px]:items-center max-[1100px]:px-1.5',
          'max-md:invisible max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:w-[min(86vw,18.75rem)] max-md:items-stretch max-md:border-r max-md:border-border max-md:px-3 max-md:shadow-2xl max-md:transition-[transform,visibility] max-md:duration-200 max-md:-translate-x-full data-[open=true]:max-md:visible data-[open=true]:max-md:translate-x-0',
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-[0.3125rem] pb-[1.1875rem] max-[1100px]:justify-center max-[1100px]:px-0 max-[1100px]:pb-3.5 max-md:justify-between max-md:px-1">
          <a href="/" aria-label="Erdfeld AI home" className="rounded-sm">
            <span className="max-[1100px]:max-md:hidden"><BrandMark height={38} /></span>
            <BrandMark variant="mark" height={34} className="hidden max-[1100px]:inline-flex max-md:hidden" />
          </a>
          <button type="button" onClick={() => setDrawerOpen(false)} className="btn btn-ghost btn-icon-md md:hidden" aria-label="Close the navigation">
            <X aria-hidden />
          </button>
        </div>

        <ProjectsPanel>
          <button
            type="button"
            title="Switch project"
            className="option-card mb-[1.375rem] mt-[1.0625rem] max-[1100px]:size-10 max-[1100px]:min-h-10 max-[1100px]:justify-center max-[1100px]:p-1 max-md:size-auto max-md:min-h-[2.875rem] max-md:w-full max-md:justify-start max-md:p-2"
            data-testid="workspace-switch"
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-accent text-accent-foreground"><Layers className="size-3.5" aria-hidden /></span>
            <span className="min-w-0 flex-1 text-body-strong text-foreground max-[1100px]:sr-only max-md:not-sr-only">
              <span className="block truncate">{previewName ?? projectName ?? 'Untitled project'}</span>
              <small className="mt-0.5 block text-label font-normal text-muted-foreground">This browser</small>
            </span>
          </button>
        </ProjectsPanel>

        <p className="mx-2 mb-1.5 text-label text-muted-foreground max-[1100px]:hidden max-md:block">Workspace</p>
        <nav aria-label="Workbench" className="grid gap-[0.1875rem] max-[1100px]:w-full">
          <button
            type="button"
            aria-current="page"
            title="Map & analysis"
            className={item}
            onClick={act(() => undefined)}
          >
            <MapPin aria-hidden /><NavLabel>Map &amp; analysis</NavLabel>
          </button>
          <ProjectsPanel>
            <button type="button" className={item} title="Projects"><FolderOpen aria-hidden /><NavLabel>Projects</NavLabel></button>
          </ProjectsPanel>
          <button type="button" className={item} title="Data catalog" onClick={act(() => openDialog('catalog'))} data-testid="nav-catalog">
            <Database aria-hidden /><NavLabel>Data catalog</NavLabel>
          </button>
          <button type="button" className={item} title="Processing" onClick={act(() => { showInspector('tools'); window.setTimeout(() => window.dispatchEvent(new Event('focus-toolbox-search')), 50) })} data-testid="nav-processing">
            <SlidersHorizontal aria-hidden /><NavLabel>Processing</NavLabel>
          </button>
          <button type="button" className={item} title="Layouts & reports" onClick={act(() => openDialog('reports'))} data-testid="nav-reports">
            <FileText aria-hidden /><NavLabel>Layouts &amp; reports</NavLabel>
          </button>
          <button type="button" className={item} title="Activity history" onClick={act(() => openDialog('activity'))} data-testid="nav-activity">
            <History aria-hidden /><NavLabel>Activity history</NavLabel>
          </button>
        </nav>

        <div className="mt-auto grid gap-2.5 max-[1100px]:w-full max-[1100px]:justify-items-center max-md:justify-items-stretch">
          <div className="flex gap-2 rounded-md border border-border bg-sunk px-2 py-2.5 max-[1100px]:hidden max-md:flex">
            <i className="mt-1.5 size-1.5 shrink-0 rounded-full bg-success" aria-hidden />
            <div>
              <span className="text-label text-ink-2">Open data</span>
              <span className="mt-1 block text-caption text-muted-foreground">Source and method stay visible.</span>
            </div>
          </div>
          <div className="flex items-center gap-1 md:hidden" aria-label="Notifications and theme">
            <NotificationPanel />
            <ThemeToggle />
          </div>
          <button type="button" className={cn(item, 'max-[1100px]:w-10')} title="Settings" onClick={act(() => setSettingsPanelOpen(true))}>
            <Settings aria-hidden /><NavLabel>Settings</NavLabel>
          </button>
          <p className="border-t border-border px-2 pt-1.5 text-label text-muted-foreground max-[1100px]:hidden max-md:block">
            Erdfeld AI · v{appVersion}
          </p>
        </div>
      </aside>
    </>
  )
}
