'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import * as maplibregl from '@/lib/maplibre'
import {
  Info,
  MapPin,
  Navigation,
  Compass,
  Sun,
  Sunrise,
  Mountain,
  Clock,
  Globe,
  Copy,
  Check,
  Building2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

// ---------------------------------------------------------------------------
// Helper: estimate timezone offset from longitude
// ---------------------------------------------------------------------------

function estimateTimezoneOffset(lng: number): number {
  return Math.round(lng / 15)
}

function getTimezoneLabel(lng: number): string {
  const offset = estimateTimezoneOffset(lng)
  const sign = offset >= 0 ? '+' : ''
  return `UTC${sign}${offset}`
}

// ---------------------------------------------------------------------------
// Helper: estimate sunrise/sunset using simplified solar calculation
// ---------------------------------------------------------------------------

interface SunTimes {
  sunrise: Date
  sunset: Date
}

function estimateSunTimes(lat: number, lng: number, date: Date = new Date()): SunTimes {
  const dayOfYear = Math.floor(
    (date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86400000,
  )
  const declination = -23.45 * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10)) * (Math.PI / 180)
  const latRad = lat * (Math.PI / 180)

  // Hour angle at sunrise/sunset
  const cosHourAngle =
    (Math.sin(-0.833 * (Math.PI / 180)) - Math.sin(latRad) * Math.sin(declination)) /
    (Math.cos(latRad) * Math.cos(declination))

  // Clamp for polar day/night
  const clampedCos = Math.max(-1, Math.min(1, cosHourAngle))
  const hourAngle = Math.acos(clampedCos) * (180 / Math.PI)

  // Solar noon in UTC
  const solarNoonUTC = 12 - lng / 15

  // Sunrise and sunset in UTC hours
  const sunriseUTC = solarNoonUTC - hourAngle / 15
  const sunsetUTC = solarNoonUTC + hourAngle / 15

  const sunrise = new Date(date)
  sunrise.setUTCHours(Math.floor(sunriseUTC), Math.round((sunriseUTC % 1) * 60), 0, 0)

  const sunset = new Date(date)
  sunset.setUTCHours(Math.floor(sunsetUTC), Math.round((sunsetUTC % 1) * 60), 0, 0)

  return { sunrise, sunset }
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// ---------------------------------------------------------------------------
// Nominatim reverse geocode response type
// ---------------------------------------------------------------------------

interface NominatimResponse {
  display_name?: string
  address?: {
    city?: string
    town?: string
    village?: string
    municipality?: string
    county?: string
    state?: string
    country?: string
    road?: string
    house_number?: string
    suburb?: string
    neighbourhood?: string
  }
}

// ---------------------------------------------------------------------------
// Detail row component
// ---------------------------------------------------------------------------

function DetailRow({
  icon: Icon,
  label,
  value,
  accent = 'text-brand-text',
}: {
  icon: React.ElementType
  label: string
  value: string
  accent?: string
}) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className={`flex-shrink-0 flex items-center justify-center h-7 w-7 rounded-lg bg-foreground/[0.04] ${accent}`}>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-muted-foreground text-label">{label}</div>
        <div className="text-body text-foreground truncate font-mono">{value || '—'}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main LocationDetailsPanel component
// ---------------------------------------------------------------------------

interface LocationDetailsPanelProps {
  map: maplibregl.Map | null
}

export default function LocationDetails({ map }: LocationDetailsPanelProps) {
  const open = useUi((st) => st.locationOpen)
  const setOpen = useUi((st) => st.setLocationOpen)
  const [coords, setCoords] = useState({ lng: 0, lat: 0 })
  const [zoom, setZoom] = useState(2)
  const [bearing, setBearing] = useState(0)
  const [pitch, setPitch] = useState(0)
  const [address, setAddress] = useState('')
  const [nearestCity, setNearestCity] = useState('')
  const [elevation, setElevation] = useState<string>('—')
  const [copied, setCopied] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nominatimRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Update map state from map instance
  const updateMapState = useCallback(() => {
    if (!map) return
    const center = map.getCenter()
    setCoords({ lng: center.lng, lat: center.lat })
    setZoom(map.getZoom())
    setBearing(map.getBearing())
    setPitch(map.getPitch())

    // Try to get elevation from terrain
    try {
      const terrain = map.getTerrain()
      if (terrain) {
        // MapLibre doesn't have a direct elevation query API,
        // so we mark as available if terrain is enabled
        setElevation('Terrain on')
      } else {
        setElevation('—')
      }
    } catch {
      setElevation('—')
    }
  }, [map])

  // Reverse geocode with debounce
  const reverseGeocode = useCallback(
    (lng: number, lat: number) => {
      if (nominatimRef.current) clearTimeout(nominatimRef.current)
      nominatimRef.current = setTimeout(async () => {
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lon=${lng.toFixed(6)}&lat=${lat.toFixed(6)}&zoom=16`,
            {
              headers: {
                'User-Agent': 'ErdfeldAI/1.0',
              },
            },
          )
          if (!res.ok) return
          const data: NominatimResponse = await res.json()
          setAddress(data.display_name || '')
          const addr = data.address
          setNearestCity(
            addr?.city || addr?.town || addr?.village || addr?.municipality || addr?.county || '',
          )
        } catch {
          setAddress('')
          setNearestCity('')
        }
      }, 500)
    },
    [],
  )

  // Listen for map movement when panel is open
  useEffect(() => {
    if (!map || !open) return

    // Initial update when panel opens — use microtask to avoid synchronous setState in effect
    const initCenter = map.getCenter()
    const initZoom = map.getZoom()
    const initBearing = map.getBearing()
    const initPitch = map.getPitch()
    queueMicrotask(() => {
      setCoords({ lng: initCenter.lng, lat: initCenter.lat })
      setZoom(initZoom)
      setBearing(initBearing)
      setPitch(initPitch)
      try {
        const terrain = map.getTerrain()
        if (terrain) {
          setElevation('Terrain on')
        } else {
          setElevation('—')
        }
      } catch {
        setElevation('—')
      }
    })
    reverseGeocode(initCenter.lng, initCenter.lat)

    const onMove = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        updateMapState()
        const c = map.getCenter()
        reverseGeocode(c.lng, c.lat)
      }, 1000)
    }

    map.on('moveend', onMove)
    map.on('zoomend', onMove)

    return () => {
      map.off('moveend', onMove)
      map.off('zoomend', onMove)
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (nominatimRef.current) clearTimeout(nominatimRef.current)
    }
  }, [map, open, updateMapState, reverseGeocode])

  // Derived values
  const timezoneLabel = getTimezoneLabel(coords.lng)
  const timezoneOffset = estimateTimezoneOffset(coords.lng)

  // Current local time at that location
  const now = new Date()
  const localTime = new Date(now.getTime() + timezoneOffset * 3600000)
  const localTimeStr = localTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  // Sunrise/sunset
  const sunTimes = estimateSunTimes(coords.lat, coords.lng)
  // Adjust for timezone
  const localSunrise = new Date(sunTimes.sunrise.getTime() + timezoneOffset * 3600000)
  const localSunset = new Date(sunTimes.sunset.getTime() + timezoneOffset * 3600000)

  const handleCopyCoords = useCallback(() => {
    const text = `${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      toast.success('Coordinates copied!')
      setTimeout(() => setCopied(false), 2000)
    })
  }, [coords])

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        className="w-[21.25rem] sm:w-[23.75rem] bg-card/95 border-l border-border text-foreground p-0"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-aqua-500/10 border border-aqua-500/20">
              <Info className="h-4 w-4 text-brand-text" />
            </div>
            <div>
              <h2 className="font-heading text-panel text-foreground">Location Details</h2>
              <p className="text-caption text-muted-foreground">Map center information</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            onClick={() => setOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Copy coordinates banner */}
        <div className="px-5 py-3 bg-aqua-500/5 border-b border-border">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MapPin className="h-3.5 w-3.5 text-brand-text" />
              <span className="text-data text-brand-text">
                {coords.lat.toFixed(6)}, {coords.lng.toFixed(6)}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
             
              onClick={handleCopyCoords}
            >
              {copied ? (
                <Check className="h-3 w-3 text-brand-text" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>
        </div>

        {/* Scrollable details */}
        <div className="overflow-y-auto px-5 py-3 space-y-0.5 max-h-[calc(100vh-10rem)] custom-scrollbar">
          {/* Address */}
          {address && (
            <div className="py-2">
              <DetailRow icon={MapPin} label="Address" value={address} accent="text-brand-text" />
            </div>
          )}

          {/* Nearest city */}
          {nearestCity && (
            <div className="py-2">
              <DetailRow icon={Building2} label="Nearest City" value={nearestCity} accent="text-brand-text" />
            </div>
          )}

          <Separator className="bg-foreground/[0.04]" />

          {/* Coordinates */}
          <DetailRow
            icon={Navigation}
            label="Latitude"
            value={coords.lat.toFixed(6)}
            accent="text-brand-text"
          />
          <DetailRow
            icon={Navigation}
            label="Longitude"
            value={coords.lng.toFixed(6)}
            accent="text-brand-text"
          />

          <Separator className="bg-foreground/[0.04]" />

          {/* Map view info */}
          <DetailRow
            icon={Compass}
            label="Zoom Level"
            value={zoom.toFixed(1)}
            accent="text-brand-text"
          />
          <DetailRow
            icon={Compass}
            label="Bearing"
            value={`${bearing.toFixed(1)}°`}
            accent="text-brand-text"
          />
          <DetailRow
            icon={Compass}
            label="Pitch"
            value={`${pitch.toFixed(1)}°`}
            accent="text-brand-text"
          />

          <Separator className="bg-foreground/[0.04]" />

          {/* Time & timezone */}
          <DetailRow
            icon={Globe}
            label="Timezone"
            value={timezoneLabel}
            accent="text-brand-text"
          />
          <DetailRow
            icon={Clock}
            label="Local Time"
            value={localTimeStr}
            accent="text-brand-text"
          />

          <Separator className="bg-foreground/[0.04]" />

          {/* Sun times */}
          <DetailRow
            icon={Sunrise}
            label="Sunrise"
            value={formatTime(localSunrise)}
            accent="text-warning"
          />
          <DetailRow
            icon={Sun}
            label="Sunset"
            value={formatTime(localSunset)}
            accent="text-warning"
          />

          {/* Elevation */}
          <Separator className="bg-foreground/[0.04]" />
          <DetailRow
            icon={Mountain}
            label="Elevation"
            value={elevation}
            accent="text-brand-text"
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
