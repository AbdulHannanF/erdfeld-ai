/** Cloud-masked spectral-index statistics — the replacement for `getNDVIMeanFromScene`
 *  and `getSpectralIndexMeanFromScene`.
 *
 *  Three defects in the retired helpers, all fixed here:
 *
 *   1. **No cloud masking.** They averaged every pixel, cloud included. On 2026-07-15 the
 *      AOI was 100 % under cloud and NDVI came back −0.072 — cloud-top reflectance
 *      (NIR 6597 / Red 7621) presented as vegetation health with a citation pill.
 *   2. **Index of the means.** They computed `f(mean(NIR), mean(RED))` rather than
 *      `mean(f(NIR, RED))`. By Jensen's inequality those differ, and the band-mean form
 *      makes per-pixel masking impossible.
 *   3. **Silent bbox fallback.** When the polygon stat failed they fell through to
 *      `fetchCogBandStats`, whose `bbox` argument titiler **ignores** — yielding a
 *      110 × 110 km scene average labelled as the AOI value.
 *
 *  Here: one polygon-clipped `feature.npy` read per scene for the index, one for SCL,
 *  masked per pixel, aggregated in-process. Never falls back to a bbox. Returns null
 *  rather than a number it cannot stand behind.
 */

import {
  clearPixelFilter,
  sceneClarity,
  MIN_USABLE_CLEAR_PCT,
  type SceneClarity,
} from './cloud'
import { fetchFeatureGrid, gridStats, toGeometry, type GridStats } from './pixels'
import { buildIndexValues, resolveBandSetReflectance } from './reflectance'
import { compileBandExpression, toPositionalExpression } from './analysis/band-expression'
import { getLogger } from './logger'
import { getStacItemHref, pickAssetKey } from './stac'
import { SPECTRAL_INDEX_TILE_CONFIG } from './titiler'

const log = getLogger('agent/index-stats')

/**
 * Longest-edge pixel budget for a statistics grid read (titiler `max_size`) — ISS-129.
 *
 * `fetchFeatureGrid`/`fetchCogFeatureGrid` default to 96 (≤9,216 px), a fixed CEILING
 * regardless of AOI size: a 0.5 km² polygon and a 38 km² polygon both come back as a
 * ≤96×96 grid, so the mean's effective ground sample distance (see `effectiveGsdMeters`
 * below) grows with the AOI even though Sentinel-2's actual pixel size never changes.
 * Measured live 2026-08-17: a 38.0 km² AOI reported "mean computed from 9216 clear
 * pixels" next to the words "real per-pixel NDVI, 10 m" — the render was real 10 m, the
 * STATISTIC was an effective ~64 m grid, and the summary said only the flattering half.
 *
 * 512 (≤262,144 px) is used here for the tools that report a headline mean (NDVI,
 * spectral indices, thermal) — about 28x more samples than 96 for the same AOI, which
 * meaningfully narrows (not closes) the gap between the claimed and effective
 * resolution. It stays well inside the existing 45s `fetchWithRetry` timeout in
 * `lib/pixels.ts` (a 512×512 multi-band float64 npy read against titiler.xyz is a few
 * seconds in practice). Do not raise further without re-measuring against the public,
 * rate-limited, no-SLA instance (see the header of `lib/titiler.ts`).
 *
 * This is opt-in per call site (passed explicitly as `opts.maxSize`), not the function
 * default below — `maskedIndexStats`'s default stays at titiler's original 96 so
 * existing callers that reuse a ranking-time `clarity` object (scored at that same 96px
 * default, e.g. `detect_change`/`detect_deforestation` in tools/derived.ts) keep getting
 * a `clarity.grid` the same shape as the value grid. See the warning on `opts.clarity`
 * below — reusing a clarity object scored at a DIFFERENT `maxSize` than this call silently
 * misaligns which array index means which ground pixel.
 */
export const STAT_GRID_MAX_SIZE = 512

/**
 * Effective ground sample distance of a statistic computed from `pixelCount` samples
 * spread over `areaKm2` km² of AOI — ISS-129.
 *
 * titiler's `max_size` caps the returned grid to a fixed pixel budget no matter how
 * large the AOI is, so a statistic's real spatial resolution degrades as the AOI grows
 * even though the sensor's native pixel size never changes. `sqrt(area_m2 / pixel_count)`
 * is the side length of the square each sample effectively represents — the number this
 * codebase used to omit entirely while still saying "10 m" next to the mean.
 *
 * Returns null when there is nothing to divide by (no pixels — i.e. no statistic).
 */
export function effectiveGsdMeters(areaKm2: number, pixelCount: number): number | null {
  if (!Number.isFinite(areaKm2) || !Number.isFinite(pixelCount) || pixelCount <= 0) return null
  const areaM2 = areaKm2 * 1_000_000
  return Math.sqrt(areaM2 / pixelCount)
}

export interface MaskedIndexStats extends GridStats {
  index: string
  sceneId: string
  sceneDate: string
  /** Scene-wide cloud from STAC metadata — reported for context only; never used to decide. */
  sceneCloudPct: number | null
  /** % of the AOI polygon that was clear in this scene. */
  clearPct: number
  /** Always 'polygon' — there is no bbox path. */
  clip: 'polygon'
  clarity: SceneClarity
  /** How DN was converted to reflectance before the index formula ran (ISS-131). */
  reflectanceNote: string
}

/** Why a scene produced no usable statistic. Callers surface this verbatim. */
export type IndexFailure =
  | { reason: 'unsupported_index'; message: string }
  | { reason: 'no_polygon'; message: string }
  | { reason: 'missing_assets'; message: string }
  | { reason: 'too_cloudy'; message: string; clearPct: number }
  | { reason: 'fetch_failed'; message: string }

export type MaskedIndexOutcome =
  | { ok: true; stats: MaskedIndexStats }
  | { ok: false; failure: IndexFailure }

/**
 * Compute cloud-masked statistics for a spectral index over the AOI polygon.
 *
 * `minClearPct` guards against reporting a mean derived from a handful of clear
 * pixels in an otherwise clouded scene. Pass 0 to accept whatever is clear (the
 * caller then owns the caveat).
 *
 * `opts.clarity`, if supplied, MUST have been scored at this same call's `maxSize`
 * (i.e. `sceneClarity(item, geom, maxSize)` with the identical `maxSize`) — titiler's
 * returned grid shape depends on it, and array index `i` means a different ground pixel
 * in a differently-shaped grid. Never reuse a clarity object scored at one `maxSize`
 * (e.g. a cheap ranking-time pick) as the mask for a statistic computed at another —
 * that silently scrambles which pixel is which rather than erroring (ISS-129). Callers
 * that raise `maxSize` above the default for a higher-accuracy statistic must either
 * recompute clarity at the new size or omit `opts.clarity` entirely and let this
 * function score it fresh (see `tools/satellite.ts` for both patterns).
 */
export async function maskedIndexStats(
  item: any,
  index: string,
  aoi: any,
  opts: { maxSize?: number; minClearPct?: number; clarity?: SceneClarity } = {},
): Promise<MaskedIndexOutcome> {
  const { maxSize = 96, minClearPct = MIN_USABLE_CLEAR_PCT } = opts
  const key = index.toUpperCase()
  const cfg = SPECTRAL_INDEX_TILE_CONFIG[key]
  if (!cfg) {
    return {
      ok: false,
      failure: {
        reason: 'unsupported_index',
        message: `Unsupported index "${index}". Supported: ${Object.keys(SPECTRAL_INDEX_TILE_CONFIG).join(', ')}.`,
      },
    }
  }

  const geom = toGeometry(aoi)
  if (!geom) {
    return {
      ok: false,
      failure: {
        reason: 'no_polygon',
        message: 'A polygon AOI is required for polygon-true statistics (draw a polygon, rectangle, or circle).',
      },
    }
  }

  const itemHref = getStacItemHref(item)
  const resolvedKeys = cfg.bandKeys.map((keys) => pickAssetKey(item, keys))
  if (!itemHref || resolvedKeys.some((k) => k === null)) {
    return {
      ok: false,
      failure: {
        reason: 'missing_assets',
        message: `Scene ${item?.id ?? '(unknown)'} is missing the band assets required for ${key}.`,
      },
    }
  }

  const readBands = () => fetchFeatureGrid({
    itemHref,
    assets: resolvedKeys as string[],
    geom,
    maxSize,
    cacheTag: `idx-bands-${key}`,
  })
  // Reuse the caller's SCL grid when it already scored this scene — saves a fetch and
  // guarantees the two grids align pixel-for-pixel. Without one, the SCL read and the band
  // read are independent (same scene, same polygon), so they run together: the band read
  // starts now and is only wasted if the scene turns out too cloudy, which the scene picker
  // has normally already ruled out.
  const bandsEarly = opts.clarity ? null : readBands()
  bandsEarly?.catch(() => {}) // consumed below; this keeps an early return from leaving it unhandled
  const clarity = opts.clarity ?? (await sceneClarity(item, geom, maxSize))
  if (!clarity) {
    return {
      ok: false,
      failure: {
        reason: 'fetch_failed',
        message: 'Could not read the scene-classification (SCL) band, so cloud contamination cannot be excluded. No value reported.',
      },
    }
  }

  if (clarity.clearPct < minClearPct) {
    return {
      ok: false,
      failure: {
        reason: 'too_cloudy',
        clearPct: clarity.clearPct,
        message:
          `Only ${clarity.clearPct.toFixed(0)}% of the AOI was clear in this scene ` +
          `(needs ≥${minClearPct}%). A ${key} mean here would largely measure cloud tops.`,
      },
    }
  }

  // ISS-131 (CLOSED 2026-08-18). The formula is evaluated HERE, not by titiler's
  // `expression` parameter, because the pixels must be converted from DN to
  // reflectance first and that conversion has to happen per band, per item.
  //
  // The scale cancels in a ratio; the additive BOA offset does not. Reading the
  // raw array settled the question the previous investigation left open: titiler
  // returns uint16 DN (mean 1271/2051 on a scene declaring `scale: 0.0001,
  // offset: -0.1`), so it does NOT apply the declared transform. See
  // `lib/reflectance.ts` for the measurements and for why pushing this same
  // arithmetic into the titiler expression string produced NDVI of -1.09e11.
  const evaluate = compileBandExpression(toPositionalExpression(cfg.exprTemplate))
  const reflectance = resolveBandSetReflectance(item, resolvedKeys as string[], { isSentinel2: true })
  let reflectanceNote = reflectance.note

  let stats: GridStats | null
  try {
    const raw = await (bandsEarly ?? readBands())
    const nBands = resolvedKeys.length
    if (raw.bands < nBands + 1) {
      return {
        ok: false,
        failure: {
          reason: 'fetch_failed',
          message:
            `titiler returned ${raw.bands} bands for a ${nBands}-band ${key} read, so the validity ` +
            `mask cannot be matched to the data. No value is reported.`,
        },
      }
    }
    const px = raw.width * raw.height
    const clear = clearPixelFilter(clarity)
    const built = buildIndexValues({
      raw: raw.raw,
      px,
      nBands,
      transforms: reflectance.transforms,
      index: key,
      evaluate,
      include: (i) => !!raw.mask[i] && (!clear || clear(i)),
      baseNote: reflectance.note,
    })
    reflectanceNote = built.note
    // Same scene, same maxSize → the SCL grid indexes align with the index grid.
    // `buildIndexValues` has already applied the cloud filter, writing NaN for every
    // pixel it would not stand behind; gridStats drops those while still counting them
    // as in-polygon, which is the bookkeeping the summary reports.
    stats = gridStats({ ...raw, values: built.values })
  } catch (err: any) {
    log.warn({ index: key, scene: item?.id, err: err?.message }, 'index grid fetch failed')
    return {
      ok: false,
      failure: {
        reason: 'fetch_failed',
        message: `titiler could not return the clipped ${key} pixel array (${err?.message ?? 'unknown error'}). The public titiler.xyz instance is rate-limited — retry, or self-host (TITILER_ENDPOINT).`,
      },
    }
  }

  if (!stats) {
    return {
      ok: false,
      failure: {
        reason: 'too_cloudy',
        clearPct: clarity.clearPct,
        message: `No clear, finite ${key} pixels inside the polygon after cloud masking.`,
      },
    }
  }

  return {
    ok: true,
    stats: {
      ...stats,
      index: key,
      sceneId: String(item?.id ?? 'unknown'),
      sceneDate: String(item?.properties?.datetime ?? '').slice(0, 10),
      sceneCloudPct:
        typeof item?.properties?.['eo:cloud_cover'] === 'number'
          ? item.properties['eo:cloud_cover']
          : null,
      clearPct: clarity.clearPct,
      clip: 'polygon',
      clarity,
      reflectanceNote,
    },
  }
}

/** Convenience: cloud-masked mean only, or null. For callers that just need a number
 *  and handle absence themselves. Never returns a bbox or cloud-contaminated value. */
export async function maskedIndexMean(
  item: any,
  index: string,
  aoi: any,
  opts: { maxSize?: number; minClearPct?: number; clarity?: SceneClarity } = {},
): Promise<number | null> {
  const out = await maskedIndexStats(item, index, aoi, opts)
  return out.ok ? out.stats.mean : null
}

/** Provenance `method` string describing exactly how a masked statistic was produced. */
export function maskedMethodNote(stats: MaskedIndexStats): string {
  return (
    `per-pixel ${stats.index} from titiler /stac/feature.npy, clipped to the drawn polygon; ` +
    `SCL cloud/shadow/cirrus masked (${stats.count} clear of ${stats.insidePolygon} in-polygon pixels, ` +
    `${stats.clearPct.toFixed(0)}% clear); ${stats.reflectanceNote}; mean of per-pixel index`
  )
}
