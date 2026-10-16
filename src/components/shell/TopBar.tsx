'use client'

import { useSyncExternalStore } from 'react'
import { Check, Download, History, Menu, Paperclip, Search, Share2 } from 'lucide-react'
import { BrandMark } from '@/components/shell/BrandMark'
import { HealthDot } from '@/components/shell/HealthDot'
import { MoreMenu } from '@/components/shell/MoreMenu'
import NotificationPanel from '@/components/shell/NotificationPanel'
import ProjectsPanel from '@/components/shell/ProjectsPanel'
import { ThemeToggle } from '@/components/shell/ThemeToggle'
import { BTN, BTN_PRIMARY, ICON_BTN } from '@/components/shell/ui'
import ExportMenu from '@/components/answer/ExportMenu'
import ShareMenu from '@/components/answer/ShareMenu'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { aoiAreaKm2, formatAreaKm2 } from '@/lib/aoi'
import { cn } from '@/lib/utils'

const subscribe = () => () => {}
const isMacSnapshot = () => /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)

/** The 54px bar: where you are (workspace / project and its honest state), the environment, then
 *  Add data, Save, Share and Export, with the app's own tools (notifications, theme, command
 *  palette, more) beside them. On a phone it is a compact 48px bar with icon buttons. */
export function TopBar() {
  const aoi = useStore((s) => s.aoi)
  const projectName = useStore((s) => s.projectName)
  const projectId = useStore((s) => s.currentProjectId)
  const previewMode = useStore((s) => s.previewMode)
  const previewName = useStore((s) => s.previewMeta?.name)
  const hasContent = useStore((s) => s.layers.length > 0 || s.messages.length > 0)
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen)
  const setDrawerOpen = useUi((s) => s.setDrawerOpen)
  const openDialog = useUi((s) => s.openDialog)
  const isMac = useSyncExternalStore(subscribe, isMacSnapshot, () => false)

  const km2 = aoiAreaKm2(aoi?.geometry)
  const title = previewName ?? projectName ?? (aoi ? `${aoi.type} area${km2 != null ? ` · ${formatAreaKm2(km2)}` : ''}` : 'Untitled project')
  // The chip only says what is true: a snapshot someone shared, a saved project, or work not yet saved.
  const chip = previewMode
    ? { text: 'SHARED SNAPSHOT', cls: 'border-[#a7824c45] bg-[#c6a16d12] text-warning' }
    : projectId
      ? { text: 'SAVED', cls: 'border-[#3d8d6755] bg-[#3d8d6712] text-[var(--success)]' }
      : hasContent
        ? { text: 'UNSAVED', cls: 'border-border bg-secondary text-muted-foreground' }
        : null

  const label = 'max-[1000px]:sr-only max-md:sr-only'

  return (
    <header className="flex h-[3.375rem] items-center justify-between gap-3 bg-card px-[1.0625rem] max-md:h-12 max-md:gap-1.5 max-md:px-2">
      <div className="flex min-w-0 items-center gap-2 max-md:gap-1">
        <button type="button" onClick={() => setDrawerOpen(true)} className={cn(ICON_BTN, 'md:hidden')} aria-label="Open the navigation" data-testid="open-drawer">
          <Menu className="size-[1.125rem]" aria-hidden />
        </button>
        <a href="/" className="rounded-sm md:hidden" aria-label="Erdfeld AI home"><BrandMark variant="mark" height={26} /></a>
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-[0.5625rem] font-mono text-xs tracking-[0.06em] text-muted-foreground">
          <span className="max-md:hidden">WORKSPACE</span>
          <b aria-hidden className="font-normal text-[#48534e] max-md:hidden">/</b>
          <strong className="min-w-0 truncate font-sans text-[0.875rem] font-medium tracking-normal text-foreground max-md:max-w-[34vw]" data-testid="breadcrumb-where" title={title}>{title}</strong>
          {chip && <i className={cn('shrink-0 rounded border px-[0.375rem] py-[0.1875rem] text-xs not-italic tracking-[0.04em]', chip.cls)} data-testid="project-chip">{chip.text}</i>}
        </nav>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 max-md:gap-0.5">
        <HealthDot variant="pill" className="mr-1.5 max-[1100px]:hidden" />
        <button type="button" onClick={() => setCommandPaletteOpen(true)} className={cn(BTN, 'max-md:hidden max-[1250px]:px-2')} aria-label="Search and commands" aria-keyshortcuts="Control+K Meta+K" data-testid="open-palette" title="Command palette">
          <Search className="size-3.5" aria-hidden />
          <kbd className="font-mono text-xs text-muted-foreground max-[1250px]:hidden">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <button type="button" onClick={() => openDialog('activity')} className={cn(BTN, 'px-2 max-md:hidden')} aria-label="Activity history" title="Activity history">
          <History className="size-3.5" aria-hidden />
        </button>
        <button type="button" onClick={() => openDialog('add-data')} className={cn(BTN, 'max-md:size-9 max-md:border-transparent max-md:bg-transparent max-md:px-0')} data-testid="add-data" title="Add data">
          <Paperclip className="size-3.5" aria-hidden /><span className={label}>Add data</span>
        </button>
        <ProjectsPanel>
          <button type="button" className={cn(BTN, 'max-md:hidden')} data-testid="save-project" title="Save the project">
            <Check className="size-3.5" aria-hidden /><span className={label}>Save</span>
          </button>
        </ProjectsPanel>
        <ShareMenu>
          <button type="button" className={cn(BTN, 'max-md:hidden')} data-testid="share" title="Share">
            <Share2 className="size-3.5" aria-hidden /><span className={label}>Share</span>
          </button>
        </ShareMenu>
        <ExportMenu>
          <button type="button" className={cn(BTN_PRIMARY, 'max-md:size-9 max-md:px-0')} data-testid="export" title="Export">
            <Download className="size-3.5" aria-hidden /><span className={label}>Export</span>
          </button>
        </ExportMenu>
        <span className="mx-0.5 h-5 w-px bg-border max-md:hidden" aria-hidden />
        <span className="max-md:hidden"><NotificationPanel /></span>
        <span className="max-md:hidden"><ThemeToggle /></span>
        <MoreMenu className={cn(ICON_BTN, 'max-md:size-9')} />
      </div>
    </header>
  )
}
