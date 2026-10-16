/**
 * Re-run the exact probes that FAILED in the 2026-08-17 sweep, against live
 * endpoints, so each fix is judged by the same evidence that condemned it —
 * not by the unit tests written alongside the fix.
 */
import fs from 'fs'
import path from 'path'
import { it } from 'vitest'
import { executeTool } from '@/app/api/agent/tools/index'
 
import { AOIS } from './probes.mjs'

const OUT = path.resolve(process.cwd(), 'qa-out')

const CASES = [
  { id: 'landcover-lahore', tool: 'classify_land_cover', aoi: 'lahore',  args: {},
    was: 'called dense Lahore "Cropland / Grassland 90%", confidence medium' },
  { id: 'ndvi-ocean',      tool: 'fetch_ndvi',          aoi: 'ocean',    args: {},
    was: 'no mean available, yet emitted a flat-fill layer + NDVI legend' },
  { id: 'ndvi-farmland',   tool: 'fetch_ndvi',          aoi: 'farmland', args: {},
    was: 'claimed "real per-pixel NDVI, 10 m" from a 9,216-pixel grid' },
  { id: 'dem-alps',        tool: 'fetch_dem',           aoi: 'alps',     args: {},
    was: 'summary said SRTM 90m while layer provenance said Copernicus DEM 30m' },
  { id: 'find-nonsense',   tool: 'find_dataset',        aoi: 'lahore',   args: { query: 'unicorn population density' },
    was: 'returned 10 real population datasets for a nonsense query' },
  { id: 'find-real',       tool: 'find_dataset',        aoi: 'lahore',   args: { query: 'land surface temperature' },
    was: 'control — genuine query must still return results' },
]

it('verify fixes against live endpoints', async () => {
  const results: any[] = []
  for (const c of CASES) {
    const aoi = AOIS[c.aoi]
    let rec: any
    try {
      const r: any = await executeTool(c.tool, aoi.geom, c.args)
      const layers = [r.layer, ...(r.layers || [])].filter(Boolean)
      rec = {
        ...c,
        summary: String(r.summary || '').replace(/\s+/g, ' '),
        summary_data: r.summary_data,
        layerCount: layers.length,
        provenance: layers.map((l: any) => l?.provenance?.source ?? null),
      }
    } catch (err: any) {
      rec = { ...c, error: String(err?.message || err).slice(0, 300) }
    }
    results.push(rec)
    console.log(`\n═══════ ${c.id} (${c.tool} @ ${c.aoi})`)
    console.log(`WAS: ${c.was}`)
    console.log(`NOW: ${rec.error ? 'ERROR ' + rec.error : rec.summary.slice(0, 620)}`)
    if (rec.summary_data) console.log(`DATA: ${JSON.stringify(rec.summary_data).slice(0, 340)}`)
    if (rec.layerCount !== undefined) console.log(`LAYERS: ${rec.layerCount} provenance=${JSON.stringify(rec.provenance)}`)
  }
  fs.writeFileSync(path.join(OUT, 'verify-fixes.json'), JSON.stringify(results, null, 2))
})
