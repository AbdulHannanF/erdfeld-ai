/** Categorical data palette and the reserved AOI colour (BR-06).
 *
 *  Rule: brand colours are for the interface, data colours for data, never mixed. This palette
 *  therefore contains no teal, leaf or aqua (a field class must never be mistaken for the
 *  selected or active UI state), and the AOI outline / selection highlight is the one reserved
 *  brand colour below. Continuous data uses the perceptual colormaps in raster-style.ts.
 *
 *  Colours 1-8 are the validated core (min CIEDE2000 12.2 under protanopia, 14.9 under
 *  deuteranopia, 17.4 for normal vision; numbers and method in docs/brand/BRAND.md). 9-12 exist
 *  because MAX_CATEGORIES is 12; they are only distinct to about 7.5 under CVD, so a legend or
 *  direct labels must always carry the identity. Order matters: always take a prefix.
 *  Based on Okabe & Ito (2008) minus its bluish-green, which is the brand teal. Validated in
 *  src/lib/__tests__/categorical-palette.test.ts. */
export const CATEGORICAL_PALETTE = [
  '#0072B2', // blue
  '#D55E00', // vermillion
  '#F0E442', // yellow
  '#CC79A7', // reddish purple
  '#56B4E9', // sky blue
  '#8B3343', // wine
  '#1B3A6B', // navy
  '#B20003', // red
  '#C2B100', // olive yellow
  '#648FFF', // cornflower
  '#6F4469', // plum
  '#785EF0', // violet
] as const

/** Palette entries validated to the strict thresholds. */
export const CATEGORICAL_CORE = 8

/** The AOI outline, selection highlight and measurement/selection overlays on the map: the one
 *  colour reserved for "what the user selected", brand teal-on-dark (BRAND.md `brand-400`). */
export const AOI_COLOR = '#5CBFA6'
