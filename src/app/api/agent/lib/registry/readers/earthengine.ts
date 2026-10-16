/** earthengine reader: reduceRegion statistics and an Earth Engine tile URL for a catalog asset.
 *  Without credentials it says so, with the asset id and catalog link, and computes nothing. */

import { geeReadAsset, isGeeConfigured } from '../../gee'
import { colormapStops } from '@/lib/raster-style'
import type { GradientPalette, Provenance } from '../../types'
import { genId } from '../../geometry'
import type { DatasetEntry } from '../types'
import { authRequiredResult, declaredExtent, fmtDate, honest, r } from './common'
import { pickColormap } from './stac'
import type { ReadOpts, ReaderAoi, ReadResult } from './types'

function gradientPalette(colormap: string, min: number, max: number, unit: string | undefined, label: string): GradientPalette {
  const stops = colormapStops(colormap) ?? ['#440154', '#21918c', '#fde725']
  return {
    kind: 'gradient', min, max, unit, label,
    stops: stops.map((color, i) => ({ value: r(min + ((max - min) * i) / Math.max(1, stops.length - 1), 4), color })),
  }
}

export function eeAssetId(entry: DatasetEntry): string {
  return entry.id.replace(/^gee:/, '')
}

/** The window for a collection median: the request, else the dataset's last year of data. */
export function eeWindow(entry: DatasetEntry, opts: ReadOpts): { start: string; end: string } {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  const full = (s: string, end: boolean) => (/^\d{4}$/.test(s) ? `${s}-${end ? '12-31' : '01-01'}` : s)
  if (opts.start || opts.end) {
    return { start: full(opts.start ?? opts.end!, false), end: full(opts.end ?? opts.start!, true) }
  }
  if (opts.date) {
    const t = Date.parse(full(opts.date, false))
    if (Number.isFinite(t)) return { start: day(t - 15 * 86400e3), end: day(t + 15 * 86400e3) }
  }
  const endMs = entry.temporal.end ? Date.parse(entry.temporal.end) : Date.now()
  return { start: day(endMs - 365 * 86400e3), end: day(endMs) }
}

export async function readEarthEngine(entry: DatasetEntry, aoi: ReaderAoi, opts: ReadOpts): Promise<ReadResult> {
  const assetId = eeAssetId(entry)
  if (!isGeeConfigured()) {
    return authRequiredResult(
      entry, 'earthengine',
      `Earth Engine asset id: \`${assetId}\` · catalog page: ${entry.access.url}`,
      ['Earth Engine credentials not configured (GEE_KEY_FILE). Nothing was computed.'],
    )
  }

  const win = eeWindow(entry, opts)
  const colormap = pickColormap(entry, opts.variable ?? entry.variables[0]?.name ?? '', { id: 'identity', apply: (v) => v, expr: () => null }, {})
  const read = await geeReadAsset(aoi.aoi, {
    assetId, band: opts.variable, start: win.start, end: win.end,
    scaleM: entry.resolution_m ?? undefined, palette: colormapStops(colormap) ?? undefined,
  })
  if ('error' in read) {
    return honest(entry, 'error', { headline: `Earth Engine could not read "${entry.title}"`, body: [read.error] })
  }

  const unit = entry.variables.find((v) => v.name === read.band)?.unit
  const u = unit ? ` ${unit}` : ''
  const s = read.stats
  const provenance: Provenance = {
    source: `${entry.title} via Google Earth Engine (${entry.license})`,
    method: `ee.reduceRegion (mean/min/max/stdDev/p2/p98, scale ${read.scaleM} m) over the drawn polygon${read.window ? `; median composite ${read.window.start} to ${read.window.end}` : ''}`,
    clip: 'polygon',
    ...(read.window ? { date: fmtDate(read.window.end) } : {}),
    resolution_limit: `Reduction at ${read.scaleM} m (bestEffort). Earth Engine dataset terms apply: ${entry.license}.`,
  }
  const lo = s.p2 ?? s.min ?? 0
  const hi = s.p98 ?? s.max ?? lo + 1
  return {
    status: 'ok',
    summary:
      `**${entry.title}**: band \`${read.band}\` over the AOI via Earth Engine.\n\n` +
      `- mean **${r(s.mean!, 3)}${u}**${s.std !== null ? ` · σ ${r(s.std, 3)}` : ''}\n` +
      `- min ${s.min !== null ? r(s.min, 3) : 'n/a'} · p2 ${s.p2 !== null ? r(s.p2, 3) : 'n/a'} · p98 ${s.p98 !== null ? r(s.p98, 3) : 'n/a'} · max ${s.max !== null ? r(s.max, 3) : 'n/a'}${u}\n\n` +
      `${read.window ? `Median composite of ${read.window.start} to ${read.window.end}. ` : ''}Asset \`${assetId}\` (${read.assetType.toLowerCase().replace('_', ' ')}); other bands: ${read.bands.filter((b) => b !== read.band).slice(0, 12).join(', ') || 'none'}.\n` +
      `**Licence:** ${entry.license}`,
    stats: { kind: 'continuous', variable: read.band, unit, mean: s.mean!, ...(s.min !== null ? { min: s.min } : {}), ...(s.max !== null ? { max: s.max } : {}), ...(s.std !== null ? { std: s.std } : {}), ...(s.p2 !== null ? { p2: s.p2 } : {}), ...(s.p98 !== null ? { p98: s.p98 } : {}) },
    summary_data: { read: 'ok', dataset: entry.id, band: read.band, mean: r(s.mean!, 3), ...(unit ? { unit } : {}), ...(read.window ? { window_start: read.window.start, window_end: read.window.end } : {}) },
    provenance,
    coverage: { verdict: 'covered', declared: declaredExtent(entry), found: 'Earth Engine returned valid pixels over the polygon' },
    ...(opts.render !== false && read.tileUrl ? {
      layer: {
        id: `dataset-${genId()}`, name: entry.title.slice(0, 48), type: 'raster', tileUrl: read.tileUrl, bounds: aoi.bbox, aoiMask: true, provenance, confidence: 'medium',
        // An Earth Engine tile URL has no titiler colormap/rescale params to restyle, so it gets a fixed legend.
        palette: gradientPalette(colormap, r(lo, 4), r(hi > lo ? hi : lo + 1, 4), unit, read.band),
      },
    } : {}),
  }
}
