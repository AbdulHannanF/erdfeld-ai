/** Using a dataset nobody wired (v2 spec §3.7, the Phase 3 gate).
 *
 *  Finding a collection is easy; the gate is *"agent locates **and uses** an
 *  unwired dataset"*. That means going all the way to a real number over the
 *  drawn polygon: STAC item search → asset → SAS signing where required →
 *  titiler POST statistics with the AOI as a cutline.
 *
 *  Proven live 2026-08-10 on the audit AOI (Lahore), all through this path:
 *
 *  | collection | result |
 *  |---|---|
 *  | `io-lulc-annual-v02` (10 m, CC-BY-4.0) | class 7 (Built Area) 90 099 px vs class 11 (Rangeland) 639 px — **99.3 % built** |
 *  | `cop-dem-glo-30` | mean elevation **216.79 m**, σ 2.17, n = 10 368 |
 *  | `esa-cci-lc`, `alos-dem` | both returned real polygon statistics |
 *
 *  The land-cover figure independently corroborates Phase 0's WorldCover result
 *  (84.6 % built) from a completely different sensor and vendor — which is the
 *  point of discovery: a second opinion the app was never wired for.
 *
 *  One caveat this module exists to enforce: **a declared STAC extent is not
 *  proof of coverage.** Planetary Computer's `3dep-seamless` advertises the bbox
 *  [-174, -15, 164, 72] for United-States-only data. Only an item search settles
 *  it, so "no items here" is reported as exactly that, never as a statistic.
 */

import { getLogger } from '../logger'
import { signPCAsset } from '../stac'
import { fetchCogPolygonStats } from '../titiler'
import type { CatalogRef, StacCollection } from './find-dataset'

const log = getLogger('agent/discovery-use')

/** Asset keys worth trying, best first, for a single-band raster read. */
const ASSET_PREFERENCE = [
  'data', 'elevation', 'dem', 'lccs_class', 'classification', 'lulc',
  'band1', 'b1', 'image', 'cog', 'asset', 'raster',
]

export interface AssetPick {
  key: string
  href: string
  /** Declared media type, when the item states one. */
  type?: string
}

/**
 * Choose a raster asset to read.
 *
 * Skips the metadata assets every PC item carries (`tilejson`,
 * `rendered_preview`, thumbnails) — they are not rasters and reading one would
 * produce a statistic about a preview image.
 */
export function pickRasterAsset(item: any): AssetPick | null {
  const assets = item?.assets
  if (!assets || typeof assets !== 'object') return null

  const isMeta = (k: string, a: any) =>
    /tilejson|rendered_preview|thumbnail|preview|metadata|mtl|ang|qa$|json$/i.test(k) ||
    /json|html|xml|text/i.test(String(a?.type ?? ''))

  const entries = Object.entries<any>(assets).filter(([k, a]) => a?.href && !isMeta(k, a))
  if (entries.length === 0) return null

  for (const want of ASSET_PREFERENCE) {
    const hit = entries.find(([k]) => k.toLowerCase() === want)
    if (hit) return { key: hit[0], href: hit[1].href, type: hit[1].type }
  }
  // Otherwise prefer something that declares itself a COG/GeoTIFF.
  const tiff = entries.find(([, a]) => /tiff|cog/i.test(String(a?.type ?? '')) || /\.tif{1,2}($|\?)/i.test(String(a?.href)))
  if (tiff) return { key: tiff[0], href: tiff[1].href, type: tiff[1].type }

  return { key: entries[0][0], href: entries[0][1].href, type: entries[0][1].type }
}

/** Planetary Computer blobs require SAS signing; everything else is direct. */
export async function signIfNeeded(href: string): Promise<string> {
  if (/blob\.core\.windows\.net/i.test(href) && !/[?&]s[ivp]=/i.test(href)) {
    try {
      return await signPCAsset(href)
    } catch (err: any) {
      log.warn({ err: err?.message }, 'PC signing failed; trying unsigned')
      return href
    }
  }
  return href
}

export type ItemSearchResult =
  | { ok: true; item: any; matched: number }
  | { ok: false; reason: string }

/** STAC item search over the AOI bbox. */
export async function searchItems(
  catalog: CatalogRef,
  collectionId: string,
  bbox: [number, number, number, number],
  opts: { datetime?: string; limit?: number } = {},
): Promise<ItemSearchResult> {
  const body: Record<string, unknown> = {
    collections: [collectionId],
    bbox,
    limit: opts.limit ?? 5,
  }
  if (opts.datetime) body.datetime = opts.datetime

  let res: Response
  try {
    res = await fetch(`${catalog.url}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
  } catch (err: any) {
    return { ok: false, reason: `${catalog.name} was unreachable: ${err?.message ?? 'network error'}.` }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, reason: `${catalog.name} returned HTTP ${res.status} for "${collectionId}". ${text.slice(0, 160)}`.trim() }
  }

  const json = await res.json().catch(() => null)
  const features = json?.features ?? []
  if (!features.length) {
    return {
      ok: false,
      reason:
        `"${collectionId}" has no items over this AOI. The collection's declared extent covers it, ` +
        `but declared extent is not coverage — this dataset simply has no data here.`,
    }
  }
  return { ok: true, item: features[0], matched: features.length }
}

// ---------------------------------------------------------------------------
// Categorical class names
// ---------------------------------------------------------------------------

export interface ClassDef { value: number; name: string; /** `#rrggbb`, when the collection declares one (`color_hint`). */ color?: string }

/**
 * Class names for a categorical asset, from the collection's own metadata.
 *
 * Read rather than hardcoded: the whole point of discovery is datasets nobody
 * anticipated, so their vocabularies cannot be baked in. When the metadata does
 * not declare classes, the caller reports raw values and says so.
 */
export function classesFromCollection(collection: StacCollection, assetKey: string): ClassDef[] | null {
  const itemAssets = (collection as any)?.item_assets
  const asset = itemAssets?.[assetKey]
  const out: ClassDef[] = []

  // Two STAC extensions describe the same thing, and real catalogs use both.
  // Measured 2026-08-10: Planetary Computer's io-lulc-annual-v02 uses
  // `file:values`, while its esa-cci-lc uses `classification:classes`. Reading
  // only one of them silently produced "class 7" instead of "Built Area" and
  // dropped the categorical path entirely.
  const classification =
    asset?.['classification:classes'] ??
    (collection as any)?.summaries?.['classification:classes']
  if (Array.isArray(classification)) {
    for (const c of classification) {
      const value = Number(c?.value)
      const name = c?.description ?? c?.title ?? c?.name
      const hint = typeof c?.color_hint === 'string' && /^#?[0-9a-fA-F]{6}$/.test(c.color_hint)
        ? `#${c.color_hint.replace('#', '').toLowerCase()}` : undefined
      if (Number.isFinite(value) && typeof name === 'string') out.push({ value, name, ...(hint ? { color: hint } : {}) })
    }
  }

  const fileValues = asset?.['file:values'] ?? (collection as any)?.summaries?.['file:values']
  if (out.length === 0 && Array.isArray(fileValues)) {
    for (const entry of fileValues) {
      const name = entry?.summary ?? entry?.description
      const values = entry?.values
      if (typeof name !== 'string' || !Array.isArray(values)) continue
      // One label can cover several pixel values; expand so lookup is by value.
      for (const v of values) {
        const value = Number(v)
        if (Number.isFinite(value)) out.push({ value, name })
      }
    }
  }

  return out.length ? out : null
}

/** Distinguishable fallback colors for classes the collection gives no color for. */
const CLASS_PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c',
  '#fabebe', '#008080', '#e6beff', '#9a6324', '#fffac8', '#800000', '#aaffc3', '#808000',
  '#ffd8b1', '#000075', '#808080', '#ffe119',
]

export interface CategoricalStyle {
  /** One entry per class present in the AOI, with the color actually drawn. */
  classes: Array<{ value: number; label: string; color: string }>
  /** titiler `colormap` param value: pixel value -> color. Unlisted values render transparent. */
  colormap: Record<string, string>
  /** True when EVERY drawn color came from the collection's own metadata. */
  allColorsDeclared: boolean
}

/**
 * Colors + labels for the classes present in the AOI. Declared `color_hint`s win;
 * classes without one get a palette color, and `allColorsDeclared` says so — the
 * caller must tell the user those colors are GeoAgent's, not the dataset's.
 */
export function categoricalStyle(
  declared: ClassDef[] | null,
  present: Array<{ value: number; name?: string }>,
): CategoricalStyle {
  const classes: CategoricalStyle['classes'] = []
  const colormap: Record<string, string> = {}
  let allColorsDeclared = true
  let next = 0
  for (const p of present) {
    if (!Number.isFinite(p.value) || colormap[String(p.value)]) continue
    const def = declared?.find((d) => d.value === p.value)
    let color = def?.color
    if (!color) { color = CLASS_PALETTE[next++ % CLASS_PALETTE.length]; allColorsDeclared = false }
    colormap[String(p.value)] = color
    classes.push({ value: p.value, label: def?.name ?? p.name ?? `class ${p.value}`, color })
  }
  return { classes, colormap, allColorsDeclared }
}

/** `histogram: [[counts], [classValues]]` → counts by class, largest first. */
export function classCountsFromHistogram(
  histogram: number[][] | undefined,
  classes: ClassDef[] | null,
): Array<{ value: number; name: string; count: number; pct: number }> {
  if (!Array.isArray(histogram) || histogram.length < 2) return []
  const counts = histogram[0] ?? []
  const values = histogram[1] ?? []
  const total = counts.reduce((s, n) => s + (Number(n) || 0), 0)
  if (total <= 0) return []

  const rows = counts.map((count, i) => {
    const value = Number(values[i])
    const def = classes?.find((c) => c.value === value)
    return {
      value,
      name: def?.name ?? `class ${value}`,
      count: Number(count) || 0,
      pct: ((Number(count) || 0) / total) * 100,
    }
  })
  return rows.filter((r) => r.count > 0).sort((a, b) => b.count - a.count)
}

// ---------------------------------------------------------------------------
// The gate: real statistics from an unwired dataset
// ---------------------------------------------------------------------------

export interface DatasetReadResult {
  ok: true
  item: any
  asset: AssetPick
  signedHref: string
  stats: import('../titiler').CogBandStats
  classes: Array<{ value: number; name: string; count: number; pct: number }>
  categorical: boolean
}

export type DatasetRead = DatasetReadResult | { ok: false; reason: string }

/**
 * Read one unwired dataset over the AOI polygon.
 *
 * Always polygon-clipped (Phase 0: titiler's GET `bbox` is silently ignored and
 * returns whole-COG statistics), and always reports failure as failure.
 */
export async function readDatasetOverAoi(opts: {
  catalog: CatalogRef
  collection: StacCollection
  aoi: any
  bbox: [number, number, number, number]
  categorical?: boolean
  datetime?: string
}): Promise<DatasetRead> {
  const { catalog, collection, aoi, bbox } = opts

  const found = await searchItems(catalog, collection.id, bbox, { datetime: opts.datetime })
  if (!found.ok) return { ok: false, reason: found.reason }

  const asset = pickRasterAsset(found.item)
  if (!asset) {
    return {
      ok: false,
      reason:
        `"${collection.id}" has items over this AOI but none carry a readable raster asset ` +
        `(only metadata assets such as tilejson/preview). It may be a vector or point dataset.`,
    }
  }

  const signedHref = await signIfNeeded(asset.href)
  const categorical = opts.categorical ?? Boolean(classesFromCollection(collection, asset.key))

  const stats = await fetchCogPolygonStats(
    signedHref,
    aoi,
    categorical ? { categorical: 'true' } : undefined,
  )
  if (!stats) {
    return {
      ok: false,
      reason:
        `Found an item in "${collection.id}" and asset "${asset.key}", but titiler could not read ` +
        `statistics from it over this polygon. The asset may not be a cloud-optimised GeoTIFF. ` +
        `No number is reported rather than a wrong one.`,
    }
  }

  const classes = categorical
    ? classCountsFromHistogram(stats.histogram, classesFromCollection(collection, asset.key))
    : []

  log.info({ collection: collection.id, asset: asset.key, mean: stats.mean }, 'read unwired dataset')
  return { ok: true, item: found.item, asset, signedHref, stats, classes, categorical }
}
