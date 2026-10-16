'use client'

import { useState, useCallback, useEffect } from 'react'
import { Crosshair, Navigation, MapPin } from 'lucide-react'
import { toast } from 'sonner'
import { useStore } from '@/store/useStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// ---------------------------------------------------------------------------
// Preset locations
// ---------------------------------------------------------------------------

const PRESET_LOCATIONS = [
  { name: 'New York', lng: -74.006, lat: 40.7128, zoom: 12 },
  { name: 'London', lng: -0.1276, lat: 51.5074, zoom: 12 },
  { name: 'Tokyo', lng: 139.6917, lat: 35.6895, zoom: 12 },
  { name: 'Dubai', lng: 55.2708, lat: 25.2048, zoom: 12 },
  { name: 'Paris', lng: 2.3522, lat: 48.8566, zoom: 13 },
  { name: 'Sydney', lng: 151.2093, lat: -33.8688, zoom: 12 },
]

// ---------------------------------------------------------------------------
// CoordinateInputDialog
// ---------------------------------------------------------------------------

export default function CoordinateInputDialog({ coordinateInputRef }: { coordinateInputRef?: React.MutableRefObject<(() => void) | null> }) {
  const setFlyToTarget = useStore((s) => s.setFlyToTarget)
  const [open, setOpen] = useState(false)
  const [longitude, setLongitude] = useState('')
  const [latitude, setLatitude] = useState('')
  const [zoom, setZoom] = useState('14')
  const [errors, setErrors] = useState<{ lng?: string; lat?: string; zoom?: string }>({})

  const validate = useCallback((): boolean => {
    const newErrors: { lng?: string; lat?: string; zoom?: string } = {}
    const lngVal = parseFloat(longitude)
    const latVal = parseFloat(latitude)
    const zoomVal = parseInt(zoom, 10)

    if (!longitude || isNaN(lngVal)) {
      newErrors.lng = 'Enter a valid number'
    } else if (lngVal < -180 || lngVal > 180) {
      newErrors.lng = 'Must be -180 to 180'
    }

    if (!latitude || isNaN(latVal)) {
      newErrors.lat = 'Enter a valid number'
    } else if (latVal < -90 || latVal > 90) {
      newErrors.lat = 'Must be -90 to 90'
    }

    if (!zoom || isNaN(zoomVal)) {
      newErrors.zoom = 'Enter a valid number'
    } else if (zoomVal < 1 || zoomVal > 20) {
      newErrors.zoom = 'Must be 1 to 20'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }, [longitude, latitude, zoom])

  const handleGo = useCallback(() => {
    if (!validate()) return

    const lngVal = parseFloat(longitude)
    const latVal = parseFloat(latitude)
    const zoomVal = parseInt(zoom, 10)

    setFlyToTarget({ lng: lngVal, lat: latVal, zoom: zoomVal })
    toast.success(`Flying to ${lngVal.toFixed(4)}, ${latVal.toFixed(4)}`)
    setOpen(false)
  }, [longitude, latitude, zoom, validate, setFlyToTarget])

  const handlePresetClick = useCallback(
    (preset: (typeof PRESET_LOCATIONS)[number]) => {
      setLongitude(preset.lng.toString())
      setLatitude(preset.lat.toString())
      setZoom(preset.zoom.toString())
      setErrors({})
    },
    [],
  )

  // Expose open dialog via ref for toolbar integration
  useEffect(() => {
    if (coordinateInputRef) {
      coordinateInputRef.current = () => setOpen(true)
    }
  }, [coordinateInputRef])

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      setOpen(isOpen)
      if (isOpen) {
        setLongitude('')
        setLatitude('')
        setZoom('14')
        setErrors({})
      }
    },
    [],
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="bg-card border-border text-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-foreground flex items-center gap-2">
            <Crosshair className="h-5 w-5 text-brand-text" />
            Jump to Coordinates
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Enter coordinates to fly the map to a specific location.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {/* Longitude */}
          <div className="grid gap-2">
            <Label htmlFor="coord-lng" className="text-muted-foreground text-body">
              Longitude (decimal degrees)
            </Label>
            <Input
              id="coord-lng"
              type="number"
              step="any"
              placeholder="-74.0060"
              value={longitude}
              onChange={(e) => {
                setLongitude(e.target.value)
                if (errors.lng) setErrors((prev) => ({ ...prev, lng: undefined }))
              }}
              className="bg-muted/80 border-border text-foreground placeholder:text-muted-foreground focus-visible:ring-brand-500/40 focus-visible:border-brand-500/40"
            />
            {errors.lng && (
              <p className="text-caption text-danger">{errors.lng}</p>
            )}
          </div>

          {/* Latitude */}
          <div className="grid gap-2">
            <Label htmlFor="coord-lat" className="text-muted-foreground text-body">
              Latitude (decimal degrees)
            </Label>
            <Input
              id="coord-lat"
              type="number"
              step="any"
              placeholder="40.7128"
              value={latitude}
              onChange={(e) => {
                setLatitude(e.target.value)
                if (errors.lat) setErrors((prev) => ({ ...prev, lat: undefined }))
              }}
              className="bg-muted/80 border-border text-foreground placeholder:text-muted-foreground focus-visible:ring-brand-500/40 focus-visible:border-brand-500/40"
            />
            {errors.lat && (
              <p className="text-caption text-danger">{errors.lat}</p>
            )}
          </div>

          {/* Zoom */}
          <div className="grid gap-2">
            <Label htmlFor="coord-zoom" className="text-muted-foreground text-body">
              Zoom level (1–20)
            </Label>
            <Input
              id="coord-zoom"
              type="number"
              min={1}
              max={20}
              placeholder="14"
              value={zoom}
              onChange={(e) => {
                setZoom(e.target.value)
                if (errors.zoom) setErrors((prev) => ({ ...prev, zoom: undefined }))
              }}
              className="bg-muted/80 border-border text-foreground placeholder:text-muted-foreground focus-visible:ring-brand-500/40 focus-visible:border-brand-500/40"
            />
            {errors.zoom && (
              <p className="text-caption text-danger">{errors.zoom}</p>
            )}
          </div>

          {/* Preset locations */}
          <div className="space-y-2">
            <Label className="text-muted-foreground text-caption">Quick jump</Label>
            <div className="flex flex-wrap gap-2">
              {PRESET_LOCATIONS.map((preset) => (
                <button
                  key={preset.name}
                  onClick={() => handlePresetClick(preset)}
                  className="chip"
                >
                  <MapPin aria-hidden />
                  {preset.name}
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => setOpen(false)}
           
          >
            Cancel
          </Button>
          <Button
            onClick={handleGo}
           
          >
            <Navigation className="h-4 w-4 mr-1.5" />
            Go
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
