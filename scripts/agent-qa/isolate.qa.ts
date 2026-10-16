/**
 * Targeted follow-up: the sweep produced land-cover results that look SWAPPED
 * (dense Lahore classified as cropland/grassland; irrigated cropland classified
 * as built-up). Two explanations fit: a cache that ignores the AOI, or values
 * genuinely computed over the wrong pixels.
 *
 * This runs the suspect tools ALONE, in a fresh process, one AOI at a time, so
 * nothing earlier in the run can contaminate the answer. If the results match
 * the sweep, the values are real and the tools are wrong. If they change, the
 * sweep was contaminated by cross-AOI caching.
 */
import fs from 'fs'
import path from 'path'
import { it } from 'vitest'
import { executeTool } from '@/app/api/agent/tools/index'
 
import { AOIS } from './probes.mjs'

const OUT = path.resolve(process.cwd(), 'qa-out')
const results: any[] = []

const CASES = [
  { id: 'iso-landcover-lahore', tool: 'classify_land_cover', aoi: 'lahore', args: {} },
  { id: 'iso-veg-farmland', tool: 'classify_vegetation', aoi: 'farmland', args: {} },
  { id: 'iso-ndvi-farmland', tool: 'fetch_ndvi', aoi: 'farmland', args: {} },
  { id: 'iso-ndvi-lahore', tool: 'fetch_ndvi', aoi: 'lahore', args: {} },
  { id: 'iso-ndwi-reservoir', tool: 'compute_spectral_index', aoi: 'reservoir', args: { index: 'NDWI' } },
]

it('isolation follow-up', async () => {
  for (const c of CASES) {
    const aoi = AOIS[c.aoi]
    let rec: any
    try {
      const r: any = await executeTool(c.tool, aoi.geom, c.args)
      rec = {
        ...c,
        summary: String(r.summary || '').replace(/\s+/g, ' ').slice(0, 700),
        summary_data: r.summary_data,
      }
    } catch (err: any) {
      rec = { ...c, error: String(err?.message || err).slice(0, 300) }
    }
    results.push(rec)
    console.log(`\n═══ ${c.id} (${c.tool} @ ${c.aoi})`)
    console.log(rec.error ? `ERROR ${rec.error}` : rec.summary.slice(0, 520))
    if (rec.summary_data) console.log('  data: ' + JSON.stringify(rec.summary_data).slice(0, 320))
  }
  fs.writeFileSync(path.join(OUT, 'isolation.json'), JSON.stringify(results, null, 2))
})
