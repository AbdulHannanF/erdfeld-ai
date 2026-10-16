'use client'

import { useState } from 'react'
import { Check, Command, Crosshair, History, Info, Keyboard, MoreHorizontal, PenTool, Share2 } from 'lucide-react'
import ShareMenu from '@/components/answer/ShareMenu'
import ProjectsPanel from '@/components/shell/ProjectsPanel'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { requestMapAction } from '@/lib/ui-events'

const item = 'flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-[0.8125rem] text-foreground transition-colors hover:bg-hover [&_svg]:size-4 [&_svg]:text-muted-foreground'

/** The map and data tools that have no permanent place in the layout: the map-centre details, the
 *  coordinate jump, the drawing panel, the shortcut reference and the command palette. On a phone
 *  it also carries Save, Share and Activity history, which have their own buttons from tablet
 *  width up. */
export function MoreMenu({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const setLocationOpen = useUi((s) => s.setLocationOpen)
  const openDialog = useUi((s) => s.openDialog)
  const setShowShortcuts = useStore((s) => s.setShowShortcuts)
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen)

  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={className} aria-label="More tools" title="More tools" data-testid="more-menu">
          <MoreHorizontal className="size-[1.0625rem]" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1.5">
        <div className="md:hidden">
          <ProjectsPanel>
            <button type="button" className={item}><Check aria-hidden />Save the project</button>
          </ProjectsPanel>
          <ShareMenu>
            <button type="button" className={item}><Share2 aria-hidden />Share</button>
          </ShareMenu>
          <button type="button" className={item} onClick={run(() => openDialog('activity'))}><History aria-hidden />Activity history</button>
          <button type="button" className={item} onClick={run(() => setCommandPaletteOpen(true))}><Command aria-hidden />Search and commands</button>
        </div>
        <button type="button" className={item} onClick={run(() => setLocationOpen(true))}>
          <Info aria-hidden />Location details
        </button>
        <button type="button" className={item} onClick={run(() => requestMapAction('coordinates'))}>
          <Crosshair aria-hidden />Jump to coordinates
        </button>
        <button type="button" className={item} onClick={run(() => requestMapAction('drawing-panel'))}>
          <PenTool aria-hidden />Drawing panel
        </button>
        <button type="button" className={item} onClick={run(() => setShowShortcuts(true))}>
          <Keyboard aria-hidden />Keyboard shortcuts
        </button>
      </PopoverContent>
    </Popover>
  )
}
