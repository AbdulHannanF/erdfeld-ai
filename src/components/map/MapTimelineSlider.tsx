'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Play, Pause, ChevronLeft, ChevronRight, Clock, CalendarRange } from 'lucide-react'
import { useStore } from '@/store/useStore'
import { Slider } from '@/components/ui/slider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// ---------------------------------------------------------------------------
// MapTimelineSlider
// ---------------------------------------------------------------------------
// Stable id of the raster layer fed by `fetch_temporal_stack`. The slider drives
// `setLayerTileUrl` on this id; MapPanel's `updateMapLayer` swaps the source via
// MapLibre's native `setTiles` so frame changes never flicker.
const TEMPORAL_LAYER_ID = 'ndvi-temporal'

export default function MapTimelineSlider({ onBrowse }: { onBrowse?: () => void } = {}) {
  const temporalFrames = useStore((s) => s.temporalFrames)
  const currentIndex = useStore((s) => s.activeFrameIndex)
  const setCurrentIndex = useStore((s) => s.setActiveFrameIndex)
  const setLayerTileUrl = useStore((s) => s.setLayerTileUrl)

  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const totalFrames = temporalFrames.length

  // Keep currentIndex inside [0, totalFrames-1] when the stack changes
  useEffect(() => {
    if (totalFrames === 0 && currentIndex !== 0) {
      setCurrentIndex(0)
    } else if (totalFrames > 0 && currentIndex >= totalFrames) {
      setCurrentIndex(totalFrames - 1)
    }
  }, [totalFrames, currentIndex, setCurrentIndex])

  // ---- Auto-play logic ----
  useEffect(() => {
    if (!isPlaying || totalFrames === 0) return

    const intervalMs = 2000 / speed
    intervalRef.current = setInterval(() => {
      const state = useStore.getState()
      const next = state.activeFrameIndex + 1
      state.setActiveFrameIndex(next >= state.temporalFrames.length ? 0 : next)
    }, intervalMs)

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [isPlaying, speed, totalFrames])

  // ---- Toggle play/pause ----
  const togglePlay = useCallback(() => setIsPlaying((p) => !p), [])

  // ---- Step backward ----
  const stepBack = useCallback(() => {
    setIsPlaying(false)
    setCurrentIndex(currentIndex > 0 ? currentIndex - 1 : Math.max(totalFrames - 1, 0))
  }, [currentIndex, totalFrames, setCurrentIndex])

  // ---- Step forward ----
  const stepForward = useCallback(() => {
    setIsPlaying(false)
    setCurrentIndex(currentIndex < totalFrames - 1 ? currentIndex + 1 : 0)
  }, [currentIndex, totalFrames, setCurrentIndex])

  // ---- Handle slider change ----
  const handleSliderChange = useCallback(
    (value: number[]) => {
      setIsPlaying(false)
      setCurrentIndex(value[0])
    },
    [setCurrentIndex],
  )

  // ---- Frame-swap effect: feed the active frame's tileUrl into the
  //      stable `ndvi-temporal` raster layer. MapPanel handles the in-place
  //      source swap via `setTiles` so there is no flicker.
  useEffect(() => {
    if (totalFrames === 0) return
    const frame = temporalFrames[currentIndex]
    if (!frame?.tileUrl) return
    const layer = useStore.getState().layers.find((l) => l.id === TEMPORAL_LAYER_ID)
    if (!layer) return
    if (layer.tileUrl !== frame.tileUrl) {
      setLayerTileUrl(TEMPORAL_LAYER_ID, frame.tileUrl, `NDVI Temporal · ${frame.date}`)
    }
  }, [currentIndex, temporalFrames, totalFrames, setLayerTileUrl])

  // ---- Format date for display ----
  const formatDate = useCallback((dateStr: string): string => {
    try {
      const d = new Date(dateStr)
      if (isNaN(d.getTime())) return dateStr
      return d.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    } catch {
      return dateStr
    }
  }, [])

  // No dated scenes: the design's resting bar, disabled, saying why.
  if (totalFrames === 0) {
    return (
      <div className="glass flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 max-md:hidden" data-testid="time-nav" aria-label="Time navigation">
        <span className="grid size-7 place-items-center rounded-md border border-border text-brand-text"><Clock className="size-3.5" aria-hidden /></span>
        <span className="min-w-0 flex-1">
          <strong className="block text-body-strong text-foreground">Time navigation</strong>
          <small className="mt-0.5 block text-data text-muted-foreground">No temporal layer active</small>
        </span>
        {onBrowse && <button type="button" className="btn btn-secondary btn-sm" onClick={onBrowse} data-testid="open-archive"><CalendarRange aria-hidden />Browse scenes</button>}
      </div>
    )
  }

  const currentFrame = temporalFrames[currentIndex]
  const currentDate = currentFrame?.date ?? ''
  const currentCloud = currentFrame?.cloud
  const currentAoiClear = currentFrame?.aoiClearPct
  const caption = [
    formatDate(currentDate),
    typeof currentCloud === 'number' ? `${currentCloud.toFixed(0)}% scene cloud` : null,
    typeof currentAoiClear === 'number' ? `${currentAoiClear.toFixed(0)}% clear over the area` : null,
  ].filter(Boolean).join(' · ')

  return (
    <div className="glass flex w-[min(35rem,100%)] items-center gap-2 rounded-lg px-2.5 py-1.5" data-testid="time-nav" aria-label="Time navigation">
      <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border text-brand-text max-sm:hidden"><Clock className="size-3.5" aria-hidden /></span>
      <span className="min-w-0 max-w-[11.875rem] shrink-0">
        <strong className="block text-body-strong text-foreground">Time navigation</strong>
        <small className="mt-0.5 block truncate text-data text-muted-foreground" title="Scene-wide cloud is the whole granule from STAC metadata; clear over the area is from the per-pixel mask inside your polygon" aria-live="polite">{caption}</small>
      </span>
      <button onClick={stepBack} className="btn btn-ghost btn-icon-sm shrink-0" aria-label="Previous frame"><ChevronLeft aria-hidden /></button>
      <button onClick={togglePlay} className={`grid size-7 shrink-0 place-items-center rounded-sm transition-colors ${isPlaying ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-hover'}`} aria-label={isPlaying ? 'Pause' : 'Play'} aria-pressed={isPlaying}>
        {isPlaying ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
      </button>
      <button onClick={stepForward} className="btn btn-ghost btn-icon-sm shrink-0" aria-label="Next frame"><ChevronRight aria-hidden /></button>
      <Slider
        value={[currentIndex]}
        min={0}
        max={totalFrames - 1}
        step={1}
        onValueChange={handleSliderChange}
        aria-label="Temporal frame"
        className="min-w-[3.75rem] flex-1 [&_[data-slot=slider-track]]:h-1 [&_[data-slot=slider-range]]:bg-teal [&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-thumb]]:border-teal"
      />
      <span className="shrink-0 text-data text-muted-foreground">{currentIndex + 1}/{totalFrames}</span>
      {onBrowse && <button type="button" className="btn btn-ghost btn-icon-sm shrink-0" onClick={onBrowse} aria-label="Browse the whole imagery archive" title="Browse the whole archive"><CalendarRange aria-hidden /></button>}
      <Select value={String(speed)} onValueChange={(v) => setSpeed(parseFloat(v))}>
        <SelectTrigger size="sm" aria-label="Playback speed" className="h-7 w-[4.25rem] shrink-0 border-border bg-secondary text-caption text-muted-foreground max-sm:hidden">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="0.5" className="text-caption">0.5x</SelectItem>
          <SelectItem value="1" className="text-caption">1x</SelectItem>
          <SelectItem value="2" className="text-caption">2x</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
