/**
 * LIVE proof that the ISS-125 coverage gate fires on real Sentinel-2 (opt-in).
 *
 *   CLOUD_LIVE=1 npx vitest run coverage-live
 *
 * The unit tests (`cloud-coverage.test.ts`) pin the logic on synthetic grids.
 * This one shows the hazard is not hypothetical. Measured 2026-08-16 over a
 * 1.4 deg x 1.0 deg AOI in northern Italy, six candidates all from 2026-08-15:
 *
 *     clear 100.0%  coverage   4.1%
 *     clear 100.0%  coverage  11.1%
 *     clear  99.2%  coverage  27.1%
 *     clear  99.7%  coverage  75.5%   <- the only scene that sees the AOI
 *     clear  96.6%  coverage   1.3%
 *     clear  98.1%  coverage   3.9%
 *
 * Ranking on clarity alone — which is what every Phase 0 tool did — selects a
 * scene observing 4.1% of the polygon and labels its mean as the AOI's value.
 *
 * Unlike cloud, this hazard is STABLE: scene footprints come from the fixed
 * Sentinel-2 tiling grid, not the weather. A wide AOI straddling tile
 * boundaries clips the same way every overpass.
 */

import { describe, it, expect } from 'vitest'
import {
  MIN_AOI_COVERAGE_PCT,
  MIN_USABLE_CLEAR_PCT,
  pickClearestScene,
  sceneClarity,
  type SceneClarity,
} from '../cloud'
import { STAC_SEARCH_URL, toRfc3339Interval } from '../stac'

const LIVE = !!process.env.CLOUD_LIVE
const suite = LIVE ? describe : describe.skip

function box(bbox: [number, number, number, number]) {
  const [a, b, c, d] = bbox
  return { type: 'Polygon', coordinates: [[[a, b], [c, b], [c, d], [a, d], [a, b]]] }
}

/** AOIs wide enough that no single scene footprint contains them. */
const WIDE_AOIS: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Po valley, N Italy', bbox: [10.0, 45.0, 11.4, 46.0] },
  { name: 'Ile-de-France', bbox: [2.0, 48.5, 3.0, 49.2] },
  { name: 'Central Valley, CA', bbox: [-120.6, 36.2, -119.6, 36.9] },
]

async function searchS2(bbox: number[], limit = 8): Promise<any[]> {
  const res = await fetch(STAC_SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collections: ['sentinel-2-l2a'],
      bbox,
      datetime: toRfc3339Interval('2026-06-01/2026-08-16'),
      sortby: [{ field: 'properties.datetime', direction: 'desc' }],
      limit,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`STAC HTTP ${res.status}`)
  return (await res.json())?.features ?? []
}

interface ClippingCase {
  name: string
  geom: any
  items: any[]
  /** Scenes clear enough to be chosen but covering too little of the AOI. */
  clearSlivers: Array<{ item: any; clarity: SceneClarity }>
  /** Scenes clear enough AND covering the AOI. */
  covering: Array<{ item: any; clarity: SceneClarity }>
}

/** Find a real AOI where a clear scene clips it and another scene does not. */
async function findClippingCase(): Promise<ClippingCase> {
  const tried: string[] = []
  for (const { name, bbox } of WIDE_AOIS) {
    const geom = box(bbox)
    const items = await searchS2(bbox)
    const scored = (await Promise.all(
      items.map(async (item) => ({ item, clarity: await sceneClarity(item, geom, 96) })),
    )).filter((s): s is { item: any; clarity: SceneClarity } => !!s.clarity)

    const usableClarity = scored.filter((s) => s.clarity.clearPct >= MIN_USABLE_CLEAR_PCT)
    const clearSlivers = usableClarity.filter((s) => (s.clarity.coveragePct ?? 100) < MIN_AOI_COVERAGE_PCT)
    const covering = usableClarity.filter((s) => (s.clarity.coveragePct ?? 0) >= MIN_AOI_COVERAGE_PCT)
    tried.push(
      `${name}: ${scored.length} scored, ${clearSlivers.length} clear-but-clipping, ${covering.length} covering`,
    )
    if (clearSlivers.length > 0 && covering.length > 0) {
      console.log(`clipping case — ${name}:`)
      for (const s of scored) {
        console.log(
          `  ${String(s.item?.properties?.datetime ?? '').slice(0, 10)} ` +
          `clear ${s.clarity.clearPct.toFixed(1)}%  coverage ${(s.clarity.coveragePct ?? -1).toFixed(1)}%`,
        )
      }
      return { name, geom, items, clearSlivers, covering }
    }
  }
  throw new Error(`No AOI showed a clear-but-clipping scene alongside a covering one. Tried:\n  ${tried.join('\n  ')}`)
}

let once: Promise<ClippingCase> | null = null
const clippingCase = () => (once ??= findClippingCase())

suite('LIVE ISS-125 — a clear scene that only clips the AOI is refused', () => {
  it('the hazard is real: a scene scores usably clear over a fraction of the polygon', async () => {
    const c = await clippingCase()
    expect(c.clearSlivers.length).toBeGreaterThan(0)
    const worst = c.clearSlivers.reduce((a, b) =>
      (a.clarity.coveragePct ?? 100) < (b.clarity.coveragePct ?? 100) ? a : b)
    console.log(
      `worst: ${worst.clarity.clearPct.toFixed(1)}% clear over ` +
      `${(worst.clarity.coveragePct ?? -1).toFixed(1)}% of the AOI`,
    )
    // Clear enough that clarity-only ranking would happily choose it...
    expect(worst.clarity.clearPct).toBeGreaterThanOrEqual(MIN_USABLE_CLEAR_PCT)
    // ...while describing a different area than the one asked about.
    expect(worst.clarity.coveragePct!).toBeLessThan(MIN_AOI_COVERAGE_PCT)
  }, 300_000)

  it('DECISIVE: the same sliver candidates are chosen without the gate and refused with it', async () => {
    const c = await clippingCase()
    // Identical input, identical clarity ranking — only the coverage gate differs.
    const slivers = c.clearSlivers.map((s) => s.item)

    const ungated = await pickClearestScene(slivers, c.geom, { minCoveragePct: 0 })
    expect(ungated, 'clarity-only ranking should still pick one of these').not.toBeNull()
    console.log(
      `without the gate: picked ${ungated!.item.id} — ` +
      `${ungated!.clarity.clearPct.toFixed(1)}% clear over ${(ungated!.clarity.coveragePct ?? -1).toFixed(1)}% of the AOI`,
    )
    expect(ungated!.clarity.coveragePct!).toBeLessThan(MIN_AOI_COVERAGE_PCT)

    const gated = await pickClearestScene(slivers, c.geom)
    console.log('with the gate:', gated === null ? 'refused' : `picked ${gated.item.id}`)
    expect(gated).toBeNull()
  }, 300_000)

  it('given the full candidate list it picks a scene that actually observes the AOI', async () => {
    const c = await clippingCase()
    const choice = await pickClearestScene(c.items, c.geom, { maxCandidates: c.items.length })
    expect(choice, 'a covering scene exists, so this must not refuse').not.toBeNull()
    console.log(
      `full list: picked ${choice!.item.id} — ${choice!.clarity.clearPct.toFixed(1)}% clear over ` +
      `${(choice!.clarity.coveragePct ?? -1).toFixed(1)}% of the AOI`,
    )
    expect(choice!.clarity.coveragePct!).toBeGreaterThanOrEqual(MIN_AOI_COVERAGE_PCT)
    // `examined` must carry coverage so a refusal can name clipping vs cloud.
    expect(choice!.examined.some((e) => e.aoiCoveragePct != null)).toBe(true)
  }, 300_000)
})
