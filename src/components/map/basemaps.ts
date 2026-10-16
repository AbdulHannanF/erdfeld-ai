import { BASEMAP_SWATCH } from '@/lib/map-colors'

/**
 * The basemaps. There is one at a time: a light or dark vector map that follows the theme, or
 * satellite imagery. `basemapStyleId` is the only place that decides which, so the map, the
 * compare view and the case maps agree.
 */

export interface MapStyleOption {
  id: string
  name: string
  previewColor: string
  styleUrl: string | null // null = raster source (satellite)
  rasterTiles?: string
}

/** The dark vector basemap (CARTO Dark Matter), also used by the case and batch maps. */
export const DARK_BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
export const LIGHT_BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
export const VOYAGER_BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json'

export const MAP_STYLES: MapStyleOption[] = [
  { id: 'dark', name: 'Dark', previewColor: BASEMAP_SWATCH.dark, styleUrl: DARK_BASEMAP_STYLE },
  { id: 'light', name: 'Light', previewColor: BASEMAP_SWATCH.light, styleUrl: LIGHT_BASEMAP_STYLE },
  { id: 'voyager', name: 'Voyager', previewColor: BASEMAP_SWATCH.light, styleUrl: VOYAGER_BASEMAP_STYLE },
  {
    id: 'satellite',
    name: 'Imagery',
    previewColor: BASEMAP_SWATCH.satellite,
    styleUrl: null,
    rasterTiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  },
]

export const BASEMAP_CHOICES = ['auto', 'dark', 'light', 'voyager', 'satellite'] as const
export type BasemapChoice = (typeof BASEMAP_CHOICES)[number]
export type BasemapStyleId = 'dark' | 'light' | 'voyager' | 'satellite'

/** The basemap until one is chosen: imagery reads as the Earth at every zoom, where the dark
 *  vector style is a near-black field at world zoom. */
export const DEFAULT_BASEMAP: BasemapChoice = 'satellite'

/** The saved choice if it is a valid one, else the default. */
export function basemapChoice(saved: string | null | undefined): BasemapChoice {
  return (BASEMAP_CHOICES as readonly string[]).includes(saved ?? '') ? (saved as BasemapChoice) : DEFAULT_BASEMAP
}

/** The style id to show: the one chosen, or (auto) the vector map for the resolved theme. */
export function basemapStyleId(choice: BasemapChoice, resolvedTheme: string | undefined): BasemapStyleId {
  if (choice !== 'auto') return choice
  return resolvedTheme === 'light' ? 'light' : 'dark'
}

/** Get the style value to pass to map.setStyle() */
export function getStyleValue(styleId: string): string | object {
  const opt = MAP_STYLES.find((s) => s.id === styleId)
  if (!opt) return MAP_STYLES[0].styleUrl!

  if (opt.styleUrl) {
    return opt.styleUrl
  }

  // Satellite: build a raster style object
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      'satellite-tiles': {
        type: 'raster',
        tiles: [opt.rasterTiles!],
        tileSize: 256,
        attribution: '&copy; Esri',
        maxzoom: 19,
      },
    },
    layers: [
      {
        id: 'satellite-layer',
        type: 'raster',
        source: 'satellite-tiles',
        minzoom: 0,
        maxzoom: 22,
      },
    ],
  }
}

/** The style to open the map with, read from what the page already knows (the theme class that
 *  next-themes sets before hydration, and the saved basemap choice) so that the first style is the
 *  right one and the map does not load one style and swap it a moment later. */
export function initialBasemapStyleId(): BasemapStyleId {
  if (typeof document === 'undefined') return basemapStyleId(DEFAULT_BASEMAP, 'dark')
  let saved: string | null = null
  try {
    saved = window.localStorage.getItem('erdfeld-basemap')
  } catch {
    // storage blocked: the default
  }
  return basemapStyleId(basemapChoice(saved), document.documentElement.classList.contains('dark') ? 'dark' : 'light')
}

/** The plain colour behind each basemap before its tiles arrive: the land colour of the CARTO
 *  styles (their own `background` layer) and a deep ocean blue for imagery. On a slow network the
 *  tiles take seconds, and this is what the map shows meanwhile, so it never reads as an error. */
export const BASEMAP_GROUND: Record<BasemapStyleId, string> = {
  dark: '#0e0e0e',
  light: '#fafaf8',
  voyager: '#fbf8f3',
  satellite: '#0b1d2a',
}

/** Hosts the basemaps fetch from (style, then vector tiles). The root layout opens connections
 *  to them early so the first tiles do not wait for the handshake. */
export const BASEMAP_HOSTS = [
  'https://basemaps.cartocdn.com',
  'https://tiles.basemaps.cartocdn.com',
  'https://tiles-a.basemaps.cartocdn.com',
  'https://tiles-b.basemaps.cartocdn.com',
] as const

/** MapLibre's world is `512 * 2^zoom` pixels across. */
const WORLD_TILE = 512

/**
 * The lowest zoom at which one copy of the world still covers the map: the world is square, so
 * its side must reach the longer side of the map. Below this the map shows the world repeated
 * (huge screens at zoom 2) or empty space past the poles.
 */
export function worldFitZoom(width: number, height: number): number {
  const side = Math.max(width, height, 1)
  return Math.max(0, Math.log2(side / WORLD_TILE))
}

/** The zoom a fresh map opens at: the usual world view (2), or the least that fills a big screen. */
export function initialWorldZoom(width: number, height: number): number {
  return Math.max(2, worldFitZoom(width, height))
}
