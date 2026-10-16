/** Colours that belong to the map renderer rather than to the interface or to data: basemap
 *  stand-ins, relief shading, atmosphere, halos and swatches. They live here, apart from
 *  components, so that no component carries a literal colour. Interface colours come from the
 *  theme tokens in globals.css; categorical data colours from categorical-palette.ts; continuous
 *  data from the colormaps in raster-style.ts. */

import { CATEGORICAL_PALETTE } from './categorical-palette'

/** Shapes the user draws with the drawing panel: a data colour, not the AOI colour. */
export const DRAWN_SHAPE_COLOR = CATEGORICAL_PALETTE[11]

/** Outline that separates a data symbol from any basemap. */
export const MAP_HALO = '#ffffff'

/** Background drawn when the basemap style cannot be loaded. */
export const MAP_FALLBACK_BACKGROUND = '#1b2330'

/** Hillshade ramp for the terrain layer. */
/** Terrain relief: the workbench design's colours on dark bases, neutral greys on light ones. */
export const MAP_HILLSHADE = {
  darkShadow: '#0b1111',
  darkHighlight: '#c7b38e',
  darkAccent: '#566d62',
  lightShadow: '#5b6663',
  lightHighlight: '#ffffff',
  lightAccent: '#8a9690',
} as const

/** Sky, horizon and fog when terrain is tilted. */
export const MAP_ATMOSPHERE = { sky: '#0b1220', horizon: '#1e293b', fog: '#0a0d12' } as const

/** Dims everything outside the AOI. */
export const MAP_OUTSIDE_AOI_MASK = '#0b0f14'

/** Thumbnails in the map-style switcher: the average tone of each basemap. */
export const BASEMAP_SWATCH = { dark: '#1a1a2e', light: '#e8e8e8', streets: '#c5e1a5', satellite: '#2d5a27' } as const

/** Red, green, blue for the band list of a true-colour layer: the RGB channel convention, not a category. */
export const RGB_CHANNEL_SWATCH = ['#ef4444', '#22c55e', '#3b82f6'] as const

/** Dark halo under the white outline of a selected feature: the pair reads on light and dark basemaps. */
export const MAP_SELECTION_HALO = '#0b0f14'
