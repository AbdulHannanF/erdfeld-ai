/** Phase 3 discovery tools (v2 spec §3.7).
 *
 *  `find_dataset` — search the offline dataset registry (~16k datasets from
 *                   Planetary Computer, Earth Engine, NASA CMR, Copernicus, GFW,
 *                   OpenTopography and curated APIs) and fall back to a live STAC
 *                   federation only when the registry has no good hit.
 *  `use_dataset`  — read one of them over the drawn polygon and return a real
 *                   statistic. This is the half that makes discovery worth
 *                   anything: a catalogue listing is not an answer.
 */

import { genId } from '../lib/geometry'
import { gatherCandidates, KNOWN_CATALOGS } from '../lib/discovery/catalogs'
import {
  isWiredAlready,
  rankCollections,
  summariseExtent,
  type CatalogRef,
  type StacCollection,
} from '../lib/discovery/find-dataset'
import { categoricalStyle, classesFromCollection, readDatasetOverAoi } from '../lib/discovery/use-dataset'
import { TITILER_BASE } from '../lib/titiler'
import type { Confidence, Provenance, ToolCtx, ToolOutput } from '../lib/types'
import { getLogger } from '../lib/logger'
import { detectAvailableAuth } from '../lib/registry/auth'
import { formatHit } from '../lib/registry/format'
import { getRegistryEntry, getRegistryIndex, registryGeneratedAt, searchRegistry } from '../lib/registry'
import { readDataset } from '../lib/registry/readers'
import type { ReadResult } from '../lib/registry/readers'
import type { DatasetEntry } from '../lib/registry/types'
import { THEMES, type Theme } from '../lib/registry/types'

const log = getLogger('agent/find-dataset')

// ---------------------------------------------------------------------------
// find_dataset
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// find_dataset: registry first, live STAC as the fallback
// ---------------------------------------------------------------------------

function parseThemes(raw: unknown): Theme[] | undefined {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\s]+/) : []
  const themes = list.map((t) => String(t).trim().toLowerCase()).filter((t): t is Theme => (THEMES as readonly string[]).includes(t))
  return themes.length ? themes : undefined
}

export async function findDataset(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const query = String(args.query).trim()

  let registryNote = ''
  if (args.live !== true) {
    try {
      const out = await findInRegistry(ctx, query, args)
      if (out.result) return { ...out.result, sources: ['GeoAgent offline dataset registry'], provenance_items: [`registry-snapshot:${registryGeneratedAt()}`] }
      registryNote = out.note
    } catch (err: any) {
      log.warn({ err: err?.message }, 'registry search failed; falling back to live STAC')
      registryNote = 'The offline dataset registry was unavailable.'
    }
  } else {
    registryNote = 'Live search was requested explicitly.'
  }
  return { ...(await findDatasetLive(ctx, query, args, registryNote)), sources: ['Live STAC catalog search'] }
}

async function findInRegistry(
  ctx: ToolCtx,
  query: string,
  args: Record<string, any>,
): Promise<{ result?: ToolOutput; note: string }> {
  const themes = parseThemes(args.themes)
  const maxRes = Number(args.max_resolution_m)
  const license = typeof args.license === 'string' && args.license.trim()
    ? args.license.split(',').map((l: string) => l.trim()).filter(Boolean)
    : Array.isArray(args.license) ? args.license.map(String) : undefined
  const start = args.start ? String(args.start) : undefined
  const end = args.end ? String(args.end) : undefined

  const res = await searchRegistry(query, {
    aoi: ctx.bbox,
    ...(themes ? { themes } : {}),
    ...(Number.isFinite(maxRes) && maxRes > 0 ? { maxResolutionM: maxRes } : {}),
    ...(start || end ? { time: { start, end } } : {}),
    ...(license?.length ? { license } : {}),
    availableAuth: detectAvailableAuth(),
    limit: Math.max(5, Math.min(Number(args.limit) || 8, 8)),
  })

  if (!res.confident) {
    const why = res.hits.length === 0
      ? 'The offline registry has no entry matching this request over the AOI.'
      : res.unknownTerms.length
        ? `The offline registry had only weak matches (it does not know: ${res.unknownTerms.join(', ')}).`
        : 'The offline registry had only weak matches.'
    return { note: why }
  }

  const hits = res.hits
  const unwired = hits.filter((h) => !isWiredAlready(h.entry.id.slice(h.entry.source.length + 1)))
  const authFlagged = hits.filter((h) => h.authAvailable === false).length
  const lines = hits.map((h, i) => formatHit(h, i + 1))

  return {
    note: '',
    result: {
      summary:
        `**${hits.length} dataset(s) match "${query}"** (offline registry, snapshot ${registryGeneratedAt().slice(0, 10)}; ` +
        `${res.afterFilters} candidates passed the AOI/time/resolution/licence filters).\n\n` +
        `${lines.join('\n\n')}\n\n` +
        `**Reading the verdicts:** "declared extent" comes from the catalog and is not proof of data ` +
        `(Planetary Computer's \`3dep-seamless\` advertises a near-global box for US-only data). ` +
        `★ marks a curated, widely used dataset. Resolution is the best the catalog states; "not stated" is unknown, not coarse.` +
        `${authFlagged ? `\n${authFlagged} hit(s) need credentials this deployment does not have; they are listed, not hidden.` : ''}` +
        `${unwired.length ? `\n${unwired.length} of these have no dedicated GeoAgent tool.` : ''}` +
        `\nTo search live STAC catalogs instead, call \`find_dataset\` with \`live: true\`.`,
      summary_data: {
        matches: hits.length,
        unwired_matches: unwired.length,
        top_dataset: hits[0].entry.id,
        top_collection: hits[0].entry.id.slice(hits[0].entry.source.length + 1),
        registry_candidates: res.matched,
        query,
        source: 'registry',
      },
    },
  }
}

async function findDatasetLive(
  ctx: ToolCtx,
  query: string,
  args: Record<string, any>,
  registryNote: string,
): Promise<ToolOutput> {
  const breadth = args.breadth !== false

  ctx.emit?.('token', {
    type: 'token',
    content: `find_dataset: ${registryNote} Searching live STAC catalogs for "${query}"...\n`,
  })

  const gathered = await gatherCandidates({ breadth })
  if (gathered.collectionsSeen === 0) {
    return {
      summary:
        `**Dataset search failed.** None of the ${gathered.catalogsSearched} STAC catalogs responded. ` +
        `This is a connectivity failure, not "no such data exists".`,
      failed: true,
    }
  }

  const ranked = rankCollections(gathered.candidates, query, ctx.bbox, Number(args.limit) || 10)

  const header =
    `${registryNote}\n\nSearched **${gathered.catalogsSearched} STAC catalog(s)** live, ` +
    `**${gathered.collectionsSeen} collections**` +
    `${gathered.catalogsUnreachable ? ` (${gathered.catalogsUnreachable} catalog(s) unreachable)` : ''}, ` +
    `filtered to those whose declared extent covers this AOI.`

  if (ranked.length === 0) {
    return {
      summary:
        `**No dataset matched "${query}" over this AOI.**\n\n${header}\n\n` +
        `Nothing scored above zero, so nothing is offered — a search that always returns something ` +
        `is worse than one that can say no. Try a broader term ("land cover" rather than a product name), ` +
        `or a different AOI: many datasets are national rather than global.`,
      summary_data: { matches: 0, catalogs_searched: gathered.catalogsSearched, query, source: 'live' },
    }
  }

  const lines = ranked.map((r, i) => {
    const c = r.collection
    return (
      `${i + 1}. **${c.title || c.id}** — \`${c.id}\`\n` +
      `   · catalog: ${r.catalog.name}\n` +
      `   · extent: ${summariseExtent(c)}\n` +
      `   · licence: ${c.license ?? 'not stated'}\n` +
      `${r.alreadyWired ? `   · ⓘ GeoAgent already has a dedicated tool for this data — prefer that.\n` : ''}` +
      `   · to use it: \`use_dataset({catalog: "${r.catalog.id}", collection: "${c.id}"})\``
    )
  })

  const fresh = ranked.filter((r) => !r.alreadyWired)
  return {
    summary:
      `**${ranked.length} dataset(s) match "${query}" and cover this AOI.**\n\n${header}\n\n` +
      `${lines.join('\n\n')}\n\n` +
      `**Coverage caveat:** a declared STAC extent is not proof of data. Planetary Computer's ` +
      `\`3dep-seamless\`, for example, advertises a near-global bbox for United-States-only data. ` +
      `\`use_dataset\` settles it by searching for actual items over the AOI.` +
      `${fresh.length ? `\n\n${fresh.length} of these are **not** already covered by a GeoAgent tool.` : ''}`,
    summary_data: {
      matches: ranked.length,
      unwired_matches: fresh.length,
      catalogs_searched: gathered.catalogsSearched,
      collections_searched: gathered.collectionsSeen,
      top_collection: ranked[0].collection.id,
      query,
      source: 'live',
    },
  }
}

// ---------------------------------------------------------------------------
// use_dataset
// ---------------------------------------------------------------------------

async function resolveCatalog(id: string): Promise<CatalogRef | null> {
  const known = KNOWN_CATALOGS.find((c) => c.id === id || c.url === id)
  if (known) return known
  if (/^https?:\/\//i.test(id)) {
    return { id, name: new URL(id).host, url: id.replace(/\/+$/, '') }
  }
  const { fetchStacIndexCatalogs } = await import('../lib/discovery/catalogs')
  const all = await fetchStacIndexCatalogs()
  return all.find((c) => c.id === id) ?? null
}

/** Find the registry entry for an id the model passed: exact id, an alternate route's id, or a bare
 *  local id ("cop-dem-glo-30") when it is unambiguous. */
async function resolveEntry(id: string): Promise<{ entry?: DatasetEntry; error?: string }> {
  const found = await getRegistryEntry(id)
  if (found) {
    if (found.id === id) return { entry: found }
    const alt = found.alternates?.find((a) => a.id === id)
    // The caller named an alternate route explicitly (e.g. the Earth Engine copy): read that route.
    return alt ? { entry: { ...found, id: alt.id, source: alt.source, access: alt.access } } : { entry: found }
  }
  if (!id.includes(':')) {
    const index = await getRegistryIndex()
    const matches = index.entries.filter((e) => e.id.slice(e.source.length + 1) === id)
    if (matches.length === 1) return { entry: matches[0] }
    if (matches.length > 1) return { error: `"${id}" is ambiguous: ${matches.slice(0, 6).map((e) => `\`${e.id}\``).join(', ')}. Pass the full id.` }
  }
  return { error: `No registry dataset has the id "${id}". Use the exact \`dataset_id\` printed by \`find_dataset\` (form \`<source>:<collection>\`).` }
}

/** A read that did not happen (credentials missing, no in-app reader, the read errored) is a
 *  failure to read, never an empty or zero answer. One that ran and found nothing (`no_coverage`)
 *  is a real answer about that dataset. */
const READ_DID_NOT_HAPPEN: ReadonlySet<ReadResult['status']> = new Set(['error', 'unavailable', 'auth_required'])

export function readResultToToolResult(res: ReadResult, entry: DatasetEntry): ToolOutput {
  const evidence: Pick<ToolOutput, 'sources' | 'provenance_items' | 'failed'> = {
    sources: [res.provenance?.source ?? `${entry.title} (${entry.source})`],
    provenance_items: [entry.id],
    failed: READ_DID_NOT_HAPPEN.has(res.status),
  }
  if (res.passthrough) {
    return { ...res.passthrough, summary: res.summary, summary_data: { ...(res.passthrough.summary_data ?? {}), ...res.summary_data }, ...evidence }
  }
  return {
    summary: res.summary,
    summary_data: res.summary_data,
    ...(res.layer ? { layer: res.layer } : {}),
    ...(res.layers?.length ? { layers: res.layers } : {}),
    ...evidence,
  }
}

async function readRegistryDataset(ctx: ToolCtx, datasetId: string, args: Record<string, any>): Promise<ToolOutput> {
  const { entry, error } = await resolveEntry(datasetId)
  if (!entry) return { summary: error ?? `Unknown dataset "${datasetId}".` }

  ctx.emit?.('token', { type: 'token', content: `use_dataset: reading "${entry.title}" (${entry.access.kind}) over the AOI...\n` })
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const res = await readDataset(
    entry,
    { aoi: ctx.aoi, bbox: ctx.bbox, centroid: ctx.centroid, areaKm2: ctx.areaKm2 },
    {
      variable: str(args.variable), date: str(args.date), start: str(args.start), end: str(args.end),
      render: args.render !== false, hillshade: args.hillshade === true,
      runTool: ctx.runTool,
    },
  )
  return readResultToToolResult(res, entry)
}

export async function useDataset(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const datasetId = String(args.dataset_id ?? '').trim()
  if (datasetId) return readRegistryDataset(ctx, datasetId, args)

  const collectionId = String(args.collection ?? '').trim()
  const catalogId = String(args.catalog ?? 'planetary-computer').trim()
  const catalog = await resolveCatalog(catalogId)
  if (!catalog) {
    return {
      summary:
        `Unknown catalog "${catalogId}". Known catalogs: ${KNOWN_CATALOGS.map((c) => c.id).join(', ')}, ` +
        `or pass a STAC API root URL directly.`,
    }
  }

  ctx.emit?.('token', {
    type: 'token',
    content: `use_dataset: reading "${collectionId}" from ${catalog.name} over the AOI...\n`,
  })

  const { fetchCollections } = await import('../lib/discovery/catalogs')
  const collections = await fetchCollections(catalog)
  const collection: StacCollection | undefined = collections.find((c) => c.id === collectionId)
  if (!collection) {
    return {
      summary:
        `${catalog.name} does not list a collection called "${collectionId}". ` +
        `${collections.length ? `It has ${collections.length} collections; run \`find_dataset\` to see matching ones.` : 'The catalog returned no collections at all.'}`,
    }
  }

  const read = await readDatasetOverAoi({
    catalog,
    collection,
    aoi: ctx.aoi,
    bbox: ctx.bbox,
    ...(args.datetime ? { datetime: String(args.datetime) } : {}),
    ...(args.categorical !== undefined ? { categorical: Boolean(args.categorical) } : {}),
  })

  if (!read.ok) {
    return {
      summary:
        `**Could not read "${collectionId}" over this AOI.**\n\n${read.reason}\n\n` +
        `_No statistic is reported. An empty answer here means the read failed or the dataset has no ` +
        `data here — not that the measured value is zero._`,
      summary_data: { collection: collectionId, catalog: catalog.id, read: 'failed' },
      sources: [`${catalog.name} (STAC collection ${collectionId})`],
    }
  }

  const { stats, classes, asset, item, categorical } = read
  const date = String(item?.properties?.datetime ?? item?.properties?.start_datetime ?? '').slice(0, 10)

  const provenance: Provenance = {
    source: `${collection.title || collection.id} via ${catalog.name}${collection.license ? ` (${collection.license})` : ''}`,
    method: `STAC item search over the AOI bbox -> asset "${asset.key}" -> titiler POST /cog/statistics with the drawn polygon as a cutline`,
    clip: 'polygon',
    ...(date ? { date } : {}),
    resolution_limit:
      `Discovered dataset, not a curated GeoAgent tool: the statistic is whatever this asset contains. ` +
      `Check the collection's own documentation for units and caveats.`,
  }

  const body = categorical && classes.length
    ? `**Class breakdown over the AOI:**\n\n` +
      classes
        .slice(0, 10)
        .map((c) => `- **${c.name}** (value ${c.value}) — ${c.pct.toFixed(1)}% (${c.count.toLocaleString()} px)`)
        .join('\n')
    : `**Statistics over the AOI polygon:**\n\n` +
      `- mean **${stats.mean.toFixed(3)}**\n` +
      `${stats.min != null ? `- min ${stats.min.toFixed(3)} · max ${stats.max?.toFixed(3)}\n` : ''}` +
      `${stats.std != null ? `- σ ${stats.std.toFixed(3)}\n` : ''}` +
      `${stats.count != null ? `- ${Math.round(stats.count).toLocaleString()} pixels\n` : ''}`

  // A categorical dataset with declared classes gets a proper class-colored tile layer
  // (value -> color via titiler's `colormap`) instead of a grey ramp over class numbers.
  const style = categorical && classes.length
    ? categoricalStyle(classesFromCollection(collection, asset.key), classes)
    : null

  const summary_data: Record<string, any> = {
    collection: collection.id,
    catalog: catalog.id,
    asset: asset.key,
    read: 'ok',
  }
  if (categorical && classes.length) {
    summary_data.dominant_class = classes[0].name
    summary_data.dominant_pct = Number(classes[0].pct.toFixed(1))
  } else {
    summary_data.mean = Number(stats.mean.toFixed(4))
    if (stats.count != null) summary_data.pixel_count = Math.round(stats.count)
  }

  const colorNote = style && !style.allColorsDeclared
    ? `\n**Map colors:** assigned by GeoAgent — this collection declares no (or only partial) class colors.`
    : ''

  return {
    summary:
      `**${collection.title || collection.id}** — read over this AOI from ${catalog.name}.\n\n` +
      `${body}${colorNote}\n\n` +
      `**Asset:** \`${asset.key}\`${date ? ` · **acquired:** ${date}` : ''}\n` +
      `**Licence:** ${collection.license ?? 'not stated'}\n\n` +
      `_This dataset has no dedicated GeoAgent tool — it was located by \`find_dataset\` and read ` +
      `directly. ${provenance.resolution_limit}_`,
    summary_data,
    layer: {
      id: `dataset-${genId()}`,
      name: `${collection.title || collection.id}`.slice(0, 40),
      type: 'raster',
      tileUrl: `${TITILER_BASE}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${encodeURIComponent(read.signedHref)}${
        style ? `&colormap=${encodeURIComponent(JSON.stringify(style.colormap))}`
        : categorical ? '' : '&rescale=' + `${stats.min ?? 0},${stats.max ?? 1}`}`,
      bounds: ctx.bbox,
      provenance,
      confidence: 'medium' as Confidence,
      ...(style ? {
        aoiMask: true,
        raster: {
          kind: 'categorical' as const,
          collection: collection.id,
          datetime: date || undefined,
          stretch: 'fixed' as const,
          classes: style.classes,
        },
      } : {}),
    },
  }
}
