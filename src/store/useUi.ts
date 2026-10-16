import { create } from 'zustand'
import { STORAGE_KEYS, readStorage, writeStorage } from '@/lib/storage'
import { DEFAULT_BASEMAP, basemapChoice, type BasemapChoice } from '@/components/map/basemaps'
import type { PinScene } from '@/lib/scene-pins'

/**
 * Interface state that has no meaning outside the workbench: which inspector tab and dock tab are
 * open, which dialog, the active map tool, the basemap, the sheet position on a phone, and what a
 * clicked citation points at. Analysis data (layers, results, messages) stays in `useStore`;
 * keeping the two apart means a tab change never re-renders anything that reads data.
 */

export type InspectorTab = 'tools' | 'layers' | 'assistant' | 'data'
export type PanelMode = 'ask' | 'investigate'
export type MapView = 'map' | 'compare' | 'timeline'
export type SheetSnap = 'peek' | 'half' | 'full'
export type DockTab = 'attributes' | 'results' | 'jobs' | 'history' | 'console'
/** Map tools that are not TerraDraw drawing modes (those live in `useStore.activeDrawMode`). */
export type MapTool = 'select' | 'identify' | 'measure'
/** Features picked by an expression in the SQL / expressions tab, shown in the Attributes tab. */
export interface AttrSelection {
  layerId: string
  /** Indices into the layer's features. */
  indices: number[]
  expression: string
}

export type DialogId = 'tool' | 'add-data' | 'crs' | 'catalog' | 'activity' | 'reports' | 'workspace'

/** What a clicked citation (or an Evidence row) refers to. `nonce` makes a repeat click on the
 *  same citation fire again. */
export interface EvidenceFocus {
  resultId: string
  field?: string
  nonce: number
}

interface UiState {
  /** Read the persisted choices. Called once after mount, so the server render and the first client render agree. */
  hydrate: () => void
  /** The persisted choices are read; until then the basemap and the rest are the defaults. */
  hydrated: boolean

  inspectorTab: InspectorTab
  setInspectorTab: (tab: InspectorTab) => void
  /** Open Analysis results in the dock (the sheet's Data tab on a phone). */
  showResults: () => void
  /** Open an inspector tab and, on a phone, lift the bottom sheet so it is visible. */
  showInspector: (tab: InspectorTab) => void
  panelMode: PanelMode
  setPanelMode: (mode: PanelMode) => void

  dockTab: DockTab
  setDockTab: (tab: DockTab) => void
  dockExpanded: boolean
  setDockExpanded: (v: boolean) => void
  /** The dock shows only its tab strip, giving the map the height. Starts true on a short window. */
  dockCollapsed: boolean
  setDockCollapsed: (v: boolean) => void
  attrSelection: AttrSelection | null
  setAttrSelection: (s: AttrSelection | null) => void

  dialog: DialogId | null
  /** The operation the tool dialog is open on. */
  dialogTool: string | null
  openDialog: (dialog: DialogId, tool?: string) => void
  closeDialog: () => void
  /** The timeline scenes the tool dialog is pinned to; null when it runs on the latest imagery. */
  dialogScenes: PinScene[] | null
  /** Open the tool dialog on `tool`, pinned to scenes chosen on the timeline. */
  openToolForScenes: (tool: string, scenes: PinScene[]) => void

  mapView: MapView
  setMapView: (view: MapView) => void
  mapTool: MapTool
  setMapTool: (tool: MapTool) => void

  basemap: BasemapChoice
  setBasemap: (choice: BasemapChoice) => void
  /** Terrain relief (hillshade from the terrarium elevation tiles). */
  relief: boolean
  setRelief: (on: boolean) => void
  /** CRS for vector export (the existing reprojection in lib/vector-io). */
  exportCrs: string
  setExportCrs: (code: string) => void

  /** null = follow the viewport width (rail below 1100px); true/false = the person's choice. */
  sidebarCollapsed: boolean | null
  setSidebarCollapsed: (collapsed: boolean) => void
  /** Phone width only: the navigation slides over the map as a drawer. */
  drawerOpen: boolean
  setDrawerOpen: (open: boolean) => void

  sheetSnap: SheetSnap
  setSheetSnap: (snap: SheetSnap) => void

  locationOpen: boolean
  setLocationOpen: (open: boolean) => void

  evidenceFocus: EvidenceFocus | null
  /** Open Analysis results on a result and mark its layer on the map. */
  focusEvidence: (resultId: string, field?: string) => void
  clearEvidenceFocus: () => void

  /** Per layer, the class values shown on the map; absent = all classes. */
  classFilter: Record<string, Array<string | number>>
  setClassFilter: (layerId: string, values: Array<string | number> | null) => void
}

function initialBasemap(): BasemapChoice {
  return basemapChoice(readStorage(STORAGE_KEYS.basemap))
}

function initialSidebar(): boolean | null {
  const v = readStorage(STORAGE_KEYS.sidebar)
  return v === 'collapsed' ? true : v === 'expanded' ? false : null
}

/** Below this window height the dock starts collapsed to its tab strip, so the map keeps the room. */
export const SHORT_WINDOW_PX = 800

let focusNonce = 0

export const useUi = create<UiState>((set) => ({
  hydrate: () =>
    set({
      hydrated: true,
      basemap: initialBasemap(),
      sidebarCollapsed: initialSidebar(),
      relief: readStorage(STORAGE_KEYS.relief) !== 'off',
      exportCrs: readStorage(STORAGE_KEYS.exportCrs) || 'EPSG:4326',
      dockCollapsed: typeof window !== 'undefined' && window.innerHeight < SHORT_WINDOW_PX,
    }),
  hydrated: false,

  // Erdfeld (the assistant, with the sample cases) is what a first visit meets, not the toolbox
  inspectorTab: 'assistant',
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  showResults: () =>
    set((s) => ({
      dockTab: 'results',
      dockExpanded: true,
      dockCollapsed: false,
      inspectorTab: typeof window !== 'undefined' && window.innerWidth < 768 ? 'data' : s.inspectorTab,
      sheetSnap: s.sheetSnap === 'peek' ? 'half' : s.sheetSnap,
    })),
  showInspector: (inspectorTab) => set((s) => ({ inspectorTab, sheetSnap: s.sheetSnap === 'peek' ? 'half' : s.sheetSnap })),
  panelMode: 'ask',
  setPanelMode: (panelMode) => set({ panelMode }),

  dockTab: 'attributes',
  setDockTab: (dockTab) => set({ dockTab }),
  dockExpanded: false,
  setDockExpanded: (dockExpanded) => set(dockExpanded ? { dockExpanded, dockCollapsed: false } : { dockExpanded }),
  dockCollapsed: false,
  setDockCollapsed: (dockCollapsed) => set(dockCollapsed ? { dockCollapsed, dockExpanded: false } : { dockCollapsed }),
  attrSelection: null,
  setAttrSelection: (attrSelection) => set({ attrSelection }),

  dialog: null,
  dialogTool: null,
  openDialog: (dialog, tool) => set({ dialog, dialogTool: tool ?? null, dialogScenes: null }),
  closeDialog: () => set({ dialog: null, dialogScenes: null }),
  dialogScenes: null,
  openToolForScenes: (tool, scenes) => set({ dialog: 'tool', dialogTool: tool, dialogScenes: scenes }),

  mapView: 'map',
  setMapView: (mapView) => set({ mapView }),
  mapTool: 'select',
  setMapTool: (mapTool) => set({ mapTool }),

  basemap: DEFAULT_BASEMAP,
  setBasemap: (basemap) => {
    writeStorage(STORAGE_KEYS.basemap, basemap)
    set({ basemap })
  },
  relief: true,
  setRelief: (relief) => {
    writeStorage(STORAGE_KEYS.relief, relief ? 'on' : 'off')
    set({ relief })
  },
  exportCrs: 'EPSG:4326',
  setExportCrs: (exportCrs) => {
    writeStorage(STORAGE_KEYS.exportCrs, exportCrs)
    set({ exportCrs })
  },

  sidebarCollapsed: null,
  setSidebarCollapsed: (collapsed) => {
    writeStorage(STORAGE_KEYS.sidebar, collapsed ? 'collapsed' : 'expanded')
    set({ sidebarCollapsed: collapsed })
  },
  drawerOpen: false,
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),

  sheetSnap: 'peek',
  setSheetSnap: (sheetSnap) => set({ sheetSnap }),

  locationOpen: false,
  setLocationOpen: (locationOpen) => set({ locationOpen }),

  evidenceFocus: null,
  focusEvidence: (resultId, field) =>
    set((s) => ({
      dockTab: 'results',
      // a phone has no dock: the same content is the sheet's Data tab, opened so the row is visible
      inspectorTab: typeof window !== 'undefined' && window.innerWidth < 768 ? 'data' : s.inspectorTab,
      sheetSnap: s.sheetSnap === 'peek' ? 'half' : s.sheetSnap,
      dockExpanded: true,
      dockCollapsed: false,
      evidenceFocus: { resultId, field, nonce: ++focusNonce },
    })),
  clearEvidenceFocus: () => set({ evidenceFocus: null }),

  classFilter: {},
  setClassFilter: (layerId, values) =>
    set((s) => {
      const next = { ...s.classFilter }
      if (values && values.length > 0) next[layerId] = values
      else delete next[layerId]
      return { classFilter: next }
    }),
}))
