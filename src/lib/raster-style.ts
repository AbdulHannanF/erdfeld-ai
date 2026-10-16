/** Generic raster layer contract + client-side tile-URL restyling.
 *
 *  Shared by the server (tool results carry a `RasterDescriptor`) and the browser
 *  (legend, colormap picker, stretch inputs). Pure: no DOM, no node APIs.
 *
 *  A raster layer is "restylable" when its `tileUrl` is a titiler XYZ template whose
 *  `colormap_name` / `rescale` query params fully describe the styling. Rewriting
 *  those two params is all a colormap or stretch change needs — no agent round trip.
 */

export type RasterKind = 'continuous' | 'rgb' | 'categorical'

export interface RasterClass { value: number; label: string; color: string }

export interface RasterDescriptor {
  kind: RasterKind
  /** Sensor / product id, e.g. 'sentinel-2-l2a'. */
  sensor?: string
  collection?: string
  sceneId?: string
  /** Acquisition date (ISO yyyy-mm-dd). */
  datetime?: string
  /** Band names as the user knows them (B08, B04, ...). */
  bands?: string[]
  /** Band-math formula over those band names, when the layer is computed. */
  expression?: string
  /** Named spectral index the layer shows (NDVI, NDWI, ...), when it is one: lets validation
   *  check its values against the index's physical range. */
  index?: string
  /** One [min,max] (continuous) or one per band (rgb) — what the tile URL currently uses. */
  rescale?: [number, number][]
  /** 'p2-p98' / 'minmax' = derived from the AOI's own pixels; 'fixed' = caller-given or edited. */
  stretch: 'p2-p98' | 'minmax' | 'fixed'
  colormap?: string
  units?: string
  classes?: RasterClass[]
}

// ---------------------------------------------------------------------------
// Colormaps
// ---------------------------------------------------------------------------

/** Colormaps offered in the picker (all are titiler / matplotlib names). */
export const RASTER_COLORMAPS = [
  'viridis', 'magma', 'inferno', 'plasma', 'cividis', 'greys',
  'rdylgn', 'rdbu', 'spectral', 'terrain', 'blues', 'ylgn',
] as const

/** Approximate stops for legend / picker previews (the tiles themselves are
 *  rendered by titiler; these only draw the colorbar). */
const STOPS: Record<string, string[]> = {
  viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  magma: ['#000004', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf'],
  inferno: ['#000004', '#420a68', '#932667', '#dd513a', '#fca50a', '#fcffa4'],
  plasma: ['#0d0887', '#7e03a8', '#cc4778', '#f89540', '#f0f921'],
  cividis: ['#00204d', '#414d6b', '#7c7b78', '#bcaf6f', '#ffea46'],
  greys: ['#ffffff', '#bdbdbd', '#737373', '#000000'],
  rdylgn: ['#a50026', '#f46d43', '#ffffbf', '#a6d96a', '#006837'],
  rdbu: ['#67001f', '#d6604d', '#f7f7f7', '#4393c3', '#053061'],
  spectral: ['#9e0142', '#f46d43', '#ffffbf', '#66c2a5', '#5e4fa2'],
  terrain: ['#333399', '#0099ff', '#00cc66', '#ffff66', '#996633', '#ffffff'],
  blues: ['#f7fbff', '#c6dbef', '#6baed6', '#2171b5', '#08306b'],
  ylgn: ['#ffffe5', '#c2e699', '#78c679', '#238443', '#004529'],
  orrd: ['#fff7ec', '#fdd49e', '#fc8d59', '#d7301f', '#7f0000'],
}

/** Resolve stops for a titiler colormap name, honouring the `_r` (reversed) suffix.
 *  Null when the name is unknown to the client (legend then omits the colorbar). */
export function colormapStops(name: string | undefined): string[] | null {
  if (!name) return null
  const key = name.toLowerCase()
  if (STOPS[key]) return STOPS[key]
  if (key.endsWith('_r') && STOPS[key.slice(0, -2)]) return [...STOPS[key.slice(0, -2)]].reverse()
  return null
}

/** CSS `linear-gradient` for a colormap, or null when the name is unknown. */
export function colormapGradientCss(name: string | undefined, dir = 'to right'): string | null {
  const stops = colormapStops(name)
  if (!stops) return null
  return `linear-gradient(${dir}, ${stops.join(', ')})`
}

// ---------------------------------------------------------------------------
// Tile URL restyling
// ---------------------------------------------------------------------------

function splitUrl(url: string): { head: string; params: URLSearchParams; hash: string } {
  const hashAt = url.indexOf('#')
  const hash = hashAt >= 0 ? url.slice(hashAt) : ''
  const noHash = hashAt >= 0 ? url.slice(0, hashAt) : url
  const q = noHash.indexOf('?')
  // The path keeps its literal `{z}/{x}/{y}` — URL() would percent-encode the braces.
  return {
    head: q >= 0 ? noHash.slice(0, q) : noHash,
    params: new URLSearchParams(q >= 0 ? noHash.slice(q + 1) : ''),
    hash,
  }
}

/** Read the colormap and per-band rescale a tile URL currently carries. */
export function readTileStyle(url: string): { colormap?: string; rescale: [number, number][] } {
  const { params } = splitUrl(url)
  const rescale: [number, number][] = []
  for (const r of params.getAll('rescale')) {
    const [a, b] = r.split(',').map(Number)
    if (Number.isFinite(a) && Number.isFinite(b)) rescale.push([a, b])
  }
  return { colormap: params.get('colormap_name') ?? undefined, rescale }
}

/** Return `url` with `colormap_name` and/or `rescale` replaced. `rescale` is one
 *  pair (applied to every band by titiler) or one per band; each becomes its own
 *  `rescale=min,max` param. Everything else in the URL is preserved verbatim. */
export function rewriteTileUrl(
  url: string,
  change: { colormap?: string; rescale?: [number, number][] },
): string {
  const { head, params, hash } = splitUrl(url)
  if (change.colormap !== undefined) params.set('colormap_name', change.colormap)
  if (change.rescale) {
    params.delete('rescale')
    for (const [lo, hi] of change.rescale) params.append('rescale', `${lo},${hi}`)
  }
  const qs = params.toString()
  return `${head}${qs ? `?${qs}` : ''}${hash}`
}

/** A valid stretch needs two finite numbers with min < max. */
export function isValidStretch(lo: number, hi: number): boolean {
  return Number.isFinite(lo) && Number.isFinite(hi) && lo < hi
}

/** Compact number for legends: more decimals for small magnitudes. */
export function formatStretchValue(v: number): string {
  const a = Math.abs(v)
  if (a >= 1000) return v.toFixed(0)
  if (a >= 100) return v.toFixed(1)
  if (a >= 1) return v.toFixed(2)
  if (a === 0) return '0'
  return v.toFixed(3)
}

// ---------------------------------------------------------------------------
// AOI mask geometry
// ---------------------------------------------------------------------------

type Ring = number[][]

/** World rectangle with the AOI's outer ring(s) cut out as holes — drawn above a
 *  raster so only pixels inside the AOI show. Null when the AOI is not areal.
 *  Rings are wound opposite to the world ring, as the GeoJSON spec expects. */
export function worldMinusAoi(geometry: { type: string; coordinates?: any } | null | undefined): GeoJSON.Polygon | null {
  if (!geometry) return null
  let outers: Ring[] = []
  if (geometry.type === 'Polygon') outers = [geometry.coordinates?.[0]]
  else if (geometry.type === 'MultiPolygon') outers = (geometry.coordinates ?? []).map((p: Ring[]) => p?.[0])
  outers = outers.filter((r) => Array.isArray(r) && r.length >= 4)
  if (!outers.length) return null
  // Mercator-safe world ring, counter-clockwise.
  const world: Ring = [[-180, -85.06], [180, -85.06], [180, 85.06], [-180, 85.06], [-180, -85.06]]
  const holes = outers.map((r) => (signedArea(r) > 0 ? [...r].reverse() : r))
  return { type: 'Polygon', coordinates: [world, ...holes] }
}

function signedArea(ring: Ring): number {
  let a = 0
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
  return a / 2
}
