import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandEntry, type RegistrySnapshot } from '../compact'
import { ALIASES } from '../dedupe'
import { GOLDEN } from '../golden'
import { RegistryIndex } from '../search'
import { SOURCES } from '../sources'
import { THEMES, type DatasetEntry } from '../types'

const FILE = path.resolve(__dirname, '../snapshot.json')
const snap: RegistrySnapshot = JSON.parse(fs.readFileSync(FILE, 'utf8'))
const entries: DatasetEntry[] = snap.entries.map(expandEntry)

describe('committed registry snapshot', () => {
  it('is a compact file (< 9 MB) in the expected format', () => {
    expect(snap.version).toBe(1)
    expect(fs.statSync(FILE).size).toBeLessThan(9 * 1e6)
    expect(Number.isNaN(Date.parse(snap.generated_at))).toBe(false)
  })

  it('holds thousands of entries from every harvested source', () => {
    expect(entries.length).toBeGreaterThan(10_000)
    const bySource = new Map<string, number>()
    for (const e of entries) bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1)
    for (const s of SOURCES.filter((x) => x.id !== 'curated')) {
      expect(bySource.get(s.id) ?? 0, `source ${s.id}`).toBeGreaterThan(0)
    }
    expect(bySource.get('cmr')!).toBeGreaterThan(5000)
  })

  it('every entry satisfies the schema invariants', () => {
    const ids = new Set<string>()
    for (const e of entries) {
      expect(ids.has(e.id), `duplicate id ${e.id}`).toBe(false)
      ids.add(e.id)
      expect(e.id.startsWith(`${e.source}:`)).toBe(true)
      expect(e.title.length).toBeGreaterThan(0)
      expect(e.description.length).toBeLessThanOrEqual(401)
      expect(e.themes.every((t) => (THEMES as readonly string[]).includes(t))).toBe(true)
      const [a, b, c, d] = e.spatial.bbox
      // minLon > maxLon is a valid antimeridian-crossing box; latitudes must be ordered.
      expect(a >= -180 && c <= 180 && b >= -90 && d <= 90 && b <= d, `bbox of ${e.id}`).toBe(true)
      expect(e.resolution_m === null || e.resolution_m > 0).toBe(true)
      expect(e.access.url.length).toBeGreaterThan(0)
      expect(['proprietary', 'various'].includes(e.license) || e.license.length <= 40).toBe(true)
    }
  })

  it('every golden id and every dedupe alias still resolves (re-harvest drift check)', () => {
    expect(RegistryIndex.unresolvedGolden(entries, GOLDEN)).toEqual([])
    const known = new Set<string>()
    for (const e of entries) { known.add(e.id); for (const a of e.alternates ?? []) known.add(a.id) }
    expect(Object.values(ALIASES).flat().filter((id) => !known.has(id))).toEqual([])
  })

  it('cross-catalog duplicates were folded (Sentinel-2 L2A keeps all four routes)', () => {
    const s2 = entries.find((e) => e.id === 'planetary-computer:sentinel-2-l2a')!
    expect(s2.alternates!.map((a) => a.source).sort()).toEqual(['cdse', 'element84', 'gee'])
  })

  it('curated entries are marked and cover the named APIs', () => {
    const curated = entries.filter((e) => e.curated).map((e) => e.id)
    for (const id of ['overture:buildings', 'overture:places', 'overture:transportation', 'overture:divisions', 'overture:base',
      'osm:overpass', 'open-meteo:forecast', 'open-meteo:era5-archive', 'open-meteo:air-quality', 'open-meteo:climate',
      'isric:soilgrids', 'worldpop:population', 'nasa-firms:active-fires', 'nasa-gibs:imagery', 'usgs-3dep:lidar-ept',
      'arco-era5:pressure-levels', 'google-open-buildings:v3', 'kontur:population']) {
      expect(curated, id).toContain(id)
    }
  })

  it('access kinds and auth flags are populated per source', () => {
    const byId = new Map(entries.map((e) => [e.id, e]))
    expect(byId.get('gee:USGS/SRTMGL1_003')!.access).toMatchObject({ kind: 'earthengine', requires_auth: 'earthengine' })
    expect(byId.get('usgs-3dep:lidar-ept')!.access.kind).toBe('ept')
    expect(byId.get('arco-era5:pressure-levels')!.access.kind).toBe('zarr')
    expect(byId.get('overture:buildings')!.access.kind).toBe('geoparquet')
    expect(entries.find((e) => e.source === 'cmr')!.access.requires_auth).toBe('earthdata')
    expect(entries.find((e) => e.source === 'openeo-cdse')!.access.kind).toBe('openeo')
  })
})

describe('search over the full snapshot', () => {
  const index = new RegistryIndex(entries, GOLDEN)

  it('answers queries in under 50 ms median (after warm-up)', () => {
    for (const w of ['elevation model', 'soil moisture', 'lidar']) index.search(w)
    const queries = [
      'Where can I get a 30 m global digital elevation model?', 'water', 'soil moisture', 'sentinel-1 backscatter',
      'population density worldwide', 'land cover', 'temperature data for the whole world', 'what data exists about forests and trees',
    ]
    const times: number[] = []
    for (const q of queries) {
      const t0 = performance.now()
      index.search(q, { limit: 8, aoi: [74.3, 31.5, 74.4, 31.6] })
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(50)
  })

  it('is confident on real requests and not on nonsense', () => {
    expect(index.search('population density').confident).toBe(true)
    expect(index.search('quokka enclosure census').confident).toBe(false)
    expect(index.search('unicorn population density').confident).toBe(false)
  })

  it('AOI filter removes regional datasets that miss the area (US-only NLCD-style data far from the US)', () => {
    const lahore: [number, number, number, number] = [74.3, 31.5, 74.4, 31.6]
    const hits = index.search('national land cover database', { aoi: lahore, limit: 20 }).hits
    for (const h of hits) expect(['global', 'covers', 'partial']).toContain(h.coverage)
    const usOnly = index.search('3DEP lidar point cloud', { aoi: lahore, limit: 20 }).hits.map((h) => h.entry.id)
    expect(usOnly).not.toContain('usgs-3dep:lidar-ept')
  })
})
