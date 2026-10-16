'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import * as maplibregl from '@/lib/maplibre'
import { Columns, X } from 'lucide-react'
import { useStore } from '@/store/useStore'
import { STORAGE_KEYS, readStorage, writeStorage } from '@/lib/storage'
import { MAP_STYLES, getStyleValue } from '@/components/map/basemaps'
import 'maplibre-gl/dist/maplibre-gl.css'

// ---------------------------------------------------------------------------
// Style selector dropdown for each compare half
// ---------------------------------------------------------------------------

function StyleDropdown({
  currentStyle,
  onStyleChange,
  label,
}: {
  currentStyle: string
  onStyleChange: (styleId: string) => void
  label: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-popover/90 border border-border text-caption-strong text-foreground hover:bg-popover/90 hover:border-brand-500/30 transition-all"
      >
        <span className="text-muted-foreground">{label}:</span>
        <span className="text-brand-text">
          {MAP_STYLES.find((s) => s.id === currentStyle)?.name ?? currentStyle}
        </span>
        <svg
          className={`h-3 w-3 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full mt-1 left-0 z-50 rounded-lg bg-popover/90 border border-border py-1 min-w-[7.5rem] shadow-xl">
            {MAP_STYLES.map((style) => (
              <button
                key={style.id}
                onClick={() => {
                  onStyleChange(style.id)
                  setOpen(false)
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-caption transition-colors ${
                  currentStyle === style.id
                    ? 'text-brand-text bg-brand-500/10'
                    : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06]'
                }`}
              >
                <span
                  className="inline-block h-3 w-3 rounded-sm border border-border shrink-0"
                  style={{ backgroundColor: style.previewColor }}
                />
                {style.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Compare view
// ---------------------------------------------------------------------------

interface MapCompareViewProps {
  mainMap: maplibregl.Map | null
  isActive: boolean
  onToggle: () => void
}

export default function MapCompareView({ mainMap, isActive, onToggle }: MapCompareViewProps) {
  const [splitRatio, setSplitRatio] = useState(0.5)
  // Left: the map in the theme in use; right: satellite imagery, the comparison people ask for.
  const [leftStyle, setLeftStyle] = useState(() => (useStore.getState().mapStyle === 'satellite' ? 'dark' : useStore.getState().mapStyle))
  const [rightStyle, setRightStyle] = useState('satellite')
  const [showTooltip, setShowTooltip] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const leftMapRef = useRef<maplibregl.Map | null>(null)
  const rightMapRef = useRef<maplibregl.Map | null>(null)
  const leftContainerRef = useRef<HTMLDivElement>(null)
  const rightContainerRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const syncing = useRef(false)

  // Show tooltip on first activation (use ref to avoid setState-in-effect)
  const tooltipShownRef = useRef(false)
  useEffect(() => {
    if (isActive && !tooltipShownRef.current) {
      const seen = readStorage(STORAGE_KEYS.compareSeen)
      if (!seen) {
        tooltipShownRef.current = true
        writeStorage(STORAGE_KEYS.compareSeen, 'true')
        // Use setTimeout to avoid synchronous setState in effect
        const showTimer = setTimeout(() => setShowTooltip(true), 0)
        const hideTimer = setTimeout(() => setShowTooltip(false), 5000)
        return () => {
          clearTimeout(showTimer)
          clearTimeout(hideTimer)
        }
      }
    }
  }, [isActive])

  // Initialize compare maps when activated
  useEffect(() => {
    if (!isActive || !mainMap || !containerRef.current) return
    if (leftMapRef.current) return // Already initialized

    const center = mainMap.getCenter()
    const zoom = mainMap.getZoom()
    const bearing = mainMap.getBearing()
    const pitch = mainMap.getPitch()

    // Left map
    if (leftContainerRef.current) {
      const leftMap = new maplibregl.Map({
        container: leftContainerRef.current,
        style: getStyleValue(leftStyle) as string | maplibregl.StyleSpecification,
        center: [center.lng, center.lat],
        zoom,
        bearing,
        pitch,
        attributionControl: false,
        interactive: true,
      })
      leftMapRef.current = leftMap
    }

    // Right map
    if (rightContainerRef.current) {
      const rightMap = new maplibregl.Map({
        container: rightContainerRef.current,
        style: getStyleValue(rightStyle) as string | maplibregl.StyleSpecification,
        center: [center.lng, center.lat],
        zoom,
        bearing,
        pitch,
        attributionControl: false,
        interactive: true,
      })
      rightMapRef.current = rightMap
    }

    // Sync move events between maps
    const syncMove = (source: maplibregl.Map, target: maplibregl.Map | null) => {
      if (!target || syncing.current) return
      syncing.current = true
      target.jumpTo({
        center: source.getCenter(),
        zoom: source.getZoom(),
        bearing: source.getBearing(),
        pitch: source.getPitch(),
      })
      syncing.current = false
    }

    const onLeftMove = () => syncMove(leftMapRef.current!, rightMapRef.current)
    const onRightMove = () => syncMove(rightMapRef.current!, leftMapRef.current)

    if (leftMapRef.current) {
      leftMapRef.current.on('move', onLeftMove)
    }
    if (rightMapRef.current) {
      rightMapRef.current.on('move', onRightMove)
    }

    return () => {
      if (leftMapRef.current) {
        leftMapRef.current.off('move', onLeftMove)
        leftMapRef.current.remove()
        leftMapRef.current = null
      }
      if (rightMapRef.current) {
        rightMapRef.current.off('move', onRightMove)
        rightMapRef.current.remove()
        rightMapRef.current = null
      }
    }
  }, [isActive, mainMap, leftStyle])

  // Handle style changes for left map
  useEffect(() => {
    if (!isActive || !leftMapRef.current) return
    leftMapRef.current.setStyle(getStyleValue(leftStyle) as string | maplibregl.StyleSpecification)
  }, [leftStyle, isActive])

  // Handle style changes for right map
  useEffect(() => {
    if (!isActive || !rightMapRef.current) return
    rightMapRef.current.setStyle(getStyleValue(rightStyle) as string | maplibregl.StyleSpecification)
  }, [rightStyle, isActive])

  // Drag handler for split divider
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
  }, [])

  useEffect(() => {
    if (!isActive) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const ratio = Math.max(0.15, Math.min(0.85, (e.clientX - rect.left) / rect.width))
      setSplitRatio(ratio)
    }

    const handleMouseUp = () => {
      isDragging.current = false
    }

    // Touch support
    const handleTouchMove = (e: TouchEvent) => {
      if (!isDragging.current || !containerRef.current) return
      const touch = e.touches[0]
      const rect = containerRef.current.getBoundingClientRect()
      const ratio = Math.max(0.15, Math.min(0.85, (touch.clientX - rect.left) / rect.width))
      setSplitRatio(ratio)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('touchmove', handleTouchMove)
    window.addEventListener('touchend', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('touchmove', handleTouchMove)
      window.removeEventListener('touchend', handleMouseUp)
    }
  }, [isActive])

  // Resize maps when split ratio changes
  useEffect(() => {
    if (!isActive) return
    const timer = setTimeout(() => {
      leftMapRef.current?.resize()
      rightMapRef.current?.resize()
    }, 50)
    return () => clearTimeout(timer)
  }, [splitRatio, isActive])

  if (!isActive) return null

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-30 flex"
    >
      {/* Left half - "Before" */}
      <div
        className="relative h-full"
        style={{ width: `${splitRatio * 100}%` }}
      >
        <div ref={leftContainerRef} className="absolute inset-0" />

        {/* "Before" label */}
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10">
          <div className="px-3 py-1 rounded-lg bg-popover/90 border border-border text-caption-strong text-foreground shadow-lg">
            Before
          </div>
        </div>

        {/* Style selector for left */}
        <div className="absolute top-12 left-3 z-10">
          <StyleDropdown
            currentStyle={leftStyle}
            onStyleChange={setLeftStyle}
            label="Style"
          />
        </div>
      </div>

      {/* Divider with drag handle */}
      <div
        className="relative w-0 z-40"
        style={{ cursor: 'col-resize' }}
        onMouseDown={handleMouseDown}
        onTouchStart={(e) => handleMouseDown(e as unknown as React.MouseEvent)}
      >
        {/* Visible divider line */}
        <div className="absolute inset-y-0 -left-[1px] w-[0.125rem] bg-brand-400/40 shadow-lg" />

        {/* Drag handle */}
        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 flex items-center justify-center h-10 w-6 rounded-full bg-popover/90 border border-brand-500/30 shadow-lg hover:bg-popover/90 hover:border-brand-400/50 transition-colors cursor-col-resize">
          <div className="flex flex-col gap-[0.125rem]">
            <div className="h-[0.125rem] w-[0.125rem] rounded-full bg-muted-foreground" />
            <div className="h-[0.125rem] w-[0.125rem] rounded-full bg-muted-foreground" />
            <div className="h-[0.125rem] w-[0.125rem] rounded-full bg-muted-foreground" />
          </div>
        </div>
      </div>

      {/* Right half - "After" */}
      <div
        className="relative h-full"
        style={{ width: `${(1 - splitRatio) * 100}%` }}
      >
        <div ref={rightContainerRef} className="absolute inset-0" />

        {/* "After" label */}
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10">
          <div className="px-3 py-1 rounded-lg bg-popover/90 border border-border text-caption-strong text-foreground shadow-lg">
            After
          </div>
        </div>

        {/* Style selector for right */}
        <div className="absolute top-12 right-3 z-10">
          <StyleDropdown
            currentStyle={rightStyle}
            onStyleChange={setRightStyle}
            label="Style"
          />
        </div>
      </div>

      {/* Close button */}
      <button
        onClick={onToggle}
        className="btn btn-ghost btn-icon-md absolute top-3 right-3 z-50"
        title="Close compare view"
      >
        <X />
      </button>

      {/* First-use tooltip */}
      {showTooltip && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-50 animate-fade-in-up">
          <div className="px-4 py-2.5 rounded-lg bg-brand-500/15 border border-brand-500/30 text-caption text-brand-text shadow-lg max-w-[17.5rem] text-center">
            Drag the center divider to adjust the split. Each side has its own style selector.
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Trigger button (renders in MapPanel)
// ---------------------------------------------------------------------------

export function MapCompareButton({
  isActive,
  onToggle,
}: {
  isActive: boolean
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      className={`map-overlay-btn absolute top-[14.5rem] left-3 z-10 flex items-center justify-center h-8 w-8 rounded-lg border transition-all ${
        isActive
          ? 'bg-brand-500/20 border-brand-500/30 text-brand-text'
          : 'bg-popover/90 border-border text-muted-foreground hover:text-brand-text hover:border-brand-500/30'
      }`}
      title={isActive ? 'Close compare view' : 'Compare map views'}
    >
      <Columns />
    </button>
  )
}
