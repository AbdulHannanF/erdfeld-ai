'use client'

import { Circle, MousePointer2, PenLine, Pencil, Pentagon, Ruler, ScanSearch, Square, Spline, Trash2, Waypoints } from 'lucide-react'
import { GLASS } from '@/components/shell/ui'
import { useStore } from '@/store/useStore'
import { useUi, type MapTool } from '@/store/useUi'
import { cn } from '@/lib/utils'

type Entry =
  | { kind: 'tool'; id: MapTool; label: string; icon: typeof Circle }
  | { kind: 'draw'; id: string; mode: string; label: string; icon: typeof Circle }
  | { kind: 'sep' }
  | { kind: 'clear' }

/** TerraDraw modes and the map tools, in the design's order. `draw` entries set
 *  `useStore.activeDrawMode` (MapPanel passes it to TerraDraw); `tool` entries are the map's own
 *  modes (pan, identify, measure). */
const ENTRIES: Entry[] = [
  { kind: 'tool', id: 'select', label: 'Pan and select', icon: MousePointer2 },
  { kind: 'tool', id: 'identify', label: 'Identify what is at a point', icon: ScanSearch },
  { kind: 'sep' },
  { kind: 'draw', id: 'point', mode: 'point', label: 'Point', icon: Waypoints },
  { kind: 'draw', id: 'line', mode: 'linestring', label: 'Line', icon: Spline },
  { kind: 'draw', id: 'polygon', mode: 'polygon', label: 'Polygon', icon: Pentagon },
  { kind: 'draw', id: 'rectangle', mode: 'rectangle', label: 'Rectangle', icon: Square },
  { kind: 'draw', id: 'circle', mode: 'circle', label: 'Circle', icon: Circle },
  { kind: 'draw', id: 'freehand', mode: 'freehand', label: 'Freehand', icon: Pencil },
  { kind: 'sep' },
  { kind: 'tool', id: 'measure', label: 'Measure distance', icon: Ruler },
  { kind: 'draw', id: 'edit', mode: 'select', label: 'Edit a drawn shape', icon: PenLine },
  { kind: 'clear' },
]

/** What the pointer does in each mode, shown as a hint over the map while that mode is on. */
export function toolHint(mode: string | null, tool: MapTool): string | null {
  if (mode === 'polygon' || mode === 'freehand') return mode === 'polygon' ? 'Click to place points, double-click to finish' : 'Press and drag to draw, release to finish'
  if (mode === 'rectangle' || mode === 'circle') return 'Click twice to set the area'
  if (mode === 'linestring') return 'Click to place points, double-click to finish'
  if (mode === 'point') return 'Click to place a point'
  if (mode === 'select') return 'Click a drawn shape to move or reshape it'
  if (tool === 'measure') return 'Click points to measure a distance'
  if (tool === 'identify') return 'Click the map to see what is there'
  return null
}

/** The vertical tool rail on the left of the map: select, identify, point, line, polygon,
 *  rectangle, circle, freehand, measure, edit and delete. Keyboard: Tab to the rail, then each
 *  button is a toggle. Tooltips show on hover and on keyboard focus. */
export default function DrawRail({ className }: { className?: string }) {
  const activeDrawMode = useStore((s) => s.activeDrawMode)
  const setActiveDrawMode = useStore((s) => s.setActiveDrawMode)
  const aoi = useStore((s) => s.aoi)
  const setAoi = useStore((s) => s.setAoi)
  const mapTool = useUi((s) => s.mapTool)
  const setMapTool = useUi((s) => s.setMapTool)

  const pressed = (e: Entry) =>
    e.kind === 'tool' ? activeDrawMode === null && mapTool === e.id : e.kind === 'draw' ? activeDrawMode === e.mode : false

  const choose = (e: Entry) => {
    if (e.kind === 'tool') {
      setActiveDrawMode(null)
      setMapTool(e.id)
    } else if (e.kind === 'draw') {
      if (activeDrawMode === e.mode) {
        setActiveDrawMode(null)
        setMapTool('select')
      } else {
        setMapTool('select')
        setActiveDrawMode(e.mode)
      }
    }
  }

  return (
    <nav aria-label="Draw and measure tools" className={cn('grid gap-[0.1875rem] rounded-lg p-[0.3125rem] [@container(max-height:35rem)]:max-h-[calc(100%-11rem)] [@container(max-height:35rem)]:overflow-y-auto [@container(max-height:35rem)]:overscroll-contain', GLASS, className)} data-testid="draw-rail">
      {ENTRIES.map((e, i) => {
        if (e.kind === 'sep') return <span key={i} className="mx-1 my-0.5 h-px bg-border" role="separator" aria-hidden />
        if (e.kind === 'clear') {
          return (
            <button
              key="clear"
              type="button"
              disabled={!aoi}
              onClick={() => setAoi(null)}
              aria-label="Clear the area of interest"
              title="Clear area"
              data-testid="draw-clear"
              className="btn btn-ghost btn-icon-md relative"
            >
              <Trash2 aria-hidden />
              <span role="tooltip" className="pointer-events-none absolute left-[calc(100%+0.4375rem)] top-1/2 -translate-y-1/2 whitespace-nowrap rounded-sm border border-input bg-popover px-2 py-1 text-caption text-popover-foreground opacity-0 group-hover/t:opacity-100 group-focus-visible/t:opacity-100 max-md:hidden [@container(max-height:35rem)]:hidden">Clear area</span>
            </button>
          )
        }
        const Icon = e.icon
        const on = pressed(e)
        return (
          <button
            key={e.id}
            type="button"
            aria-pressed={on}
            aria-label={e.label}
            title={e.label}
            data-testid={`draw-${e.id}`}
            onClick={() => choose(e)}
            className={cn(
              'btn btn-ghost btn-icon-md relative',
              on && 'bg-accent text-accent-foreground',
            )}
          >
            <Icon aria-hidden />
            <span role="tooltip" className="pointer-events-none absolute left-[calc(100%+0.4375rem)] top-1/2 -translate-y-1/2 whitespace-nowrap rounded-sm border border-input bg-popover px-2 py-1 text-caption text-popover-foreground opacity-0 group-hover/t:opacity-100 group-focus-visible/t:opacity-100 max-md:hidden [@container(max-height:35rem)]:hidden">{e.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
