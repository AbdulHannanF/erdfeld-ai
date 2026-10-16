/**
 * Read a typed coordinate pair for the map search: "31.13, 74.06", "31.13 74.06", "31.13N 74.06E",
 * "N31.13 E74.06", "31.13 N, 74.06 W". Latitude first, as every map app reads it. A value out of
 * range is refused with the reason, never swapped or clamped: guessing which number was meant would
 * put the map in the wrong country.
 */
export type CoordinateRead =
  | { kind: 'ok'; lat: number; lng: number }
  | { kind: 'invalid'; reason: string }
  | { kind: 'none' }

const NUM = String.raw`[+-]?\d+(?:\.\d+)?`
const HEMI = String.raw`[NSEWnsew]`
const PART = new RegExp(String.raw`^(?:(${HEMI})\s*)?(${NUM})\s*°?\s*(?:(${HEMI}))?$`)

function part(raw: string): { value: number; hemi: string | null } | null {
  const m = PART.exec(raw.trim())
  if (!m) return null
  const hemi = (m[1] ?? m[3] ?? '').toUpperCase() || null
  let value = Number(m[2])
  if (hemi === 'S' || hemi === 'W') value = -Math.abs(value)
  return { value, hemi }
}

export function parseCoordinates(input: string): CoordinateRead {
  const text = input.trim()
  if (!text) return { kind: 'none' }
  const pieces = text.includes(',') ? text.split(',') : text.split(/\s+(?=[+-]?\d|[NSEWnsew]\s*[+-]?\d)|(?<=[NSEWnsew°])\s+/)
  if (pieces.length !== 2) return { kind: 'none' }
  const a = part(pieces[0])
  const b = part(pieces[1])
  if (!a || !b) return { kind: 'none' }
  // "74.06E 31.13N" names its axes: honour them. Otherwise the first number is the latitude.
  const aIsLng = a.hemi === 'E' || a.hemi === 'W'
  const bIsLat = b.hemi === 'N' || b.hemi === 'S'
  const [lat, lng] = aIsLng && bIsLat ? [b.value, a.value] : [a.value, b.value]
  if ((a.hemi === 'N' || a.hemi === 'S') && (b.hemi === 'N' || b.hemi === 'S')) return { kind: 'invalid', reason: 'Both values are latitudes. One needs E or W.' }
  if (Math.abs(lat) > 90) return { kind: 'invalid', reason: `Latitude ${lat} is outside -90 to 90. Type latitude first, then longitude.` }
  if (Math.abs(lng) > 180) return { kind: 'invalid', reason: `Longitude ${lng} is outside -180 to 180.` }
  return { kind: 'ok', lat, lng }
}
