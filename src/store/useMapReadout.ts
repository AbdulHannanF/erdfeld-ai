import { create } from 'zustand'

/**
 * What the map reports about itself, for the status bar and the on-map readouts: where the cursor
 * is and the camera (zoom, centre, bearing). MapPanel writes it at most once per animation frame;
 * it lives in its own store so a mouse move re-renders the readouts and nothing else.
 */
interface MapReadout {
  cursor: { lat: number; lng: number } | null
  zoom: number | null
  center: { lat: number; lng: number } | null
  bearing: number
  setCursor: (c: { lat: number; lng: number } | null) => void
  setView: (v: { zoom: number; center: { lat: number; lng: number }; bearing: number }) => void
}

export const useMapReadout = create<MapReadout>((set) => ({
  cursor: null,
  zoom: null,
  center: null,
  bearing: 0,
  setCursor: (cursor) => set({ cursor }),
  setView: ({ zoom, center, bearing }) => set({ zoom, center, bearing }),
}))

/** Metres per screen pixel at a latitude and zoom (Web Mercator, 512 px tiles as MapLibre uses). */
export function metresPerPixel(lat: number, zoom: number): number {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom)
}

/** The map scale as "1:n", assuming 96 dpi. Approximate by nature: a screen has no fixed dpi. */
export function scaleDenominator(lat: number, zoom: number): number {
  return Math.round(metresPerPixel(lat, zoom) / 0.000264583)
}
