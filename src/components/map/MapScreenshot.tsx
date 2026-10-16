'use client'

import { useState, useCallback, useEffect } from 'react'
import * as maplibregl from '@/lib/maplibre'
import { Camera } from 'lucide-react'
import { toast } from 'sonner'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface MapScreenshotProps {
  map: maplibregl.Map | null
  screenshotRef?: React.MutableRefObject<(() => void) | null>
}

export default function MapScreenshot({ map, screenshotRef }: MapScreenshotProps) {
  const [isFlashing, setIsFlashing] = useState(false)

  const takeScreenshot = useCallback(() => {
    if (!map) return

    try {
      // Trigger flash animation
      setIsFlashing(true)

      // Small delay so the flash is visible before capture
      setTimeout(() => {
        try {
          const canvas = map.getCanvas()
          const dataUrl = canvas.toDataURL('image/png')

          // Create download link
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
          const filename = `erdfeld-screenshot-${timestamp}.png`

          const link = document.createElement('a')
          link.download = filename
          link.href = dataUrl
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)

          toast.success('Screenshot saved', {
            description: filename,
          })
        } catch (err) {
          toast.error('Failed to capture screenshot', {
            description: err instanceof Error ? err.message : 'Unknown error',
          })
        }

        // Remove flash after a short delay
        setTimeout(() => {
          setIsFlashing(false)
        }, 300)
      }, 150)
    } catch (err) {
      setIsFlashing(false)
      toast.error('Failed to capture screenshot', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }, [map])

  // Expose takeScreenshot via ref for toolbar integration
  useEffect(() => {
    if (screenshotRef) {
      screenshotRef.current = takeScreenshot
    }
  }, [takeScreenshot, screenshotRef])

  return (
    <>
      {/* Flash overlay */}
      <div
        className={`absolute inset-0 z-30 bg-foreground pointer-events-none transition-opacity duration-150 ${
          isFlashing ? 'opacity-60' : 'opacity-0'
        }`}
      />
    </>
  )
}
