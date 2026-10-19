import type { AOI } from '@/store/useStore'

/**
 * The three sample cases on the welcome screen. Each one was run end to end on real
 * data (eval/RESULTS.md): picking it sets the AOI and sends the
 * question. Nothing here is a canned answer; the agent runs the tools and the answer
 * carries its own sources and caveats.
 */
export interface SampleCase {
  id: string
  title: string
  /** One line on why the case matters. */
  why: string
  /** The sensor behind the answer. */
  source: 'Sentinel-1' | 'Sentinel-2'
  /** What the sensor is used for in this case. */
  sourceDetail: string
  /** Honest limit of the result, shown on the card when there is one. */
  note?: string
  place: string
  /** AOI bounding box in degrees: [west, south, east, north]. */
  bbox: [number, number, number, number]
  /** Sent to the agent as written. */
  question: string
}

export const SAMPLE_CASES: SampleCase[] = [
  {
    id: 'sutlej-flood-2025',
    title: '2025 Sutlej flood',
    why: 'Radar sees through monsoon cloud, so the flood can be measured and matched to buildings and roads.',
    source: 'Sentinel-1',
    sourceDetail: 'radar before and after',
    note: 'Flooded area is a range across thresholds, not one number.',
    place: 'Sutlej near Kasur, Pakistan',
    bbox: [74.4, 30.95, 74.56, 31.08],
    question: 'What went under water in the 2025 Sutlej flood, and what did it hit?',
  },
  {
    id: 'kasur-b08',
    title: 'Near-infrared, one clear scene',
    why: 'A single raw band from the clearest scene of the month, with the scene date and cloud cover stated.',
    source: 'Sentinel-2',
    sourceDetail: 'band B08, 10 m',
    place: 'Kasur, Pakistan',
    bbox: [74.05, 31.12, 74.08, 31.15],
    question: 'Show near-infrared (B08) for this area from the clearest September 2026 Sentinel-2 scene',
  },
  {
    id: 'kasur-fields',
    title: 'Fields and how they were cropped',
    why: 'Field zones with a cropping pattern for the season, from several dates of vegetation index.',
    source: 'Sentinel-2',
    sourceDetail: 'multi-date NDVI',
    note: 'Zones, not parcels, at 10 m.',
    place: 'Kasur, Pakistan',
    bbox: [74.05, 31.12, 74.08, 31.15],
    question: 'Map the agricultural fields here and how they were cropped this season',
  },
]

export function sampleCaseToAOI(c: SampleCase): AOI {
  const [west, south, east, north] = c.bbox
  const ring: [number, number][] = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ]
  return {
    type: 'Rectangle',
    geometry: { type: 'Polygon', coordinates: [ring] },
    center: { lng: (west + east) / 2, lat: (south + north) / 2 },
  }
}

/** Whether the server can answer with its own key when the provider is "Default (built-in)":
 *  `GET /api/providers` names the default provider and whether it holds a server key. Any
 *  failure reads as "no", so the caller falls back to asking for a provider. */
export async function serverCanAnswer(fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn('/api/providers')
    if (!res.ok) return false
    const j = (await res.json()) as { default_provider?: string; providers?: { id: string; server_key: boolean }[] }
    return !!j.providers?.find((p) => p.id === j.default_provider)?.server_key
  } catch {
    return false
  }
}
