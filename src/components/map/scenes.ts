import type { MapLayer, TemporalFrame } from '@/store/useStore'

export interface SceneInfo {
  key: string
  /** ISO date or date-time as the source gave it. */
  date: string
  /** Sensor or scene id: what identifies the scene. */
  label: string
  /** Scene-wide cloud cover % from the catalogue. */
  cloud?: number
  /** % of the drawn area that was clear in this scene. */
  clear?: number
}

const SENSOR_LABELS: Record<string, string> = {
  'sentinel-2-l2a': 'Sentinel-2 L2A',
  'landsat-c2-l2': 'Landsat C2 L2',
}

/** Every dated scene the current layers are built from: the frames of a time series plus the
 *  scene behind each raster layer. Sorted oldest first; a scene named twice is listed once. */
export function collectScenes(frames: TemporalFrame[], layers: MapLayer[]): SceneInfo[] {
  const out = new Map<string, SceneInfo>()
  const frameDays = new Set(frames.map((f) => f.date.slice(0, 10)))
  for (const f of frames) {
    out.set(`frame:${f.date}`, { key: `frame:${f.date}`, date: f.date, label: 'Time-series scene', cloud: f.cloud, clear: f.aoiClearPct })
  }
  for (const l of layers) {
    const r = l.raster
    if (!r?.datetime) continue
    const label = r.sceneId ?? (r.sensor ? SENSOR_LABELS[r.sensor] ?? r.sensor : l.name)
    const key = `scene:${r.sceneId ?? `${r.sensor ?? l.name}:${r.datetime}`}`
    // A layer drawn from a frame of the time series is that frame, not another scene.
    if (!out.has(key) && !frameDays.has(r.datetime.slice(0, 10))) out.set(key, { key, date: r.datetime, label })
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** "3 Oct" within a year of today, "3 Oct 2024" otherwise. */
export function shortDate(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear()
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' })
}
