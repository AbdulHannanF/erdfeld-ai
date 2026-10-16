import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { executeTool } from '..'
import { getToolDefinitions } from '../../engine/registry'

// Every registered tool, run with the network down. None may answer as if the world had no
// data: an outage must read as a failure (Q-06). Tools that need no network are listed with the
// reason; everything else is swept automatically, so a new tool is covered the day it is added.

const aoi = { type: 'Polygon', coordinates: [[[74.30, 31.50], [74.33, 31.50], [74.33, 31.53], [74.30, 31.53], [74.30, 31.50]]] }

/** Dispatchable names that the model is no longer offered (aliases of a listed tool). */
const ALIASES = ['render_ndvi_colormap', 'fetch_high_res_imagery']

/** Tools whose work is local, so a dead network is irrelevant to them. */
const NO_NETWORK = new Set<string>([
  'make_chart', // charts results already in the store
  'style_layer', // restyles a layer already on the map
])

/** Minimal valid arguments where a tool refuses to run without some. */
const ARGS: Record<string, Record<string, any>> = {
  compute_spectral_index: { index: 'NDWI' },
  render_raster: { bands: ['B08'] },
  query_osm: { query: 'hospital' },
  // live: the default path answers from the bundled registry, which needs no network
  find_dataset: { query: 'sea surface temperature', live: true },
  use_dataset: { dataset_id: 'planetary-computer:sentinel-1-rtc' },
  digitize_features: { feature: 'building' },
  detect_objects: { target: 'building' },
  segment_feature: {},
  vectorize_raster: { index: 'NDWI', op: '>', threshold: 0.2 },
  run_cv_detector: { model: 'informal_struct' },
  analyze_raster: { operation: 'stats' },
  inspect_imagery: { question: 'what is here?' },
}

/** Phrases that assert an absence of data. Deliberately about the WORLD, not about the tool:
 *  "could not reach", "failed", "retry" are all fine. */
const ABSENCE_CLAIMS: RegExp[] = [
  /\bno (?:sentinel|landsat|scene|imagery|data|elevation|results?|coverage|buildings?|features?|aircraft|datasets?)\b[^.\n]{0,60}\b(?:found|exist|available|covers?|here|detected)\b/i,
  /\bno (?:usable )?(?:sentinel-2|sentinel-1|landsat) scene\b/i,
  /\bno data\b/i,
  /\bocean\b/i,
  /\b(?:data|dataset|imagery|scenes?|coverage|water history)\b[^.\n]{0,40}\b(?:does not|do not|doesn't) exist\b/i,
  /\bnot available in this area\b/i,
  /\babsence of\b/i,
  /\bnothing (?:was )?found\b/i,
]
/** A summary that says outright it is a connectivity failure may mention what it is NOT. */
const DISCLAIMS = /connectivity failure|not (?:an )?absence|not "no such data|fetch failure|could not (?:reach|search|read|fetch)|failed/i

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean)
}

// The parked computer-vision detectors are part of the sweep too: they must not claim absence either.
process.env.GEOAGENT_ENABLE_CV = '1'

const tools = [...new Set([...getToolDefinitions().map((d: any) => d.function.name as string), ...ALIASES])]
  .filter((t) => !NO_NETWORK.has(t))

describe('offline sweep: every network tool under a total outage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('covers the whole registry', () => {
    expect(tools.length).toBeGreaterThan(30)
    expect(tools).toContain('fetch_dem')
  })

  it.each(tools)('%s does not claim absence of data', async (tool) => {
    const r = await executeTool(tool, aoi, ARGS[tool] ?? {})
    const summary = String(r.summary ?? '')
    expect(summary.length, 'tool returned an empty summary').toBeGreaterThan(0)
    const bad = sentences(summary).filter(
      (s) => ABSENCE_CLAIMS.some((re) => re.test(s)) && !DISCLAIMS.test(s),
    )
    expect(bad, `claims absence of data while the network was down:\n${summary}`).toEqual([])
    expect(r.status, 'an outage must not produce an ok result').not.toBe('ok')
    expect(r.layers, 'a map layer was produced with no network').toHaveLength(0)
  }, 60_000)
})
