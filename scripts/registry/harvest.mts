/** Dataset registry harvester.
 *
 *    NODE_USE_ENV_PROXY=1 npx tsx scripts/registry/harvest.mts [--only=gee,cmr] [--cache=DIR]
 *
 *  Crawls every source, maps records to `DatasetEntry`, de-duplicates across
 *  catalogs, and writes:
 *    src/app/api/agent/lib/registry/snapshot.json   (committed)
 *    docs/registry/SOURCES.md                       (per-source counts + failures)
 *
 *  A dead or slow source never fails the run: each source is isolated, reported,
 *  and (when `--only` is used) the entries of sources not re-harvested are kept
 *  from the previous snapshot.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import {
  crawlStacCollections, crawlStaticTree, cmrCloudCollectionIds, cmrStacProviders, makeHttp, paginate,
  type CrawlResult, type GetJson, type HttpResponse,
} from '../../src/app/api/agent/lib/registry/crawl'
import {
  cmrCollectionToEntry, geeCollectionToEntry, gfwDatasetToEntry, openEoCollectionToEntry,
  openTopographyToEntry, stacCollectionToEntry,
} from '../../src/app/api/agent/lib/registry/normalize'
import { curatedEntries } from '../../src/app/api/agent/lib/registry/curated'
import { checkSnapshotShrink, checkSnapshotSize, diffSnapshots, renderDiffMd } from '../../src/app/api/agent/lib/registry/guard'
import { dedupeEntries } from '../../src/app/api/agent/lib/registry/dedupe'
import { SOURCES, sourceInfo } from '../../src/app/api/agent/lib/registry/sources'
import { compactEntry, expandEntry, type RegistrySnapshot } from '../../src/app/api/agent/lib/registry/compact'
import type { DatasetEntry, SourceReport } from '../../src/app/api/agent/lib/registry/types'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SNAPSHOT = path.join(ROOT, 'src/app/api/agent/lib/registry/snapshot.json')
const SOURCES_MD = path.join(ROOT, 'docs/registry/SOURCES.md')
const CHANGES_MD = path.join(ROOT, 'docs/registry/CHANGES.md')

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=')
  return [k, v ?? 'true'] as const
}))
const only = args.get('only')?.split(',').filter(Boolean)
const cacheDir = args.get('cache') ?? process.env.REGISTRY_HARVEST_CACHE

// --- HTTP with optional on-disk cache (dev iteration only) -----------------

const cache = cacheDir
  ? {
      async get(url: string): Promise<HttpResponse | null> {
        const f = path.join(cacheDir, crypto.createHash('sha1').update(url).digest('hex') + '.json')
        try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null }
      },
      async set(url: string, v: HttpResponse) {
        fs.mkdirSync(cacheDir, { recursive: true })
        fs.writeFileSync(path.join(cacheDir, crypto.createHash('sha1').update(url).digest('hex') + '.json'), JSON.stringify(v))
      },
    }
  : undefined

// One shared limiter: total in-flight requests across ALL sources stays <= 6.
const get: GetJson = makeHttp({ concurrency: 6, timeoutMs: 60_000, retries: 2, cache })

// --- Source harvesters -----------------------------------------------------

interface Harvest { entries: DatasetEntry[]; failures: string[]; note?: string }

function mapAll<T>(rows: T[], fn: (r: T) => DatasetEntry | null): { entries: DatasetEntry[]; skipped: number } {
  const entries: DatasetEntry[] = []
  let skipped = 0
  for (const r of rows) {
    let e: DatasetEntry | null = null
    try { e = fn(r) } catch { e = null }
    if (e) entries.push(e)
    else skipped++
  }
  return { entries, skipped }
}

async function harvestStac(id: string): Promise<Harvest> {
  const info = sourceInfo(id)!
  const res = await crawlStacCollections(get, info.root)
  const { entries, skipped } = mapAll(res.items, (c) => stacCollectionToEntry(c, {
    source: id, root: info.root, auth: info.auth,
  }))
  return { entries, failures: res.failures, note: skipped ? `${skipped} collection(s) skipped (no title or no spatial extent)` : undefined }
}

async function harvestGee(): Promise<Harvest> {
  const res = await crawlStaticTree(get, sourceInfo('gee')!.root)
  const { entries, skipped } = mapAll(res.items, geeCollectionToEntry)
  return { entries, failures: res.failures, note: skipped ? `${skipped} collection(s) skipped (deprecated or no extent)` : undefined }
}

async function harvestCmr(): Promise<Harvest> {
  const root = sourceInfo('cmr')!.root
  const providers = await cmrStacProviders(get, root)
  const failures: string[] = []
  const entries: DatasetEntry[] = []
  const notes: string[] = []
  let skippedTotal = 0

  await Promise.all(providers.map(async (provider) => {
    try {
      const cloud = await cmrCloudCollectionIds(get, provider)
      failures.push(...cloud.failures.map((f) => `${provider}: ${f}`))
      if (!cloud.items.length) return // not a cloud-hosted provider: skip entirely
      const cloudIds = new Set(cloud.items)
      const res = await crawlStacCollections(get, `${root}/${provider}`)
      failures.push(...res.failures.map((f) => `${provider}: ${f}`))
      const inCloud = res.items.filter((c) => cloudIds.has(String(c?.id)))
      // If the id convention does not line up for a provider, keep all of its STAC collections.
      // (Only when the cloud list is big: a provider that is mostly NOT cloud-hosted, with a
      // handful of cloud ids, must be filtered strictly.)
      const useAll = cloudIds.size >= res.items.length * 0.5 && inCloud.length < cloudIds.size * 0.5
      if (useAll) notes.push(`${provider}: id convention mismatch, kept all ${res.items.length} STAC collections`)
      const { entries: es, skipped } = mapAll(useAll ? res.items : inCloud, (c) => cmrCollectionToEntry(c, provider, root))
      entries.push(...es)
      skippedTotal += skipped
    } catch (err: any) {
      failures.push(`${provider}: ${err?.message ?? err}`)
    }
  }))
  return {
    entries, failures,
    note: [`cloud-hosted providers only (cmr search cloud_hosted=true)`, skippedTotal ? `${skippedTotal} skipped (no title or extent)` : '', ...notes].filter(Boolean).join('; '),
  }
}

async function harvestOpenEo(): Promise<Harvest> {
  const root = sourceInfo('openeo-cdse')!.root
  const res: CrawlResult<any> = await paginate(get, `${root}/collections`, (j) => (Array.isArray(j?.collections) ? j.collections : []))
  const { entries, skipped } = mapAll(res.items, (c) => openEoCollectionToEntry(c, root))
  return { entries, failures: res.failures, note: skipped ? `${skipped} skipped` : undefined }
}

async function harvestGfw(): Promise<Harvest> {
  const root = sourceInfo('gfw')!.root
  const res: CrawlResult<any> = await paginate(get, `${root}/datasets`, (j) => (Array.isArray(j?.data) ? j.data : []))
  const { entries, skipped } = mapAll(res.items, gfwDatasetToEntry)
  return { entries, failures: res.failures, note: skipped ? `${skipped} dataset(s) skipped (no title metadata)` : undefined }
}

async function harvestOpenTopography(): Promise<Harvest> {
  const base = sourceInfo('opentopography')!.root
  const failures: string[] = []
  const entries: DatasetEntry[] = []
  let skipped = 0
  for (const format of ['PointCloud', 'Raster'] as const) {
    try {
      const { json } = await get(`${base}?productFormat=${format}&detail=true&outputFormat=json&include_federated=true`)
      const m = mapAll<any>(json?.Datasets ?? [], (d) => openTopographyToEntry(d, format))
      entries.push(...m.entries)
      skipped += m.skipped
    } catch (err: any) {
      failures.push(`${format}: ${err?.message ?? err}`)
    }
  }
  return { entries, failures, note: skipped ? `${skipped} survey(s) skipped (no footprint)` : undefined }
}

async function harvestCurated(): Promise<Harvest> {
  const failures: string[] = []
  let overtureRelease: string | undefined
  try {
    const res = await fetch('https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&prefix=release/&delimiter=/', { signal: AbortSignal.timeout(30_000) })
    const xml = await res.text()
    const rels = [...xml.matchAll(/<Prefix>release\/([^<]+?)\/<\/Prefix>/g)].map((m) => m[1]).sort()
    overtureRelease = rels[rels.length - 1]
    if (!overtureRelease) failures.push('overture: no release prefix found, using built-in release id')
  } catch (err: any) {
    failures.push(`overture release lookup: ${err?.message ?? err} (built-in release id kept)`)
  }
  return { entries: curatedEntries({ overtureRelease }), failures, note: overtureRelease ? `Overture release ${overtureRelease}` : undefined }
}

/** Report-group id -> harvester. Entries are tagged with the `source` the mapper set. */
const HARVESTERS: Array<{ id: string; run: () => Promise<Harvest> }> = [
  { id: 'curated', run: harvestCurated },
  { id: 'planetary-computer', run: () => harvestStac('planetary-computer') },
  { id: 'element84', run: () => harvestStac('element84') },
  { id: 'landsatlook', run: () => harvestStac('landsatlook') },
  { id: 'eodc', run: () => harvestStac('eodc') },
  { id: 'cdse', run: () => harvestStac('cdse') },
  { id: 'openeo-cdse', run: harvestOpenEo },
  { id: 'gee', run: harvestGee },
  { id: 'cmr', run: harvestCmr },
  { id: 'gfw', run: harvestGfw },
  { id: 'opentopography', run: harvestOpenTopography },
]

// --- Main ------------------------------------------------------------------

/** Re-render docs/registry/SOURCES.md from the committed snapshot and SOURCES.json without any network. */
function renderOnly() {
  const snap: RegistrySnapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'))
  const reports: SourceReport[] = JSON.parse(fs.readFileSync(SOURCES_MD.replace(/\.md$/, '.json'), 'utf8'))
  const entries = snap.entries.map(expandEntry)
  const finalBySource = new Map<string, number>()
  for (const e of entries) { const g = e.curated ? 'curated' : e.source; finalBySource.set(g, (finalBySource.get(g) ?? 0) + 1) }
  const merged = entries.reduce((n, e) => n + (e.alternates?.length ?? 0), 0)
  const mb = fs.statSync(SNAPSHOT).size / 1e6
  fs.writeFileSync(SOURCES_MD, renderSourcesMd(reports, finalBySource, entries.length, merged, mb, snap.generated_at))
  console.log(`rendered ${SOURCES_MD}`)
}

async function main() {
  if (args.has('render-only')) return renderOnly()
  const started = Date.now()
  const selected = HARVESTERS.filter((h) => !only || only.includes(h.id))
  const previous: { entries: DatasetEntry[] } | null = (() => {
    try {
      const snap: RegistrySnapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'))
      return { entries: snap.entries.map(expandEntry) }
    } catch { return null }
  })()
  const prevReports: SourceReport[] = (() => {
    try { return JSON.parse(fs.readFileSync(SOURCES_MD.replace(/\.md$/, '.json'), 'utf8')) } catch { return [] }
  })()

  const harvested = new Map<string, Harvest>()
  const reports: SourceReport[] = []

  await Promise.all(selected.map(async (h) => {
    const t0 = Date.now()
    try {
      const out = await h.run()
      harvested.set(h.id, out)
      reports.push({
        source: h.id, count: out.entries.length, harvested_at: new Date().toISOString(),
        ok: out.entries.length > 0, failures: out.failures.slice(0, 25), note: out.note,
      })
      console.log(`[${h.id}] ${out.entries.length} entries, ${out.failures.length} failure(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    } catch (err: any) {
      reports.push({ source: h.id, count: 0, harvested_at: new Date().toISOString(), ok: false, failures: [String(err?.message ?? err)] })
      console.log(`[${h.id}] FAILED: ${err?.message ?? err}`)
    }
  }))

  // Keep prior entries for sources that were not harvested (--only) or that returned nothing this run.
  // Entries a previous run folded into another entry's `alternates` are not restored.
  let all: DatasetEntry[] = []
  const keepFromPrevious = new Set<string>()
  for (const s of SOURCES) {
    const h = harvested.get(s.id)
    if (h && h.entries.length) all.push(...h.entries)
    else if (previous) keepFromPrevious.add(s.id)
  }
  if (previous && keepFromPrevious.size) {
    // Previous snapshot entries are already de-duplicated: re-expand alternates are not needed,
    // the primary keeps its alternates. Take entries whose primary source is one we are keeping.
    const group = (e: DatasetEntry) => (e.curated ? 'curated' : e.source)
    all.push(...previous.entries.filter((e) => keepFromPrevious.has(group(e))))
    for (const id of keepFromPrevious) {
      const wasFailed = reports.find((r) => r.source === id && !r.ok)
      if (wasFailed) wasFailed.note = `${wasFailed.note ?? ''} kept ${previous.entries.filter((e) => group(e) === id).length} entries from the previous snapshot`.trim()
    }
  }

  // Curated entries and sources that only exist in `other` slots (sources not in SOURCES, e.g. 'overture')
  // come from the curated harvester and share its list; make sure they are present exactly once.
  const seen = new Set<string>()
  all = all.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))

  const { entries, merged } = dedupeEntries(all)

  // Per-source counts in the final snapshot (by primary source) for the report.
  const finalBySource = new Map<string, number>()
  for (const e of entries) { const g = e.curated ? 'curated' : e.source; finalBySource.set(g, (finalBySource.get(g) ?? 0) + 1) }

  // Refuse to overwrite the committed snapshot when the catalogue shrank sharply (a broken run).
  const shrink = checkSnapshotShrink(previous?.entries.length ?? null, entries.length)
  if (!shrink.ok && previous) {
    const prevBySource = new Map<string, number>()
    for (const e of previous.entries) { const g = e.curated ? 'curated' : e.source; prevBySource.set(g, (prevBySource.get(g) ?? 0) + 1) }
    console.error(`REFUSED to write snapshot: ${shrink.message}. Per-source counts (previous -> new):`)
    const ids = new Set([...prevBySource.keys(), ...finalBySource.keys()])
    for (const id of [...ids].sort()) {
      console.error(`  ${id.padEnd(20)} ${String(prevBySource.get(id) ?? 0).padStart(6)} -> ${String(finalBySource.get(id) ?? 0).padStart(6)}`)
    }
    process.exitCode = 1
    return
  }
  console.log(`snapshot check: ${shrink.message}`)

  const snapshot: RegistrySnapshot = { version: 1, generated_at: new Date().toISOString(), entries: entries.map(compactEntry) }
  const json = JSON.stringify(snapshot)
  const sizeMb = Buffer.byteLength(json) / 1e6
  const size = checkSnapshotSize(sizeMb)
  if (!size.ok) {
    console.error(`REFUSED to write snapshot: ${size.message}`)
    process.exitCode = 1
    return
  }
  fs.writeFileSync(SNAPSHOT, json)
  const diff = diffSnapshots(previous?.entries ?? [], entries)
  fs.mkdirSync(path.dirname(CHANGES_MD), { recursive: true })
  fs.writeFileSync(CHANGES_MD, renderDiffMd(diff, previous?.entries.length ?? null, entries.length))
  console.log(`${size.message}; added ${diff.added.length}, removed ${diff.removed.length} (${CHANGES_MD})`)

  // Report: merge with earlier reports for sources not re-harvested.
  const byId = new Map<string, SourceReport>(prevReports.map((r) => [r.source, r]))
  for (const r of reports) byId.set(r.source, r)
  const finalReports = [...byId.values()].sort((a, b) => a.source.localeCompare(b.source))
  fs.mkdirSync(path.dirname(SOURCES_MD), { recursive: true })
  fs.writeFileSync(SOURCES_MD.replace(/\.md$/, '.json'), JSON.stringify(finalReports, null, 1))
  fs.writeFileSync(SOURCES_MD, renderSourcesMd(finalReports, finalBySource, entries.length, merged, sizeMb, snapshot.generated_at))

  console.log(`\nraw ${all.length} -> ${entries.length} entries after dedupe (${merged} merged as alternates), snapshot ${sizeMb.toFixed(2)} MB, ${((Date.now() - started) / 1000).toFixed(0)}s`)
  for (const r of finalReports) console.log(`  ${r.source.padEnd(20)} harvested ${String(r.count).padStart(6)}  in snapshot ${String(finalBySource.get(r.source) ?? 0).padStart(6)}  failures ${r.failures.length}`)
}

function renderSourcesMd(reports: SourceReport[], final: Map<string, number>, total: number, merged: number, mb: number, at: string): string {
  const L: string[] = []
  L.push('# Dataset registry sources', '')
  L.push('Generated by `scripts/registry/harvest.mts`. Do not edit by hand.', '')
  L.push('Refresh with `NODE_USE_ENV_PROXY=1 npx tsx scripts/registry/harvest.mts` (about 2.5 minutes, at most 6 requests in flight). `--only=gee,cmr` re-harvests just those sources and keeps the rest from the previous snapshot; `--cache=DIR` caches HTTP responses for development; `--render-only` rebuilds this file offline.', '')
  L.push(`- Snapshot generated: ${at}`)
  L.push(`- Entries in snapshot: **${total}** (${merged} duplicates folded into \`alternates\`)`)
  L.push(`- Snapshot size: ${mb.toFixed(2)} MB (\`src/app/api/agent/lib/registry/snapshot.json\`)`, '')
  L.push('| source | harvested | in snapshot | last harvested | status | failures |')
  L.push('|---|---:|---:|---|---|---:|')
  for (const r of reports) {
    L.push(`| \`${r.source}\` | ${r.count} | ${final.get(r.source) ?? 0} | ${r.harvested_at.slice(0, 10)} | ${r.ok ? 'ok' : 'FAILED'} | ${r.failures.length} |`)
  }
  L.push('', '"harvested" is what the source returned this run; "in snapshot" is the count whose primary source it is after cross-catalog de-duplication (an entry present on two catalogs is counted once, under the higher-priority one).', '')
  L.push('## Notes and failures', '')
  for (const r of reports) {
    if (!r.note && !r.failures.length) continue
    L.push(`### \`${r.source}\``, '')
    if (r.note) L.push(`- ${r.note}`)
    for (const f of r.failures.slice(0, 15)) L.push(`- failure: ${f.slice(0, 300)}`)
    if (r.failures.length > 15) L.push(`- ... and ${r.failures.length - 15} more`)
    L.push('')
  }
  L.push('## Source details', '')
  for (const s of SOURCES) L.push(`- \`${s.id}\`: ${s.name}${s.root ? ` (${s.root})` : ''}${s.auth ? `, auth: ${s.auth}` : ''}`)
  L.push('', '## What the snapshot is and is not', '')
  L.push('- It is **metadata**: one record per dataset or collection (title, description, themes, bands/variables, bbox, period, best-effort resolution, licence, access route). It holds no pixels and proves no coverage: a declared extent can be wrong (Planetary Computer `3dep-seamless` advertises a near-global box for US-only data; `fws-nwi` publishes a box that does not match its own description).')
  L.push('- **Resolution** is parsed from declared `gsd`/band metadata first, then from titles and ids ("500m", "30 arc-second", "GLO-30"), then from description sentences that mention resolution; otherwise `null` (unknown). About a third of entries have one.')
  L.push('- **Themes** are assigned by rules in `themes.ts` (title/keywords/id evidence, or two description hits) plus catalog categories. They are good enough for filtering and ranking, not a curated taxonomy; CMR collections are the noisiest.')
  L.push('- **NASA CMR** is limited to collections that CMR flags `cloud_hosted=true` (the STAC catalog also lists archival, non-cloud collections; those are dropped). Every collection needs a title and a spatial extent; a handful were dropped for lacking one.')
  L.push('- **OpenTopography** contributes one record per lidar/raster survey (about 4,300), with the footprint taken from its polygon. Survey ids that appear in both the point-cloud and raster listings are counted once (about 400). They are ranked below general datasets unless the question carries an area of interest that selects them.')
  L.push('- **Global Forest Watch** datasets without descriptive metadata (about 140 of 382) are skipped; the API exposes no spatial extent, so GFW entries are marked global.')
  L.push('- **De-duplication** is conservative (explicit aliases, MODIS/VIIRS product code + collection version, or equal ids on STAC catalogs with similar titles). Different editions of one product (for example Copernicus DEM 2021 and 2024 releases) stay separate entries.')
  L.push('- **Not reachable from the harvest sandbox**: `overpass-api.de` and `api.worldpop.org`. The curated entries still list them because they are the public endpoints (the Overpass entry names a mirror that answered); a deployment should verify them.', '')
  L.push('', 'Curated entries (`curated` report row) also cover: Overture Maps, OpenStreetMap/Overpass, Open-Meteo, ISRIC SoilGrids, WorldPop, Kontur, NASA FIRMS, NASA GIBS, Hansen GFC, Meta/WRI canopy height, USGS 3DEP lidar EPT, ARCO-ERA5, Google/Microsoft/VIDA buildings, CHIRPS. Their `source` ids differ from `curated` (e.g. `overture`, `open-meteo`).', '')
  return L.join('\n')
}

main().catch((err) => {
  console.error('harvest crashed:', err)
  process.exit(1)
})
