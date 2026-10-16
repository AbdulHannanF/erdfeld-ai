'use client'

import dynamic from 'next/dynamic'
import { Suspense, useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTheme } from 'next-themes'
import { Maximize2 } from 'lucide-react'
import { toast } from 'sonner'
import { TopBar } from '@/components/shell/TopBar'
import { Sidebar } from '@/components/shell/Sidebar'
import StatusBar from '@/components/shell/StatusBar'
import Inspector from '@/components/shell/Inspector'
import WorkspaceDock from '@/components/shell/Dock'
import CommandPalette from '@/components/shell/CommandPalette'
import PreviewBanner from '@/components/shell/PreviewBanner'
import SettingsSheet from '@/components/shell/SettingsPanel'
import KeyboardShortcuts from '@/components/shell/KeyboardShortcuts'
import JobRunner from '@/components/shell/JobRunner'
import ToolDialog from '@/components/shell/ToolDialog'
import AddDataDialog from '@/components/shell/AddDataDialog'
import CrsDialog from '@/components/shell/CrsDialog'
import CatalogDialog from '@/components/shell/CatalogDialog'
import ReportsDialog from '@/components/shell/ReportsDialog'
import ActivityDialog from '@/components/shell/ActivityDialog'
import VerifyClaimDialog from '@/components/evidence/VerifyClaimDialog'
import { BASEMAP_CHOICES, basemapStyleId, type BasemapChoice } from '@/components/map/basemaps'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { fromDto, type ProjectDto, type SharedProjectDto } from '@/lib/projects'
import { useMapReadout } from '@/store/useMapReadout'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { cn } from '@/lib/utils'

// MapLibre needs the browser, so the map is loaded on the client only.
const MapPanel = dynamic(() => import('@/components/map/MapPanel'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-card">
      <div className="flex flex-col items-center gap-3">
        <div className="size-8 animate-spin rounded-full border-2 border-teal border-t-transparent" />
        <span className="text-body text-muted-foreground">Loading map...</span>
      </div>
    </div>
  ),
})

/** Run `fn` once the map has reported its first view (it exists and its style is loading), so a
 *  fly-to is not lost to a map that is not there yet. Gives up after 15 s. */
function whenMapReady(fn: () => void) {
  const t0 = Date.now()
  const tick = () => {
    if (useMapReadout.getState().zoom != null || Date.now() - t0 > 15_000) window.setTimeout(fn, 300)
    else window.setTimeout(tick, 200)
  }
  tick()
}

/** Opens what a link carries: `?share=` loads a read-only project snapshot, and `lat`, `lng`,
 *  `zoom`, `style`, `aoi` reopen a place and area. Applied once, on first load. */
function ShareUrlHandler() {
  const searchParams = useSearchParams()
  const setFlyToTarget = useStore((s) => s.setFlyToTarget)
  const setAoi = useStore((s) => s.setAoi)
  const loadProject = useStore((s) => s.loadProject)
  const setBasemap = useUi((s) => s.setBasemap)
  const applied = useRef(false)

  useEffect(() => {
    if (applied.current) return
    applied.current = true

    const shareToken = searchParams.get('share')
    if (shareToken) {
      ;(async () => {
        try {
          const res = await fetch(`/api/share/${encodeURIComponent(shareToken)}`)
          const data = (await res.json()) as SharedProjectDto & { error?: string }
          if (!res.ok) throw new Error(data.error || 'Could not open shared link')
          const restored = fromDto(data.project as ProjectDto)
          loadProject({ id: data.projectId, ...restored }, { preview: { token: data.token, name: data.name, updatedAt: data.updatedAt } })
          if (restored.aoi?.center) {
            whenMapReady(() => setFlyToTarget({ lat: restored.aoi!.center!.lat, lng: restored.aoi!.center!.lng, zoom: 12 }))
          }
          toast.success(`Opened shared snapshot "${data.name}" (read-only)`)
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Could not open shared link')
        }
      })()
      return
    }

    const lat = parseFloat(searchParams.get('lat') ?? '')
    const lng = parseFloat(searchParams.get('lng') ?? '')
    const zoom = parseFloat(searchParams.get('zoom') ?? '12')
    const style = searchParams.get('style') ?? ''
    if ((BASEMAP_CHOICES as readonly string[]).includes(style) && style !== 'auto') setBasemap(style as BasemapChoice)
    if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(zoom)) {
      whenMapReady(() => setFlyToTarget({ lat, lng, zoom }))
    }
    const aoiParam = searchParams.get('aoi')
    if (aoiParam) {
      try {
        const geometry = JSON.parse(decodeURIComponent(aoiParam)) as GeoJSON.Geometry
        if (geometry.type === 'Polygon') {
          const coords = geometry.coordinates[0]
          const center = {
            lng: coords.reduce((s, c) => s + c[0], 0) / coords.length,
            lat: coords.reduce((s, c) => s + c[1], 0) / coords.length,
          }
          setAoi({ type: 'Polygon', geometry, center })
        }
      } catch {
        // an unreadable area in the link is ignored; the place still opens
      }
    }
  }, [searchParams, setFlyToTarget, setAoi, loadProject, setBasemap])

  return null
}

/** Move keyboard focus into the question box (the skip link's target). Focused synchronously: a
 *  deferred focus never lands in a background tab or a headless test. */
function focusComposer(e: { preventDefault: () => void }) {
  e.preventDefault()
  const ui = useUi.getState()
  if (ui.inspectorTab !== 'assistant') ui.showInspector('assistant')
  const focus = () => {
    const composer = document.getElementById('chat-composer') as HTMLTextAreaElement | null
    composer?.focus({ preventScroll: true })
    composer?.scrollIntoView({ block: 'nearest' })
  }
  focus()
  // the composer mounts after a tab switch: try again once it has
  window.setTimeout(focus, 60)
}

/**
 * The workbench: a 208px navigation, a 54px top bar, the map over the workspace dock, the 360px
 * inspector, and a 28px status bar, in the dark QGIS-style layout of the design. Below 1100px the
 * navigation is a 62px icon rail. On a phone the map is full bleed with the inspector as a bottom
 * sheet, the navigation as a drawer and a compact top bar. Focus mode hides every panel.
 */
export default function AppShell() {
  const isMobile = useIsMobile()
  const focus = useStore((s) => s.isMapFullscreen)
  const setFocus = useStore((s) => s.setMapFullscreen)
  const setMapStyle = useStore((s) => s.setMapStyle)
  const basemap = useUi((s) => s.basemap)
  const sheetSnap = useUi((s) => s.sheetSnap)
  const dockExpanded = useUi((s) => s.dockExpanded)
  const dockCollapsed = useUi((s) => s.dockCollapsed)
  const hydrateUi = useUi((s) => s.hydrate)
  const hydrateStore = useStore((s) => s.hydrate)
  const { resolvedTheme } = useTheme()

  // Persisted state is read after mount so the server and the first client render match.
  useEffect(() => {
    hydrateUi()
    hydrateStore()
  }, [hydrateUi, hydrateStore])

  // The basemap in effect follows the theme unless one was chosen.
  useEffect(() => {
    if (resolvedTheme) setMapStyle(basemapStyleId(basemap, resolvedTheme))
  }, [resolvedTheme, basemap, setMapStyle])

  // The map's own overlays clear the bottom sheet by this much.
  useEffect(() => {
    const h = !isMobile || focus ? '0px' : sheetSnap === 'peek' ? '76px' : sheetSnap === 'half' ? '52dvh' : '88dvh'
    document.documentElement.style.setProperty('--sheet-h', h)
    // lets the map's overlays step aside while the sheet is open
    document.documentElement.dataset.sheet = isMobile && !focus ? sheetSnap : 'none'
  }, [isMobile, focus, sheetSnap])

  const dockH = dockCollapsed ? '2.5rem' : dockExpanded ? 'min(56%, 35rem)' : '13.25rem'

  return (
    <div
      className={cn(
        'grid h-dvh w-screen gap-px overflow-hidden bg-border',
        focus ? 'grid-cols-1' : 'grid-cols-[13rem_minmax(0,1fr)] max-[1100px]:grid-cols-[3.875rem_minmax(0,1fr)] max-md:grid-cols-1',
      )}
    >
      <a
        href="#chat-composer"
        onClick={focusComposer}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') focusComposer(e)
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-body-strong focus:text-primary-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      >
        Skip to question box
      </a>
      <h1 className="sr-only">Erdfeld AI: spatial workbench with map, processing toolbox and assistant</h1>

      {!focus && <Sidebar />}

      <div
        className={cn('grid min-h-0 min-w-0 gap-px bg-border', focus ? 'grid-rows-[minmax(0,1fr)]' : 'grid-rows-[3.375rem_minmax(0,1fr)_1.75rem] max-md:grid-rows-[3rem_minmax(0,1fr)]')}
        style={{ ['--dock-h' as string]: dockH }}
      >
        {!focus && <TopBar />}
        <div
          className={cn(
            'grid min-h-0 min-w-0 gap-px bg-border',
            focus || isMobile
              ? 'grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]'
              : 'grid-cols-[minmax(0,1fr)_22.5rem] grid-rows-[minmax(0,1fr)_var(--dock-h)] max-[1250px]:grid-cols-[minmax(0,1fr)_20.625rem]',
          )}
        >
          <main aria-label="Map" className="relative min-h-0 min-w-0 overflow-hidden bg-sunk [grid-column:1] [grid-row:1]">
            <MapPanel />
            <PreviewBanner />
            {focus && (
              <button
                type="button"
                onClick={() => setFocus(false)}
                className="btn btn-secondary btn-md absolute left-3 top-16 z-20 shadow-float"
              >
                <Maximize2 aria-hidden />Show the panels
              </button>
            )}
          </main>
          {!focus && !isMobile && <WorkspaceDock />}
          {!focus && !isMobile && <Inspector />}
        </div>
        {!focus && !isMobile && <StatusBar />}
      </div>
      {!focus && isMobile && <Inspector sheet />}

      <CommandPalette />
      <SettingsSheet />
      <KeyboardShortcuts />
      <ToolDialog />
      <AddDataDialog />
      <CrsDialog />
      <CatalogDialog />
      <ReportsDialog />
      <ActivityDialog />
      <VerifyClaimDialog />
      <JobRunner />
      <Suspense fallback={null}>
        <ShareUrlHandler />
      </Suspense>
    </div>
  )
}
